/**
 * PhotoMatch Server v7
 * ════════════════════════════════════════════════════════════════
 * Single login: Name + Password
 * Staff: Mon-Fri 8am-6pm Pacific
 * Manager: 24/7
 * Clear log: either password with confirmation
 * Google Sheet logs: date, time, who processed it
 * ════════════════════════════════════════════════════════════════
 */

const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const url    = require("url");
const crypto = require("crypto");

const CONFIG = {
  DROPBOX_TOKEN:       process.env.DROPBOX_TOKEN       || "",
  ANTHROPIC_KEY:       process.env.ANTHROPIC_KEY       || "",
  STAFF_PASSWORD:      process.env.STAFF_PASSWORD      || "StaffPass",
  MANAGER_PASSWORD:    process.env.MANAGER_PASSWORD    || "ManagerPass",
  INDEX_DROPBOX_PATH:  process.env.INDEX_DROPBOX_PATH  || "/_Cathy's Order/photo-index.json",
  MAIN_FOLDER:         process.env.MAIN_FOLDER         || "/_Cathy's Order",
  NEW_ARRIVALS_FOLDER: process.env.NEW_ARRIVALS_FOLDER || "/_Cathy's Order/New Arrivals",
  GOOGLE_SHEET_ID:     process.env.GOOGLE_SHEET_ID     || "",
  GOOGLE_SERVICE_ACCT: process.env.GOOGLE_SERVICE_ACCT || "",
  PORT:                process.env.PORT                || 3000,
  TIMEZONE:            "America/Los_Angeles",
};

let shipmentLog = [];
let csvData     = { vendors: [], categories: [], colors: [] };
let cachedIndex = null;
let cacheAt     = null;
const CACHE_TTL = 10 * 60 * 1000;

// ─── Office hours ──────────────────────────────────────────────────────────
function isOfficeHours() {
  const now  = new Date();
  const pt   = new Date(now.toLocaleString("en-US", { timeZone: CONFIG.TIMEZONE }));
  const day  = pt.getDay();
  const hour = pt.getHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 18;
}

function getPacificDateTime() {
  const now = new Date();
  const pt  = new Date(now.toLocaleString("en-US", { timeZone: CONFIG.TIMEZONE }));
  const date = pt.toISOString().slice(0, 10);
  const h    = pt.getHours();
  const m    = pt.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const h12  = (h % 12 || 12).toString();
  return { date, time: `${h12}:${m} ${ampm}` };
}

// ─── Auth ──────────────────────────────────────────────────────────────────
function checkPassword(password) {
  if (password === CONFIG.MANAGER_PASSWORD) return { valid: true, role: "manager" };
  if (password === CONFIG.STAFF_PASSWORD) {
    if (isOfficeHours()) return { valid: true, role: "staff" };
    return { valid: false, reason: "OUTSIDE_HOURS" };
  }
  return { valid: false, reason: "WRONG_PASSWORD" };
}

function checkClearPassword(password) {
  return password === CONFIG.STAFF_PASSWORD || password === CONFIG.MANAGER_PASSWORD;
}

// ─── Google Sheets ─────────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}
async function getGoogleToken() {
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
    const data = await sheetsRead("Sheet1!A1:K1");
    if (!data.values || data.values.length === 0) {
      await sheetsAppend([["Date","Time","SKU","Vendor","Category","Color","Type","Processed By","Shipment","Dropbox Path","Photo Name"]]);
    }
  } catch(e) { console.error("Sheet header check failed:", e.message); }
}

