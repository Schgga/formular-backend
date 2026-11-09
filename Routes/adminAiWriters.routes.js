import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';
import { PROVIDERS, MODEL_NAME_RE, testWriter, listModels, AiError } from '../Services/ai/aiProviders.js';
import { sealKey, openKey } from '../Services/ai/writers.js';
import { makeLimiter } from '../Services/studio/walletService.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { listVoices, cloneVoice, VoiceError } from '../Services/video/elevenlabs.js';
import { convertAudio, MediaError } from '../Services/video/mediaStore.js';
import { runFfmpeg, mediaDuration } from '../Services/video/ffmpeg.js';
import { cleanStyle, cleanDirection, FONTS, PACES, GRADES, HEADLINE_POS, END_CARDS, MUSIC_LEVELS } from '../Services/ai/videoLooks.js';

// =====================================================================
// SUPER ADMIN — AI WRITERS   (mounted at /api/admin/ai-writers)
//   GET    /                 all writers + usage + ratings (keys are NEVER sent back)
//   GET    /providers        the services you can choose
//   POST   /                 add a writer
//   PUT    /:id              edit (send apiKey only when replacing it)
//   DELETE /:id
//   POST   /:id/test         "Test connection"
//   GET    /feedback         latest user comments and ratings
//   POST   /models            { provider, apiKey? | writerId? } → model list for "Browse models"
//   GET    /engines | PUT /engines/:key       video engines + prices
//   GET    /voices/elevenlabs                  voices in your ElevenLabs account (+ which are on)
//   PUT    /voices                             save the voices users can choose
//   GET    /music | POST /music | PUT /music/:id | DELETE /music/:id | GET /music/:id/file
//   POST   /voices/clone                        copy a voice (yours, or with the speaker's permission)
//   GET|PUT /voice-clone-settings               let users copy their own voice: on/off + price
// Permission key: 'ai-writers'
// =====================================================================

const router = Router();
const guard = [requireAuth, requirePermission('ai-writers')];
const testLimiter = makeLimiter(10, 60 * 1000);

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const cents = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : null;
};

const PUBLIC_COLS = `w.id, w.display_name, w.description, w.provider, w.model_name, w.key_last4,
  (w.encrypted_key IS NOT NULL) AS has_key, w.price_usd_cents, w.premium_price_usd_cents, w.max_output_tokens,
  w.is_active, w.is_default, w.sort_order, w.last_test_ok, w.last_test_at, w.last_test_message, w.created_at, w.updated_at`;

function readBody(b, { creating }) {
  const out = {};
  const errors = [];
  if (creating || b.displayName !== undefined) {
    out.display_name = clean(b.displayName, 60);
    if (!out.display_name) errors.push('Display name is required');
  }
  if (b.description !== undefined) out.description = clean(b.description, 240) || null;
  if (creating || b.provider !== undefined) {
    out.provider = String(b.provider || '');
    if (!PROVIDERS[out.provider]) errors.push('Choose a service');
  }
  if (creating || b.modelName !== undefined) {
    out.model_name = String(b.modelName || '').trim();
    if (!MODEL_NAME_RE.test(out.model_name)) errors.push('Model name looks wrong (letters, numbers, dots, dashes only)');
  }
  if (b.priceCents !== undefined) { out.price_usd_cents = cents(b.priceCents); if (out.price_usd_cents === null) errors.push('Price is not valid'); }
  if (b.premiumPriceCents !== undefined) { out.premium_price_usd_cents = cents(b.premiumPriceCents); if (out.premium_price_usd_cents === null) errors.push('Premium price is not valid'); }
  if (b.maxOutputTokens !== undefined) {
    const t = Math.round(Number(b.maxOutputTokens));
    if (!Number.isFinite(t) || t < 1000 || t > 32000) errors.push('Max length must be between 1000 and 32000');
    else out.max_output_tokens = t;
  }
  if (b.isActive !== undefined) out.is_active = Boolean(b.isActive);
  if (b.isDefault !== undefined) out.is_default = Boolean(b.isDefault);
  if (b.sortOrder !== undefined) out.sort_order = Math.max(0, Math.min(999, Math.round(Number(b.sortOrder) || 0)));
  if (b.apiKey !== undefined && String(b.apiKey).trim()) {
    const k = String(b.apiKey).trim();
    if (k.length < 20 || k.length > 400 || /\s/.test(k)) errors.push('That API key does not look right');
    else {
      const sealed = sealKey(k);
      out.encrypted_key = sealed.encryptedValue;
      out.key_iv = sealed.iv;
      out.key_last4 = sealed.last4;
      out.last_test_ok = null;
    }
  }
  return { out, errors };
}

