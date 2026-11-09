import { getDecryptedApiKey } from '../../Utils/encryption.js';

// How long we wait for a template server in total (connecting + creating the site).
export const PROVISION_TIMEOUT_MS = 20000;

/**
 * A provisioning failure with a short machine-readable reason, so the website page
 * can show the right explanation:
 *   timeout       — the template server did not answer in time (slow or busy network)
 *   unreachable   — could not connect at all (server down, firewall, network)
 *   dns           — the domain name could not be found (new domain / DNS not set up)
 *   ssl           — the domain's HTTPS certificate is missing or invalid
 *   unauthorized  — the API key in Formular does not match the template server
 *   blocked       — a firewall / security filter on the server refused the request
 *   server_config — the template server is not fully set up (e.g. env.php)
 *   not_found     — the provision address is wrong (template files missing)
 *   taken         — the template says this address is already in use
 *   invalid       — the template refused the details (bad subdomain, unknown design…)
 *   server_error  — the template server crashed (500)
 *   bad_response  — the template answered with something unexpected
 *   no_api_key    — no API key saved in Formular for this template
 * `sent` is false when the request never reached the server (safe to forget the site).
 */
export class ProvisionError extends Error {
  constructor(reason, message, { detail = null, status = null, sent = true } = {}) {
    super(message);
    this.name = 'ProvisionError';
    this.reason = reason;
    this.detail = detail;
    this.status = status;
    this.sent = sent;
  }
}

// Errors that happen before the request reaches the server: safe to retry, nothing was created.
const CONNECT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT']);

function errCode(err) {
  return err?.cause?.code || err?.code || '';
}