async function getNextSkuNumber(vendorCode, categoryCode) {
  try {
    const data   = await sheetsRead("Sheet1!A:K");
    const rows   = data.values || [];
    const prefix = `${vendorCode}${categoryCode}`.toUpperCase();
    let   max    = 0;
    for (const row of rows) {
      const sku = (row[2] || "").toString().toUpperCase();
      if (sku.startsWith(prefix)) {
        const num = parseInt(sku.slice(prefix.length).match(/^(\d+)/)?.[1] || "0", 10);
        if (num > max) max = num;
      }
    }
    for (const entry of shipmentLog) {
      const sku = (entry.sku || "").toUpperCase();
      if (sku.startsWith(prefix)) {
        const num = parseInt(sku.slice(prefix.length).match(/^(\d+)/)?.[1] || "0", 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch(e) { return 1; }
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

// ─── Dropbox ───────────────────────────────────────────────────────────────
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

function saveIndexToCache(index) { cachedIndex = index; cacheAt = Date.now(); }

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

async function uploadToDropbox(base64Image, filename) {
  const filePath    = `${CONFIG.NEW_ARRIVALS_FOLDER}/${filename}`;
  const imageBuffer = Buffer.from(base64Image, "base64");
  const result = await httpsPostBuffer("content.dropboxapi.com", "/2/files/upload", {
    "Authorization":   `Bearer ${CONFIG.DROPBOX_TOKEN}`,
    "Dropbox-API-Arg": JSON.stringify({ path: filePath, mode: { ".tag": "overwrite" }, autorename: false }),
    "Content-Type":    "application/octet-stream",
    "Content-Length":  imageBuffer.length
  }, imageBuffer);
  if (result.status !== 200) throw new Error("Failed to upload photo to Dropbox");
  return filePath;
}

async function saveIndexToDropbox(index) {
  const buf = Buffer.from(JSON.stringify(index, null, 2));
  await httpsPostBuffer("content.dropboxapi.com", "/2/files/upload", {
    "Authorization":   `Bearer ${CONFIG.DROPBOX_TOKEN}`,
    "Dropbox-API-Arg": JSON.stringify({ path: CONFIG.INDEX_DROPBOX_PATH, mode: { ".tag": "overwrite" } }),
    "Content-Type":    "application/octet-stream",
    "Content-Length":  buf.length
  }, buf);
}

// ─── Claude ────────────────────────────────────────────────────────────────
async function describePhoto(base64Image, mimeType) {
  const result = await httpsPost("api.anthropic.com", "/v1/messages", {
    "x-api-key":         CONFIG.ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
    "Content-Type":      "application/json"
  }, {
    model: "claude-haiku-4-5-20251001", max_tokens: 300,
    system: `Product photo tagger for jewelry/accessories. Respond ONLY with JSON:
{"category":"<type>","type":"<specific>","colors":["<color>"],"materials":["<material>"],"style":"<style>","tags":["<6-10 tags>"]}`,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
      { type: "text",  text: "Tag this product." }
    ]}]
  });
  const text = result.body?.content?.find(b => b.type === "text")?.text || "{}";
  try { return JSON.parse(text.replace(/```json|```/g,"").trim()); }
  catch { return { category:"", type:"", colors:[], materials:[], style:"", tags:[] }; }
}

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
  }).filter(r => r.score > 0).sort((a,b) => b.score-a.score).slice(0,30);
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Password, X-Username");
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

  if (reqPath.startsWith("/api/")) {
    const password = req.headers["x-password"] || "";
    const auth     = checkPassword(password);
    if (!auth.valid) {
      sendJSON(res, 401, { error: auth.reason });
      return;
    }
    req._auth     = auth;
    req._username = req.headers["x-username"] || "Unknown";
  }

  if (reqPath === "/api/index-info" && req.method === "GET") {
    try {
      const idx = await loadIndex();
      sendJSON(res, 200, { count: Object.keys(idx.photos||{}).length, lastUpdated: idx.lastUpdated, csvData });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (reqPath === "/api/search" && req.method === "POST") {
    try {
      const { imageBase64, mimeType } = await readBody(req);
      if (!imageBase64||!mimeType) { sendJSON(res, 400, { error: "Missing image" }); return; }
      const [idx, desc] = await Promise.all([loadIndex(), describePhoto(imageBase64, mimeType)]);
      sendJSON(res, 200, { results: scoreAll(Object.values(idx.photos||{}), desc) });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (reqPath === "/api/thumbnail" && req.method === "POST") {
    try {
      const { path: p } = await readBody(req);
      const thumb = await getThumbnail(p);
      if (!thumb) { sendJSON(res, 404, { error: "No thumbnail" }); return; }
      sendJSON(res, 200, { base64: thumb });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (reqPath === "/api/upload-csv" && req.method === "POST") {
    try {
      const { type, content } = await readBody(req);
      if (!["vendors","categories","colors"].includes(type)) { sendJSON(res, 400, { error: "Invalid type" }); return; }
      csvData[type] = parseCSV(content);
      sendJSON(res, 200, { ok: true, count: csvData[type].length });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (reqPath === "/api/next-sku" && req.method === "POST") {
    try {
      const { vendorCode, categoryCode, colorCode } = await readBody(req);
      const num = await getNextSkuNumber(vendorCode, categoryCode);
      const sku = `${vendorCode}${categoryCode}${num}${colorCode}`.toUpperCase();
      sendJSON(res, 200, { sku, number: num });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (reqPath === "/api/confirm-sku" && req.method === "POST") {
    try {
      const { sku, vendor, vendorCode, category, categoryCode, color, colorCode, photoBase64, mimeType, shipmentName } = await readBody(req);
      if (!sku||!photoBase64) { sendJSON(res, 400, { error: "Missing SKU or photo" }); return; }
      const ext         = (mimeType||"image/jpeg").includes("png") ? ".png" : ".jpg";
      const filename    = `${sku}${ext}`;
      const dropboxPath = await uploadToDropbox(photoBase64, filename);
      const { date, time } = getPacificDateTime();
      const processedBy = req._username;
      await ensureSheetHeader();
      await sheetsAppend([[date, time, sku, vendor, category, color, "NEW", processedBy, shipmentName||"Current", dropboxPath, filename]]);
      const index = await loadIndex();
      const tags  = await describePhoto(photoBase64, mimeType||"image/jpeg");
      const newId = `new_${Date.now()}`;
      index.photos[newId] = { id:newId, name:filename, filename:sku, path:dropboxPath, tags, indexed:new Date().toISOString(), isNewArrival:true };
      index.lastUpdated = new Date().toISOString();
      saveIndexToCache(index);
      await saveIndexToDropbox(index);
      const entry = { id:Date.now().toString(), date, time, sku, vendor, vendorCode, category, categoryCode, color, colorCode, type:"NEW", processedBy, photoBase64, dropboxPath, filename, shipment:shipmentName||"Current" };
      shipmentLog.push(entry);
      sendJSON(res, 200, { ok:true, sku, dropboxPath, filename });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (reqPath === "/api/restock" && req.method === "POST") {
    try {
      const { sku, vendor, category, color, photoBase64, shipmentName } = await readBody(req);
      const { date, time } = getPacificDateTime();
      const processedBy = req._username;
      await ensureSheetHeader();
      await sheetsAppend([[date, time, sku, vendor||"", category||"", color||"", "RESTOCK", processedBy, shipmentName||"Current", "", ""]]);
      const entry = { id:Date.now().toString(), date, time, sku, vendor, category, color, type:"RESTOCK", processedBy, photoBase64, shipment:shipmentName||"Current" };
      shipmentLog.push(entry);
      sendJSON(res, 200, { ok:true, entry });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (reqPath === "/api/log" && req.method === "GET") {
    sendJSON(res, 200, { log: shipmentLog });
    return;
  }

  if (reqPath === "/api/clear-log" && req.method === "POST") {
    try {
      const { confirmPassword } = await readBody(req);
      if (!checkClearPassword(confirmPassword)) {
        sendJSON(res, 403, { error: "Wrong password" }); return;
      }
      shipmentLog = [];
      sendJSON(res, 200, { ok: true });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  if (reqPath === "/" || reqPath === "/index.html") {
    serveStatic(res, path.join(__dirname, "app", "index.html"));
    return;
  }

  res.writeHead(404); res.end("Not found");

}).listen(CONFIG.PORT, () => {
  console.log(`\n✅  PhotoMatch v7 running on port ${CONFIG.PORT}`);
  console.log(`    Staff: Mon-Fri 8am-6pm Pacific`);
  console.log(`    Manager: 24/7\n`);
});
