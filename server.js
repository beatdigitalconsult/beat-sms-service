// =====================================================================
// BEAT SMS — Hosted ID Card & Cloud Backup Service
// Product:  BEAT SMS (School & Training Institution Management System)
// Made by:  Beat Digital Consult  ("Your Vision, Our Priority")
//
// This is the small, always-online companion service for BEAT SMS's
// Digital ID Card feature. It gives every student/staff ID card a
// permanent public verification link — scanning the QR code (or
// opening the link) always lands here, so anyone checking a card at
// a gate, exam hall, or staff room sees a live, up-to-date page, not
// just raw text. It also stores an optional full cloud backup of
// each school's data, keyed by that school's BEAT SMS license key.
//
// Exactly like the BMS hosting-service, this process is stateless
// and safe to redeploy at any time as long as MONGODB_URI is set —
// see README-DEPLOY.md for the 5-minute MongoDB Atlas setup.
// =====================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();

// Render/Railway/Fly (and virtually every PaaS) terminate TLS at a proxy
// in front of this app and forward the request as plain HTTP internally.
// Without this line, req.protocol always reports "http" — even for a
// visitor who came in over https — which would produce broken
// "http://..." links on every ID card's public page.
app.set('trust proxy', 1);
app.use(express.json({ limit: '6mb' }));

// ---------------------------------------------------------------
// CORS — REQUIRED so the BEAT SMS desktop app (running from a
// file:// or localhost page) is allowed to call this API from the
// browser. Without this, every publish/backup request is silently
// blocked before it reaches this server.
// ---------------------------------------------------------------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-school-key, x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------
// BASIC SECURITY HEADERS
// ---------------------------------------------------------------
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ---------------------------------------------------------------
// RATE LIMITING (hand-rolled in-memory sliding window — good enough
// for a single-instance deploy on Render/Railway/Fly's free tiers)
// ---------------------------------------------------------------
function makeRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    if (arr.length > max) {
      return res.status(429).json({ ok: false, error: 'Too many requests — please slow down and try again shortly.' });
    }
    next();
  };
}
const publicLimiter = makeRateLimiter({ windowMs: 60 * 1000, max: 120 });
app.use(publicLimiter);

// ---------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const BRAND = { product: 'BEAT SMS', company: 'Beat Digital Consult', site: 'https://beatdigitalconsult.com' };

// ---------------------------------------------------------------
// STORAGE — MongoDB Atlas if configured, local JSON file otherwise.
// Same pattern as beat-bms's hosting-service: without MONGODB_URI
// this still runs fine for local testing, but nothing survives a
// restart on a host with an ephemeral filesystem (e.g. Render free
// tier). See README-DEPLOY.md → "Making data permanent".
// ---------------------------------------------------------------
let mongoCollection = null;

async function initMongo() {
  if (!MONGODB_URI) {
    console.warn('\n⚠️  MONGODB_URI is not set — using local file storage only.');
    console.warn('   ID cards and backups will be LOST on the next restart/redeploy.');
    console.warn('   See README-DEPLOY.md → "Making data permanent" to fix this.\n');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('beat_sms');
    mongoCollection = db.collection('service_state');
    console.log('✅ Connected to MongoDB — ID cards and backups will now persist permanently.');
  } catch (e) {
    console.error('\n⚠️  Could not connect to MongoDB:', e.message);
    console.error('   Falling back to local file storage (not persistent on most hosts).');
    console.error('   Double-check MONGODB_URI and that Atlas Network Access allows 0.0.0.0/0.\n');
    mongoCollection = null;
  }
}

async function loadDB() {
  if (mongoCollection) {
    try {
      const doc = await mongoCollection.findOne({ _id: 'db' });
      if (doc) return { idcards: doc.idcards || {}, backups: doc.backups || {} };
      return { idcards: {}, backups: {} };
    } catch (e) {
      console.error('MongoDB load error, falling back to local file for this boot:', e.message);
    }
  }
  try {
    if (!fs.existsSync(DB_PATH)) return { idcards: {}, backups: {} };
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '{}');
    return { idcards: parsed.idcards || {}, backups: parsed.backups || {} };
  } catch (e) {
    console.error('DB load error, starting with an empty store:', e.message);
    return { idcards: {}, backups: {} };
  }
}

