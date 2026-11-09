import { pool } from '../../db.js';

// =====================================================================
// LOOKS — the style recipe a video is made in.
//
// A Look does two things:
//   1. direction  → extra creative instructions for the AI writer
//   2. style      → how the video is put together (lettering, pace,
//                   camera, colour, music level, last screen)
//
// Anything the admin (or a user) types is treated as UNTRUSTED:
//   - only style keys we know are used, and only with values we allow,
//   - the direction text is trimmed and can never replace the safety
//     rules or the JSON format rules in the main instructions.
// So a badly written Look can change how a video LOOKS, but can never
// break the video maker.
// =====================================================================

export const FONTS = {
  modern: { head: 'Montserrat Black', cap: 'Montserrat ExtraBold', body: 'Montserrat SemiBold' },
  elegant: { head: 'Lora', cap: 'Montserrat ExtraBold', body: 'Lora' },
  friendly: { head: 'Poppins', cap: 'Poppins', body: 'Poppins' }
};
export const PACES = {
  // how many scenes per 30 seconds, and the shortest a scene may be
  calm: { per30: 3.5, minScene: 3.6, transition: 0.6 },
  normal: { per30: 4.5, minScene: 2.8, transition: 0.45 },
  snappy: { per30: 6, minScene: 2.0, transition: 0.3 }
};
// Gentle colour grading — the same photo, in a different mood
export const GRADES = {
  neutral: '',
  warm: 'eq=saturation=1.14:contrast=1.05:gamma_r=1.04:gamma_b=0.97',
  rich: 'eq=saturation=1.10:contrast=1.10:gamma=0.97',
  cool: 'eq=saturation=0.96:contrast=1.04:gamma_b=1.05:gamma_r=0.98',
  bright: 'eq=saturation=1.05:contrast=1.02:brightness=0.035'
};
export const HEADLINE_POS = ['top', 'middle', 'bottom'];
export const END_CARDS = ['minimal', 'bold'];
export const MUSIC_LEVELS = ['soft', 'medium', 'loud'];
const MOTIONS = ['push_in', 'pull_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down'];

export const DEFAULT_STYLE = {
  font: 'modern',
  pace: 'normal',
  motions: MOTIONS,
  headline: 'bottom',
  caps: false,
  accent: '#FFD54A',
  grade: 'neutral',
  vignette: false,
  musicVolume: 'medium',
  endCard: 'minimal'
};

const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const hex = (v, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v).toUpperCase() : fallback);

/** Keep only the keys we understand, with values we allow. */
export function cleanStyle(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const motions = Array.isArray(s.motions) ? s.motions.filter((m) => MOTIONS.includes(m)) : [];
  return {
    font: oneOf(s.font, Object.keys(FONTS), DEFAULT_STYLE.font),
    pace: oneOf(s.pace, Object.keys(PACES), DEFAULT_STYLE.pace),
    motions: motions.length ? [...new Set(motions)] : MOTIONS,
    headline: oneOf(s.headline, HEADLINE_POS, DEFAULT_STYLE.headline),
    caps: s.caps === true,
    accent: hex(s.accent, DEFAULT_STYLE.accent),
    grade: oneOf(s.grade, Object.keys(GRADES), DEFAULT_STYLE.grade),
    vignette: s.vignette === true,
    musicVolume: oneOf(s.musicVolume, MUSIC_LEVELS, DEFAULT_STYLE.musicVolume),
    endCard: oneOf(s.endCard, END_CARDS, DEFAULT_STYLE.endCard)
  };
}

const MAX_DIRECTION = 2500;
export const cleanDirection = (v) => String(v ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
  .trim()
  .slice(0, MAX_DIRECTION);

const row = (r) => ({
  id: Number(r.id),
  key: r.look_key,
  name: r.display_name,
  description: r.description || '',
  suits: r.suits || '',
  direction: cleanDirection(r.direction),
  style: cleanStyle(r.style),
  mine: Boolean(r.user_id),
  isActive: r.is_active !== false,
  sortOrder: Number(r.sort_order) || 0
});

/** The Looks a user may pick: the built-in ones plus their own. */
export async function looksFor(userId) {
  try {
    const r = await pool.query(
      `SELECT * FROM video_looks
       WHERE is_active = TRUE AND (user_id IS NULL OR user_id = $1)
       ORDER BY (user_id IS NOT NULL), sort_order, id`,
      [String(userId || '')]);
    return r.rows.map(row);
  } catch { return []; } // table not created yet: videos still work, just without Looks
}

/** One Look by its key, for this user. Returns null when there is none. */
export async function lookByKey(key, userId) {
  if (!key) return null;
  try {
    const r = await pool.query(
      `SELECT * FROM video_looks
       WHERE look_key = $1 AND is_active = TRUE AND (user_id IS NULL OR user_id = $2)
       ORDER BY (user_id IS NOT NULL) DESC LIMIT 1`,
      [String(key).slice(0, 40), String(userId || '')]);
    return r.rows[0] ? row(r.rows[0]) : null;
  } catch { return null; }
}

/** Everything the renderer needs, whether or not a Look was chosen. */
export const styleOf = (look) => cleanStyle(look?.style);

/**
 * How many scenes this Look wants for a video of this length, and how short
 * a scene may be. Used both in the AI instructions and when checking the script.
 */
export function sceneBudget(look, seconds) {
  const pace = PACES[styleOf(look).pace] || PACES.normal;
  const want = Math.max(3, Math.round((seconds / 30) * pace.per30));
  return { min: Math.max(3, want - 1), max: want + 2, minScene: pace.minScene, transition: pace.transition };
}