router.get('/providers', ...guard, (req, res) => {
  res.json({ success: true, providers: Object.entries(PROVIDERS).map(([value, p]) => ({ value, label: p.label, hint: p.hint })) });
});

// ---------------- "Browse models" ----------------
// The key typed in the form (or the saved key of the writer being edited) is used only
// for this one request and never sent back.
const modelsLimiter = makeLimiter(20, 60 * 1000);
router.post('/models', ...guard, async (req, res) => {
  if (!modelsLimiter(String(req.user.id))) return res.status(429).json({ success: false, error: 'Please wait a moment.' });
  const provider = String(req.body?.provider || '');
  if (!PROVIDERS[provider]) return res.status(400).json({ success: false, error: 'Choose a service' });
  try {
    let apiKey = String(req.body?.apiKey || '').trim();
    if (!apiKey && /^\d{1,9}$/.test(String(req.body?.writerId || ''))) {
      const w = (await pool.query('SELECT * FROM ai_writers WHERE id = $1 AND provider = $2', [req.body.writerId, provider])).rows[0];
      if (w?.encrypted_key) apiKey = openKey(w);
    }
    if (apiKey && (apiKey.length > 400 || /\s/.test(apiKey))) return res.status(400).json({ success: false, error: 'That API key does not look right' });
    const models = await listModels({ provider, apiKey });
    res.json({ success: true, models });
  } catch (err) {
    res.status(502).json({ success: false, error: err instanceof AiError ? err.message : 'Could not load the model list' });
  }
});

// ---------------- Pro Video voices (ElevenLabs) ----------------
// Defined before "/:id" so "/voices" is not read as a writer id.
router.get('/voices/elevenlabs', ...guard, async (req, res) => {
  let saved = [];
  try {
    saved = (await pool.query('SELECT * FROM ai_voices ORDER BY sort_order, display_name')).rows;
  } catch {
    return res.status(500).json({ success: false, error: 'Run the Pro Video part of formular-video-maker.sql first.' });
  }
  let account = [];
  let accountError = '';
  try { account = await listVoices(); } catch (err) { accountError = err instanceof VoiceError ? err.message : 'Could not reach ElevenLabs.'; }
  const byId = new Map(saved.map((v) => [v.voice_id, v]));
  const voices = account.map((v) => {
    const s = byId.get(v.voiceId);
    return {
      voiceId: v.voiceId, name: v.name, category: v.category, description: v.description, labels: v.labels,
      languages: v.languages, previewUrl: v.previewUrl,
      displayName: s?.display_name || v.name, userDescription: s?.description || '', isActive: Boolean(s?.is_active), sortOrder: s?.sort_order ?? 0, saved: Boolean(s)
    };
  });
  // Saved voices that are no longer in the account
  for (const s of saved) {
    if (!account.some((v) => v.voiceId === s.voice_id)) {
      voices.push({ voiceId: s.voice_id, name: s.display_name, category: 'missing', description: '', labels: {}, languages: [], previewUrl: s.preview_url || '',
        displayName: s.display_name, userDescription: s.description || '', isActive: s.is_active, sortOrder: s.sort_order, saved: true, missing: !accountError });
    }
  }
  res.json({ success: true, voices, accountError });
});

