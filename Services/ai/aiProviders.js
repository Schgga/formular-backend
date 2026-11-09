// =====================================================================
// One small door to the AI services. The super admin picks the service and
// model on the AI Writers page; this file knows how to talk to each one.
//
// Safety:
//  - Only these four fixed addresses are ever called (no admin-typed URLs).
//  - The API key is only used here, on the server. It is never logged or returned.
//  - The AI gets no tools and cannot browse; it can only return JSON text.
// =====================================================================

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', hint: 'e.g. claude-sonnet-5-5 or claude-haiku-5-5' },
  openai: { label: 'OpenAI (GPT)', hint: 'the model name from your OpenAI dashboard' },
  google: { label: 'Google (Gemini)', hint: 'the model name from Google AI Studio' },
  openrouter: { label: 'OpenRouter (many models, one key)', hint: 'Use "Browse models", or type any name from openrouter.ai/models (like provider/model-name)' }
};

export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{1,79}$/;

export class AiError extends Error {
  constructor(message, { status = 0, retryable = false, adminDetail = '' } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.adminDetail = adminDetail;
  }
}

// Remove anything that looks like a key before showing a provider message to the admin
const scrub = (s) => String(s || '')
  .replace(/(sk|key|AIza)[-_A-Za-z0-9]{12,}/g, '[hidden]')
  .replace(/\s+/g, ' ')
  .slice(0, 200);

function friendly(status, provider, bodyText) {
  const detail = scrub(bodyText);
  // Model exists but is not offered to apps like ours (e.g. "only available on agentic harnesses")
  if (/only available on|harness|not available for|not supported for this|no allowed providers|guardrail|data policy/i.test(detail)) {
    return new AiError('This model cannot be used by this website (the AI service only offers it inside certain apps or with other privacy settings). Choose another model.', { status, adminDetail: detail });
  }
  if (status === 401 || status === 403) return new AiError('The AI service rejected the API key.', { status, adminDetail: detail });
  if (status === 402 || /credit|insufficient|afford|quota|billing/i.test(detail)) {
    return new AiError('The AI account has no credit left, or not enough for this length. Top up on the AI service website (or lower "Max answer length").', { status, adminDetail: detail });
  }
  if (/model/i.test(detail) && /(not a valid|not found|invalid|does not exist|unknown|no endpoints)/i.test(detail)) {
    return new AiError('The AI service does not know this model name.', { status, adminDetail: detail });
  }
  if (/max_tokens|max_completion_tokens|maximum context|too many tokens|context length/i.test(detail)) {
    return new AiError('This model cannot write such a long answer. Lower "Max answer length" on the AI Writers page.', { status, adminDetail: detail });
  }
  if (status === 404) return new AiError('The AI service does not know this model name.', { status, adminDetail: detail });
  if (status === 400 || status === 422) return new AiError('The AI service did not accept the request.', { status, adminDetail: detail });
  if (status === 429) return new AiError('The AI service is busy (rate limit). Please try again shortly.', { status, retryable: true, adminDetail: detail });
  if (status >= 500) return new AiError('The AI service is having problems right now. Please try again.', { status, retryable: true, adminDetail: detail });
  return new AiError(`Unexpected reply from ${PROVIDERS[provider]?.label || provider}.`, { status, adminDetail: detail });
}

async function post(url, headers, body, timeoutMs, provider) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new AiError(timedOut ? 'The AI took too long to answer. Please try again.' : 'Could not reach the AI service.', {
      retryable: true, adminDetail: scrub(err?.message)
    });
  }
  let text;
  try {
    text = await res.text(); // the time limit also covers reading the answer
  } catch (err) {
    throw new AiError('The AI took too long to answer. Please try again.', { retryable: true, adminDetail: scrub(err?.message) });
  }
  if (!res.ok) throw friendly(res.status, provider, text);
  try { return JSON.parse(text); } catch { throw new AiError('The AI service sent a reply we could not read.', { adminDetail: scrub(text) }); }
}

// Pull a JSON object out of model text (handles ```json fences and extra words)
export function parseJsonText(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* try the outer braces */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ }
  }
  throw new AiError('The AI reply was not in the expected format. Please try again.', { retryable: true });
}

