import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFfmpeg, mediaSize } from './ffmpeg.js';
import { FONTS, GRADES, cleanStyle } from '../ai/videoLooks.js';

// =====================================================================
// PRO VIDEO RENDERER — real photos become a finished advert:
//   • each scene = ONE real photo with smooth camera motion (eased zoom / pan)
//   • photos that don't fit the frame sit on a blurred copy of themselves
//   • soft transitions, a headline per scene, word-by-word captions
//   • end card with logo, call to action and contact
//   • voiceover + optional music that ducks under the voice, loudness for social apps
//   • output: H.264 + AAC MP4 (plays with sound in WhatsApp, Telegram, iPhone…)
// Everything runs inside one work folder with short file names (safe on Windows).
// =====================================================================

const FPS = 30;
// How long one scene melts into the next — a calm Look lingers, a snappy one cuts
const PACE_T = { calm: 0.6, normal: 0.45, snappy: 0.3 };
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');

export const SIZES = {
  '9:16': { W: 1080, H: 1920 },
  '1:1': { W: 1080, H: 1080 },
  '16:9': { W: 1920, H: 1080 },
  '4:3': { W: 1440, H: 1080 }
};
export const MOTIONS = ['push_in', 'pull_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down'];
const TRANSITIONS = ['fade', 'smoothleft', 'fade', 'smoothup', 'fade', 'smoothright'];

const assColor = (hex, alpha = 0) => {
  const h = String(hex || '#ffffff').replace('#', '').padEnd(6, 'f').slice(0, 6);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};