router.put('/voices', ...guard, async (req, res) => {
  const list = Array.isArray(req.body?.voices) ? req.body.voices.slice(0, 60) : null;
  if (!list) return res.status(400).json({ success: false, error: 'Nothing to save' });
  const rows = [];
  for (const v of list) {
    const id = String(v?.voiceId || '');
    if (!/^[A-Za-z0-9]{8,40}$/.test(id)) return res.status(400).json({ success: false, error: 'A voice id is not valid' });
    const name = clean(v.displayName, 60);
    if (!name) return res.status(400).json({ success: false, error: 'Every voice needs a name' });
    const preview = /^https:\/\/[^\s"'<>]{5,480}$/.test(String(v.previewUrl || '')) ? String(v.previewUrl) : null;
    rows.push([id, name, clean(v.userDescription, 200) || null, preview, Boolean(v.isActive), Math.max(0, Math.min(999, Math.round(Number(v.sortOrder) || 0)))]);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO ai_voices (voice_id, display_name, description, preview_url, is_active, sort_order) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (voice_id) DO UPDATE SET display_name = $2, description = $3, preview_url = COALESCE($4, ai_voices.preview_url),
           is_active = $5, sort_order = $6, updated_at = NOW()`, r);
    }
    await client.query('COMMIT');
    res.json({ success: true, active: rows.filter((r) => r[4]).length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save the voices' });
  } finally {
    client.release();
  }
});

// Make an AI copy of YOUR voice (or a speaker who gave permission) and add it to the voice list
router.post('/voices/clone', ...guard, (req, res) => {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 3 } }).array('audio', 3)(req, res, async (upErr) => {
    const temps = [];
    try {
      if (upErr) return res.status(400).json({ success: false, error: upErr.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 15 MB or less.' : 'Upload failed' });
      if (req.body?.consent !== 'yes') return res.status(400).json({ success: false, error: 'Please confirm this is your voice or you have the speaker\'s permission.' });
      const name = clean(req.body?.name, 60);
      if (!name) return res.status(400).json({ success: false, error: 'Give the voice a name' });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ success: false, error: 'Add a recording' });
      let total = 0;
      const ready = [];
      for (const f of files) {
        const c = await convertAudio(f.buffer, { mp3: true, out: path.join(os.tmpdir(), `fma-${crypto.randomBytes(8).toString('hex')}.mp3`), maxSeconds: 300, minSeconds: 3 });
        temps.push(c.file);
        total += c.seconds;
        ready.push({ buffer: fs.readFileSync(c.file), filename: `sample${ready.length + 1}.mp3` });
      }
      if (total < 30) return res.status(400).json({ success: false, error: `At least 30 seconds of speech is needed (got ${Math.round(total)}). 1–3 minutes gives the best copy.` });
      const voiceId = await cloneVoice({ name, files: ready, description: clean(req.body?.description, 200) });
      await pool.query(
        `INSERT INTO ai_voices (voice_id, display_name, description, is_active, sort_order) VALUES ($1, $2, $3, true, 0)
         ON CONFLICT (voice_id) DO UPDATE SET display_name = $2, description = $3, is_active = true, updated_at = NOW()`,
        [voiceId, name, clean(req.body?.description, 200) || null]);
      res.json({ success: true, voiceId });
    } catch (err) {
      const msg = err instanceof MediaError || err instanceof VoiceError ? err.message : 'Could not copy the voice';
      if (!(err instanceof MediaError)) console.error('Admin voice copy failed:', err?.message);
      res.status(err instanceof MediaError ? 400 : 502).json({ success: false, error: msg });
    } finally {
      for (const t of temps) fs.rm(t, { force: true }, () => {});
    }
  });
});

// Can users make a copy of their own voice? On/off + price
router.get('/voice-clone-settings', ...guard, async (req, res) => {
  try {
    const v = (await pool.query(`SELECT value FROM video_settings WHERE key = 'voice_clone'`)).rows[0]?.value || {};
    const n = (await pool.query('SELECT COUNT(*)::int AS n FROM user_voices')).rows[0].n;
    res.json({ success: true, settings: { enabled: Boolean(v.enabled), priceCents: Number(v.priceCents) || 0, premiumPriceCents: Number(v.premiumPriceCents) || 0 }, userVoices: n });
  } catch {
    res.status(500).json({ success: false, error: 'Run the latest formular-video-maker.sql first.' });
  }
});
router.put('/voice-clone-settings', ...guard, async (req, res) => {
  const b = req.body || {};
  const price = cents(b.priceCents);
  const premium = cents(b.premiumPriceCents);
  if (price === null || premium === null) return res.status(400).json({ success: false, error: 'Prices are not valid' });
  try {
    await pool.query(
      `INSERT INTO video_settings (key, value) VALUES ('voice_clone', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify({ enabled: Boolean(b.enabled), priceCents: price, premiumPriceCents: premium })]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

// ---------------- Pro Video background music ----------------
// Upload only music you have the right to use in adverts (royalty-free / licensed).
const MUSIC_DIR = () => path.resolve(process.env.VIDEO_MUSIC_DIR || 'storage/music');
const MOODS = ['calm', 'upbeat', 'luxury', 'corporate', 'emotional', 'energetic', 'fun'];
const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `fmm-${crypto.randomBytes(12).toString('hex')}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }
});
function audioKind(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(12);
  fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  if (b.slice(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (b.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WAVE') return 'wav';
  return null;
}

router.get('/music', ...guard, async (req, res) => {
  try {
    let r;
    try { r = await pool.query('SELECT id, title, mood, is_active, created_at FROM video_music WHERE user_id IS NULL ORDER BY created_at DESC'); } catch { r = await pool.query('SELECT id, title, mood, is_active, created_at FROM video_music ORDER BY created_at DESC'); }
    res.json({ success: true, music: r.rows, moods: MOODS });
  } catch {
    res.status(500).json({ success: false, error: 'Run the Pro Video part of formular-video-maker.sql first.' });
  }
});

router.post('/music', ...guard, (req, res) => {
  musicUpload.single('file')(req, res, async (upErr) => {
    const tmp = req.file?.path;
    const work = tmp ? `${tmp}.m4a` : null;
    const done = () => { for (const f of [tmp, work]) if (f) fs.rm(f, { force: true }, () => {}); };
    try {
      if (upErr) return res.status(400).json({ success: false, error: upErr.code === 'LIMIT_FILE_SIZE' ? 'The music file must be 20 MB or less.' : 'Upload failed' });
      if (!tmp) return res.status(400).json({ success: false, error: 'Choose a music file' });
      const title = clean(req.body?.title, 80);
      const mood = MOODS.includes(req.body?.mood) ? req.body.mood : 'calm';
      if (!title) { done(); return res.status(400).json({ success: false, error: 'Give the track a name' }); }
      if (!audioKind(tmp)) { done(); return res.status(400).json({ success: false, error: 'Use an MP3, M4A or WAV file.' }); }
      // Re-encode: proves it is real audio and gives every track the same format
      const conv = await runFfmpeg(['-loglevel', 'error', '-y', '-i', path.basename(tmp), '-map', '0:a:0', '-vn', '-t', '600', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', path.basename(work)], { cwd: path.dirname(tmp), timeoutMs: 180_000 });
      const secs = conv.ok ? await mediaDuration(path.basename(work), path.dirname(work)) : null;
      if (!conv.ok || !secs || secs < 5) { done(); return res.status(400).json({ success: false, error: 'That file could not be read as music (needs at least 5 seconds of audio).' }); }
      fs.mkdirSync(MUSIC_DIR(), { recursive: true });
      const name = `m-${crypto.randomBytes(8).toString('hex')}.m4a`;
      fs.copyFileSync(work, path.join(MUSIC_DIR(), name));
      done();
      const r = await pool.query('INSERT INTO video_music (title, mood, file) VALUES ($1, $2, $3) RETURNING id, title, mood, is_active, created_at', [title, mood, name]);
      res.json({ success: true, track: r.rows[0] });
    } catch (err) {
      done();
      console.error(err);
      res.status(500).json({ success: false, error: 'Could not save the music' });
    }
  });
});

router.put('/music/:id', ...guard, async (req, res) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).json({ success: false, error: 'Not found' });
    const b = req.body || {};
    const title = b.title !== undefined ? clean(b.title, 80) : null;
    if (b.title !== undefined && !title) return res.status(400).json({ success: false, error: 'Give the track a name' });
    const mood = b.mood !== undefined ? (MOODS.includes(b.mood) ? b.mood : null) : null;
    const r = await pool.query(
      `UPDATE video_music SET title = COALESCE($2, title), mood = COALESCE($3, mood), is_active = COALESCE($4, is_active) WHERE id = $1`,
      [req.params.id, title, mood, b.isActive === undefined ? null : Boolean(b.isActive)]);
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

router.delete('/music/:id', ...guard, async (req, res) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).json({ success: false, error: 'Not found' });
    const r = await pool.query('DELETE FROM video_music WHERE id = $1 RETURNING file', [req.params.id]);
    if (r.rows[0]) fs.rm(path.join(MUSIC_DIR(), path.basename(r.rows[0].file)), { force: true }, () => {});
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

// The admin page fetches this with its login header and plays it from a blob
router.get('/music/:id/file', ...guard, async (req, res) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).end();
    const r = await pool.query('SELECT file FROM video_music WHERE id = $1', [req.params.id]);
    const full = r.rows[0] ? path.join(MUSIC_DIR(), path.basename(r.rows[0].file)) : null;
    if (!full || !fs.existsSync(full)) return res.status(404).end();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(full);
  } catch {
    res.status(500).end();
  }
});

router.get('/', ...guard, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${PUBLIC_COLS},
         COALESCE(s.plans_30d, 0)::int AS plans_30d,
         COALESCE(s.failed_30d, 0)::int AS failed_30d,
         COALESCE(s.revenue_30d, 0)::bigint AS revenue_30d,
         f.avg_rating, COALESCE(f.ratings, 0)::int AS ratings
       FROM ai_writers w
       LEFT JOIN (
         SELECT writer_id, COUNT(*) FILTER (WHERE status = 'done') AS plans_30d,
                COUNT(*) FILTER (WHERE status = 'failed') AS failed_30d,
                SUM(cost_cents) FILTER (WHERE status = 'done' AND NOT refunded) AS revenue_30d
         FROM video_plans WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY writer_id
       ) s ON s.writer_id = w.id
       LEFT JOIN (
         SELECT writer_id, ROUND(AVG(rating)::numeric, 2) AS avg_rating, COUNT(*) AS ratings
         FROM video_plan_feedback GROUP BY writer_id
       ) f ON f.writer_id = w.id
       ORDER BY w.sort_order, w.id`);
    res.json({ success: true, writers: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load AI writers' });
  }
});

async function saveDefault(id, isDefault) {
  if (isDefault) await pool.query('UPDATE ai_writers SET is_default = false WHERE id <> $1', [id]);
}

router.post('/', ...guard, async (req, res) => {
  try {
    const { out, errors } = readBody(req.body || {}, { creating: true });
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('. ') });
    const cols = Object.keys(out);
    const r = await pool.query(
      `INSERT INTO ai_writers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => out[c]));
    await saveDefault(r.rows[0].id, out.is_default);
    const row = await pool.query(`SELECT ${PUBLIC_COLS} FROM ai_writers w WHERE w.id = $1`, [r.rows[0].id]);
    res.json({ success: true, writer: row.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save the AI writer' });
  }
});

router.put('/:id', ...guard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ success: false, error: 'Not found' });
    const { out, errors } = readBody(req.body || {}, { creating: false });
    if (req.body?.removeKey === true) { out.encrypted_key = null; out.key_iv = null; out.key_last4 = null; out.is_active = false; }
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('. ') });
    const cols = Object.keys(out);
    if (!cols.length) return res.status(400).json({ success: false, error: 'Nothing to change' });
    const r = await pool.query(
      `UPDATE ai_writers SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [id, ...cols.map((c) => out[c])]);
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Not found' });
    await saveDefault(id, out.is_default);
    const row = await pool.query(`SELECT ${PUBLIC_COLS} FROM ai_writers w WHERE w.id = $1`, [id]);
    res.json({ success: true, writer: row.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save the AI writer' });
  }
});

router.delete('/:id', ...guard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ success: false, error: 'Not found' });
    const r = await pool.query('DELETE FROM ai_writers WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete the AI writer' });
  }
});

