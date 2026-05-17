/**
 * PhotoMatch Indexer
 * ══════════════════════════════════════════════════════
 * Scans all photos in your Dropbox folder, tags them
 * with Claude AI, and saves photo-index.json
 * Run once overnight: node indexer.js
 * ══════════════════════════════════════════════════════
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ─── CONFIG — fill these in ────────────────────────────────────────────────
const CONFIG = {
  DROPBOX_TOKEN:  "sl.u.AGflvpr2VQPAeNd046Z-XdRA5iLgUdipE7iFAJRWNzq5Tb_fqX3es3mEOVaRtQ5DEK7S3wz9U8BbhmGPdyvQLC7WB_BZSej6HnD2WR5C6RIYVt-IPOJVS-ahXWHrx0iKJ-VWkEY9G6sxfzE9VZLDvV8TSWMoRPwL16erJr5lnV3hKFxpsrSB-pBet_k56R--2bwU9r9efHSrF74SP65FPyrYke8FeWXLKZdC_WvZu1bKYBFqBgJuZoQh0sckefdNUWXY6AcO4Yrzi5ITGKy2-Fgg4YhONLsr3m3C8YzwfWJXShv-WdggAgD1S32nujW5NHXiz8k2zXsle0lMKfWCpXyPRtNwjJp4cTNVfhgeVZP2aL5WZX_Qb_evX1dvUn4Ga94LS8zULTWQcFwx5AIlJ7gzEJp7raanz4s4UpbeiacO1CvgmOOba9NcxLLzdoHuluxVDeVJQ6UOpys6p66WNXZaKhi12kWqCutzHVwasGMz_94uTmzjzzmFtbcYfqW7NHlmY1YgEuCkjcgiQW56WWo0sMrNk_lOX7q4XPL3e5qcADErWrxh9PgaVxxtqOgr_gkdj1b2FyQU40w_c9XvJwd-Jix7HF6jl3shdnFk1zvi6AAnQLDLe5cZEBbhFl0R5-tpmj9yARsXbz61hxRkwr-cvCydQn-l3uDgJq29SXQqk99xF-m0V7I5ykM9pBt6EhDZ25SA5UtCIgD-gofvukW3UnVjSUTxJYwvjnwuiD5CjQ8HN8w6ZNchejfZcKYfXSfmVVs4_Gy5ywMAbZArOh1cK_YdwaAV1mQRVmlkmTmiBVovcbYAqGHvZa7Fyi0GCa2XPWYnfT3GMEPCZZkgxVK_2wc9uH0K_YZZG1DRuT0UGQxTXTxCOMESS00Ls9V6LH3Ba6WvquUHkVMAEjtp5sU6f8wpoFIvOfL9UfU-UzAiRCHxeTLp1Xa6iAg4Ug7FY_LGud4IJMdyKKdNpj4n3m_Ubo1lDrBCAOn604E9IJT1DRtoN3eZFZJtyZurTYPLWiWw33vruH-1O-c8b7RN9wL84RZwS6YN2lWxNcpiRCvItbmZpaWMiPMLwweEqHfRZJqssGCfkLDXUIPVkQZpdmTRhMarcUcSfQLpQ5ozug48q_HeiE2umO1s6KVBf9VzEpJI72fAIqWctfiP9Hi7skzKXaNaA60O2EH-t0HJvJf6Pp6Wyt5qe0aR-9LhpgRbz50hSvbJHwiFRYT8j8a8rqZ_pi5kdvcs9gr3dWPGRxrO7Ug_DedlG8hlw7ksRpzB0WxLDPAMr2mkC_WcdIWobqupHRAObcR2XxqMxVft8bIafg",   // your sl. token
  ANTHROPIC_KEY:  "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",   // your sk-ant- key
  DROPBOX_FOLDER: "/_Cathy's Order",                // Dropbox app folder path
  INDEX_FILE:     "./photo-index.json",              // saved locally
  BATCH_SIZE:     3,                                 // photos per batch
  BATCH_DELAY:    2000,                              // ms between batches
};

// ─── Helpers ───────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function httpsPostBuffer(hostname, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, method: "POST", headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), status: res.statusCode }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ─── List all photos in Dropbox folder ────────────────────────────────────
async function listAllPhotos(folderPath) {
  const imageExts = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
  const photos    = [];
  let   cursor    = null;
  let   hasMore   = true;

  console.log(`\nScanning Dropbox folder: ${folderPath}`);

  while (hasMore) {
    let result;
    if (!cursor) {
      result = await httpsPost("api.dropboxapi.com", "/2/files/list_folder", {
        "Authorization": `Bearer ${CONFIG.DROPBOX_TOKEN}`,
        "Content-Type":  "application/json"
      }, { path: folderPath, recursive: true, limit: 2000 });
    } else {
      result = await httpsPost("api.dropboxapi.com", "/2/files/list_folder/continue", {
        "Authorization": `Bearer ${CONFIG.DROPBOX_TOKEN}`,
        "Content-Type":  "application/json"
      }, { cursor });
    }

    if (result.status !== 200) {
      console.error("Error listing folder:", result.body);
      break;
    }

    const entries = result.body.entries || [];
    for (const entry of entries) {
      if (entry[".tag"] === "file") {
        const ext = path.extname(entry.name).toLowerCase();
        if (imageExts.includes(ext)) {
          photos.push({
            id:       entry.id,
            name:     entry.name,
            filename: path.basename(entry.name, ext),
            path:     entry.path_lower,
            size:     entry.size,
            modified: entry.server_modified
          });
        }
      }
    }

    cursor  = result.body.cursor;
    hasMore = result.body.has_more;
    process.stdout.write(`\r  Found ${photos.length} photos so far...`);
  }

  console.log(`\n  Total photos found: ${photos.length}`);
  return photos;
}

// ─── Get thumbnail from Dropbox ────────────────────────────────────────────
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

// ─── Tag photo with Claude ─────────────────────────────────────────────────
async function tagPhoto(base64Image) {
  const result = await httpsPost("api.anthropic.com", "/v1/messages", {
    "x-api-key":         CONFIG.ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
    "Content-Type":      "application/json"
  }, {
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `You are a product photo tagger for a jewelry/accessory inventory system.
Respond ONLY with a JSON object, no markdown:
{
  "category": "<product category e.g. necklace, ring, bracelet, earring>",
  "type": "<specific product type>",
  "colors": ["<primary color>", "<secondary color if any>"],
  "materials": ["<material e.g. gold, silver, rhodium, crystal>"],
  "style": "<style descriptor e.g. delicate, chunky, minimalist>",
  "tags": ["<6-10 short descriptive tags for similarity matching>"]
}`,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Image } },
        { type: "text",  text: "Tag this product photo for inventory search." }
      ]
    }]
  });

  const text = result.body?.content?.find(b => b.type === "text")?.text || "{}";
  try { return JSON.parse(text.replace(/```json|```/g, "").trim()); }
  catch { return { category: "", type: "", colors: [], materials: [], style: "", tags: [] }; }
}

// ─── Load existing index ───────────────────────────────────────────────────
function loadIndex() {
  if (fs.existsSync(CONFIG.INDEX_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG.INDEX_FILE, "utf8"));
      console.log(`\nResuming from existing index — ${Object.keys(data.photos||{}).length} photos already indexed`);
      return data;
    } catch(e) {}
  }
  return { photos: {}, lastUpdated: null, version: "1.0" };
}

// ─── Save index ────────────────────────────────────────────────────────────
function saveIndex(index) {
  index.lastUpdated = new Date().toISOString();
  fs.writeFileSync(CONFIG.INDEX_FILE, JSON.stringify(index, null, 2));
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     PhotoMatch Indexer Starting      ║");
  console.log("╚══════════════════════════════════════╝");

  if (!CONFIG.DROPBOX_TOKEN || CONFIG.DROPBOX_TOKEN.includes("PASTE")) {
    console.error("\n❌ Please fill in your DROPBOX_TOKEN in the CONFIG section at the top of this file");
    process.exit(1);
  }
  if (!CONFIG.ANTHROPIC_KEY || CONFIG.ANTHROPIC_KEY.includes("PASTE")) {
    console.error("\n❌ Please fill in your ANTHROPIC_KEY in the CONFIG section at the top of this file");
    process.exit(1);
  }

  // Load existing index
  const index  = loadIndex();
  const photos = await listAllPhotos(CONFIG.DROPBOX_FOLDER);

  // Filter to only new/unindexed photos
  const toIndex = photos.filter(p => !index.photos[p.id]);
  console.log(`\n${toIndex.length} new photos to index (${photos.length - toIndex.length} already done)`);

  if (toIndex.length === 0) {
    console.log("\n✅ All photos already indexed! Saving...");
    saveIndex(index);
    console.log(`\nIndex saved to: ${CONFIG.INDEX_FILE}`);
    console.log("Copy this file to your Dropbox PhotoMatch folder.");
    return;
  }

  // Process in batches
  let done    = 0;
  let errors  = 0;
  const start = Date.now();

  for (let i = 0; i < toIndex.length; i += CONFIG.BATCH_SIZE) {
    const batch = toIndex.slice(i, i + CONFIG.BATCH_SIZE);

    await Promise.all(batch.map(async photo => {
      try {
        const thumb = await getThumbnail(photo.path);
        if (!thumb) { errors++; return; }

        const tags = await tagPhoto(thumb);
        index.photos[photo.id] = { ...photo, tags, indexed: new Date().toISOString() };
        done++;
      } catch(e) {
        errors++;
        console.error(`\n  Error on ${photo.name}: ${e.message}`);
      }
    }));

    // Save progress after every batch
    saveIndex(index);

    // Progress display
    const pct     = Math.round(((i + batch.length) / toIndex.length) * 100);
    const elapsed = Math.round((Date.now() - start) / 1000);
    const rate    = done / (elapsed || 1);
    const eta     = Math.round((toIndex.length - done) / (rate || 1));
    const etaStr  = eta > 3600 ? `${Math.round(eta/3600)}h ${Math.round((eta%3600)/60)}m` : `${Math.round(eta/60)}m`;

    process.stdout.write(`\r  Progress: ${pct}% (${done}/${toIndex.length}) | Errors: ${errors} | ETA: ${etaStr}    `);

    if (i + CONFIG.BATCH_SIZE < toIndex.length) await sleep(CONFIG.BATCH_DELAY);
  }

  console.log(`\n\n✅ Indexing complete!`);
  console.log(`   Indexed: ${done} photos`);
  console.log(`   Errors:  ${errors} photos`);
  console.log(`   Total:   ${Object.keys(index.photos).length} photos in index`);
  console.log(`\n📁 Index saved to: ${CONFIG.INDEX_FILE}`);
  console.log(`\nNext step: Copy photo-index.json to your Dropbox _Cathy's Order folder`);
}

main().catch(e => {
  console.error("\n❌ Fatal error:", e.message);
  process.exit(1);
});