let DB = { idcards: {}, backups: {} };
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2));
    } catch (e) {
      console.error('DB file save error:', e.message);
    }
    if (mongoCollection) {
      try {
        await mongoCollection.updateOne(
          { _id: 'db' },
          { $set: { idcards: DB.idcards, backups: DB.backups, updatedAt: new Date() } },
          { upsert: true }
        );
      } catch (e) {
        console.error('MongoDB save error (data is still safe in the local file for now):', e.message);
      }
    }
  }, 150);
}

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
function esc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function newId(prefix) { return prefix + '_' + crypto.randomBytes(8).toString('hex'); }

const FIELD_LIMITS = { name: 150, idNo: 60, role: 100, sub: 100, schoolName: 150 };
function validateCard(c) {
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    if (c[field] != null && String(c[field]).length > max) return `Field "${field}" is too long.`;
  }
  if (c.type !== 'student' && c.type !== 'staff') return 'Invalid card type.';
  if (c.photo && c.photo.length > 900000) return 'Photo is too large for cloud publishing (try a smaller image).';
  return null;
}

// ---------------------------------------------------------------
// PUBLIC: service health / info page
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${BRAND.product} — ID Card Service</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Segoe UI,Arial,sans-serif;background:#0d0d63;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
  .box{max-width:460px}h1{margin:0 0 6px;font-size:22px}p{opacity:.85;font-size:14px;line-height:1.6}a{color:#ff6b00;font-weight:700;text-decoration:none}</style>
  </head><body><div class="box">
  <h1>🪪 ${BRAND.product}</h1>
  <p>Digital ID Card verification &amp; cloud backup service — online and ready.<br>Every scanned ID card resolves to a live public page here.</p>
  <p>Built &amp; owned by <a href="${BRAND.site}">${BRAND.company}</a></p>
  </div></body></html>`);
});

app.get('/healthz', (req, res) => res.json({
  ok: true, product: BRAND.product, company: BRAND.company,
  idcards: Object.keys(DB.idcards).length,
  backups: Object.keys(DB.backups).length,
  storage: mongoCollection ? 'mongodb' : 'file-only (not persistent on most free hosting tiers)'
}));

// ---------------------------------------------------------------
// ID CARD PUBLISH / FETCH  (called by the BEAT SMS desktop app)
// ---------------------------------------------------------------
app.post('/api/idcards', (req, res) => {
  const card = req.body || {};
  const err = validateCard(card);
  if (err) return res.status(400).json({ ok: false, error: err });

  // A card can only be updated by the school key that owns it.
  if (card.id && DB.idcards[card.id] && DB.idcards[card.id].schoolKey !== card.schoolKey) {
    return res.status(403).json({ ok: false, error: 'This ID card belongs to a different school license.' });
  }
  if (!card.id) card.id = newId(card.type === 'staff' ? 'stf' : 'stu');
  DB.idcards[card.id] = { ...card, publishedAt: new Date().toISOString() };
  saveDB();
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, id: card.id, url: `${base}/id/${card.id}` });
});

app.delete('/api/idcards/:id', (req, res) => {
  const schoolKey = req.get('x-school-key') || '';
  const c = DB.idcards[req.params.id];
  if (c && c.schoolKey === schoolKey) { delete DB.idcards[req.params.id]; saveDB(); }
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// PUBLIC VERIFICATION PAGE — opens when anyone scans a card's QR
// ---------------------------------------------------------------
app.get('/id/:id', (req, res) => {
  const c = DB.idcards[req.params.id];
  if (!c) return res.status(404).send(notFoundPage());

  const expired = c.expiresAt && new Date(c.expiresAt) < new Date();
  const roleLine = c.type === 'staff'
    ? `${esc(c.role || 'Staff')}${c.sub ? ' · ' + esc(c.sub) : ''}`
    : `${esc(c.role || 'Student')}${c.sub ? ' · ' + esc(c.sub) : ''}`;

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>${esc(c.name)} — ${esc(c.schoolName)} ID Verification</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:Segoe UI,Arial,sans-serif;background:#f2f2f8;margin:0;padding:24px;display:flex;justify-content:center;}
    .card{max-width:380px;width:100%;background:#fff;border-radius:18px;box-shadow:0 14px 34px rgba(10,7,50,.14);overflow:hidden;}
    .head{background:${c.type === 'staff' ? 'linear-gradient(160deg,#ff6b00,#c2560f)' : 'linear-gradient(160deg,#0d0d63,#050535)'};color:#fff;padding:22px 20px;text-align:center;}
    .head img.logo{width:40px;height:40px;border-radius:10px;object-fit:cover;background:#fff;margin-bottom:8px;}
    .head .school{font-weight:800;font-size:15px;}
    .head .type{font-size:11px;opacity:.85;text-transform:uppercase;letter-spacing:1px;margin-top:2px;}
    .body{padding:24px 20px;text-align:center;}
    .photo{width:96px;height:96px;border-radius:50%;object-fit:cover;border:3px solid #eee;margin:-56px auto 14px;background:#eee;display:block;}
    .name{font-size:19px;font-weight:800;color:#0d0d63;}
    .role{font-size:13px;color:#666;margin-top:2px;}
    .idno{display:inline-block;margin-top:14px;font-family:'Courier New',monospace;background:#f2f2f8;color:#0d0d63;padding:6px 14px;border-radius:8px;font-size:13px;font-weight:700;letter-spacing:.5px;}
    .status{margin-top:18px;padding:10px 14px;border-radius:10px;font-size:13px;font-weight:700;}
    .status.ok{background:#e6f7ee;color:#0a8a4a;}
    .status.bad{background:#fdeaea;color:#c62828;}
    .foot{font-size:11px;color:#999;padding:14px 20px 20px;text-align:center;}
  </style></head><body>
  <div class="card">
    <div class="head">
      ${c.schoolLogo ? `<img class="logo" src="${esc(c.schoolLogo)}">` : ''}
      <div class="school">${esc(c.schoolName)}</div>
      <div class="type">${c.type === 'staff' ? 'Staff Identity Card' : 'Student Identity Card'}</div>
    </div>
    <div class="body">
      <img class="photo" src="${c.photo ? esc(c.photo) : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23eee%22/%3E%3C/svg%3E'}">
      <div class="name">${esc(c.name)}</div>
      <div class="role">${roleLine}</div>
      <div class="idno">ID: ${esc(c.idNo)}</div>
      <div class="status ${expired ? 'bad' : 'ok'}">${expired ? '⚠️ License expired — verify with the school office' : '✅ Verified — active ' + (c.type === 'staff' ? 'staff member' : 'student')}</div>
    </div>
    <div class="foot">Issued by ${esc(c.schoolName)} · Powered by ${BRAND.company}</div>
  </div>
  </body></html>`);
});

function notFoundPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Card not found</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Segoe UI,Arial,sans-serif;background:#0d0d63;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}</style>
  </head><body><div><h2>⚠️ ID card not found</h2><p>This link is invalid, or the card hasn't been published to the cloud yet.</p></div></body></html>`;
}

// ---------------------------------------------------------------
// FULL SCHOOL DATA BACKUP — keyed by the school's BEAT SMS license
// key. One backup slot per school; each call overwrites the last.
// ---------------------------------------------------------------
app.post('/api/backup/:schoolKey', (req, res) => {
  const key = req.params.schoolKey;
  const payload = req.body || {};
  if (!payload.data) return res.status(400).json({ ok: false, error: 'Missing "data".' });
  DB.backups[key] = { school: payload.school || {}, data: payload.data, savedAt: new Date().toISOString() };
  saveDB();
  res.json({ ok: true, savedAt: DB.backups[key].savedAt });
});

app.get('/api/backup/:schoolKey', (req, res) => {
  const b = DB.backups[req.params.schoolKey];
  if (!b) return res.status(404).json({ ok: false, error: 'No backup found for this license key yet.' });
  res.json({ ok: true, ...b });
});

// ---------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------
async function boot() {
  await initMongo();
  DB = await loadDB();
  app.listen(PORT, () => {
    console.log(`${BRAND.product} hosting-service listening on port ${PORT}`);
    console.log(`Storage: ${mongoCollection ? 'MongoDB Atlas (persistent)' : 'local file (NOT persistent on most hosts)'}`);
  });
}
boot();