const assText = (s) => String(s || '').replace(/[\\{}]/g, '').replace(/\r?\n/g, '\\N').trim();
const ts = (sec) => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${r}`;
};

// ---------- word-by-word captions ----------
function captionChunks(words) {
  const chunks = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    const chars = cur.map((x) => x.text).join(' ').length;
    if (cur.length >= 4 || chars >= 22 || /[.!?,;:]$/.test(w.text)) { chunks.push(cur); cur = []; }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function buildAss({ W, H, words, scenes, endCard, lead, accent, style = {} }) {
  const base = Math.min(W, H);
  const fonts = FONTS[style.font] || FONTS.modern;
  // Serif headlines read smaller than heavy sans, so give them a little more size
  const headScale = style.font === 'elegant' ? 1.1 : 1;
  const capSize = Math.round(base * (W < H ? 0.074 : 0.062));
  const headSize = Math.round(base * (W < H ? 0.07 : 0.062) * headScale);
  const marginX = Math.round(W * 0.08);
  const acc = assColor(accent || '#FFD54A');
  // Where the scene headline sits: 8 = top, 5 = middle, 2 = bottom (above the captions)
  const headAlign = style.headline === 'middle' ? 5 : style.headline === 'top' ? 8 : 2;
  const headMarginV = style.headline === 'middle' ? 0
    : Math.round(H * (style.headline === 'top' ? (W < H ? 0.09 : 0.07) : (W < H ? 0.30 : 0.24)));
  const headSpacing = style.caps ? Math.round(headSize * 0.06) : 0;
  const endCardStyle = style.endCard === 'bold' ? 'bold' : 'minimal';
  const headText = (t) => (style.caps ? assText(t).toUpperCase() : assText(t));
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${fonts.cap},${capSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${Math.round(capSize * 0.09)},${Math.round(capSize * 0.05)},2,${marginX},${marginX},${Math.round(H * (W < H ? 0.16 : 0.1))},1`,
    `Style: Head,${fonts.head},${headSize},&H00FFFFFF,&H00FFFFFF,&H50000000,&H50000000,0,0,0,0,100,100,${headSpacing},0,3,${Math.round(headSize * 0.3)},0,${headAlign},${marginX},${marginX},${headMarginV},1`,
    `Style: EndTitle,${fonts.head},${Math.round(base * 0.1 * headScale)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,${marginX},${marginX},0,1`,
    `Style: EndCta,${fonts.cap},${Math.round(base * (endCardStyle === 'bold' ? 0.072 : 0.062))},${acc},${acc},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,${marginX},${marginX},0,1`,
    `Style: EndInfo,${fonts.body},${Math.round(base * 0.045)},&H00E6E6E6,&H00E6E6E6,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,${marginX},${marginX},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];

  // Headline per scene
  let t = 0;
  for (const s of scenes) {
    if (s.headline) lines.push(`Dialogue: 1,${ts(t + 0.25)},${ts(t + s.seconds - 0.05)},Head,,0,0,0,,{\\fad(300,250)}${headText(s.headline)}`);
    t += s.seconds;
  }
  // Captions: the whole short phrase, with the word being spoken highlighted
  for (const chunk of captionChunks(words)) {
    for (let i = 0; i < chunk.length; i += 1) {
      const start = chunk[i].start + lead;
      const end = (i < chunk.length - 1 ? chunk[i + 1].start : chunk[i].end + 0.12) + lead;
      if (end - start < 0.03) continue;
      const text = chunk.map((w, j) => (j === i ? `{\\c${acc}}${assText(w.text)}{\\c&H00FFFFFF&}` : assText(w.text))).join(' ');
      lines.push(`Dialogue: 0,${ts(start)},${ts(end)},Cap,,0,0,0,,${text}`);
    }
  }
  // End card text
  if (endCard) {
    const s = t;
    const e = t + endCard.seconds;
    const cx = Math.round(W / 2);
    const y0 = Math.round(H * (endCard.hasLogo ? 0.54 : 0.44));
    if (endCard.headline) lines.push(`Dialogue: 2,${ts(s + 0.15)},${ts(e)},EndTitle,,0,0,0,,{\\an5\\pos(${cx},${y0})\\fad(350,0)}${headText(endCard.headline)}`);
    if (endCard.cta) lines.push(`Dialogue: 2,${ts(s + 0.45)},${ts(e)},EndCta,,0,0,0,,{\\an5\\pos(${cx},${Math.round(y0 + base * 0.13)})\\fad(350,0)}${assText(endCard.cta)}`);
    if (endCard.contact) lines.push(`Dialogue: 2,${ts(s + 0.7)},${ts(e)},EndInfo,,0,0,0,,{\\an5\\pos(${cx},${Math.round(y0 + base * 0.22)})\\fad(350,0)}${assText(endCard.contact)}`);
  }
  return lines.join('\n');
}

// ---------- pictures ----------
// Two layouts:
//   cover → the photo already suits the frame: it fills the screen and the camera moves over it
//   card  → e.g. a landscape photo in a vertical video: the photo sits in a large card over a
//           blurred copy of itself, and the camera moves inside the card (shows the whole room)
async function prepareScene({ input, idx, W, H, cwd }) {
  const size = await mediaSize(input, cwd);
  const imgAspect = size ? size.w / size.h : W / H;
  const cover = Math.abs(Math.log(imgAspect / (W / H))) < 0.28;
  if (cover) {
    const still = `still${idx}.png`;
    const r = await runFfmpeg(['-loglevel', 'error', '-y', '-i', input, '-vf',
      `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W * 2}:${H * 2},setsar=1`, '-frames:v', '1', still], { cwd });
    if (!r.ok) throw new Error(`Could not prepare a photo (${r.error})`);
    return { cover: true, still };
  }
  // card size: as large as the frame allows, close to the photo's own shape
  const frameAspect = W / H;
  const cardAspect = Math.min(Math.max(imgAspect * (frameAspect < 1 ? 0.78 : 1), 0.8), frameAspect < 1 ? 1.3 : 1.9);
  let Wc = Math.round(W * (frameAspect < 1 ? 0.92 : 0.8));
  let Hc = Math.round(Wc / cardAspect);
  if (Hc > H * (frameAspect < 1 ? 0.62 : 0.78)) { Hc = Math.round(H * (frameAspect < 1 ? 0.62 : 0.78)); Wc = Math.round(Hc * cardAspect); }
  Wc -= Wc % 2; Hc -= Hc % 2;
  const bg = `bg${idx}.png`;
  const card = `card${idx}.png`;
  const r1 = await runFfmpeg(['-loglevel', 'error', '-y', '-i', input, '-vf',
    `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=45,eq=brightness=-0.16:saturation=1.1,setsar=1`, '-frames:v', '1', bg], { cwd });
  const r2 = await runFfmpeg(['-loglevel', 'error', '-y', '-i', input, '-vf',
    `scale=${Wc * 2}:${Hc * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${Wc * 2}:${Hc * 2},setsar=1`, '-frames:v', '1', card], { cwd });
  if (!r1.ok || !r2.ok) throw new Error(`Could not prepare a photo (${r1.error || r2.error})`);
  return { cover: false, bg, card, Wc, Hc };
}

async function makeEndStill({ bgInput, logo, out, W, H, cwd }) {
  const W2 = W * 2;
  const H2 = H * 2;
  const args = ['-loglevel', 'error', '-y'];
  let filter;
  if (bgInput) {
    args.push('-i', bgInput);
    filter = `[0:v]scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},gblur=sigma=80,eq=brightness=-0.42:saturation=0.8,setsar=1[bg]`;
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=0x0E0F12:s=${W2}x${H2}:d=1`);
    filter = '[0:v]setsar=1[bg]';
  }
  if (logo) {
    args.push('-i', logo);
    const lw = Math.round(Math.min(W2, H2) * 0.26);
    filter += `;[1:v]scale=${lw}:${lw}:force_original_aspect_ratio=decrease[lg];[bg][lg]overlay=(W-w)/2:H*0.3-h/2[o]`;
  } else {
    filter += ';[bg]null[o]';
  }
  const r = await runFfmpeg([...args, '-filter_complex', filter, '-map', '[o]', '-frames:v', '1', out], { cwd });
  if (!r.ok) throw new Error(`Could not prepare the end card (${r.error})`);
}

