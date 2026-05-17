/**
 * PhotoMatch Server v5
 * ════════════════════════════════════════════════════════════════
 * Full SKU management system with Google Sheets permanent record.
 * Auto photo rename + save to New Arrivals folder in Dropbox.
 * ════════════════════════════════════════════════════════════════
 */

const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const url    = require("url");
const crypto = require("crypto");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  DROPBOX_TOKEN:        process.env.DROPBOX_TOKEN        || "",
  ANTHROPIC_KEY:        process.env.ANTHROPIC_KEY        || "",
  GROUP1_PASSWORD:      process.env.GROUP1_PASSWORD      || "Group1Pass",
  GROUP1_NAME:          process.env.GROUP1_NAME          || "Group 1",
  GROUP2_PASSWORD:      process.env.GROUP2_PASSWORD      || "Group2Pass",
  GROUP2_NAME:          process.env.GROUP2_NAME          || "Group 2",
  ADMIN_PASSWORD:       process.env.ADMIN_PASSWORD       || "AdminPass",
  MAIN_FOLDER:          process.env.MAIN_FOLDER          || "/_Cathy's Order",
  NEW_ARRIVALS_FOLDER:  process.env.NEW_ARRIVALS_FOLDER  || "/_Cathy's Order/New Arrivals",
  INDEX_DROPBOX_PATH:   process.env.INDEX_DROPBOX_PATH   || "/_Cathy's Order/photo-index.json",
  GOOGLE_SHEET_ID:      process.env.GOOGLE_SHEET_ID      || "",
  GOOGLE_SERVICE_ACCT:  process.env.GOOGLE_SERVICE_ACCT  || "",
  PORT:                 process.env.PORT                 || 3000,
};

// ─── In-memory state ───────────────────────────────────────────────────────
let shipmentLog = [];
let csvData     = { vendors: [], categories: [], colors: [] };
let cachedIndex = null;
let cacheAt     = null;
const CACHE_TTL = 10 * 60 * 1000;

// ─── Google Sheets JWT auth ────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}

async function getGoogleToken() {
  if (!CONFIG.GOOGLE_SERVICE_ACCT) throw new Error("No Google service account configured");
  let sa;
  try { sa = JSON.parse(CONFIG.GOOGLE_SERVICE_ACCT); }
  catch { throw new Error("Invalid GOOGLE_SERVICE_ACCT JSON"); }

  const now     = Math.floor(Date.now() / 1000);
  const header  = base64url(Buffer.from(JSON.stringify({ alg:"RS256", typ:"JWT" })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now
  })));
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const jwt    = `${header}.${payload}.${base64url(sign.sign(sa.private_key))}`;
  const body   = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const result = await httpsPost("oauth2.googleapis.com", "/token",
    { "Content-Type": "application/x-www-form-urlencoded" }, body);
  if (!result.body.access_token) throw new Error("Google auth failed");
  return result.body.access_token;
}

