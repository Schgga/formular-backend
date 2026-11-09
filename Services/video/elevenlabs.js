import { getDecryptedApiKey } from '../../Utils/encryption.js';

// =====================================================================
// ElevenLabs voiceover. The key is on your admin API Keys page as
//   elevenlabs_api_key
// We use "text to speech with timestamps", which also tells us when every
// letter is spoken — that is how scenes and captions line up with the voice.
// =====================================================================

const BASE = 'https://api.elevenlabs.io';
const MODEL = () => process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

export class VoiceError extends Error {}

async function key() {
  let k;
  try { k = await getDecryptedApiKey('elevenlabs_api_key'); } catch { k = ''; }
  k = String(k || '').trim().replace(/^["']|["']$/g, ''); // stray spaces/quotes from copy-paste
  if (!k) throw new VoiceError('The voice service is not set up yet (add elevenlabs_api_key on the API Keys page).');
  return k;
}

// ElevenLabs explains the problem in detail.status — turn it into a clear message
function friendly(status, body) {
  let code = '';
  let msg = '';
  try {
    const d = JSON.parse(body)?.detail;
    code = String(d?.status || d?.code || '').toLowerCase();
    msg = String(d?.message || (typeof d === 'string' ? d : '')).slice(0, 200);
  } catch { msg = String(body || '').slice(0, 200); }
  console.warn(`ElevenLabs said (${status}): ${code} ${msg}`.trim());
  const all = `${code} ${msg}`.toLowerCase();
  if (/missing_permissions|permission/.test(all)) {
    return new VoiceError('Your ElevenLabs API key is missing permissions. In ElevenLabs → Developers → API Keys, edit the key and allow "Text to Speech" and "Voices" (read), or create a new key with no restrictions.');
  }
  if (/unusual_activity|unusual activity|free tier/.test(all)) {
    return new VoiceError('ElevenLabs blocked the Free plan from your server ("unusual activity"). Upgrade to a paid plan (Starter or higher) — then it works.');
  }
  if (/quota|credits|exceeds your|character limit/.test(all) || status === 402) return new VoiceError('The voice service has no credit left. Top up your ElevenLabs plan.');
  if (/invalid_api_key|invalid api key|api key/.test(all) || status === 401) {
    return new VoiceError('ElevenLabs does not accept this API key. Copy the key again from ElevenLabs → Developers → API Keys and save it as elevenlabs_api_key on the API Keys page (no spaces).');
  }
  if (status === 403) return new VoiceError(`ElevenLabs refused the request${msg ? `: ${msg}` : '.'}`);
  if (status === 404) return new VoiceError('That voice is no longer available. Choose another voice.');
  if (status === 429) return new VoiceError('The voice service is busy. Please try again in a minute.');
  if (status === 422 || status === 400) return new VoiceError('The voice service did not accept the script.');
  return new VoiceError('The voice service is having problems. Please try again.');
}

export async function listVoices() {
  const res = await fetch(`${BASE}/v1/voices`, { headers: { 'xi-api-key': await key() }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw friendly(res.status, text);
  const data = JSON.parse(text);
  return (data.voices || []).map((v) => ({
    voiceId: v.voice_id,
    name: v.name || 'Voice',
    category: v.category || '',
    description: v.description || '',
    labels: v.labels || {},
    previewUrl: v.preview_url || '',
    languages: (v.verified_languages || []).map((l) => [l.language, l.accent].filter(Boolean).join(' ')).filter(Boolean)
  }));
}

// Turn ElevenLabs character timings into words
export function wordsFromAlignment(alignment) {
  const chars = alignment?.characters || [];
  const starts = alignment?.character_start_times_seconds || [];
  const ends = alignment?.character_end_times_seconds || [];
  const words = [];
  let cur = null;
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (/\s/.test(c)) { if (cur) { words.push(cur); cur = null; } continue; }
    if (!cur) cur = { text: '', start: starts[i] ?? 0, end: ends[i] ?? 0, index: i };
    cur.text += c;
    cur.end = ends[i] ?? cur.end;
  }
  if (cur) words.push(cur);
  return words;
}

/**
 * @returns {Promise<{ audio: Buffer, alignment: object, duration: number }>}
 */
const SAFE_MODEL = 'eleven_multilingual_v2'; // always supports word timings

export async function speak({ voiceId, text, speed = 1, stability = 0.45, style = 0.25 }) {
  if (!/^[A-Za-z0-9]{8,40}$/.test(String(voiceId || ''))) throw new VoiceError('Choose a voice.');
  const k = await key();
  const call = (model) => fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': k, 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability, similarity_boost: 0.8, style, use_speaker_boost: true, speed: Math.min(1.2, Math.max(0.7, speed)) }
    }),
    signal: AbortSignal.timeout(180_000)
  }).catch((e) => { throw new VoiceError(e?.name === 'TimeoutError' ? 'The voice service took too long.' : 'Could not reach the voice service.'); });

  const read = async (res) => {
    const body = await res.text();
    if (!res.ok) return { error: friendly(res.status, body), status: res.status };
    const data = JSON.parse(body);
    if (!data.audio_base64) return { error: new VoiceError('The voice service sent no audio.') };
    const alignment = data.alignment || data.normalized_alignment || {};
    const ends = alignment.character_end_times_seconds || [];
    return { audio: Buffer.from(data.audio_base64, 'base64'), alignment, duration: ends.length ? ends[ends.length - 1] : 0, hasTimings: ends.length > 0 };
  };

  let out = await read(await call(MODEL()));
  // A newer model set in .env (e.g. ELEVENLABS_MODEL=eleven_v4) that refuses the request
  // or sends no word timings → try again once with the model that always works.
  if (MODEL() !== SAFE_MODEL && ((out.error && [400, 422].includes(out.status)) || (!out.error && !out.hasTimings))) {
    console.warn(`ElevenLabs model ${MODEL()} could not be used for timed voiceover — using ${SAFE_MODEL}.`);
    out = await read(await call(SAFE_MODEL));
  }
  if (out.error) throw out.error;
  return { audio: out.audio, alignment: out.alignment, duration: out.duration };
}