router.post('/:id/test', ...guard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ success: false, error: 'Not found' });
  if (!testLimiter(String(req.user.id))) return res.status(429).json({ success: false, error: 'Please wait a moment before testing again.' });
  try {
    const w = (await pool.query('SELECT * FROM ai_writers WHERE id = $1', [id])).rows[0];
    if (!w) return res.status(404).json({ success: false, error: 'Not found' });
    if (!w.encrypted_key) return res.status(400).json({ success: false, error: 'Add an API key first.' });
    let ok = false;
    let message;
    try {
      const t = await testWriter({ provider: w.provider, model: w.model_name, apiKey: openKey(w), maxTokens: Math.min(4000, Math.max(1500, Number(w.max_output_tokens) || 2000)) });
      ok = t.ok;
      message = ok ? `Connected in ${(t.ms / 1000).toFixed(1)}s` : 'Connected, but the reply was not as expected';
    } catch (err) {
      message = err instanceof AiError ? `${err.message}${err.adminDetail ? ` (${err.adminDetail})` : ''}` : 'Test failed';
    }
    message = String(message).slice(0, 240);
    await pool.query('UPDATE ai_writers SET last_test_ok = $2, last_test_at = NOW(), last_test_message = $3 WHERE id = $1', [id, ok, message]);
    res.json({ success: true, ok, message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Test failed' });
  }
});

