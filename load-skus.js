/**
 * PhotoMatch — One-time SKU Loader
 * ══════════════════════════════════════════════════════
 * Loads all existing SKU starting numbers into Google Sheet A
 * Run ONCE: node load-skus.js
 * ══════════════════════════════════════════════════════
 */

const https  = require("https");
const crypto = require("crypto");

// ─── CONFIG — fill these in ────────────────────────────────────────────────
const CONFIG = {
  GOOGLE_SHEET_ID:     "1qUlqL0Wbm4Ns9Xp_jw0ufSiVhPenNBDKGhXcdysnafU",
  GOOGLE_SERVICE_ACCT: require("fs").readFileSync("./google-key.json", "utf8"),
};

// ─── All existing SKUs — last used number ──────────────────────────────────
// Format: "VENDORCATEGORY" -> last used number
// App will use NEXT number (these + 1)
const EXISTING_SKUS = [
  // Each entry: [Date, Time, SKU, Vendor, Category, Color, Type, Processed By, Shipment, Path, Photo]
  // We load the LAST used SKU for each vendor+category combo
  // The number shown IS the last used number — next will be +1
  ["2025-01-01","00:00","16B82","16","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","16E77","16","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","16N36","16","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","16R19","16","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","822B82","822","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","822E3","822","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","822R29","822","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","92E9","92","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","92N10","92","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","AAK9","A","ANKLETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","AB236","A","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","AE90","A","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","AHT35","A","HAIR TIES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","AN238","A","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","APC90","A","PHONE CHAINS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","APD59","A","PENDANTS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","AR30","A","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B1E26","B1","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B2B2","B2","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B2E45","B2","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B2N2","B2","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B2R29","B2","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B3B42","B3","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B3E89","B3","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B3N32","B3","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B3R44","B3","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B4E5","B4","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B6E5","B6","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B6R3","B6","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","B7B4","B7","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","BC14","BC","","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","BG99","BG","","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","CC564","CC","","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","D1B5","D1","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","D1E3","D1","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","D2B4","D2","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","D2E4","D2","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","D2N24","D2","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","KB28","K","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","KE1","K","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","KN149","K","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","KR5","K","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","LB212","L","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","LE314","L","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","LN34","L","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","LPD187","L","PENDANTS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","LR462","L","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","MB43","M","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","ME33","M","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","MH16","M","HANDCHAINS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","MN270","M","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","O4","O","","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","R53","R","","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S1B26","S1","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S1C1","S1","","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S1E47","S1","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S1N104","S1","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S1R51","S1","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S2B7","S2","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S2E1","S2","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S2N14","S2","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S3E44","S3","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S4B2","S4","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S4N5","S4","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S5B2","S5","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S5E4","S5","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S5N15","S5","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S5R1","S5","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S6B2","S6","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S6N187","S6","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S6R29","S6","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S7N25","S7","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S8A10","S8","ANKLETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S8B46","S8","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S8E57","S8","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S8H16","S8","HANDCHAINS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S8N135","S8","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S8R52","S8","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S8WC1","S8","WAISTCHAINS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S9B16","S9","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S9E3","S9","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S9N3","S9","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","S9R8","S9","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","SCARF33","SCF","","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","SCF159","SCF","","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T1N5","T1","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T2E17","T2","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T2N4","T2","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T2R1","T2","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T3P1","T3","","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T4E1","T4","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T4N8","T4","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T4R19","T4","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T5E1","T5","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T5N6","T5","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T7B2","T7","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T7E10","T7","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T7HC1","T7","HANDCHAINS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T7N30","T7","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","T7R14","T7","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","TB1","T","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","TPC3","T","PHONE CHAINS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","YB7","Y","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","YE5","Y","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","YNK24","Y","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","YPC2","Y","PHONE CHAINS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","Z1B24","Z1","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","Z2B12","Z2","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","Z2E2","Z2","EARRINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","Z2N9","Z2","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","Z3B16","Z3","BRACELETS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","Z3N4","Z3","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","Z3R5","Z3","RINGS","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","Z4N8","Z4","NECKLACES","","EXISTING","System","Pre-load","",""],
  ["2025-01-01","00:00","Z5E3","Z5","EARRINGS","","EXISTING","System","Pre-load","",""],
];

// ─── Google Auth ───────────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}

async function getGoogleToken() {
  let sa;
  try { sa = JSON.parse(CONFIG.GOOGLE_SERVICE_ACCT); }
  catch { throw new Error("Invalid GOOGLE_SERVICE_ACCT JSON"); }
  const now     = Math.floor(Date.now()/1000);
  const header  = base64url(Buffer.from(JSON.stringify({alg:"RS256",typ:"JWT"})));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss:sa.client_email, scope:"https://www.googleapis.com/auth/spreadsheets",
    aud:"https://oauth2.googleapis.com/token", exp:now+3600, iat:now
  })));
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const jwt    = `${header}.${payload}.${base64url(sign.sign(sa.private_key))}`;
  const body   = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const result = await httpsPost("oauth2.googleapis.com","/token",{"Content-Type":"application/x-www-form-urlencoded"},body);
  if (!result.body.access_token) throw new Error("Google auth failed: "+JSON.stringify(result.body));
  return result.body.access_token;
}

function httpsPost(hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body==="string" ? body : JSON.stringify(body);
    const req  = https.request({
      hostname, path:reqPath, method:"POST",
      headers:{...headers,"Content-Length":Buffer.byteLength(data)}
    }, res => {
      const chunks=[];
      res.on("data",c=>chunks.push(c));
      res.on("end",()=>{
        const raw=Buffer.concat(chunks).toString();
        try{resolve({body:JSON.parse(raw),status:res.statusCode});}
        catch{resolve({body:raw,status:res.statusCode});}
      });
    });
    req.on("error",reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║   PhotoMatch — SKU Pre-loader        ║");
  console.log("╚══════════════════════════════════════╝\n");

  if (CONFIG.GOOGLE_SHEET_ID.includes("PASTE")) {
    console.error("❌ Fill in GOOGLE_SHEET_ID"); process.exit(1);
  }
  if (CONFIG.GOOGLE_SERVICE_ACCT.includes("PASTE")) {
    console.error("❌ Fill in GOOGLE_SERVICE_ACCT"); process.exit(1);
  }

  console.log("Getting Google token...");
  const token = await getGoogleToken();

  // First add header row
  console.log("Adding header row...");
  await httpsPost("sheets.googleapis.com",
    `/v4/spreadsheets/${CONFIG.GOOGLE_SHEET_ID}/values/${encodeURIComponent("Sheet1!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    { values:[["Date","Time","SKU","Vendor","Category","Color","Type","Processed By","Shipment","Dropbox Path","Photo Name"]] }
  );

  // Load all existing SKUs in batches
  console.log(`Loading ${EXISTING_SKUS.length} existing SKU records...`);
  const batchSize = 50;
  for (let i=0; i<EXISTING_SKUS.length; i+=batchSize) {
    const batch = EXISTING_SKUS.slice(i, i+batchSize);
    await httpsPost("sheets.googleapis.com",
      `/v4/spreadsheets/${CONFIG.GOOGLE_SHEET_ID}/values/${encodeURIComponent("Sheet1!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
      { values: batch }
    );
    process.stdout.write(`\r  Loaded ${Math.min(i+batchSize, EXISTING_SKUS.length)}/${EXISTING_SKUS.length}...`);
  }

  console.log("\n\n✅ Done! Google Sheet A now has all starting SKU numbers.");
  console.log("The app will now generate correct next numbers for each vendor+category.");
}

main().catch(e => { console.error("\n❌ Error:", e.message); process.exit(1); });