/**
 * Make an AI copy of a voice ("Instant Voice Cloning", paid ElevenLabs plans).
 * Only ever used with the speaker's own consent (checked by the caller).
 * @param {{ name: string, files: { buffer: Buffer, filename: string }[], description?: string }} o
 * @returns {Promise<string>} the new voice_id
 */
export async function cloneVoice({ name, files, description = '' }) {
  const form = new FormData();
  form.append('name', String(name).slice(0, 60));
  form.append('description', String(description).slice(0, 200));
  form.append('remove_background_noise', 'true');
  for (const f of files) form.append('files', new Blob([f.buffer], { type: 'audio/mpeg' }), f.filename);
  let res;
  try {
    res = await fetch(`${BASE}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': await key() }, body: form, signal: AbortSignal.timeout(180_000) });
  } catch (e) {
    throw new VoiceError(e?.name === 'TimeoutError' ? 'The voice service took too long.' : 'Could not reach the voice service.');
  }
  const text = await res.text();
  if (!res.ok) {
    if (/voice_limit|limit_reached|maximum amount of custom voices|voices limit/i.test(text)) {
      console.warn('ElevenLabs said:', text.slice(0, 200));
      throw new VoiceError('Voice copying is full right now (the voice account has no free voice slots). Please try again later.');
    }
    if (/can_not_use_instant_voice_cloning|instant voice cloning|subscription|upgrade/i.test(text)) {
      console.warn('ElevenLabs said:', text.slice(0, 200));
      throw new VoiceError('Voice copying needs a paid ElevenLabs plan (Starter or higher).');
    }
    throw friendly(res.status, text);
  }
  const data = JSON.parse(text);
  if (!data.voice_id) throw new VoiceError('The voice service did not make the voice. Please try again.');
  return data.voice_id;
}

export async function deleteVoice(voiceId) {
  if (!/^[A-Za-z0-9]{8,40}$/.test(String(voiceId || ''))) return;
  try {
    await fetch(`${BASE}/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE', headers: { 'xi-api-key': await key() }, signal: AbortSignal.timeout(30_000) });
  } catch { /* the voice stays in the account; the admin can remove it there */ }
}