router.get('/feedback', ...guard, async (req, res) => {
  try {
    const writer = Number(req.query.writer);
    const r = await pool.query(
      `SELECT fb.plan_id::text, fb.rating, fb.useful, fb.comment, fb.created_at, w.display_name AS writer,
              vp.kind, vp.platform, vp.title
       FROM video_plan_feedback fb
       LEFT JOIN ai_writers w ON w.id = fb.writer_id
       LEFT JOIN video_plans vp ON vp.id = fb.plan_id
       WHERE ($1::int IS NULL OR fb.writer_id = $1)
       ORDER BY fb.created_at DESC LIMIT 100`, [Number.isInteger(writer) ? writer : null]);
    res.json({ success: true, feedback: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load feedback' });
  }
});

// ---------------- AI Video Maker engines (Reactor) ----------------
router.get('/engines', ...guard, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT e.*, COALESCE(s.videos_30d, 0)::int AS videos_30d, COALESCE(s.seconds_30d, 0)::numeric AS seconds_30d,
              COALESCE(s.revenue_30d, 0)::bigint AS revenue_30d
       FROM ai_video_engines e
       LEFT JOIN (
         SELECT engine_key, COUNT(*) FILTER (WHERE status = 'done') AS videos_30d,
                SUM(video_seconds) FILTER (WHERE status = 'done') AS seconds_30d,
                SUM(video_cost_cents) AS revenue_30d
         FROM video_projects WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY engine_key
       ) s ON s.engine_key = e.engine_key
       ORDER BY e.engine_key DESC`);
    res.json({ success: true, engines: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load video engines (run formular-video-maker.sql first)' });
  }
});

router.put('/engines/:key', ...guard, async (req, res) => {
  try {
    const key = String(req.params.key);
    if (!['scenes', 'presenter', 'showcase'].includes(key)) return res.status(404).json({ success: false, error: 'Not found' });
    const b = req.body || {};
    const price = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 10000 ? Math.round(n * 1000) / 1000 : null; };
    const fields = {};
    if (b.displayName !== undefined) { fields.display_name = clean(b.displayName, 60); if (!fields.display_name) return res.status(400).json({ success: false, error: 'Name is required' }); }
    if (b.description !== undefined) fields.description = clean(b.description, 240) || null;
    if (b.pricePerSecondCents !== undefined) { fields.price_per_second_cents = price(b.pricePerSecondCents); if (fields.price_per_second_cents === null) return res.status(400).json({ success: false, error: 'Price is not valid' }); }
    if (b.premiumPerSecondCents !== undefined) { fields.premium_per_second_cents = price(b.premiumPerSecondCents); if (fields.premium_per_second_cents === null) return res.status(400).json({ success: false, error: 'Premium price is not valid' }); }
    if (b.maxSeconds !== undefined) {
      const m = Math.round(Number(b.maxSeconds));
      const cap = key === 'presenter' ? 300 : 120;
      if (!Number.isFinite(m) || m < 10 || m > cap) return res.status(400).json({ success: false, error: `Max length must be 10 to ${cap} seconds` });
      fields.max_seconds = m;
    }
    if (b.isActive !== undefined) fields.is_active = Boolean(b.isActive);
    const cols = Object.keys(fields);
    if (!cols.length) return res.status(400).json({ success: false, error: 'Nothing to change' });
    await pool.query(
      `UPDATE ai_video_engines SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE engine_key = $1`,
      [key, ...cols.map((c) => fields[c])]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

// =====================================================================
// LOOKS — the style recipes (Property Tour, Product Drop…).
// A Look changes how the AI writes AND how the video is put together.
// Only style keys we know are kept, so a typo can never break a video.
// =====================================================================
const lookKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

router.get('/looks', ...guard, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM video_looks ORDER BY (user_id IS NOT NULL), sort_order, id');
    res.json({
      success: true,
      looks: r.rows.map((x) => ({
        id: Number(x.id),
        key: x.look_key,
        name: x.display_name,
        description: x.description || '',
        suits: x.suits || '',
        direction: x.direction || '',
        style: cleanStyle(x.style),
        isActive: x.is_active !== false,
        sortOrder: Number(x.sort_order) || 0,
        ownedByUser: Boolean(x.user_id)
      })),
      options: { fonts: Object.keys(FONTS), paces: Object.keys(PACES), grades: Object.keys(GRADES), headline: HEADLINE_POS, endCard: END_CARDS, musicVolume: MUSIC_LEVELS }
    });
  } catch {
    res.status(500).json({ success: false, error: 'Run the latest formular-video-maker.sql first.' });
  }
});

router.post('/looks', ...guard, async (req, res) => {
  const b = req.body || {};
  const key = lookKey(b.key || b.name);
  const name = clean(b.name, 60);
  if (!key || !name) return res.status(400).json({ success: false, error: 'Give the look a name' });
  if (!clean(b.direction, 4000)) return res.status(400).json({ success: false, error: 'Write the creative direction (how the AI should write for this look)' });
  try {
    const r = await pool.query(
      `INSERT INTO video_looks (look_key, display_name, description, suits, direction, style, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [key, name, clean(b.description, 200), clean(b.suits, 200), cleanDirection(b.direction),
        JSON.stringify(cleanStyle(b.style)), b.isActive !== false, Number(b.sortOrder) || 0]);
    res.json({ success: true, id: Number(r.rows[0].id) });
  } catch (err) {
    if (err?.code === '23505') return res.status(400).json({ success: false, error: 'A look with that name already exists.' });
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save the look' });
  }
});

