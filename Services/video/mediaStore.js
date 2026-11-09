import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool } from '../../db.js';
import { fetchImage, imageKind } from '../ai/siteReader.js';
import { runFfmpeg, mediaDuration } from './ffmpeg.js';
import { imageSize } from '../ai/photoVision.js';

// =====================================================================
// Files users add themselves: photos, voice recordings, music.
// Everything is re-made by FFmpeg before it is kept, which
//   - proves it is a real picture / real audio,
//   - removes hidden data (e.g. the GPS location inside phone photos),
//   - gives every file the same safe format.
// Files live OUTSIDE the public folder and are only served through signed links.
//
// .env (optional):
//   VIDEO_PHOTO_DIR=storage/video-photos
//   VIDEO_VOICE_DIR=storage/video-voice
// =====================================================================

export const PHOTO_DIR = () => path.resolve(process.env.VIDEO_PHOTO_DIR || 'storage/video-photos');
export const VOICE_DIR = () => path.resolve(process.env.VIDEO_VOICE_DIR || 'storage/video-voice');
const tmpName = (ext) => path.join(os.tmpdir(), `fmu-${crypto.randomBytes(10).toString('hex')}${ext}`);
const rm = (f) => { if (f) fs.rm(f, { force: true }, () => {}); };

export class MediaError extends Error {}

// ---------- photos ----------
export async function saveUserPhoto({ buffer, userId, websiteId }) {
  if (!imageKind(buffer)) throw new MediaError('Use a JPG, PNG or WEBP photo.');
  const src = tmpName('.img');
  const out = tmpName('.jpg');
  fs.writeFileSync(src, buffer);
  try {
    // Longest side 1920px, upright, no hidden data
    const r = await runFfmpeg(['-loglevel', 'error', '-y', '-i', path.basename(src), '-map_metadata', '-1',
      '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'", '-q:v', '3', '-frames:v', '1', path.basename(out)],
    { cwd: os.tmpdir(), timeoutMs: 60_000 });
    if (!r.ok || !fs.existsSync(out)) throw new MediaError(/not installed/.test(r.error) ? 'Photos cannot be added right now (the video tool is not installed on the server).' : 'That photo could not be read. Try another one.');
    const body = fs.readFileSync(out);
    const size = imageSize(body) || { w: 0, h: 0 };
    if (size.w && Math.max(size.w, size.h) < 400) throw new MediaError('That photo is too small. Use a bigger, clearer photo.');
    fs.mkdirSync(PHOTO_DIR(), { recursive: true });
    const file = `u-${crypto.randomBytes(12).toString('hex')}.jpg`;
    fs.writeFileSync(path.join(PHOTO_DIR(), file), body);
    const row = (await pool.query(
      'INSERT INTO video_user_photos (user_id, website_id, file, w, h) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [String(userId), websiteId ? String(websiteId) : null, file, size.w, size.h])).rows[0];
    return { id: Number(row.id), url: `upload:${row.id}`, w: size.w, h: size.h };
  } finally { rm(src); rm(out); }
}

// The user's own photos for a website (newest first) — added to every new video
export async function userPhotosFor(userId, websiteId, limit = 12) {
  try {
    const r = await pool.query(
      `SELECT id FROM video_user_photos WHERE user_id = $1 AND (website_id = $2 OR website_id IS NULL) ORDER BY created_at DESC LIMIT $3`,
      [String(userId), websiteId ? String(websiteId) : '', limit]);
    return r.rows.map((x) => ({ url: `upload:${x.id}`, alt: 'Your photo', page: '' }));
  } catch { return []; }
}

/**
 * Load a photo used in a video: either one the user added ("upload:ID") or one on the website.
 * userId must be the project's owner — a user can never load someone else's upload.
 */
export async function loadPhoto(url, siteUrl, userId) {
  const m = /^upload:(\d{1,18})$/.exec(String(url || ''));
  if (m) {
    const row = (await pool.query('SELECT file FROM video_user_photos WHERE id = $1 AND user_id = $2', [m[1], String(userId)])).rows[0];
    if (!row) return null;
    const full = path.join(PHOTO_DIR(), path.basename(row.file));
    if (!fs.existsSync(full)) return null;
    return { body: fs.readFileSync(full), type: 'image/jpeg' };
  }
  return siteUrl ? fetchImage(url, siteUrl) : null;
}

// ---------- audio ----------
export function audioKind(buf) {
  if (!buf || buf.length < 12) return null;
  const s = (a, b) => buf.slice(a, b).toString('latin1');
  if (s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  if (s(4, 8) === 'ftyp') return 'm4a';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  if (s(0, 4) === 'OggS') return 'ogg';                   // WhatsApp voice notes
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm'; // browser recordings
  if (s(0, 4) === 'fLaC') return 'flac';
  return null;
}

/**
 * Turn any recording into clean AAC audio.
 * clean=true: removes rumble and background hiss and evens out the level (for voice).
 * @returns {Promise<{ file: string, seconds: number }>} file = temp path (caller moves or deletes it)
 */
export async function convertAudio(buffer, { clean = false, maxSeconds = 600, minSeconds = 1, out = tmpName('.m4a'), mp3 = false } = {}) {
  if (!audioKind(buffer)) throw new MediaError('Use a voice recording or audio file (MP3, M4A, WAV, OGG or a WhatsApp voice note).');
  const src = tmpName('.aud');
  fs.writeFileSync(src, buffer);
  try {
    const filters = clean ? ['-af', 'highpass=f=80,afftdn=nf=-25,dynaudnorm=f=250:g=7,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15'] : [];
    const codec = mp3 ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '192k'];
    const r = await runFfmpeg(['-loglevel', 'error', '-y', '-i', path.basename(src), '-map', '0:a:0', '-vn', '-t', String(maxSeconds),
      ...filters, '-ar', '44100', '-ac', clean ? '1' : '2', ...codec, path.basename(out)],
    { cwd: path.dirname(src), timeoutMs: 180_000 });
    const produced = path.join(path.dirname(src), path.basename(out));
    if (!r.ok || !fs.existsSync(produced)) throw new MediaError(/not installed/.test(r.error) ? 'Audio cannot be added right now (the video tool is not installed on the server).' : 'That recording could not be read. Try again.');
    const seconds = await mediaDuration(path.basename(produced), path.dirname(produced));
    if (!seconds || seconds < minSeconds) { rm(produced); throw new MediaError('The recording is empty or too short.'); }
    return { file: produced, seconds: Math.round(seconds * 100) / 100 };
  } finally { rm(src); }
}

// Voice recordings for one scene of a project
export async function saveSceneRecording({ buffer, projectId }) {
  const { file, seconds } = await convertAudio(buffer, { clean: true, maxSeconds: 60 });
  if (seconds > 45) { rm(file); throw new MediaError('Keep each scene under 45 seconds. Short and clear works best.'); }
  fs.mkdirSync(VOICE_DIR(), { recursive: true });
  const token = `p${projectId}-${crypto.randomBytes(8).toString('hex')}`;
  fs.copyFileSync(file, path.join(VOICE_DIR(), `${token}.m4a`));
  rm(file);
  return { token, seconds };
}
export const recordingPath = (token) => (/^p\d{1,18}-[a-f0-9]{16}$/.test(String(token)) ? path.join(VOICE_DIR(), `${token}.m4a`) : null);
