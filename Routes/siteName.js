// =====================================================================
// SITE NAME for backend pages and emails ("Powered by ...", email footers).
// Reads the same name your admin sets in Settings, from your own /api/settings,
// so nothing is hard-coded. Refreshes itself every 5 minutes.
//
// Optional in .env:
//   SITE_NAME=...                     used until the first read finishes (or if it fails)
//   SETTINGS_URL=http://127.0.0.1:4000/api/settings   only if your settings live elsewhere
// =====================================================================

let cached = (process.env.SITE_NAME || '').trim();
let lastTry = 0;

async function refresh() {
  lastTry = Date.now();
  try {
    const url = process.env.SETTINGS_URL || `http://127.0.0.1:${process.env.PORT || 4000}/api/settings`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    const name = String(d?.settings?.site_name || '').trim();
    if (d?.success && name) cached = name.slice(0, 80);
  } catch { /* keep the last known name */ }
}

// Fast, never waits: returns the last known name ('' if not known yet)
export function siteName() {
  if (Date.now() - lastTry > 5 * 60 * 1000) refresh();
  return cached;
}

// "Powered by X" (or nothing when the name is not known yet)
export const poweredBy = () => (siteName() ? `Powered by ${siteName()}` : '');

setTimeout(refresh, 2500).unref?.();