// ─── Google Sheets ─────────────────────────────────────────────────────────
async function sheetsRead(range) {
  const token = await getGoogleToken();
  return new Promise((resolve, reject) => {
    https.get({
      hostname: "sheets.googleapis.com",
      path: `/v4/spreadsheets/${CONFIG.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}`,
      headers: { Authorization: `Bearer ${token}` }
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

async function sheetsAppend(values) {
  const token = await getGoogleToken();
  return httpsPost("sheets.googleapis.com",
    `/v4/spreadsheets/${CONFIG.GOOGLE_SHEET_ID}/values/${encodeURIComponent("Sheet1!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    { values });
}

async function ensureSheetHeader() {
  try {
    const data = await sheetsRead("Sheet1!A1:I1");
    if (!data.values || data.values.length === 0) {
      await sheetsAppend([["Date","SKU","Vendor","Category","Color","Type","Shipment","Dropbox Path","Photo Name"]]);
    }
  } catch(e) { console.error("Sheet header check failed:", e.message); }
}

// ─── Get next SKU number from Google Sheet ─────────────────────────────────
async function getNextSkuNumber(vendorCode, categoryCode) {
  try {
    const data   = await sheetsRead("Sheet1!A:I");
    const rows   = data.values || [];
    const prefix = `${vendorCode}${categoryCode}`.toUpperCase();
    let   max    = 0;

    for (const row of rows) {
      const sku = (row[1] || "").toString().toUpperCase();
      if (sku.startsWith(prefix)) {
        const middle = sku.slice(prefix.length);
        const num    = parseInt(middle.match(/^(\d+)/)?.[1] || "0", 10);
        if (num > max) max = num;
      }
    }

    // Also check shipment log in memory
    for (const entry of shipmentLog) {
      const sku = (entry.sku || "").toUpperCase();
      if (sku.startsWith(prefix)) {
        const middle = sku.slice(prefix.length);
        const num    = parseInt(middle.match(/^(\d+)/)?.[1] || "0", 10);
        if (num > max) max = num;
      }
    }

    return max + 1;
  } catch(e) {
    console.error("SKU lookup failed:", e.message);
    return 1;
  }
}

// ─── HTTPS helpers ─────────────────────────────────────────────────────────
function httpsPost(hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req  = https.request({
      hostname, path: reqPath, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(data) }
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ body: JSON.parse(raw), status: res.statusCode }); }
        catch { resolve({ body: raw, status: res.statusCode }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpsPostBuffer(hostname, reqPath, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, method: "POST", headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), status: res.statusCode }));
    });
    req.on("error", reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

// ─── Auth ──────────────────────────────────────────────────────────────────
function checkPassword(password) {
  if (password === CONFIG.GROUP1_PASSWORD) return { valid: true, group: 1, name: CONFIG.GROUP1_NAME };
  if (password === CONFIG.GROUP2_PASSWORD) return { valid: true, group: 2, name: CONFIG.GROUP2_NAME };
  return { valid: false };
}

// ─── Dropbox: load index ───────────────────────────────────────────────────
async function loadIndex() {
  const now = Date.now();
  if (cachedIndex && cacheAt && (now - cacheAt) < CACHE_TTL) return cachedIndex;
  const result = await httpsPostBuffer("content.dropboxapi.com", "/2/files/download", {
    "Authorization":   `Bearer ${CONFIG.DROPBOX_TOKEN}`,
    "Dropbox-API-Arg": JSON.stringify({ path: CONFIG.INDEX_DROPBOX_PATH }),
    "Content-Type":    ""
  });
  if (result.status !== 200) throw new Error("Could not load index from Dropbox");
  cachedIndex = JSON.parse(result.buffer.toString());
  cacheAt     = now;
  return cachedIndex;
}

function saveIndexToCache(index) {
  cachedIndex = index;
  cacheAt     = Date.now();
}

// ─── Dropbox: get thumbnail ────────────────────────────────────────────────
async function getThumbnail(photoPath) {
  const result = await httpsPostBuffer("content.dropboxapi.com", "/2/files/get_thumbnail_v2", {
    "Authorization":   `Bearer ${CONFIG.DROPBOX_TOKEN}`,
    "Dropbox-API-Arg": JSON.stringify({
      resource: { ".tag": "path", path: photoPath },
      format:   { ".tag": "jpeg" },
      size:     { ".tag": "w256h256" }
    }),
    "Content-Type": ""
  });
  if (result.status !== 200) return null;
  return result.buffer.toString("base64");
}

// ─── Dropbox: upload photo ─────────────────────────────────────────────────
async function uploadToDropbox(base64Image, filename) {
  const filePath   = `${CONFIG.NEW_ARRIVALS_FOLDER}/${filename}`;
  const imageBuffer = Buffer.from(base64Image, "base64");
  const result = await httpsPostBuffer("content.dropboxapi.com", "/2/files/upload", {
    "Authorization":   `Bearer ${CONFIG.DROPBOX_TOKEN}`,
    "Dropbox-API-Arg": JSON.stringify({
      path: filePath,
      mode: { ".tag": "overwrite" },
      autorename: false
    }),
    "Content-Type": "application/octet-stream",
    "Content-Length": imageBuffer.length
  }, imageBuffer);
  if (result.status !== 200) throw new Error("Failed to upload photo to Dropbox");
  return filePath;
}

// ─── Dropbox: save index back ──────────────────────────────────────────────
async function saveIndexToDropbox(index) {
  const buf = Buffer.from(JSON.stringify(index, null, 2));
  await httpsPostBuffer("content.dropboxapi.com", "/2/files/upload", {
    "Authorization":   `Bearer ${CONFIG.DROPBOX_TOKEN}`,
    "Dropbox-API-Arg": JSON.stringify({
      path: CONFIG.INDEX_DROPBOX_PATH,
      mode: { ".tag": "overwrite" }
    }),
    "Content-Type":  "application/octet-stream",
    "Content-Length": buf.length
  }, buf);
}

// ─── Claude: describe photo ────────────────────────────────────────────────
async function describePhoto(base64Image, mimeType) {
  const result = await httpsPost("api.anthropic.com", "/v1/messages", {
    "x-api-key":         CONFIG.ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
    "Content-Type":      "application/json"
  }, {
    model: "claude-haiku-4-5-20251001", max_tokens: 300,
    system: `Product photo tagger. Respond ONLY with JSON no markdown:
{"category":"<type>","type":"<specific>","colors":["<color>"],"materials":["<material>"],"style":"<style>","tags":["<5-8 tags>"]}`,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
      { type: "text",  text: "Tag this product." }
    ]}]
  });
  const text = result.body?.content?.find(b => b.type === "text")?.text || "{}";
  try { return JSON.parse(text.replace(/```json|```/g,"").trim()); }
  catch { return { category:"", type:"", colors:[], materials:[], style:"", tags:[] }; }
}

// ─── Similarity scoring ────────────────────────────────────────────────────
function extractWords(obj) {
  const words = new Set();
  const add = v => {
    if (!v) return;
    if (typeof v === "string")                       v.toLowerCase().split(/[\s,\-_]+/).forEach(w => w.length>1 && words.add(w));
    if (Array.isArray(v))                            v.forEach(add);
    if (typeof v === "object" && !Array.isArray(v)) Object.values(v).forEach(add);
  };
  add(obj); return words;
}

function scoreAll(photos, queryDesc) {
  const qW = extractWords(queryDesc);
  return photos.map(photo => {
    const pW = extractWords(photo.tags || {});
    let m = 0; qW.forEach(w => { if (pW.has(w)) m++; });
    const score = Math.min(Math.round(((m/(qW.size||1))*0.7+(m/(pW.size||1))*0.3)*100),99);
    return { photo, score };
  }).filter(r => r.score > 0).sort((a,b) => b.score-a.score).slice(0, 6);
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Password");
}
function sendJSON(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function serveStatic(res, filePath) {
  const mime = {".html":"text/html",".js":"application/javascript",".css":"text/css"}[path.extname(filePath)]||"text/plain";
  try { res.writeHead(200,{"Content-Type":mime}); res.end(fs.readFileSync(filePath)); }
  catch { res.writeHead(404); res.end("Not found"); }
}
function readBody(req) {
  return new Promise((resolve,reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); } });
    req.on("error", reject);
  });
}
function parseCSV(text) {
  return text.split("\n").slice(1).map(line => {
    const parts = line.split(",").map(p => p.trim().replace(/^"|"$/g,""));
    return parts.length >= 2 && parts[0] ? { code: parts[0], name: parts[1] } : null;
  }).filter(Boolean);
}

// ─── Main server ───────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const reqPath = url.parse(req.url, true).pathname;
  setCORS(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Auth
  if (reqPath.startsWith("/api/")) {
    const pw   = req.headers["x-password"] || "";
    const auth = checkPassword(pw);
    if (!auth.valid) { sendJSON(res, 401, { error: "NEED_PASSWORD" }); return; }
    req._auth = auth;
  }

  // ── GET /api/index-info ──
  if (reqPath === "/api/index-info" && req.method === "GET") {
    try {
      const idx = await loadIndex();
      sendJSON(res, 200, { count: Object.keys(idx.photos||{}).length, lastUpdated: idx.lastUpdated, csvData });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /api/search ──
  if (reqPath === "/api/search" && req.method === "POST") {
    try {
      const { imageBase64, mimeType } = await readBody(req);
      if (!imageBase64||!mimeType) { sendJSON(res, 400, { error: "Missing image" }); return; }
      const [idx, desc] = await Promise.all([loadIndex(), describePhoto(imageBase64, mimeType)]);
      const top6 = scoreAll(Object.values(idx.photos||{}), desc);
      sendJSON(res, 200, { results: top6 });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /api/thumbnail ──
  if (reqPath === "/api/thumbnail" && req.method === "POST") {
    try {
      const { path: p } = await readBody(req);
      const thumb = await getThumbnail(p);
      if (!thumb) { sendJSON(res, 404, { error: "No thumbnail" }); return; }
      sendJSON(res, 200, { base64: thumb });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /api/upload-csv ──
  if (reqPath === "/api/upload-csv" && req.method === "POST") {
    try {
      const { type, content } = await readBody(req);
      if (!["vendors","categories","colors"].includes(type)) { sendJSON(res, 400, { error: "Invalid type" }); return; }
      csvData[type] = parseCSV(content);
      sendJSON(res, 200, { ok: true, count: csvData[type].length });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /api/next-sku ──
  if (reqPath === "/api/next-sku" && req.method === "POST") {
    try {
      const { vendorCode, categoryCode, colorCode } = await readBody(req);
      const num = await getNextSkuNumber(vendorCode, categoryCode);
      const sku = `${vendorCode}${categoryCode}${num}${colorCode}`.toUpperCase();
      sendJSON(res, 200, { sku, number: num });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /api/confirm-sku ── (new item — upload photo, rename, index)
  if (reqPath === "/api/confirm-sku" && req.method === "POST") {
    try {
      const { sku, vendor, vendorCode, category, categoryCode, color, colorCode, photoBase64, mimeType, shipmentName } = await readBody(req);
      if (!sku || !photoBase64) { sendJSON(res, 400, { error: "Missing SKU or photo" }); return; }

      // Determine file extension
      const ext      = (mimeType || "image/jpeg").includes("png") ? ".png" : ".jpg";
      const filename = `${sku}${ext}`;

      // 1. Upload photo to Dropbox New Arrivals folder
      const dropboxPath = await uploadToDropbox(photoBase64, filename);

      // 2. Write to Google Sheet
      const date = new Date().toISOString().slice(0, 10);
      await ensureSheetHeader();
      await sheetsAppend([[date, sku, vendor, category, color, "NEW", shipmentName||"Current", dropboxPath, filename]]);

      // 3. Add to search index immediately
      const index = await loadIndex();
      const tags  = await describePhoto(photoBase64, mimeType || "image/jpeg");
      const newId = `new_${Date.now()}`;
      index.photos[newId] = {
        id: newId, name: filename,
        filename: sku,
        path: dropboxPath,
        tags, indexed: new Date().toISOString(),
        isNewArrival: true
      };
      index.lastUpdated = new Date().toISOString();
      saveIndexToCache(index);
      // Save updated index back to Dropbox
      await saveIndexToDropbox(index);

      // 4. Add to shipment log
      const entry = { id: Date.now().toString(), date, sku, vendor, vendorCode, category, categoryCode, color, colorCode, type: "NEW", photoBase64, dropboxPath, filename, shipment: shipmentName||"Current" };
      shipmentLog.push(entry);

      sendJSON(res, 200, { ok: true, sku, dropboxPath, filename });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── POST /api/restock ──
  if (reqPath === "/api/restock" && req.method === "POST") {
    try {
      const { sku, vendor, category, color, photoBase64, shipmentName } = await readBody(req);
      const date  = new Date().toISOString().slice(0, 10);
      await ensureSheetHeader();
      await sheetsAppend([[date, sku, vendor||"", category||"", color||"", "RESTOCK", shipmentName||"Current", "", ""]]);
      const entry = { id: Date.now().toString(), date, sku, vendor, category, color, type: "RESTOCK", photoBase64, shipment: shipmentName||"Current" };
      shipmentLog.push(entry);
      sendJSON(res, 200, { ok: true, entry });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── GET /api/log ──
  if (reqPath === "/api/log" && req.method === "GET") {
    sendJSON(res, 200, { log: shipmentLog });
    return;
  }

  // ── POST /api/clear-log ──
  if (reqPath === "/api/clear-log" && req.method === "POST") {
    try {
      const { adminPassword } = await readBody(req);
      if (adminPassword !== CONFIG.ADMIN_PASSWORD) { sendJSON(res, 403, { error: "Wrong admin password" }); return; }
      shipmentLog = [];
      sendJSON(res, 200, { ok: true });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ── Serve static ──
  if (reqPath === "/" || reqPath === "/index.html") {
    serveStatic(res, path.join(__dirname, "app", "index.html"));
    return;
  }

  res.writeHead(404); res.end("Not found");

}).listen(CONFIG.PORT, () => {
  console.log(`\n✅  PhotoMatch v5 running on port ${CONFIG.PORT}`);
  console.log(`    Main folder:        ${CONFIG.MAIN_FOLDER}`);
  console.log(`    New Arrivals:       ${CONFIG.NEW_ARRIVALS_FOLDER}`);
  console.log(`    Index path:         ${CONFIG.INDEX_DROPBOX_PATH}`);
  console.log(`    Google Sheet ID:    ${CONFIG.GOOGLE_SHEET_ID||"NOT SET"}\n`);
});