/**
 * Ask a model for one JSON object.
 * @returns {Promise<{ data: object, tokensIn: number, tokensOut: number }>}
 */
export async function callAI({ provider, model, apiKey, system, prompt, schema, schemaName = 'result', maxTokens = 6000, timeoutMs = 90_000, images = [] }) {
  // images: [{ mime: 'image/jpeg', data: '<base64>' }] — sent with the prompt for vision models
  if (!PROVIDERS[provider]) throw new AiError('Unknown AI service.');
  if (!MODEL_NAME_RE.test(String(model || ''))) throw new AiError('Invalid model name.');
  if (!apiKey) throw new AiError('This AI writer has no API key yet.');
  const schemaText = `\n\nReturn ONLY one JSON object that matches this JSON Schema (no other text):\n${JSON.stringify(schema)}`;

  if (provider === 'anthropic') {
    // Forced tool call = the reply is guaranteed to be a JSON object of our shape
    const out = await post('https://api.anthropic.com/v1/messages', {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }, {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: images.length ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } })), { type: 'text', text: prompt }] : prompt }],
      tools: [{ name: schemaName, description: 'Return the finished result.', input_schema: schema }],
      tool_choice: { type: 'tool', name: schemaName }
    }, timeoutMs, provider);
    const block = (out.content || []).find((c) => c.type === 'tool_use');
    const textBlock = (out.content || []).find((c) => c.type === 'text');
    const data = block?.input || (textBlock ? parseJsonText(textBlock.text) : null);
    if (!data || typeof data !== 'object') throw new AiError('The AI returned an empty answer. Please try again.', { retryable: true });
    if (out.stop_reason === 'max_tokens') throw new AiError('The AI ran out of space before finishing. Please try again — if it keeps happening, the admin should raise "Max answer length" for this AI writer.', { retryable: true });
    return { data, tokensIn: out.usage?.input_tokens || 0, tokensOut: out.usage?.output_tokens || 0 };
  }

  if (provider === 'openai') {
    const out = await post('https://api.openai.com/v1/chat/completions', {
      authorization: `Bearer ${apiKey}`
    }, {
      model,
      max_completion_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system + schemaText },
        { role: 'user', content: images.length ? [{ type: 'text', text: prompt }, ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } }))] : prompt }
      ]
    }, timeoutMs, provider);
    const choice = out.choices?.[0];
    if (choice?.finish_reason === 'length') throw new AiError('The AI ran out of space before finishing. Please try again — if it keeps happening, the admin should raise "Max answer length" for this AI writer.', { retryable: true });
    const data = parseJsonText(choice?.message?.content);
    return { data, tokensIn: out.usage?.prompt_tokens || 0, tokensOut: out.usage?.completion_tokens || 0 };
  }

  if (provider === 'openrouter') {
    // OpenRouter speaks the OpenAI format. We don't force JSON mode because not every
    // model behind it supports it — the schema in the instructions + our parser handle it.
    const out = await post('https://openrouter.ai/api/v1/chat/completions', {
      authorization: `Bearer ${apiKey}`,
      'x-title': 'Formular Video Planner'
    }, {
      model,
      max_tokens: maxTokens,
      // "Thinking" models spend part of max_tokens on hidden reasoning; keep it short
      // so the plan itself has room. Models that don't think ignore this.
      reasoning: { effort: 'low', exclude: true },
      messages: [
        { role: 'system', content: system + schemaText },
        { role: 'user', content: images.length ? [{ type: 'text', text: prompt }, ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } }))] : prompt }
      ]
    }, timeoutMs, provider);
    if (out.error) throw friendly(Number(out.error.code) || 502, provider, out.error.message);
    const choice = out.choices?.[0];
    if (choice?.finish_reason === 'length') throw new AiError('The AI ran out of space before finishing. Please try again — if it keeps happening, the admin should raise "Max answer length" for this AI writer.', { retryable: true });
    const data = parseJsonText(choice?.message?.content);
    return { data, tokensIn: out.usage?.prompt_tokens || 0, tokensOut: out.usage?.completion_tokens || 0 };
  }

  // google
  const out = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    'x-goog-api-key': apiKey
  }, {
    systemInstruction: { parts: [{ text: system + schemaText }] },
    contents: [{ role: 'user', parts: [...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })), { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens }
  }, timeoutMs, provider);
  const cand = out.candidates?.[0];
  if (cand?.finishReason === 'MAX_TOKENS') throw new AiError('The AI ran out of space before finishing. Please try again — if it keeps happening, the admin should raise "Max answer length" for this AI writer.', { retryable: true });
  if (cand?.finishReason === 'SAFETY') throw new AiError('The AI refused this request. Try different wording.', {});
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  const data = parseJsonText(text);
  return { data, tokensIn: out.usageMetadata?.promptTokenCount || 0, tokensOut: out.usageMetadata?.candidatesTokenCount || 0 };
}