function classifyNetworkError(err, timedOut) {
  const code = errCode(err);
  const sent = !CONNECT_CODES.has(code) && !timedOut?.beforeConnect;
  if (timedOut?.value || err?.name === 'TimeoutError' || err?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'ETIMEDOUT') {
    const detail = code === 'UND_ERR_CONNECT_TIMEOUT' ? 'Could not connect within 20 seconds' : `No answer after ${PROVISION_TIMEOUT_MS / 1000} seconds`;
    return new ProvisionError('timeout', 'The website server did not answer in time.', { detail, sent: code === 'UND_ERR_CONNECT_TIMEOUT' ? false : sent });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new ProvisionError('dns', 'The website domain could not be found.', { detail: code, sent: false });
  }
  if (code.startsWith('ERR_TLS') || code.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new ProvisionError('ssl', 'The website domain has no valid HTTPS certificate yet.', { detail: code, sent: false });
  }
  return new ProvisionError('unreachable', 'Could not connect to the website server.', { detail: code || err?.message, sent: CONNECT_CODES.has(code) ? false : sent });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function classifyHttpError(status, rawText) {
  const json = parseJson(rawText);
  const msg = typeof json?.error === 'string' ? json.error.slice(0, 300) : null;
  if (status === 401) return new ProvisionError('unauthorized', 'The template server refused Formular\'s API key.', { detail: msg, status });
  if (status === 403) {
    return json ? new ProvisionError('unauthorized', 'The template server refused the request.', { detail: msg, status })
                : new ProvisionError('blocked', 'A firewall or security filter on the server blocked the request.', { detail: 'HTTP 403 (not from the template)', status });
  }
  if (status === 404) return new ProvisionError('not_found', 'The template was not found at its provision address.', { detail: msg || 'HTTP 404', status });
  if (status === 409) return new ProvisionError('taken', 'That web address is already in use.', { detail: msg, status });
  if (status === 400 || status === 422) return new ProvisionError('invalid', msg || 'The template refused these details.', { detail: msg, status });
  if (status === 503) return new ProvisionError('server_config', 'The template server is not fully set up yet.', { detail: msg || 'HTTP 503', status });
  if (status === 429) return new ProvisionError('blocked', 'The server is limiting requests right now. Wait a minute and try again.', { detail: msg || 'HTTP 429', status });
  return new ProvisionError('server_error', 'The template server had an error.', { detail: msg || `HTTP ${status}`, status });
}

/**
 * POST to the template, waiting up to PROVISION_TIMEOUT_MS in total. Node's fetch gives up
 * connecting after 10 seconds, so when the connection itself times out (nothing reached the
 * server yet) we try once more with the time that is left.
 */
async function postWithDeadline(url, init) {
  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(remaining) });
      const rawText = await response.text();
      return { response, rawText };
    } catch (err) {
      lastErr = err;
      const code = errCode(err);
      // Only retry when the request never reached the server, so a site can't be created twice.
      if (!['UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) break;
      console.warn(`Provision attempt ${attempt} could not connect (${code}); retrying with ${Math.round((deadline - Date.now()) / 1000)}s left`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw classifyNetworkError(lastErr, { value: Date.now() >= deadline - 1500 });
}

export async function provisionWebsite({ catalogEntry, subdomain, businessName, logoUrl, description, primaryCurrency, country, adminLoginMethod, adminAccessCode, adminEmail, adminPassword, visitorSupportMode, liveChatScript, supportPosition, supportEmail, supportPhone, supportWhatsapp, supportTelegram, supportFacebook, supportInstagram, supportX, supportTiktok }) {
  let apiKey;
  try {
    apiKey = await getDecryptedApiKey(catalogEntry.provision_api_key_name);
  } catch (err) {
    throw new ProvisionError('no_api_key', 'No API key is saved in Formular for this template.', { detail: catalogEntry.provision_api_key_name, sent: false });
  }
  if (!apiKey) {
    throw new ProvisionError('no_api_key', 'No API key is saved in Formular for this template.', { detail: catalogEntry.provision_api_key_name, sent: false });
  }

  console.log('DEBUG — calling provision endpoint:', catalogEntry.provision_endpoint);

  const { response, rawText } = await postWithDeadline(catalogEntry.provision_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({
      subdomain,
      base_domain: catalogEntry.base_domain,
      design_key: catalogEntry.design_key || 'executive',
      business_name: businessName,
      logo_url: logoUrl,
      description,
      primary_currency: primaryCurrency || null,
      country: country || null,          // two letters, e.g. "GH" — sets the currency and clock on the new site
      admin_login_method: adminLoginMethod || 'access_code',
      admin_access_code: adminAccessCode || null,
      admin_email: adminEmail || null,
      admin_password: adminPassword || null,
      visitor_support_mode: visitorSupportMode || 'off',
      live_chat_script: liveChatScript || null,
      support_position: supportPosition || 'right',
      support_email: supportEmail || null,
      support_phone: supportPhone || null,
      support_whatsapp: supportWhatsapp || null,
      support_telegram: supportTelegram || null,
      support_facebook: supportFacebook || null,
      support_instagram: supportInstagram || null,
      support_x: supportX || null,
      support_tiktok: supportTiktok || null
    })
  });

  console.log('DEBUG — raw response status:', response.status);
  console.log('DEBUG — FULL raw response body:', rawText);

  if (!response.ok) {
    throw classifyHttpError(response.status, rawText);
  }

  const data = parseJson(rawText);
  if (!data || typeof data !== 'object') {
    throw new ProvisionError('bad_response', 'The template server answered with something unexpected.', { detail: rawText.slice(0, 200), status: response.status });
  }
  const fullDomain = `${subdomain}.${catalogEntry.base_domain}`;

  return {
    siteUrl: data.site_url || `https://${fullDomain}`,
    adminUrl: data.admin_url || null,
    accessCode: data.access_code || null
  };
}

export async function deprovisionWebsite({ catalogEntry, subdomain, fullHost }) {
  const apiKey = await getDecryptedApiKey(catalogEntry.provision_api_key_name);
  const deprovisionEndpoint = catalogEntry.provision_endpoint.replace('provision.php', 'deprovision.php').replace('/provision', '/deprovision');

  const response = await fetch(deprovisionEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ subdomain, fullHost }),
    signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Template deprovisioning failed: ${response.status} ${errText}`);
  }
  return response.json();
}
