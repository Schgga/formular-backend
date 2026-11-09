import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { isPremiumUser, debit, credit, inTransaction, makeLimiter, OutOfFundsError } from '../Services/studio/walletService.js';
import { listWritersForUser, getActiveWriter, openKey } from '../Services/ai/writers.js';
import { callAI, AiError } from '../Services/ai/aiProviders.js';
import { readWebsite } from '../Services/ai/siteReader.js';
import { KINDS, LANGUAGES, TONES, guessType, suggestKind } from '../Services/ai/videoPlan.js';
import {
  ENGINES, ASPECTS, SCENE_LENGTHS, PRESENTER_LENGTHS, CLIP_SECONDS, MAX_SCENES, MAX_PHOTOS_PER_SCENE,
  QUESTIONS_SCHEMA, SCENES_SCHEMA, PRESENTER_SCHEMA, questionsPrompts, productionPrompts,
  cleanQuestions, cleanProduction, cleanEditedProduction, scenePrompt, productionSeconds,
  SHOWCASE_LENGTHS, SHOWCASE_MOTIONS, ACCENTS, SHOWCASE_SCHEMA, showcasePrompts, cleanShowcase, cleanEditedShowcase, photoInfoOf, MUSIC_VOLUMES
} from '../Services/ai/videoMaker.js';
import { saveUserPhoto, userPhotosFor, loadPhoto, saveSceneRecording, recordingPath, convertAudio, MediaError } from '../Services/video/mediaStore.js';
import { cloneVoice, deleteVoice, VoiceError } from '../Services/video/elevenlabs.js';
import { looksFor, lookByKey, sceneBudget } from '../Services/ai/videoLooks.js';
import { analyzePhotos } from '../Services/ai/photoVision.js';
import { enqueueShowcase, queuePosition } from '../Services/video/showcaseJob.js';
import { createReactorToken } from '../Services/reactor/reactorClient.js';
import { toShareableMp4 } from '../Services/video/convert.js';

// =====================================================================
// AI VIDEO MAKER  (mounted at /api/video-maker)
//
//   GET    /options                          writers, engines (with prices), choices
//   GET    /websites                         the user's websites
//   POST   /projects                         start: read website → AI asks questions (free, daily limit)
//   POST   /projects/:id/script              answers → AI writes the production script (writer price)
//   PUT    /projects/:id/production          user edits the script
//   GET    /projects   |  GET /projects/:id  |  DELETE /projects/:id
//   POST   /projects/:id/render/start        hold the video price, get a Reactor token
//   POST   /projects/:id/render/played       the video started playing (no refund after this)
//   POST   /projects/:id/render/fail         failed before playing → money back
//   POST   /projects/:id/render/done         upload the finished MP4/WEBM
//   GET    /photo/:id/:n?exp&sig             website photo (signed, short-lived link)
//   GET    /file/:id?exp&sig                 finished video (signed, short-lived link)
//   GET    /music/:id?exp&sig                background music preview (signed link)
//   POST   /projects/:id/photos              add your own photo (kept for this website's next videos too)
//   POST   /projects/:id/recordings          your own voice for one scene (field "scene" = 0,1,2…)
//   GET    /recording/:id/:token?exp&sig     play a scene recording (signed link)
//   POST   /music  |  DELETE /music/:id      your own background music (you must have the rights)
//   POST   /voices/clone | DELETE /voices/mine   an AI copy of YOUR OWN voice (consent required)
//
// PRO VIDEO ("showcase" engine) is made on the SERVER: render/start holds the
// price and puts the job in a queue; the page polls GET /projects/:id for
// renderStage / renderProgress. If it fails, the money goes back automatically.
//
// .env (optional):
//   VIDEO_STORAGE_DIR=storage/videos     where finished videos are kept (NOT a public folder)
//   VIDEO_LINK_SECRET=<long random>      signs video/photo links (random each restart if empty)
//   VIDEO_MAKER_DAILY_LIMIT=20           new projects per user per day
// =====================================================================

const router = Router();
const STORAGE = () => path.resolve(process.env.VIDEO_STORAGE_DIR || 'storage/videos');
const LINK_SECRET = process.env.VIDEO_LINK_SECRET || crypto.randomBytes(32).toString('hex');
const DAILY_LIMIT = () => Math.max(1, Number(process.env.VIDEO_MAKER_DAILY_LIMIT) || 20);
const MAX_UPLOAD = 300 * 1024 * 1024;

const busy = new Set();
const aiLimiter = makeLimiter(8, 10 * 60 * 1000);
const renderLimiter = makeLimiter(12, 60 * 60 * 1000);
const isId = (v) => /^\d{1,18}$/.test(String(v));
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const lengthsFor = (engine) => (engine === 'presenter' ? PRESENTER_LENGTHS : engine === 'showcase' ? SHOWCASE_LENGTHS : SCENE_LENGTHS);
// The user may pick several AI writers: 1st choice, then backups. If one is busy or
// fails, the next one does the job. The user pays only for the one that finished.
const MAX_WRITERS = 4;
function readWriterIds(b) {
  const list = Array.isArray(b.writerIds) ? b.writerIds : [b.writerId];
  return [...new Set(list.filter(isId).map(Number))].slice(0, MAX_WRITERS);
}
async function activeWritersIn(ids) {
  const out = [];
  for (const id of ids) { const w = await getActiveWriter(id); if (w) out.push(w); }
  return out;
}
// Problems with the AI itself → try the next writer. The user's own input problems are not retried.
const tryNextWriter = (err) => err instanceof AiError;
async function withWriters(writers, label, fn) {
  let lastErr;
  for (let i = 0; i < writers.length; i += 1) {
    try {
      return { result: await fn(writers[i]), writer: writers[i] };
    } catch (err) {
      lastErr = err;
      if (!tryNextWriter(err) || i === writers.length - 1) break;
      console.warn(`${label}: "${writers[i].display_name}" failed (${err.message}) — trying "${writers[i + 1].display_name}".`);
    }
  }
  if (lastErr instanceof AiError && writers.length > 1) lastErr.message = `${lastErr.message.replace(/\.?$/, '.')} (All ${writers.length} AI writers you picked were tried.)`;
  throw lastErr;
}

const pick = (obj) => Object.entries(obj).map(([value, v]) => ({ value, label: typeof v === 'string' ? v : v.label, ...(v.help && { help: v.help }) }));

