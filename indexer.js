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
  DROPBOX_TOKEN:  "PASTE_YOUR_DROPBOX_TOKEN_HERE",
  ANTHROPIC_KEY:  "PASTE_YOUR_ANTHROPIC_KEY_HERE",
  DROPBOX_FOLDER: "/_Cathy's Order",
  INDEX_FILE:     "./photo-index.json",
  BATCH_SIZE:     3,
  BATCH_DELAY:    2000,
};