router.put('/looks/:id', ...guard, async (req, res) => {
  const b = req.body || {};
  if (!/^\d{1,18}$/.test(String(req.params.id))) return res.status(404).json({ success: false, error: 'Not found' });
  try {
    const cur = (await pool.query('SELECT * FROM video_looks WHERE id = $1', [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: 'Not found' });
    if (cur.user_id) return res.status(403).json({ success: false, error: "This look belongs to a user — you cannot change it." });
    const r = await pool.query(
      `UPDATE video_looks SET display_name = $2, description = $3, suits = $4, direction = $5, style = $6,
         is_active = $7, sort_order = $8, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [cur.id,
        clean(b.name, 60) || cur.display_name,
        b.description === undefined ? cur.description : clean(b.description, 200),
        b.suits === undefined ? cur.suits : clean(b.suits, 200),
        b.direction === undefined ? cur.direction : (cleanDirection(b.direction) || cur.direction),
        JSON.stringify(cleanStyle(b.style === undefined ? cur.style : b.style)),
        b.isActive === undefined ? cur.is_active : b.isActive !== false,
        b.sortOrder === undefined ? cur.sort_order : Number(b.sortOrder) || 0]);
    res.json({ success: true, id: Number(r.rows[0].id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save the look' });
  }
});

router.delete('/looks/:id', ...guard, async (req, res) => {
  if (!/^\d{1,18}$/.test(String(req.params.id))) return res.status(404).json({ success: false, error: 'Not found' });
  try {
    // Videos already made keep their own copy of the style, so deleting is safe
    await pool.query('DELETE FROM video_looks WHERE id = $1 AND user_id IS NULL', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

export default router;