// ---------- signed links (for <img>/<video>, which cannot send a login header) ----------
function sign(kind, id, extra = '', ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', LINK_SECRET).update(`${kind}:${id}:${extra}:${exp}`).digest('base64url');
  return `exp=${exp}&sig=${sig}`;
}
function verify(kind, id, extra, exp, sig) {
  if (!/^\d{9,12}$/.test(String(exp)) || Number(exp) < Date.now() / 1000) return false;
  const want = crypto.createHmac('sha256', LINK_SECRET).update(`${kind}:${id}:${extra}:${exp}`).digest('base64url');
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function getEngines(premium) {
  const r = await pool.query('SELECT * FROM ai_video_engines ORDER BY engine_key DESC');
  return r.rows.map((e) => ({
    key: e.engine_key,
    model: e.model_name,
    name: e.display_name,
    description: e.description || '',
    perSecondCents: Number(premium ? e.premium_per_second_cents : e.price_per_second_cents),
    maxSeconds: e.max_seconds,
    active: e.is_active
  }));
}

async function ownWebsite(websiteId, userId) {
  try {
    const r = await pool.query(
      `SELECT uw.id, uw.business_name, uw.site_url, wcl.name AS class_name
       FROM user_websites uw
       LEFT JOIN website_catalog wc ON wc.id = uw.catalog_id
       LEFT JOIN website_classes wcl ON wcl.id = wc.class_id
       WHERE uw.id = $1 AND uw.user_id = $2 AND uw.deleted_at IS NULL`, [websiteId, userId]);
    return r.rows[0] || null;
  } catch { return null; }
}

async function ownProject(id, userId) {
  if (!isId(id)) return null;
  const r = await pool.query(
    `SELECT vp.*, uw.business_name AS website_name, uw.site_url
     FROM video_projects vp LEFT JOIN user_websites uw ON uw.id = vp.website_id
     WHERE vp.id = $1 AND vp.user_id = $2`, [id, userId]);
  return r.rows[0] || null;
}

async function myVoice(userId) {
  if (!userId) return null;
  try { return (await pool.query('SELECT voice_id, name, created_at FROM user_voices WHERE user_id = $1', [String(userId)])).rows[0] || null; } catch { return null; }
}
// The studio voices, plus the user's own voice copy (first) if they made one
async function activeVoices(userId) {
  const out = [];
  const mine = await myVoice(userId);
  if (mine) out.push({ id: mine.voice_id, name: 'My voice', description: 'Your own voice (AI copy)', preview: '', mine: true });
  try {
    const r = await pool.query('SELECT voice_id, display_name, description, preview_url FROM ai_voices WHERE is_active = true ORDER BY sort_order, display_name');
    out.push(...r.rows.map((v) => ({ id: v.voice_id, name: v.display_name, description: v.description || '', preview: /^https:\/\//.test(v.preview_url || '') ? v.preview_url : '' })));
  } catch { /* table not installed yet */ }
  return out;
}
// Admin music for everyone, plus music this user uploaded
async function activeMusic(userId) {
  const link = (m) => ({ id: m.id, title: m.title, mood: m.mood, mine: Boolean(m.user_id), url: `/api/video-maker/music/${m.id}?${sign('music', m.id, '', 6 * 3600)}` });
  try {
    const r = await pool.query('SELECT id, title, mood, user_id FROM video_music WHERE is_active = true AND (user_id IS NULL OR user_id = $1) ORDER BY (user_id IS NULL), mood, title', [String(userId || '')]);
    return r.rows.map(link);
  } catch {
    try { return (await pool.query('SELECT id, title, mood FROM video_music WHERE is_active = true ORDER BY mood, title')).rows.map(link); } catch { return []; }
  }
}
async function voiceCloneSettings() {
  try {
    const v = (await pool.query(`SELECT value FROM video_settings WHERE key = 'voice_clone'`)).rows[0]?.value || {};
    return { enabled: Boolean(v.enabled), priceCents: Math.max(0, Math.round(Number(v.priceCents) || 0)), premiumPriceCents: Math.max(0, Math.round(Number(v.premiumPriceCents) || 0)) };
  } catch { return { enabled: false, priceCents: 0, premiumPriceCents: 0 }; }
}

// What the browser gets for a project (no internal fields, links signed)
function present(p) {
  const photos = (p.site_snapshot?.photos || []).map((ph, i) => ({
    n: i + 1,
    alt: ph.alt || '',
    url: `/api/video-maker/photo/${p.id}/${i + 1}?${sign('photo', p.id, String(i + 1))}`
  }));
  return {
    id: String(p.id),
    status: p.status,
    engine: p.engine_key,
    kind: p.kind,
    aspect: p.aspect,
    length: p.length_sec,
    language: p.language,
    tone: p.tone,
    website: p.website_name || '',
    writer: p.writer_name || '',
    writerIds: (Array.isArray(p.writer_ids) && p.writer_ids.length ? p.writer_ids : [p.writer_id]).filter(Boolean).map(Number),
    look: p.look_key || '',
    title: p.title || p.production?.title || '',
    understanding: p.questions?.understanding || '',
    highlights: p.questions?.highlights || [],
    questions: p.questions?.questions || [],
    answers: p.answers || {},
    production: p.production || null,
    readWebsite: Boolean(p.site_snapshot?.ok),
    photos,
    scriptCostCents: p.script_cost_cents,
    videoCostCents: p.video_cost_cents,
    renderError: p.render_error || '',
    renderStage: p.status === 'rendering' ? (p.render_stage || 'queued') : null,
    renderProgress: p.status === 'rendering' ? Number(p.render_progress || 0) : null,
    queuePosition: p.status === 'rendering' && p.engine_key === 'showcase' ? queuePosition(Number(p.id)) : 0,
    voiceId: p.voice_id || '',
    recordingUrls: Object.fromEntries(Object.keys(p.production?.recordings || {}).map((t) => [t, `/api/video-maker/recording/${p.id}/${t}?${sign('rec', p.id, t)}`])),
    photoInfo: (p.engine_key === 'showcase' ? photoInfoOf(p.site_snapshot) : []).map((ph) => ({ n: ph.n, label: ph.label, category: ph.category, quality: ph.quality, usable: ph.usable, portrait: ph.h > ph.w })),
    video: p.video_file ? {
      url: `/api/video-maker/file/${p.id}?${sign('file', p.id, p.video_file)}`,
      bytes: Number(p.video_bytes || 0),
      seconds: Number(p.video_seconds || 0),
      ext: path.extname(p.video_file).slice(1)
    } : null,
    created_at: p.created_at,
    updated_at: p.updated_at
  };
}

// ---------------- choices ----------------
router.get('/options', requireAuth, async (req, res) => {
  try {
    const premium = await isPremiumUser(pool, req.user.id);
    res.json({
      success: true,
      writers: await listWritersForUser(premium),
      engines: (await getEngines(premium)).filter((e) => e.active).map(({ active, model, ...e }) => e),
      kinds: pick(KINDS),
      languages: pick(LANGUAGES),
      tones: pick(TONES),
      aspects: ASPECTS,
      sceneLengths: SCENE_LENGTHS,
      presenterLengths: PRESENTER_LENGTHS,
      showcaseLengths: SHOWCASE_LENGTHS,
      motions: SHOWCASE_MOTIONS,
      accents: ACCENTS,
      voices: await activeVoices(req.user.id),
      music: await activeMusic(req.user.id),
      musicVolumes: Object.keys(MUSIC_VOLUMES),
      looks: await looksFor(req.user.id),
      voiceClone: await (async () => { const c = await voiceCloneSettings(); return { enabled: c.enabled, priceCents: premium ? c.premiumPriceCents : c.priceCents }; })(),
      myVoice: Boolean(await myVoice(req.user.id))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load the Video Maker' });
  }
});

router.get('/websites', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT uw.id, uw.business_name, uw.site_url, uw.logo_url, wcl.name AS class_name
       FROM user_websites uw
       LEFT JOIN website_catalog wc ON wc.id = uw.catalog_id
       LEFT JOIN website_classes wcl ON wcl.id = wc.class_id
       WHERE uw.user_id = $1 AND uw.deleted_at IS NULL ORDER BY uw.created_at DESC`, [req.user.id]);
    res.json({
      success: true,
      websites: r.rows.map((w) => ({ id: w.id, name: w.business_name, url: w.site_url || '', logo: w.logo_url || '', type: guessType(w.class_name), suggestedKind: suggestKind(w.class_name) }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your websites' });
  }
});

// ---------------- step 1: read website + AI questions ----------------
router.post('/projects', requireAuth, async (req, res) => {
  const userId = String(req.user.id);
  const b = req.body || {};
  const kind = KINDS[b.kind] ? b.kind : null;
  const engine = ENGINES.includes(b.engine) ? b.engine : null;
  const aspect = engine === 'presenter' ? '16:9' : (ASPECTS.includes(b.aspect) ? b.aspect : '9:16');
  const length = engine && lengthsFor(engine).includes(Number(b.length)) ? Number(b.length) : null;
  const language = LANGUAGES[b.language] ? b.language : 'english';
  const tone = TONES[b.tone] ? b.tone : 'friendly';
  const notes = clean(b.notes, 1000);
  const writerIds = readWriterIds(b);
  if (!kind || !engine || !length || !writerIds.length) {
    return res.status(400).json({ success: false, error: 'Please choose a website, video type, style, length and AI writer.' });
  }
  if (busy.has(userId)) return res.status(429).json({ success: false, error: 'Please wait for your last request to finish.' });
  if (!aiLimiter(userId)) return res.status(429).json({ success: false, error: 'Too many requests. Please wait a few minutes.' });
  busy.add(userId);
  try {
    const site = await ownWebsite(b.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const writers = await activeWritersIn(writerIds);
    if (!writers.length) return res.status(400).json({ success: false, error: 'The AI writer you picked is not available right now. Choose another one.' });
    const engines = await getEngines(false);
    const eng = engines.find((e) => e.key === engine);
    if (!eng?.active) return res.status(400).json({ success: false, error: 'This video style is not switched on yet.' });
    if (length > eng.maxSeconds) return res.status(400).json({ success: false, error: `This style can make videos up to ${eng.maxSeconds} seconds.` });
    let voiceId = null;
    let look = null;
    if (engine === 'showcase') {
      const voices = await activeVoices(req.user.id);
      if (!voices.length) return res.status(400).json({ success: false, error: 'No voices are switched on yet. Please check back soon.' });
      voiceId = voices.some((v) => v.id === b.voiceId) ? b.voiceId : voices[0].id;
      // The Look (style recipe). None chosen, or an unknown one, just means the plain default.
      look = await lookByKey(b.lookKey, req.user.id);
    }
    const today = await pool.query(`SELECT COUNT(*)::int AS n FROM video_projects WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [req.user.id]);
    if (today.rows[0].n >= DAILY_LIMIT()) return res.status(429).json({ success: false, error: `Daily limit of ${DAILY_LIMIT()} new videos reached. Try again tomorrow.` });

    let read = site.site_url ? await readWebsite(site.site_url) : { ok: false, text: '', photos: [], pages: [] };
    // Slow websites sometimes time out the first time: try once more
    if (site.site_url && (!read.ok || !(read.photos || []).length)) {
      const again = await readWebsite(site.site_url);
      if ((again.photos || []).length > (read.photos || []).length || (!read.ok && again.ok)) read = again;
    }
    // Photos the user added before for this website come first (they are the most reliable)
    const own = await userPhotosFor(req.user.id, site.id);
    const snapshot = { ok: read.ok, text: read.text || '', photos: [...own, ...(read.photos || [])].slice(0, 30), pages: (read.pages || []).map((p) => p.url).slice(0, 5) };
    const input = {
      business: { name: site.business_name, type: guessType(site.class_name), url: site.site_url },
      kind, engine, aspect, length, language, tone, notes, siteText: snapshot.text, photos: snapshot.photos
    };
    const { system, prompt } = questionsPrompts(input);
    const { result: q, writer } = await withWriters(writers, 'Video maker questions', async (w) => {
      const ai = await callAI({
        provider: w.provider, model: w.model_name, apiKey: openKey(w),
        system, prompt, schema: QUESTIONS_SCHEMA, schemaName: 'video_questions',
        maxTokens: Math.min(16000, Math.max(2000, Number(w.max_output_tokens) || 6000))
      });
      try { return cleanQuestions(ai.data); } catch { throw new AiError('The AI answer was not in the expected format.', { retryable: true }); }
    });
    const ins = await pool.query(
      `INSERT INTO video_projects (user_id, website_id, writer_id, writer_name, writer_ids, engine_key, kind, aspect, length_sec, language, tone, site_snapshot, questions, answers, voice_id, look_key)
       VALUES ($1, $2, $3, $4, $15, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $16) RETURNING id`,
      [req.user.id, site.id, writer.id, writer.display_name, engine, kind, aspect, length, language, tone,
        JSON.stringify({ ...snapshot, notes }), JSON.stringify(q), JSON.stringify({}), voiceId, JSON.stringify(writers.map((w) => w.id)),
        look?.key || null]);
    res.json({ success: true, project: present(await ownProject(ins.rows[0].id, req.user.id)) });
  } catch (err) {
    const msg = err instanceof AiError ? err.message : 'Could not prepare your questions.';
    console.error('Video maker questions failed:', err?.message, err?.adminDetail || '');
    res.status(502).json({ success: false, error: msg });
  } finally {
    busy.delete(userId);
  }
});

// ---------------- step 2: answers → production script ----------------
router.post('/projects/:id/script', requireAuth, async (req, res) => {
  const userId = String(req.user.id);
  if (busy.has(userId)) return res.status(429).json({ success: false, error: 'Please wait for your last request to finish.' });
  if (!aiLimiter(userId)) return res.status(429).json({ success: false, error: 'Too many requests. Please wait a few minutes.' });
  busy.add(userId);
  let charged = 0;
  try {
    const p = await ownProject(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ success: false, error: 'Video not found' });
    if (!['questions', 'script', 'failed'].includes(p.status)) return res.status(409).json({ success: false, error: 'This video is being made or is finished.' });
    // The writers picked for this video (1st choice first). "Write a new script" may send a new choice.
    const asked = readWriterIds(req.body || {});
    const saved = Array.isArray(p.writer_ids) && p.writer_ids.length ? p.writer_ids : [p.writer_id];
    const writers = await activeWritersIn(asked.length ? asked : saved);
    if (!writers.length) return res.status(400).json({ success: false, error: 'The AI writer for this video is no longer available. Choose another one.' });

    const given = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const answers = {};
    for (const q of p.questions?.questions || []) {
      const v = clean(given[q.id], 900); // tapped options + the owner's own words
      if (v) answers[q.id] = v;
    }
    const engines = await getEngines(false);
    const eng = engines.find((e) => e.key === p.engine_key);

    // Hold the highest price of the picked writers; the difference comes back if a cheaper one writes it
    const premium = await isPremiumUser(pool, req.user.id);
    const priceOf = (w) => Number(premium ? w.premium_price_usd_cents : w.price_usd_cents) || 0;
    const hold = Math.max(...writers.map(priceOf));
    charged = (await inTransaction(pool, (client) => debit(client, req.user.id, hold, `video_script_${writers[0].id}`, `AI Video Maker - script (${writers.map((w) => w.display_name).join(' / ')})`))).charged;

    let snap = p.site_snapshot || {};
    // AI Scenes: no photos found the first time (slow website)? Look once more.
    if (p.engine_key === 'scenes' && !(snap.photos || []).length && p.site_url) {
      const again = await readWebsite(p.site_url).catch(() => null);
      if (again?.photos?.length) {
        snap = { ...snap, photos: again.photos.slice(0, 30) };
        await pool.query(`UPDATE video_projects SET site_snapshot = site_snapshot || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify({ photos: snap.photos })]);
      }
    }
    const input = {
      business: { name: p.website_name, type: '', url: p.site_url },
      kind: p.kind, engine: p.engine_key, aspect: p.aspect, length: p.length_sec, language: p.language, tone: p.tone,
      notes: snap.notes || '', siteText: snap.text || '', photos: snap.photos || [],
      questions: p.questions?.questions || [], answers
    };
    const { result: production, writer } = await withWriters(writers, 'Video maker script', async (w) => {
      if (p.engine_key === 'showcase') return writeShowcase(p, w, input, eng);
      const { system, prompt } = productionPrompts(input);
      const ai = await callAI({
        provider: w.provider, model: w.model_name, apiKey: openKey(w),
        system, prompt, schema: p.engine_key === 'presenter' ? PRESENTER_SCHEMA : SCENES_SCHEMA, schemaName: 'video_production',
        maxTokens: Math.min(32000, Math.max(2000, Number(w.max_output_tokens) || 6000))
      });
      try {
        return cleanProduction(ai.data, { engine: p.engine_key, photoCount: (snap.photos || []).length, maxSeconds: Math.min(eng?.maxSeconds || 90, p.length_sec + 15) });
      } catch { throw new AiError('The AI answer was not in the expected format.', { retryable: true }); }
    });
    // Pay only the price of the writer that actually wrote it
    const back = charged > 0 ? Math.max(0, charged - Math.min(charged, priceOf(writer))) : 0;
    if (back > 0) {
      await inTransaction(pool, (client) => credit(client, req.user.id, back, `video_script_${writer.id}`, `AI Video Maker - difference returned (written by ${writer.display_name})`));
      charged -= back;
    }
    await pool.query(
      `UPDATE video_projects SET status = 'script', answers = $2, production = $3, title = $4,
         script_cost_cents = script_cost_cents + $5, render_error = NULL, writer_id = $6, writer_name = $7, writer_ids = $8, updated_at = NOW() WHERE id = $1`,
      [p.id, JSON.stringify(answers), JSON.stringify(production), production.title, charged, writer.id, writer.display_name, JSON.stringify(writers.map((w) => w.id))]);
    res.json({ success: true, project: present(await ownProject(p.id, req.user.id)) });
  } catch (err) {
    if (err instanceof OutOfFundsError) return res.status(402).json({ success: false, outOfFunds: true, error: 'Not enough balance. Please top up your wallet.' });
    if (charged > 0) {
      try {
        await inTransaction(pool, (client) => credit(client, req.user.id, charged, 'video_script', 'AI Video Maker - script refunded (failed)'));
      } catch (e) { console.error('Refund failed:', e?.message); }
    }
    const msg = err instanceof AiError || err?.userMessage ? err.message : 'Could not write the script.';
    console.error('Video maker script failed:', err?.message, err?.adminDetail || '');
    res.status(502).json({ success: false, error: `${msg}${charged ? ' You were not charged.' : ''}` });
  } finally {
    busy.delete(userId);
  }
});

// PRO VIDEO script: the AI first LOOKS at every photo, then writes one scene per real photo
async function writeShowcase(p, writer, input, eng) {
  let snap = p.site_snapshot || {};
  let photoInfo = snap.photoInfo;
  const usableCount = (list) => (list || []).filter((ph) => ph.usable).length;
  // Look (again) when there is no list yet, too few usable photos, or no AI has really looked at them yet
  if (!Array.isArray(photoInfo) || usableCount(photoInfo) < 2 || !photoInfo.some((ph) => ph.vision)) {
    // Read the website's photos again (they may have been added since, or the old reader missed them)
    if ((snap.photos || []).length < 4 && p.site_url) {
      const again = await readWebsite(p.site_url).catch(() => null);
      if (again?.photos?.length > (snap.photos || []).length) {
        snap = { ...snap, photos: again.photos.slice(0, 24) };
        await pool.query(`UPDATE video_projects SET site_snapshot = site_snapshot || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify({ photos: snap.photos })]);
      }
    }
    const workDir = path.join(os.tmpdir(), `fmv-vision-${p.id}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      photoInfo = await analyzePhotos({ writer, apiKey: openKey(writer), photos: snap.photos || [], siteUrl: p.site_url, userId: p.user_id, workDir });
    } finally {
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    }
    const st = photoInfo.stats || {};
    if (usableCount(photoInfo) < 2) {
      // Not saved, so the next try checks the photos again
      const why = !st.found
        ? 'We could not find any photos on your website.'
        : !st.downloaded
          ? `We found ${st.found} photo${st.found === 1 ? '' : 's'} on your website but could not download them (they may be hosted on another website).`
          : `Only ${usableCount(photoInfo)} of the ${st.found} photos on your website are clear, real photos (logos, icons and very small pictures can't be used).`;
      throw Object.assign(new Error(`${why} A Pro Video needs at least 2. Add more photos to your website, or choose the AI Scenes style.`), { userMessage: true });
    }
    // Always saved: the editor, the photo picker and the video are made from this list
    await pool.query(`UPDATE video_projects SET site_snapshot = site_snapshot || $2::jsonb WHERE id = $1`, [p.id, JSON.stringify({ photoInfo })]);
    p.site_snapshot = { ...snap, photoInfo };
  }
  const maxSeconds = Math.min(eng?.maxSeconds || 90, p.length_sec + 15);
  // The Look decides the creative direction, how many scenes suit its pace, and which camera moves
  const look = await lookByKey(p.look_key, p.user_id);
  const budget = sceneBudget(look, p.length_sec);
  const { system, prompt } = showcasePrompts({
    ...input, photoInfo, sceneBudget: budget, lookDirection: look?.direction || '', lookMotions: look?.style?.motions
  });
  const ai = await callAI({
    provider: writer.provider, model: writer.model_name, apiKey: openKey(writer),
    system, prompt, schema: SHOWCASE_SCHEMA, schemaName: 'video_production',
    maxTokens: Math.min(32000, Math.max(2000, Number(writer.max_output_tokens) || 6000))
  });
  let production;
  try {
    production = cleanShowcase(ai.data, { photoInfo, look });
  } catch {
    throw new AiError('The AI did not use the website photos correctly. Please try again.', { retryable: true });
  }
  while (production.scenes.length > 1 && productionSeconds(production) > maxSeconds + 6) production.scenes.pop();
  const voices = await activeVoices(p.user_id);
  production.voiceId = voices.some((v) => v.id === p.voice_id) ? p.voice_id : (voices[0]?.id || '');
  let host = '';
  try { host = new URL(p.site_url).hostname.replace(/^www\./, ''); } catch { /* no website address */ }
  production.endCard.headline = production.endCard.headline || String(p.website_name || '').slice(0, 40);
  production.endCard.contact = host;
  return production;
}

router.put('/projects/:id/production', requireAuth, async (req, res) => {
  try {
    const p = await ownProject(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ success: false, error: 'Video not found' });
    if (!p.production || !['script', 'failed', 'done'].includes(p.status)) return res.status(409).json({ success: false, error: 'This video cannot be edited right now.' });
    const eng = (await getEngines(false)).find((e) => e.key === p.engine_key);
    let production;
    try {
      if (p.engine_key === 'showcase') {
        const voiceIds = (await activeVoices(req.user.id)).map((v) => v.id);
        const musicIds = (await activeMusic(req.user.id)).map((m) => m.id);
        production = cleanEditedShowcase(req.body?.production || {}, p.production, { photoInfo: photoInfoOf(p.site_snapshot), voiceIds, musicIds, maxSeconds: eng?.maxSeconds || 90 });
      } else {
        production = cleanEditedProduction(req.body?.production || {}, p.production, { photoCount: (p.site_snapshot?.photos || []).length, maxSeconds: eng?.maxSeconds || 90 });
      }
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }
    await pool.query(`UPDATE video_projects SET production = $2, status = CASE WHEN status = 'done' THEN 'done' ELSE 'script' END, updated_at = NOW() WHERE id = $1`, [p.id, JSON.stringify(production)]);
    res.json({ success: true, project: present(await ownProject(p.id, req.user.id)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save your changes' });
  }
});

router.get('/projects', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT vp.id::text, vp.title, vp.status, vp.engine_key AS engine, vp.kind, vp.length_sec AS length, vp.video_seconds,
              vp.created_at, uw.business_name AS website, (vp.video_file IS NOT NULL) AS has_video
       FROM video_projects vp LEFT JOIN user_websites uw ON uw.id = vp.website_id
       WHERE vp.user_id = $1 ORDER BY vp.created_at DESC LIMIT 60`, [req.user.id]);
    res.json({ success: true, projects: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your videos' });
  }
});

router.get('/projects/:id', requireAuth, async (req, res) => {
  try {
    const p = await ownProject(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ success: false, error: 'Video not found' });
    res.json({ success: true, project: present(p) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load the video' });
  }
});

router.delete('/projects/:id', requireAuth, async (req, res) => {
  try {
    const p = await ownProject(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ success: false, error: 'Video not found' });
    if (p.status === 'rendering') return res.status(409).json({ success: false, error: 'Wait until the video is finished.' });
    if (p.video_file) fs.rm(path.join(STORAGE(), path.basename(p.video_file)), { force: true }, () => {});
    for (const t of Object.keys(p.production?.recordings || {})) { const f = recordingPath(t); if (f) fs.rm(f, { force: true }, () => {}); }
    await pool.query('DELETE FROM video_projects WHERE id = $1', [p.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

// ---------------- step 3: make the video ----------------
router.post('/projects/:id/render/start', requireAuth, async (req, res) => {
  const userId = String(req.user.id);
  if (!renderLimiter(userId)) return res.status(429).json({ success: false, error: 'Too many videos started in the last hour. Please wait a little.' });
  try {
    const p = await ownProject(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ success: false, error: 'Video not found' });
    if (!p.production || !['script', 'failed', 'done'].includes(p.status)) return res.status(409).json({ success: false, error: 'Write the script first.' });
    const other = await pool.query(`SELECT 1 FROM video_projects WHERE user_id = $1 AND status = 'rendering' AND id <> $2 AND render_started_at > NOW() - INTERVAL '30 minutes'`, [req.user.id, p.id]);
    if (other.rowCount) return res.status(429).json({ success: false, error: 'Another video is being made. Please wait for it to finish.' });

    const premium = await isPremiumUser(pool, req.user.id);
    const eng = (await getEngines(premium)).find((e) => e.key === p.engine_key);
    if (!eng?.active) return res.status(400).json({ success: false, error: 'This video style is switched off right now.' });
    const seconds = productionSeconds(p.production);
    if (seconds > eng.maxSeconds + 6) return res.status(400).json({ success: false, error: `This video is longer than the ${eng.maxSeconds}-second limit. Shorten the script.` });
    const cents = Math.ceil(seconds * eng.perSecondCents);
    if (p.engine_key === 'showcase') {
      if (p.production.voiceMode === 'own') {
        const missing = p.production.scenes.findIndex((s) => !s.recording || !fs.existsSync(recordingPath(s.recording) || ''));
        if (missing >= 0) return res.status(400).json({ success: false, error: `Record your voice for scene ${missing + 1} first (or switch back to the AI voice).` });
      } else {
        const voices = await activeVoices(req.user.id);
        if (!voices.some((v) => v.id === p.production.voiceId)) return res.status(400).json({ success: false, error: 'Choose a voice for the voiceover first.' });
      }
    }

    await inTransaction(pool, async (client) => {
      const locked = (await client.query('SELECT status FROM video_projects WHERE id = $1 FOR UPDATE', [p.id])).rows[0];
      if (locked.status === 'rendering') throw Object.assign(new Error('busy'), { code: 'BUSY' });
      await debit(client, req.user.id, cents, `video_render_${p.engine_key}`, `AI Video Maker - ${eng.name} (${Math.round(seconds)}s video)`);
      await client.query(
        `UPDATE video_projects SET status = 'rendering', render_started_at = NOW(), render_played = false, render_error = NULL,
           last_render_cents = $2, video_cost_cents = video_cost_cents + $2, updated_at = NOW() WHERE id = $1`, [p.id, cents]);
    });

    if (p.engine_key === 'showcase') {
      // Made on the server — the user can leave the page
      await pool.query(`UPDATE video_projects SET render_stage = 'queued', render_progress = 0 WHERE id = $1`, [p.id]);
      enqueueShowcase(Number(p.id));
      return res.json({ success: true, queued: true, chargedCents: cents, project: present(await ownProject(p.id, req.user.id)) });
    }

    let token;
    try {
      token = await createReactorToken({ modelMatch: [eng.model] });
    } catch (err) {
      console.error('Video maker token failed:', err?.message);
      await refundRender(p.id, req.user.id, 'Could not reach the video engine.', { force: true });
      return res.status(502).json({ success: false, error: 'The video engine is busy. You were not charged. Please try again.' });
    }

    // Everything the browser needs to make the video (prompts built here, on the server)
    const prod = p.production;
    const plan = p.engine_key === 'presenter'
      ? { engine: 'presenter', model: eng.model, script: prod.script, scenePrompt: prod.scenePrompt, wpm: prod.wpm, seconds }
      : {
        engine: 'scenes',
        model: eng.model,
        aspect: p.aspect,
        seconds,
        clips: prod.scenes.map((s) => ({ seconds: s.seconds, photoIds: s.photoIds, prompt: scenePrompt(s, prod) }))
      };
    res.json({ success: true, token: { jwt: token.jwt, expiresAt: token.expiresAt }, chargedCents: cents, plan, project: present(await ownProject(p.id, req.user.id)) });
  } catch (err) {
    if (err instanceof OutOfFundsError) return res.status(402).json({ success: false, outOfFunds: true, error: 'Not enough balance to make this video. Please top up your wallet.' });
    if (err?.code === 'BUSY') return res.status(409).json({ success: false, error: 'This video is already being made.' });
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not start making the video' });
  }
});

const REFUND_WINDOW_SEC = 120;
async function refundRender(projectId, userId, reason, { force = false } = {}) {
  return inTransaction(pool, async (client) => {
    const p = (await client.query('SELECT * FROM video_projects WHERE id = $1 FOR UPDATE', [projectId])).rows[0];
    if (!p || p.status !== 'rendering') return 0;
    // Money back only when nothing could have been seen yet: the video never started
    // playing, the failure came soon after starting, and not too many refunds today.
    let back = 0;
    const secsSinceStart = (Date.now() - new Date(p.render_started_at).getTime()) / 1000;
    const refundsToday = (await client.query(
      `SELECT COUNT(*)::int AS n FROM video_projects WHERE user_id = $1 AND video_refunded AND updated_at > NOW() - INTERVAL '24 hours'`, [userId])).rows[0].n;
    if (!p.render_played && (secsSinceStart <= REFUND_WINDOW_SEC || force) && refundsToday < 5) {
      back = Number(p.last_render_cents || 0);
      if (back > 0) await credit(client, userId, back, `video_render_${p.engine_key}`, 'AI Video Maker - refunded (video was not made)');
    }
    await client.query(
      `UPDATE video_projects SET status = $2, render_error = $3, video_cost_cents = GREATEST(0, video_cost_cents - $4),
         video_refunded = $5, updated_at = NOW() WHERE id = $1`,
      [projectId, p.video_file ? 'done' : 'script', String(reason || 'Failed').slice(0, 300), back, back > 0]);
    return back;
  });
}

router.post('/projects/:id/render/played', requireAuth, async (req, res) => {
  try {
    const p = await ownProject(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ success: false, error: 'Video not found' });
    if (p.engine_key === 'showcase') return res.status(409).json({ success: false, error: 'Pro Videos are made on the server.' });
    await pool.query(`UPDATE video_projects SET render_played = true, updated_at = NOW() WHERE id = $1 AND status = 'rendering'`, [p.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

router.post('/projects/:id/render/fail', requireAuth, async (req, res) => {
  try {
    const p = await ownProject(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ success: false, error: 'Video not found' });
    if (p.engine_key === 'showcase') return res.status(409).json({ success: false, error: 'Pro Videos are made on the server.' });
    const refunded = await refundRender(p.id, req.user.id, clean(req.body?.reason, 280) || 'The video engine stopped.');
    res.json({ success: true, refundedCents: refunded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `fmv-${crypto.randomBytes(12).toString('hex')}`)
  }),
  limits: { fileSize: MAX_UPLOAD, files: 1 }
});

function videoKind(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return null;
}

router.post('/projects/:id/render/done', requireAuth, (req, res) => {
  upload.single('video')(req, res, async (uploadErr) => {
    const tmp = req.file?.path;
    const cleanup = () => { if (tmp) fs.rm(tmp, { force: true }, () => {}); };
    try {
      if (uploadErr) return res.status(400).json({ success: false, error: uploadErr.code === 'LIMIT_FILE_SIZE' ? 'The video file is too large.' : 'Upload failed' });
      const p = await ownProject(req.params.id, req.user.id);
      if (!p) { cleanup(); return res.status(404).json({ success: false, error: 'Video not found' }); }
      if (p.status !== 'rendering' || p.engine_key === 'showcase') { cleanup(); return res.status(409).json({ success: false, error: 'This video is not being made right now.' }); }
      if (!tmp) return res.status(400).json({ success: false, error: 'No video received' });
      const kind = videoKind(tmp);
      if (!kind) { cleanup(); return res.status(400).json({ success: false, error: 'That is not an MP4 or WEBM video.' }); }

      fs.mkdirSync(STORAGE(), { recursive: true });
      // Convert to H.264 + AAC so the sound plays in Telegram, WhatsApp, iPhone…
      const base = `v${p.id}-${crypto.randomBytes(6).toString('hex')}`;
      let name = `${base}.mp4`;
      const conv = await toShareableMp4(tmp, path.join(STORAGE(), name));
      if (!conv.ok) {
        console.warn('Video convert skipped:', conv.error, '— saving the original recording (some apps may play it without sound).');
        fs.rmSync(path.join(STORAGE(), name), { force: true }); // (sync: the fallback may use the same name)
        name = `${base}.${kind}`;
        fs.copyFileSync(tmp, path.join(STORAGE(), name));
      }
      cleanup();
      const size = fs.statSync(path.join(STORAGE(), name)).size;
      if (p.video_file) fs.rm(path.join(STORAGE(), path.basename(p.video_file)), { force: true }, () => {});
      const secs = Math.max(0, Math.min(600, Number(req.body?.seconds) || productionSeconds(p.production)));
      await pool.query(
        `UPDATE video_projects SET status = 'done', video_file = $2, video_bytes = $3, video_seconds = $4, render_played = true, updated_at = NOW() WHERE id = $1`,
        [p.id, name, size, secs]);
      res.json({ success: true, project: present(await ownProject(p.id, req.user.id)) });
    } catch (err) {
      cleanup();
      console.error(err);
      res.status(500).json({ success: false, error: 'Could not save the video' });
    }
  });
});

// ---------------- your own photos, voice and music ----------------
const memUpload = (field, maxMb, maxFiles = 1) => multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: maxFiles } }).array(field, maxFiles);
const mediaLimiter = makeLimiter(60, 60 * 60 * 1000);
const uploadError = (err) => (err?.code === 'LIMIT_FILE_SIZE' ? 'That file is too big.' : err?.code === 'LIMIT_FILE_COUNT' ? 'Too many files at once.' : 'Upload failed. Please try again.');

// Add a photo to a video (and to this website's photos for next time)
router.post('/projects/:id/photos', requireAuth, (req, res) => {
  memUpload('photo', 15)(req, res, async (upErr) => {
    try {
      if (upErr) return res.status(400).json({ success: false, error: uploadError(upErr) });
      if (!mediaLimiter(`p${req.user.id}`)) return res.status(429).json({ success: false, error: 'Too many uploads. Please wait a little.' });
      const p = await ownProject(req.params.id, req.user.id);
      if (!p) return res.status(404).json({ success: false, error: 'Video not found' });
      if (p.status === 'rendering') return res.status(409).json({ success: false, error: 'Wait until the video is finished.' });
      const file = req.files?.[0];
      if (!file) return res.status(400).json({ success: false, error: 'Choose a photo.' });
      const snap = p.site_snapshot || {};
      if ((snap.photos || []).length >= 40) return res.status(400).json({ success: false, error: 'This video already has 40 photos. Remove some from your website or start a new video.' });
      const saved = await saveUserPhoto({ buffer: file.buffer, userId: req.user.id, websiteId: p.website_id });
      const photos = [...(snap.photos || []), { url: saved.url, alt: 'Your photo', page: '' }];
      const n = photos.length;
      const patch = { photos };
      if (p.engine_key === 'showcase') {
        patch.photoInfo = [...photoInfoOf(snap), { n, url: saved.url, label: 'Your photo', category: 'other', quality: 4, usable: true, w: saved.w, h: saved.h, vision: false, uploaded: true }];
      }
      await pool.query(`UPDATE video_projects SET site_snapshot = site_snapshot || $2::jsonb, updated_at = NOW() WHERE id = $1`, [p.id, JSON.stringify(patch)]);
      res.json({ success: true, n, project: present(await ownProject(p.id, req.user.id)) });
    } catch (err) {
      if (err instanceof MediaError) return res.status(400).json({ success: false, error: err.message });
      console.error(err);
      res.status(500).json({ success: false, error: 'Could not add the photo' });
    }
  });
});

// Your own voice for one scene (recorded in the browser, or a voice note / audio file)
router.post('/projects/:id/recordings', requireAuth, (req, res) => {
  memUpload('audio', 15)(req, res, async (upErr) => {
    try {
      if (upErr) return res.status(400).json({ success: false, error: uploadError(upErr) });
      if (!mediaLimiter(`r${req.user.id}`)) return res.status(429).json({ success: false, error: 'Too many recordings. Please wait a little.' });
      const p = await ownProject(req.params.id, req.user.id);
      if (!p || p.engine_key !== 'showcase') return res.status(404).json({ success: false, error: 'Video not found' });
      if (!p.production || !['script', 'failed', 'done'].includes(p.status)) return res.status(409).json({ success: false, error: 'This video cannot be changed right now.' });
      const idx = Number(req.body?.scene);
      if (!Number.isInteger(idx) || idx < 0 || idx >= p.production.scenes.length) return res.status(400).json({ success: false, error: 'Scene not found' });
      const file = req.files?.[0];
      if (!file) return res.status(400).json({ success: false, error: 'No recording received.' });
      const { token, seconds } = await saveSceneRecording({ buffer: file.buffer, projectId: p.id });
      const prod = { ...p.production, recordings: { ...(p.production.recordings || {}) }, scenes: p.production.scenes.map((s) => ({ ...s })) };
      const old = prod.scenes[idx].recording;
      prod.scenes[idx].recording = token;
      prod.recordings[token] = seconds;
      prod.voiceMode = 'own';
      // forget recordings no scene uses any more
      const used = new Set(prod.scenes.map((s) => s.recording).filter(Boolean));
      for (const t of Object.keys(prod.recordings)) if (!used.has(t)) { delete prod.recordings[t]; const f = recordingPath(t); if (f) fs.rm(f, { force: true }, () => {}); }
      if (old && old !== token && !used.has(old)) { const f = recordingPath(old); if (f) fs.rm(f, { force: true }, () => {}); }
      await pool.query(`UPDATE video_projects SET production = $2, status = CASE WHEN status = 'done' THEN 'done' ELSE 'script' END, updated_at = NOW() WHERE id = $1`, [p.id, JSON.stringify(prod)]);
      res.json({ success: true, seconds, project: present(await ownProject(p.id, req.user.id)) });
    } catch (err) {
      if (err instanceof MediaError) return res.status(400).json({ success: false, error: err.message });
      console.error(err);
      res.status(500).json({ success: false, error: 'Could not save the recording' });
    }
  });
});

// Your own background music
router.post('/music', requireAuth, (req, res) => {
  memUpload('file', 20)(req, res, async (upErr) => {
    let tmp;
    try {
      if (upErr) return res.status(400).json({ success: false, error: uploadError(upErr) });
      if (!mediaLimiter(`m${req.user.id}`)) return res.status(429).json({ success: false, error: 'Too many uploads. Please wait a little.' });
      if (req.body?.rights !== 'yes') return res.status(400).json({ success: false, error: 'Please confirm you have the right to use this music.' });
      const file = req.files?.[0];
      if (!file) return res.status(400).json({ success: false, error: 'Choose a music file.' });
      const mine = await pool.query('SELECT COUNT(*)::int AS n FROM video_music WHERE user_id = $1', [String(req.user.id)]);
      if (mine.rows[0].n >= 10) return res.status(400).json({ success: false, error: 'You can keep up to 10 of your own tracks. Delete one first.' });
      const conv = await convertAudio(file.buffer, { maxSeconds: 600, minSeconds: 5 });
      tmp = conv.file;
      const dir = path.resolve(process.env.VIDEO_MUSIC_DIR || 'storage/music');
      fs.mkdirSync(dir, { recursive: true });
      const name = `um-${crypto.randomBytes(8).toString('hex')}.m4a`;
      fs.copyFileSync(tmp, path.join(dir, name));
      const title = clean(req.body?.title, 80) || clean(path.parse(file.originalname || '').name, 80) || 'My music';
      const r = await pool.query(`INSERT INTO video_music (title, mood, file, user_id) VALUES ($1, 'mine', $2, $3) RETURNING id`, [title, name, String(req.user.id)]);
      res.json({ success: true, id: r.rows[0].id, music: await activeMusic(req.user.id) });
    } catch (err) {
      if (err instanceof MediaError) return res.status(400).json({ success: false, error: err.message });
      console.error(err);
      res.status(500).json({ success: false, error: 'Could not add the music' });
    } finally { if (tmp) fs.rm(tmp, { force: true }, () => {}); }
  });
});

router.delete('/music/:id', requireAuth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Not found' });
    const r = await pool.query('DELETE FROM video_music WHERE id = $1 AND user_id = $2 RETURNING file', [req.params.id, String(req.user.id)]);
    if (r.rows[0]) fs.rm(path.join(path.resolve(process.env.VIDEO_MUSIC_DIR || 'storage/music'), path.basename(r.rows[0].file)), { force: true }, () => {});
    res.json({ success: true, music: await activeMusic(req.user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

// An AI copy of the user's OWN voice (ElevenLabs). One per user. Consent is required and stored.
const cloneLimiter = makeLimiter(5, 24 * 60 * 60 * 1000); // only real tries count (see below)
router.post('/voices/clone', requireAuth, (req, res) => {
  memUpload('audio', 15, 3)(req, res, async (upErr) => {
    const temps = [];
    let charged = 0;
    try {
      if (upErr) return res.status(400).json({ success: false, error: uploadError(upErr) });
      const settings = await voiceCloneSettings();
      if (!settings.enabled) return res.status(403).json({ success: false, error: 'Voice copying is not switched on yet.' });
      if (req.body?.consent !== 'yes') return res.status(400).json({ success: false, error: 'Please confirm this is your own voice.' });
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ success: false, error: 'Record or upload your voice first.' });
      let total = 0;
      const ready = [];
      for (const f of files) {
        const c = await convertAudio(f.buffer, { mp3: true, out: path.join(os.tmpdir(), `fmc-${crypto.randomBytes(8).toString('hex')}.mp3`), maxSeconds: 300, minSeconds: 3 });
        temps.push(c.file);
        total += c.seconds;
        ready.push({ buffer: fs.readFileSync(c.file), filename: `sample${ready.length + 1}.mp3` });
      }
      if (total < 30) return res.status(400).json({ success: false, error: `We need at least 30 seconds of your voice (we got ${Math.round(total)}). Read the text a little longer.` });
      // Only a real try counts, so a too-short or unreadable recording never uses up the day's tries
      if (!cloneLimiter(String(req.user.id))) return res.status(429).json({ success: false, error: 'You can only make a copy of your voice 5 times a day. Please try again tomorrow.' });
      const premium = await isPremiumUser(pool, req.user.id);
      const price = premium ? settings.premiumPriceCents : settings.priceCents;
      charged = (await inTransaction(pool, (client) => debit(client, req.user.id, price, 'video_voice_clone', 'AI Video Maker - copy of my voice'))).charged;
      const voiceId = await cloneVoice({ name: `user-${req.user.id}`.slice(0, 60), files: ready, description: `Formular user ${req.user.id} (own voice, consent given)` });
      const old = await myVoice(req.user.id);
      await pool.query(
        `INSERT INTO user_voices (user_id, voice_id, name, consent_ip) VALUES ($1, $2, 'My voice', $3)
         ON CONFLICT (user_id) DO UPDATE SET voice_id = $2, consent_at = NOW(), consent_ip = $3, created_at = NOW()`,
        [String(req.user.id), voiceId, String(req.ip || '').slice(0, 64)]);
      if (old?.voice_id && old.voice_id !== voiceId) await deleteVoice(old.voice_id);
      res.json({ success: true, voiceId, voices: await activeVoices(req.user.id) });
    } catch (err) {
      if (err instanceof OutOfFundsError) return res.status(402).json({ success: false, outOfFunds: true, error: 'Not enough balance. Please top up your wallet.' });
      if (charged > 0) {
        try { await inTransaction(pool, (client) => credit(client, req.user.id, charged, 'video_voice_clone', 'AI Video Maker - voice copy refunded (failed)')); } catch (e) { console.error('Refund failed:', e?.message); }
      }
      const msg = err instanceof MediaError || err instanceof VoiceError ? err.message : 'Could not copy your voice. Please try again.';
      if (!(err instanceof MediaError)) console.error('Voice copy failed:', err?.message);
      res.status(err instanceof MediaError ? 400 : 502).json({ success: false, error: `${msg}${charged ? ' You were not charged.' : ''}` });
    } finally {
      for (const t of temps) fs.rm(t, { force: true }, () => {});
    }
  });
});

router.delete('/voices/mine', requireAuth, async (req, res) => {
  try {
    const old = await myVoice(req.user.id);
    if (old) {
      await pool.query('DELETE FROM user_voices WHERE user_id = $1', [String(req.user.id)]);
      await deleteVoice(old.voice_id);
    }
    res.json({ success: true, voices: await activeVoices(req.user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete your voice' });
  }
});

router.get('/recording/:id/:token', async (req, res) => {
  try {
    const { id, token } = req.params;
    if (!isId(id) || !verify('rec', id, token, req.query.exp, req.query.sig) || !token.startsWith(`p${id}-`)) return res.status(403).end();
    const file = recordingPath(token);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=600', 'Content-Type': 'audio/mp4' } });
  } catch {
    res.status(500).end();
  }
});

// ---------------- signed files ----------------
router.get('/photo/:id/:n', async (req, res) => {
  try {
    const { id, n } = req.params;
    if (!isId(id) || !/^\d{1,2}$/.test(n) || !verify('photo', id, n, req.query.exp, req.query.sig)) return res.status(403).end();
    const r = await pool.query(`SELECT vp.user_id, vp.site_snapshot, uw.site_url FROM video_projects vp LEFT JOIN user_websites uw ON uw.id = vp.website_id WHERE vp.id = $1`, [id]);
    const ph = r.rows[0]?.site_snapshot?.photos?.[Number(n) - 1];
    if (!ph) return res.status(404).end();
    const img = await loadPhoto(ph.url, r.rows[0].site_url, r.rows[0].user_id);
    if (!img) return res.status(404).end();
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(img.body);
  } catch {
    res.status(500).end();
  }
});

router.get('/file/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id)) return res.status(404).end();
    const r = await pool.query('SELECT video_file, title FROM video_projects WHERE id = $1', [id]);
    const file = r.rows[0]?.video_file;
    if (!file || !verify('file', id, file, req.query.exp, req.query.sig)) return res.status(403).end();
    const full = path.join(STORAGE(), path.basename(file));
    if (!fs.existsSync(full)) return res.status(404).end();
    const nice = String(r.rows[0].title || 'video').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'video';
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${nice}${path.extname(file)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(full, { headers: { 'Cache-Control': 'private, max-age=600' } });
  } catch {
    res.status(500).end();
  }
});

const MUSIC_DIR = () => path.resolve(process.env.VIDEO_MUSIC_DIR || 'storage/music');
router.get('/music/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id) || !verify('music', id, '', req.query.exp, req.query.sig)) return res.status(403).end();
    const r = await pool.query('SELECT file FROM video_music WHERE id = $1 AND is_active = true', [id]);
    if (!r.rows[0]) return res.status(404).end();
    const full = path.join(MUSIC_DIR(), path.basename(r.rows[0].file));
    if (!fs.existsSync(full)) return res.status(404).end();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(full, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  } catch {
    res.status(500).end();
  }
});

// Renders left hanging (page closed): close them after 30 minutes
setInterval(async () => {
  try {
    const r = await pool.query(`SELECT id, user_id FROM video_projects WHERE status = 'rendering' AND engine_key <> 'showcase' AND render_started_at < NOW() - INTERVAL '30 minutes' LIMIT 50`);
    for (const row of r.rows) await refundRender(row.id, row.user_id, 'The page was closed before the video finished.', { force: false });
  } catch { /* table not installed yet */ }
}, 5 * 60 * 1000).unref?.();

export const VIDEO_MAKER_LIMITS = { CLIP_SECONDS, MAX_SCENES, MAX_PHOTOS_PER_SCENE };
export default router;