// Used by the "Test connection" button
export async function testWriter({ provider, model, apiKey, maxTokens = 2000 }) {
  const started = Date.now();
  const { data } = await callAI({
    provider, model, apiKey,
    system: 'You are a connection test. Follow the instructions exactly.',
    prompt: 'Return ok = true and word = "ready".',
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, word: { type: 'string' } },
      required: ['ok', 'word']
    },
    schemaName: 'connection_test',
    maxTokens, // "thinking" models use part of this to think first, so not too small
    timeoutMs: 60_000
  });
  return { ok: data?.ok === true, ms: Date.now() - started };
}

// =====================================================================
// MODEL LIST for the admin "Browse models" button.
// OpenRouter's list is public (no key needed). The others need the API key.
// Returns [{ id, name, free, vision, inPrice, outPrice, context }]
//   inPrice / outPrice = US dollars per 1 million tokens (null when unknown)
// =====================================================================
let orCache = { at: 0, list: null };

async function getJson(url, headers) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new AiError('Could not reach the AI service to list its models.');
  }
  const text = await res.text();
  if (!res.ok) throw friendly(res.status, '', text);
  try { return JSON.parse(text); } catch { throw new AiError('The AI service sent a model list we could not read.'); }
}

export async function listModels({ provider, apiKey }) {
  if (provider === 'openrouter') {
    if (!orCache.list || Date.now() - orCache.at > 30 * 60_000) {
      const d = await getJson('https://openrouter.ai/api/v1/models', {});
      orCache = {
        at: Date.now(),
        list: (d.data || [])
          .filter((m) => MODEL_NAME_RE.test(String(m.id || '')))
          .filter((m) => { const out = m.architecture?.output_modalities; return !Array.isArray(out) || out.includes('text'); }) // writers must answer in text
          .map((m) => {
          const inP = Number(m.pricing?.prompt);
          const outP = Number(m.pricing?.completion);
          const mods = m.architecture?.input_modalities || String(m.architecture?.modality || '').split('->')[0].split('+');
          return {
            id: m.id,
            name: String(m.name || m.id).slice(0, 100),
            free: /:free$/.test(m.id) || (inP === 0 && outP === 0),
            vision: mods.includes('image'),
            inPrice: Number.isFinite(inP) ? Math.round(inP * 1e6 * 1000) / 1000 : null,
            outPrice: Number.isFinite(outP) ? Math.round(outP * 1e6 * 1000) / 1000 : null,
            context: Number(m.context_length) || null
          };
        })
      };
    }
    return orCache.list;
  }
  if (!apiKey) throw new AiError('Paste the API key first — this service only shows its models to key holders.');
  if (provider === 'anthropic') {
    const d = await getJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
    return (d.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id, free: false, vision: true, inPrice: null, outPrice: null, context: null }));
  }
  if (provider === 'openai') {
    const d = await getJson('https://api.openai.com/v1/models', { authorization: `Bearer ${apiKey}` });
    return (d.data || [])
      .filter((m) => /^(gpt-|o\d|chatgpt)/i.test(m.id) && !/(audio|realtime|tts|transcribe|search|image|embedding|moderation|instruct)/i.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map((m) => ({ id: m.id, name: m.id, free: false, vision: /^(gpt-4o|gpt-4\.1|gpt-5|o\d|chatgpt-4o)/i.test(m.id), inPrice: null, outPrice: null, context: null }));
  }
  if (provider === 'google') {
    const d = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': apiKey });
    return (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ''), name: m.displayName || m.name, free: false, vision: true, inPrice: null, outPrice: null, context: Number(m.inputTokenLimit) || null }));
  }
  throw new AiError('Unknown AI service.');
}
