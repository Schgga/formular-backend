import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool } from '../../db.js';
import { credit, inTransaction } from '../studio/walletService.js';
import { fetchImage } from '../ai/siteReader.js';
import { loadPhoto, recordingPath } from './mediaStore.js';
import { runFfmpeg } from './ffmpeg.js';
import { speak, wordsFromAlignment, VoiceError } from './elevenlabs.js';
import { renderShowcase } from './showcaseRenderer.js';
import { photoInfoOf, MUSIC_VOLUMES } from '../ai/videoMaker.js';
import { lookByKey, styleOf } from '../ai/videoLooks.js';

// =====================================================================
// Makes a Pro Video on the server (one job at a time by default):
//   voice → photos → scenes timed to the voice → render → save to My videos
// If anything fails, the user's money is returned automatically.
// =====================================================================

const STORAGE = () => path.resolve(process.env.VIDEO_STORAGE_DIR || 'storage/videos');
const MUSIC_DIR = () => path.resolve(process.env.VIDEO_MUSIC_DIR || 'storage/music');
const LEAD = 0.45; // seconds before the voice starts

const queue = [];
let running = 0;
const MAX = () => Math.max(1, Number(process.env.VIDEO_RENDER_CONCURRENCY) || 1);

export function enqueueShowcase(projectId) {
  if (queue.includes(projectId)) return queue.indexOf(projectId) + 1;
  queue.push(projectId);
  pump();
  return queue.length + running - 1;
}
export const queuePosition = (projectId) => queue.indexOf(projectId) + 1; // 0 = running or not queued

function pump() {
  while (running < MAX() && queue.length) {
    const id = queue.shift();
    running += 1;
    runJob(id).catch((e) => console.error('Pro video job crashed:', e)).finally(() => { running -= 1; pump(); });
  }
}

async function setStage(id, stage, pct) {
  await pool.query(`UPDATE video_projects SET render_stage = $2, render_progress = $3, updated_at = NOW() WHERE id = $1 AND status = 'rendering'`, [id, stage, Math.round(pct)]).catch(() => {});
}

