import fs from 'node:fs';
import { spawn } from 'node:child_process';

// Finds FFmpeg: FFMPEG_PATH in .env, else the "ffmpeg-static" npm package (backend folder),
// else the system one. Only a WORKING path is remembered, so installing FFmpeg later
// just needs a backend restart.
let cachedPath = null;
export let ffmpegSource = '';
export async function ffmpegPath() {
  if (cachedPath) return cachedPath;
  if (process.env.FFMPEG_PATH) {
    if (fs.existsSync(process.env.FFMPEG_PATH)) { ffmpegSource = 'FFMPEG_PATH in .env'; return (cachedPath = process.env.FFMPEG_PATH); }
    console.warn(`FFMPEG_PATH in .env points to a file that does not exist: ${process.env.FFMPEG_PATH}`);
  }
  try {
    const mod = await import('ffmpeg-static');
    const p = mod?.default;
    if (p && fs.existsSync(p)) { ffmpegSource = 'ffmpeg-static'; return (cachedPath = p); }
    if (p) console.warn(`ffmpeg-static is installed but its program is missing (${p}). Run "npm rebuild ffmpeg-static" in the backend folder.`);
  } catch { /* not installed in the backend */ }
  ffmpegSource = 'system';
  return 'ffmpeg'; // the system one, if FFmpeg is installed on the computer
}

/**
 * Run FFmpeg with an argument list (never through a shell).
 * cwd lets us use short relative file names — avoids Windows "C:" path problems inside filters.
 * @returns {Promise<{ ok: boolean, error: string, stderr: string }>}
 */
export async function runFfmpeg(args, { cwd, timeoutMs = 10 * 60_000 } = {}) {
  const bin = await ffmpegPath();
  return new Promise((resolve) => {
    let err = '';
    let child;
    try {
      child = spawn(bin, ['-hide_banner', ...args], { cwd, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: e.message, stderr: '' });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-6000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: /ENOENT/.test(e.message) ? 'FFmpeg is not installed on the server — run "npm install ffmpeg-static" in the BACKEND folder and restart the backend' : e.message, stderr: err }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? '' : err.trim().split('\n').slice(-4).join(' '), stderr: err });
    });
  });
}

// Width x height of a picture or video, read from FFmpeg's description of the input
export async function mediaSize(file, cwd) {
  const r = await runFfmpeg(['-i', file], { cwd, timeoutMs: 30_000 });
  const m = r.stderr.match(/Stream #.*?(?:Video|video).*?(\d{2,5})x(\d{2,5})/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

export async function mediaDuration(file, cwd) {
  const r = await runFfmpeg(['-i', file], { cwd, timeoutMs: 30_000 });
  const m = r.stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
