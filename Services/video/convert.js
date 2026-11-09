import fs from 'node:fs';
import { runFfmpeg } from './ffmpeg.js';

// =====================================================================
// Turns a browser recording into a standard MP4 that plays WITH SOUND
// everywhere (Telegram, WhatsApp, iPhone, Instagram, TikTok):
//   video H.264 (yuv420p) + audio AAC, "faststart" so it streams instantly.
// Needs FFmpeg:  npm install ffmpeg-static   (in the backend)  or FFMPEG_PATH in .env
// =====================================================================

export async function toShareableMp4(inputFile, outputFile, { timeoutMs = 5 * 60_000 } = {}) {
  const r = await runFfmpeg([
    '-loglevel', 'error', '-y',
    '-i', inputFile,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outputFile
  ], { timeoutMs });
  if (!r.ok) return { ok: false, error: r.error };
  try {
    if (fs.statSync(outputFile).size < 1000) return { ok: false, error: 'Empty output' };
  } catch {
    return { ok: false, error: 'No output' };
  }
  return { ok: true };
}