export async function refundShowcase(id, reason) {
  return inTransaction(pool, async (client) => {
    const p = (await client.query('SELECT * FROM video_projects WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p || p.status !== 'rendering') return 0;
    const back = Number(p.last_render_cents || 0);
    if (back > 0) await credit(client, p.user_id, back, 'video_render_showcase', 'AI Video Maker - Pro Video refunded (could not be made)');
    await client.query(
      `UPDATE video_projects SET status = $2, render_error = $3, render_stage = NULL, render_progress = NULL,
         video_cost_cents = GREATEST(0, video_cost_cents - $4), video_refunded = $5, updated_at = NOW() WHERE id = $1`,
      [id, p.video_file ? 'done' : 'script', `${String(reason || 'Failed').slice(0, 220)}${back > 0 ? ' Your money was returned to your wallet.' : ''}`, back, back > 0]);
    return back;
  });
}

// Scene lengths come from WHEN the narrator starts each scene's line
export function timeScenes(scenes, text, lineStarts, alignment, duration) {
  const chars = alignment?.characters || [];
  const starts = alignment?.character_start_times_seconds || [];
  let times;
  if (chars.length === text.length && starts.length === chars.length) {
    times = lineStarts.map((i) => starts[i] ?? 0);
  } else {
    // Fallback: spread by word count
    const counts = scenes.map((s) => s.narration.split(/\s+/).filter(Boolean).length);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    times = counts.map((c) => { const t = (acc / total) * duration; acc += c; return t; });
  }
  return scenes.map((s, i) => {
    const from = i === 0 ? 0 : times[i] + LEAD;
    const to = i < scenes.length - 1 ? times[i + 1] + LEAD : duration + LEAD + 0.7;
    return Math.max(1.6, Math.round((to - from) * 1000) / 1000);
  });
}

// The user's own recordings, one per scene: joined with a short pause between scenes.
// Words on screen follow each recording (spread over it by word length).
const GAP = 0.6;
export async function ownVoiceTrack(prod, workDir) {
  const recs = prod.scenes.map((s, i) => {
    const file = recordingPath(s.recording);
    if (!file || !fs.existsSync(file)) throw new Error(`Scene ${i + 1} has no recording yet. Record your voice for every scene, or switch back to the AI voice.`);
    const dest = `rec${i}.m4a`;
    fs.copyFileSync(file, path.join(workDir, dest));
    return { file: dest, seconds: Number(prod.recordings?.[s.recording]) || 3 };
  });
  const args = ['-loglevel', 'error', '-y'];
  recs.forEach((r) => args.push('-i', r.file));
  const pads = recs.map((_, i) => `[${i}:a]aresample=44100,apad=pad_dur=${GAP}[a${i}]`).join(';');
  const joined = `${recs.map((_, i) => `[a${i}]`).join('')}concat=n=${recs.length}:v=0:a=1[out]`;
  const r = await runFfmpeg([...args, '-filter_complex', `${pads};${joined}`, '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', 'voice.m4a'], { cwd: workDir, timeoutMs: 120_000 });
  if (!r.ok) throw new Error(`Could not join your recordings (${r.error})`);
  const words = [];
  let t = 0;
  const seconds = [];
  recs.forEach((rec, i) => {
    const list = String(prod.scenes[i].narration || '').split(/\s+/).filter(Boolean);
    const weights = list.map((w) => 1 + w.length);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const span = Math.max(0.5, rec.seconds - 0.2);
    let at = t + 0.1;
    list.forEach((w, k) => { const d = (weights[k] / total) * span; words.push({ text: w, start: at, end: at + d * 0.92 }); at += d; });
    seconds.push(Math.round((rec.seconds + GAP + (i === 0 ? LEAD : 0) + (i === recs.length - 1 ? 0.7 : 0)) * 1000) / 1000);
    t += rec.seconds + GAP;
  });
  return { voiceFile: 'voice.m4a', words, seconds };
}

async function runJob(id) {
  const workDir = path.join(os.tmpdir(), `fmv-job-${id}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const p = (await pool.query(
      `SELECT vp.*, uw.site_url, uw.logo_url FROM video_projects vp LEFT JOIN user_websites uw ON uw.id = vp.website_id WHERE vp.id = $1`, [id])).rows[0];
    if (!p || p.status !== 'rendering') return;
    const prod = p.production;
    const photoInfo = photoInfoOf(p.site_snapshot);

    // 1. voice: the user's own recordings, or the studio AI voice
    await setStage(id, 'voice', 5);
    let words;
    let seconds;
    let voiceFile;
    if (prod.voiceMode === 'own') {
      ({ voiceFile, words, seconds } = await ownVoiceTrack(prod, workDir));
    } else {
      const lines = prod.scenes.map((s) => s.narration.trim());
      const lineStarts = [];
      let text = '';
      for (const l of lines) { if (text) text += ' '; lineStarts.push(text.length); text += l; }
      const voice = await speak({ voiceId: prod.voiceId, text, speed: prod.voiceSpeed || 1 });
      voiceFile = 'voice.mp3';
      fs.writeFileSync(path.join(workDir, voiceFile), voice.audio);
      words = wordsFromAlignment(voice.alignment);
      seconds = timeScenes(prod.scenes, text, lineStarts, voice.alignment, voice.duration || words.at(-1)?.end || 10);
    }
    if (prod.captions === false) words = [];

    // 2. photos (fresh from the website), logo, music
    await setStage(id, 'photos', 14);
    const scenes = [];
    for (let i = 0; i < prod.scenes.length; i += 1) {
      const s = prod.scenes[i];
      const info = photoInfo.find((ph) => ph.n === s.photo);
      const img = info ? await loadPhoto(info.url, p.site_url, p.user_id) : null;
      if (!img) throw new Error(`The photo for scene ${i + 1} could not be loaded right now. Choose another photo for that scene, or try again.`);
      const file = `p${i}.${img.type === 'image/png' ? 'png' : img.type === 'image/webp' ? 'webp' : 'jpg'}`;
      fs.writeFileSync(path.join(workDir, file), img.body);
      scenes.push({ image: file, seconds: seconds[i], motion: s.motion, headline: s.headline });
    }
    let logo = null;
    if (p.logo_url && p.site_url) {
      const lg = await fetchImage(new URL(p.logo_url, p.site_url).toString(), p.site_url);
      if (lg) { logo = `logo.${lg.type === 'image/png' ? 'png' : lg.type === 'image/webp' ? 'webp' : 'jpg'}`; fs.writeFileSync(path.join(workDir, logo), lg.body); }
    }
    let music = null;
    if (prod.musicId) {
      // Admin music, or music this user uploaded
      const m = (await pool.query('SELECT file FROM video_music WHERE id = $1 AND is_active = true AND (user_id IS NULL OR user_id = $2)', [prod.musicId, String(p.user_id)]).catch(() => ({ rows: [] }))).rows[0];
      const src = m ? path.join(MUSIC_DIR(), path.basename(m.file)) : null;
      if (src && fs.existsSync(src)) { music = `music${path.extname(src)}`; fs.copyFileSync(src, path.join(workDir, music)); }
    }

    // 3. render
    let lastPct = 0;
    // The Look this video was made in (lettering, pace, colour). None = the plain default.
    const look = await lookByKey(prod.look || p.look_key, p.user_id);
    const r = await renderShowcase({
      workDir, aspect: p.aspect, scenes, words, voice: voiceFile, music, musicVolume: MUSIC_VOLUMES[prod.musicVolume] || MUSIC_VOLUMES.medium, lead: LEAD, accent: prod.accent,
      style: styleOf(look),
      endCard: { seconds: 3.6, headline: prod.endCard?.headline, cta: prod.endCard?.cta, contact: prod.endCard?.contact, logo },
      onProgress: (stage, pct) => {
        const overall = 20 + pct * 0.75;
        if (overall - lastPct >= 4 || pct === 100) { lastPct = overall; setStage(id, stage === 'done' ? 'saving' : 'rendering', overall); }
      }
    });

    // 4. save
    fs.mkdirSync(STORAGE(), { recursive: true });
    const name = `v${id}-${crypto.randomBytes(6).toString('hex')}.mp4`;
    fs.copyFileSync(r.file, path.join(STORAGE(), name));
    const old = p.video_file;
    await pool.query(
      `UPDATE video_projects SET status = 'done', video_file = $2, video_bytes = $3, video_seconds = $4, render_played = true,
         render_stage = NULL, render_progress = NULL, render_error = NULL, updated_at = NOW() WHERE id = $1`,
      [id, name, fs.statSync(path.join(STORAGE(), name)).size, Math.round(r.seconds * 10) / 10]);
    if (old) fs.rm(path.join(STORAGE(), path.basename(old)), { force: true }, () => {});
  } catch (err) {
    const msg = err instanceof VoiceError ? err.message : String(err?.message || 'The video could not be made.');
    console.error(`Pro video ${id} failed:`, msg);
    await refundShowcase(id, msg).catch((e) => console.error('Refund failed:', e?.message));
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

// After a server restart, jobs that were in progress are lost: give the money back.
// (Run the backend as ONE process — e.g. one PM2 instance — so jobs are not lost.)
const BOOTED_AT = new Date();
setTimeout(async () => {
  try {
    const r = await pool.query(`SELECT id FROM video_projects WHERE status = 'rendering' AND engine_key = 'showcase' AND render_started_at < $1`, [BOOTED_AT]);
    for (const row of r.rows) await refundShowcase(row.id, 'The server restarted while making the video. Please try again.');
  } catch { /* tables not installed yet */ }
}, 5000).unref?.();

// Say clearly in the terminal at start-up whether videos can be made
setTimeout(async () => {
  const { ffmpegPath, runFfmpeg } = await import('./ffmpeg.js');
  const bin = await ffmpegPath();
  const r = await runFfmpeg(['-version'], { timeoutMs: 15_000 });
  if (r.ok) console.log(`Pro Video: FFmpeg ready (${bin}).`);
  else console.warn('Pro Video: FFmpeg NOT found — videos cannot be made. In the BACKEND folder run "npm install ffmpeg-static" (if npm says scripts were blocked: "npm install-scripts approve ffmpeg-static" then "npm rebuild ffmpeg-static"), then restart.');
}, 1500).unref?.();