function motionExpr(motion, frames, amount) {
  const P = `((1-cos(PI*on/${frames}))/2)`; // smooth ease in-out
  const cx = '(iw-iw/zoom)/2';
  const cy = '(ih-ih/zoom)/2';
  switch (motion) {
    case 'pull_out': return { z: `1+${amount}*(1-${P})`, x: cx, y: cy };
    case 'pan_left': return { z: `${1 + amount}`, x: `(iw-iw/zoom)*(1-${P})`, y: cy };
    case 'pan_right': return { z: `${1 + amount}`, x: `(iw-iw/zoom)*${P}`, y: cy };
    case 'pan_up': return { z: `${1 + amount}`, x: cx, y: `(ih-ih/zoom)*(1-${P})` };
    case 'pan_down': return { z: `${1 + amount}`, x: cx, y: `(ih-ih/zoom)*${P}` };
    default: return { z: `1+${amount}*${P}`, x: cx, y: cy };
  }
}

async function makeClip({ scene, out, seconds, motion, W, H, cwd }) {
  const frames = Math.max(2, Math.round(seconds * FPS));
  const enc = ['-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS), out];
  let r;
  if (scene.cover) {
    const m = motionExpr(motion, frames, scene.amount ?? 0.13);
    r = await runFfmpeg(['-loglevel', 'error', '-y', '-i', scene.still, '-vf',
      `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p`, ...enc], { cwd });
  } else {
    const m = motionExpr(motion, frames, 0.16);
    const border = Math.max(2, Math.round(Math.min(W, H) * 0.004));
    const fx = `(W-w)/2`;
    const fy = `(H-h)/2-H*0.015`;
    r = await runFfmpeg(['-loglevel', 'error', '-y', '-loop', '1', '-i', scene.bg, '-i', scene.card, '-filter_complex',
      `[1:v]zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=${scene.Wc}x${scene.Hc}:fps=${FPS},`
      + `pad=iw+${border * 2}:ih+${border * 2}:${border}:${border}:color=white@0.85[fg];`
      + `[0:v]fps=${FPS}[bgv];[bgv][fg]overlay=${fx}:${fy}:shortest=1,format=yuv420p`, ...enc], { cwd });
  }
  if (!r.ok) throw new Error(`Could not animate a scene (${r.error})`);
}

/**
 * @param {object} o
 * @param {string} o.workDir           empty folder for this job (deleted by the caller)
 * @param {'9:16'|'1:1'|'16:9'|'4:3'} o.aspect
 * @param {{image:string, seconds:number, motion:string, headline?:string}[]} o.scenes  image = file name inside workDir
 * @param {{text:string,start:number,end:number}[]} o.words   spoken words with times (from the voice)
 * @param {string|null} o.voice        file name inside workDir (mp3) or null
 * @param {string|null} o.music        file name inside workDir or null
 * @param {number} o.lead               seconds of silence before the voice starts
 * @param {{seconds:number, headline?:string, cta?:string, contact?:string, logo?:string|null}} o.endCard
 * @param {string} [o.accent]          caption highlight colour, e.g. #FFD54A
 * @param {(stage:string, pct:number)=>void} [o.onProgress]
 * @returns {Promise<{ file: string, seconds: number }>}   file = absolute path of the finished MP4
 */
export async function renderShowcase({ workDir, aspect, scenes, words, voice, music, musicVolume = 0.3, lead = 0.4, endCard, accent, style: rawStyle, onProgress = () => {} }) {
  const style = cleanStyle(rawStyle);          // the Look: lettering, colour, pace
  const T = PACE_T[style.pace] || 0.45;        // how long one scene melts into the next
  const mv = Math.min(0.7, Math.max(0.05, Number(musicVolume) || 0.3));
  const { W, H } = SIZES[aspect] || SIZES['9:16'];
  const cwd = workDir;
  fs.mkdirSync(path.join(cwd, 'fonts'), { recursive: true });
  for (const f of fs.readdirSync(FONT_DIR)) if (f.endsWith('.ttf')) fs.copyFileSync(path.join(FONT_DIR, f), path.join(cwd, 'fonts', f));

  // 1. pictures → moving clips
  const clips = [];
  for (let i = 0; i < scenes.length; i += 1) {
    const s = scenes[i];
    onProgress('scenes', Math.round((i / (scenes.length + 1)) * 60));
    const prepared = await prepareScene({ input: s.image, idx: i, W, H, cwd });
    const clip = `clip${i}.mp4`;
    await makeClip({ scene: prepared, out: clip, seconds: s.seconds + T, motion: MOTIONS.includes(s.motion) ? s.motion : 'push_in', W, H, cwd });
    clips.push(clip);
  }
  onProgress('scenes', 60);
  const endSecs = Math.max(2.5, endCard?.seconds || 3.2);
  await makeEndStill({ bgInput: scenes[0]?.image || null, logo: endCard?.logo || null, out: 'end.png', W, H, cwd });
  await makeClip({ scene: { cover: true, still: 'end.png', amount: 0.04 }, out: 'end.mp4', seconds: endSecs, motion: 'push_in', W, H, cwd });
  clips.push('end.mp4');

  // 2. join with transitions
  onProgress('joining', 68);
  const total = scenes.reduce((a, s) => a + s.seconds, 0) + endSecs;
  let filter = '';
  let last = '[0:v]';
  let offset = 0;
  for (let i = 1; i < clips.length; i += 1) {
    offset += scenes[i - 1].seconds;
    const out = `[x${i}]`;
    const tr = i === clips.length - 1 ? 'fadeblack' : TRANSITIONS[(i - 1) % TRANSITIONS.length];
    filter += `${last}[${i}:v]xfade=transition=${tr}:duration=${T}:offset=${offset.toFixed(3)}${out};`;
    last = out;
  }
  const visualArgs = ['-loglevel', 'error', '-y'];
  clips.forEach((c) => visualArgs.push('-i', c));
  if (clips.length > 1) visualArgs.push('-filter_complex', filter.replace(/;$/, ''), '-map', last);
  const vr = await runFfmpeg([...visualArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-t', total.toFixed(3), 'visual.mp4'], { cwd });
  if (!vr.ok) throw new Error(`Could not join the scenes (${vr.error})`);

  // 3. captions + headlines + end card text
  fs.writeFileSync(path.join(cwd, 'subs.ass'), buildAss({
    W, H, words: words || [], scenes, lead, accent, style,
    endCard: endCard ? { ...endCard, seconds: endSecs, hasLogo: Boolean(endCard.logo) } : null
  }), 'utf8');

  // 4. sound: voice (+ music ducked under it), loudness for social apps
  onProgress('sound', 80);
  const args = ['-loglevel', 'error', '-y', '-i', 'visual.mp4'];
  const leadMs = Math.round(lead * 1000);
  let afilter;
  if (voice && music) {
    args.push('-i', voice, '-stream_loop', '-1', '-i', music);
    afilter = `[1:a]aresample=48000,adelay=${leadMs}|${leadMs},apad,asplit[v1][v2];`
      + `[2:a]aresample=48000,volume=${mv.toFixed(2)},afade=t=in:d=1.2,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[mu];`
      + '[mu][v1]sidechaincompress=threshold=0.015:ratio=9:attack=20:release=450[duck];'
      + '[duck][v2]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]';
  } else if (voice) {
    args.push('-i', voice);
    afilter = `[1:a]aresample=48000,adelay=${leadMs}|${leadMs},apad,loudnorm=I=-14:TP=-1.5:LRA=11[a]`;
  } else if (music) {
    args.push('-stream_loop', '-1', '-i', music);
    afilter = `[1:a]aresample=48000,volume=${Math.min(1, mv * 2).toFixed(2)},afade=t=in:d=1,afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2,loudnorm=I=-14:TP=-1.5:LRA=11[a]`;
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    afilter = '[1:a]anull[a]';
  }
  // The Look's colour mood and optional soft vignette, then the text on top
  const grade = GRADES[style.grade] || '';
  const vig = style.vignette ? 'vignette=angle=PI/5:mode=backward' : '';
  const vchain = [grade, vig, 'subtitles=subs.ass:fontsdir=fonts'].filter(Boolean).join(',');
  const final = 'final.mp4';
  const fr = await runFfmpeg([...args,
    '-filter_complex', `[0:v]${vchain}[v];${afilter}`,
    '-map', '[v]', '-map', '[a]', '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', final], { cwd, timeoutMs: 20 * 60_000 });
  if (!fr.ok) throw new Error(`Could not finish the video (${fr.error})`);
  onProgress('done', 100);
  return { file: path.join(cwd, final), seconds: total };
}
