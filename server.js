/**
 * PhotoMatch Server v7
 * ════════════════════════════════════════════════════════════════
 * Single login: Name + Password
 * Staff: Mon-Fri 8am-6pm Pacific
 * Manager: 24/7
 * Google key loaded from Dropbox — reliable, no Railway JSON issues
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
  GOOGLE_KEY_PATH:     "/_Cathy's Order/google-key.json",
  PORT:                process.env.PORT                || 3000,
  TIMEZONE:            "America/Los_Angeles",
};

// ─── In-memory state ───────────────────────────────────────────────────────
let shipmentLog = [];
let csvData     = { vendors: [], categories: [], colors: [] };
let cachedIndex = null;
let cacheAt     = null;
let cachedSA    = null;
const CACHE_TTL = 10 * 60 * 1000;

// ─── SKU starting numbers ──────────────────────────────────────────────────
const SKU_STARTING = {
  "16B":82,"16E":77,"16N":36,"16R":19,
  "822B":82,"822E":3,"822R":29,
  "92E":9,"92N":10,
  "AAK":9,"AB":236,"AE":90,"AHT":35,"AN":238,"APC":90,"APD":59,"AR":30,
  "B1E":26,"B2B":2,"B2E":45,"B2N":2,"B2R":29,
  "B3B":42,"B3E":89,"B3N":32,"B3R":44,
  "B4E":5,"B6E":5,"B6R":3,"B7B":4,
  "BC":14,"BG":99,"CC":564,
  "D1B":5,"D1E":3,"D2B":4,"D2E":4,"D2N":24,
  "KB":28,"KE":1,"KN":149,"KR":5,
  "LB":212,"LE":314,"LN":34,"LPD":187,"LR":462,
  "MB":43,"ME":33,"MH":16,"MN":270,
  "O":4,"R":53,
  "S1B":26,"S1C":1,"S1E":47,"S1N":104,"S1R":51,
  "S2B":7,"S2E":1,"S2N":14,
  "S3E":44,"S4B":2,"S4N":5,
  "S5B":2,"S5E":4,"S5N":15,"S5R":1,
  "S6B":2,"S6N":187,"S6R":29,
  "S7N":25,
  "S8A":10,"S8B":46,"S8E":57,"S8H":16,"S8N":135,"S8R":52,"S8WC":1,
  "S9B":16,"S9E":3,"S9N":3,"S9R":8,
  "SCARF":33,"SCF":159,
  "T1N":5,"T2E":17,"T2N":4,"T2R":1,
  "T3P":1,"T4E":1,"T4N":8,"T4R":19,
  "T5E":1,"T5N":6,
  "T7B":2,"T7E":10,"T7HC":1,"T7N":30,"T7R":14,
  "TB":1,"TPC":3,
  "YB":7,"YE":5,"YNK":24,"YPC":2,
  "Z1B":24,"Z2B":12,"Z2E":2,"Z2N":9,
  "Z3B":16,"Z3N":4,"Z3R":5,
  "Z4N":8,"Z5E":3,
};

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

// ─── Load Google service account from Dropbox ──────────────────────────────
async function loadServiceAccount() {
  if (cachedSA) return cachedSA;
  const result = await httpsPostBuffer("content.dropboxapi.com", "/2/files/download", {
    "Authorization":   `Bearer ${CONFIG.DROPBOX_TOKEN}`,
    "Dropbox-API-Arg": JSON.stringify({ path: CONFIG.GOOGLE_KEY_PATH }),
    "Content-Type":    ""
  });
  if (result.status !== 200) throw new Error("Could not load google-key.json from Dropbox");
  cachedSA = JSON.parse(result.buffer.toString());
  return cachedSA;
}

// ─── Google Sheets JWT auth ────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}

async function getGoogleToken() {
  const sa  = await loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
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
  if (!result.body.access_token) throw new Error("Google auth failed: " + JSON.stringify(result.body));
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
    const data = await sheetsRead("Sheet1!A1:K1");
    if (!data.values || data.values.length === 0) {
      await sheetsAppend([["Date","Time","SKU","Vendor","Category","Color","Type","Processed By","Shipment","Dropbox Path","Photo Name"]]);
    }
  } catch(e) { console.error("Sheet header check failed:", e.message); }
}

// ─── Get next SKU number ───────────────────────────────────────────────────
async function getNextSkuNumber(vendorCode, categoryCode) {
  const prefix = `${vendorCode}${categoryCode}`.toUpperCase();
  let max = SKU_STARTING[prefix] || 0;

  try {
    const data = await sheetsRead("Sheet1!A:K");
    const rows = data.values || [];
    for (const row of rows) {
      const sku = (row[2] || "").toString().toUpperCase();
      if (sku.startsWith(prefix)) {
        const num = parseInt(sku.slice(prefix.length).match(/^(\d+)/)?.[1] || "0", 10);
        if (num > max) max = num;
      }
    }
  } catch(e) { console.log("Sheet read skipped, using local starting numbers"); }

  for (const entry of shipmentLog) {
    const sku = (entry.sku || "").toUpperCase();
    if (sku.startsWith(prefix)) {
      const num = parseInt(sku.slice(prefix.length).match(/^(\d+)/)?.[1] || "0", 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
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
    system: `You are a jewelry visual similarity analyzer. Respond ONLY with JSON no markdown:
{
  "category": "<anklet|bracelet|earring|necklace|ring|phone chain|waist chain|hair tie|eyewear|hand chain>",
  "style": "<delicate|chunky|minimalist|statement|layered|classic|bohemian>",
  "shape": "<chain|pendant|hoop|stud|cuff|bangle|drop|cluster|bar|coin|cross|heart|geometric>",
  "metal": "<gold|silver|rose gold|rhodium|gunmetal|mixed>",
  "stone": "<none|crystal|pearl|turquoise|amazonite|malachite|amber|quartz|enamel|shell|resin|other>",
  "stone_color": "<none|white|black|blue|green|pink|purple|red|orange|yellow|brown|multicolor>",
  "chain_style": "<none|cable|snake|box|rope|figaro|curb|ball|link|paperclip>",
  "length": "<short|medium|long|adjustable>",
  "colors": ["<color>"],
  "tags": ["<10 specific visual tags>"]
}`,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
      { type: "text",  text: "Analyze this jewelry." }
    ]}]
  });
  const text = result.body?.content?.find(b => b.type === "text")?.text || "{}";
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    parsed.vector = descriptionToVector(parsed);
    return parsed;
  } catch {
    return { category:"", style:"", shape:"", metal:"", stone:"none", stone_color:"none", chain_style:"none", length:"", colors:[], tags:[], vector:[] };
  }
}

// ─── Visual similarity ─────────────────────────────────────────────────────
function descriptionToVector(desc) {
  const categories  = ["anklet","bracelet","earring","necklace","ring","phone chain","waist chain","hair tie","eyewear","hand chain"];
  const styles      = ["delicate","chunky","minimalist","statement","layered","classic","bohemian"];
  const shapes      = ["chain","pendant","hoop","stud","cuff","bangle","drop","cluster","bar","coin","cross","heart","geometric"];
  const metals      = ["gold","silver","rose gold","rhodium","gunmetal","mixed"];
  const stones      = ["none","crystal","pearl","turquoise","amazonite","malachite","amber","quartz","enamel","shell","resin","other"];
  const stoneColors = ["none","white","black","blue","green","pink","purple","red","orange","yellow","brown","multicolor"];
  const chainStyles = ["none","cable","snake","box","rope","figaro","curb","ball","link","paperclip"];
  const lengths     = ["short","medium","long","adjustable"];
  const oneHot = (arr, val) => arr.map(v => v === (val||"").toLowerCase() ? 1 : 0);
  return [
    ...oneHot(categories,  desc.category),
    ...oneHot(styles,      desc.style),
    ...oneHot(shapes,      desc.shape),
    ...oneHot(metals,      desc.metal),
    ...oneHot(stones,      desc.stone),
    ...oneHot(stoneColors, desc.stone_color),
    ...oneHot(chainStyles, desc.chain_style),
    ...oneHot(lengths,     desc.length),
  ];
}

function cosineSimilarity(a, b) {
  if (!a||!b||a.length!==b.length) return 0;
  let dot=0,magA=0,magB=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];magA+=a[i]*a[i];magB+=b[i]*b[i];}
  const d=Math.sqrt(magA)*Math.sqrt(magB);
  return d===0?0:dot/d;
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
  const queryVector = queryDesc.vector || descriptionToVector(queryDesc);
  const qW          = extractWords(queryDesc);
  const hasVectors  = photos.some(p => p.vector && p.vector.length > 0);

  return photos.map(photo => {
    let score = 0;
    if (hasVectors && photo.vector && photo.vector.length > 0) {
      const visualSim = cosineSimilarity(queryVector, photo.vector);
      const pW        = extractWords(photo.tags || {});
      let   kwMatches = 0;
      qW.forEach(w => { if (pW.has(w)) kwMatches++; });
      const kwSim = kwMatches / (qW.size || 1);
      score = Math.min(Math.round((visualSim * 0.7 + kwSim * 0.3) * 100), 99);
    } else {
      const pW = extractWords(photo.tags || {});
      let m = 0; qW.forEach(w => { if (pW.has(w)) m++; });
      score = Math.min(Math.round(((m/(qW.size||1))*0.7+(m/(pW.size||1))*0.3)*100), 99);
    }
    return { photo, score };
  }).filter(r => r.score > 0).sort((a,b) => b.score-a.score).slice(0,30);
}

// ─── CSV from Dropbox ──────────────────────────────────────────────────────
const CSV_PATHS = {
  vendors:    "/_Cathy's Order/vendors.csv",
  categories: "/_Cathy's Order/categories.csv",
  colors:     "/_Cathy's Order/colors.csv",
};

function parseCSV(text) {
  return text.split("\n").slice(1).map(line => {
    const parts = line.split(",").map(p => p.trim().replace(/^"|"$/g,""));
    return parts.length >= 2 && parts[0] ? { code: parts[0], name: parts[1] } : null;
  }).filter(Boolean);
}

async function loadCSVFromDropbox(type) {
  try {
    const result = await httpsPostBuffer("content.dropboxapi.com", "/2/files/download", {
      "Authorization":   `Bearer ${CONFIG.DROPBOX_TOKEN}`,
      "Dropbox-API-Arg": JSON.stringify({ path: CSV_PATHS[type] }),
      "Content-Type":    ""
    });
    if (result.status !== 200) return;
    csvData[type] = parseCSV(result.buffer.toString());
    console.log(`  Loaded ${type}: ${csvData[type].length} entries`);
  } catch(e) { console.error(`  Could not load ${type} CSV:`, e.message); }
}

async function loadAllCSVs() {
  console.log("Loading CSVs from Dropbox...");
  await Promise.all(["vendors","categories","colors"].map(loadCSVFromDropbox));
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

// ─── Main server ───────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const reqPath = url.parse(req.url, true).pathname;
  setCORS(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (reqPath.startsWith("/api/")) {
    const password = req.headers["x-password"] || "";
    const auth     = checkPassword(password);
    if (!auth.valid) { sendJSON(res, 401, { error: auth.reason }); return; }
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
      index.photos[newId] = { id:newId, name:filename, filename:sku, path:dropboxPath, tags, vector:tags.vector||[], indexed:new Date().toISOString(), isNewArrival:true };
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
      if (!checkClearPassword(confirmPassword)) { sendJSON(res, 403, { error: "Wrong password" }); return; }
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

}).listen(CONFIG.PORT, async () => {
  await loadAllCSVs();
  console.log(`\n✅  PhotoMatch v7 running on port ${CONFIG.PORT}`);
  console.log(`    Staff: Mon-Fri 8am-6pm Pacific`);
  console.log(`    Manager: 24/7`);
  console.log(`    Google key: loaded from Dropbox\n`);
});