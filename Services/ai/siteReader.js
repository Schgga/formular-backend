import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

// =====================================================================
// Reads the PUBLIC pages of a user's own website so the AI knows the real
// listings, rooms, menu, products, prices and services.
//
// Safety (stops anyone using this to reach private machines — "SSRF"):
//  - only the website address saved in user_websites is read (never a URL the user types)
//  - only http/https on ports 80/443
//  - every connection is checked AT CONNECT TIME: private, local and internal
//    addresses (127.x, 10.x, 192.168.x, 169.254.x, ::1 ...) are refused
//  - same website only (no jumping to other sites), max 3 redirects
//    PHOTOS may also come from the same main domain (e.g. cdn.yoursite.com for
//    yoursite.com), from well-known photo hosts (Cloudinary, Unsplash, Pexels…),
//    or from hosts you add in .env:  VIDEO_PHOTO_HOSTS=cdn.example.com,photos.example.net
//    (still public internet only — private addresses are always refused)
//  - 15 second timeout, max 900 KB per page, max 5 pages
//  - we only keep visible text; scripts and styles are thrown away
// =====================================================================

const MAX_BYTES = 900 * 1024;
const TIMEOUT_MS = 15000;
const MAX_PAGES = 5;
const MAX_CHARS = 14000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_PHOTOS = 24;
const UA = 'FormularVideoPlanner/1.0 (+reads the owner\'s own public pages)';

function ipv4ToInt(ip) {
  return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^f[cd]/.test(v)) return true;          // fc00::/7 unique local
    if (/^fe[89ab]/.test(v)) return true;       // fe80::/10 link local
    if (/^ff/.test(v)) return true;             // multicast
    if (/^2001:db8/.test(v)) return true;       // documentation
    return false;
  }
  return true;
}

// Only for testing on your own computer: SITE_READER_ALLOW_PRIVATE=1 (never on the live server)
const allowPrivate = () => process.env.SITE_READER_ALLOW_PRIVATE === '1' && process.env.NODE_ENV !== 'production';

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad && !allowPrivate()) return cb(new Error('Blocked private address'));
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

function getOnce(url, { image = false } = {}) {
  const maxBytes = image ? MAX_IMAGE_BYTES : MAX_BYTES;
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      lookup: safeLookup,
      headers: { 'user-agent': UA, accept: image ? 'image/jpeg,image/png,image/webp' : 'text/html,application/xhtml+xml' },
      timeout: TIMEOUT_MS
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location, status });
      }
      const type = String(res.headers['content-type'] || '');
      // Some hosts send photos as "application/octet-stream" — the first bytes are checked later anyway
      const okType = image ? /^(image\/(jpeg|jpg|pjpeg|png|webp)|application\/octet-stream|binary\/octet-stream)/i.test(type) || !type : /text\/html|application\/xhtml/i.test(type);
      if (status !== 200 || !okType) {
        res.resume();
        return resolve({ status, html: '', body: null });
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); return; }
        chunks.push(c);
      });
      const done = () => {
        const buf = Buffer.concat(chunks);
        if (size > maxBytes) return resolve({ status: 413, html: '', body: null });
        resolve({ status, html: image ? '' : buf.toString('utf8'), body: image ? buf : null, type });
      };
      res.on('end', done);
      res.on('close', done);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

const sameSite = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

// "shop.lekkihomes.com.ng" → "lekkihomes.com.ng";  "cdn.site.com" → "site.com"
const TWO_PART = /\.(com|net|org|gov|edu|co|ac|sch|mil|name|ltd|plc|or|ne|go)\.[a-z]{2}$/i;
export function baseDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (net.isIP(h)) return h;
  const parts = h.split('.');
  return parts.slice(TWO_PART.test(h) ? -3 : -2).join('.');
}
// Where website builders usually keep photos (your own uploads go to Cloudinary)
const PHOTO_CDNS = ['res.cloudinary.com', 'images.unsplash.com', 'plus.unsplash.com', 'images.pexels.com', 'cdn.pixabay.com',
  'firebasestorage.googleapis.com', 'storage.googleapis.com', 'amazonaws.com', 'cloudfront.net', 'imagekit.io', 'imgix.net',
  'cdn.shopify.com', 'i.ibb.co', 'i.imgur.com', 'ucarecdn.com', 'b-cdn.net', 'r2.dev', 'wp.com', 'supabase.co'];
const photoHosts = () => [...PHOTO_CDNS, ...String(process.env.VIDEO_PHOTO_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)];
const onPhotoCdn = (host) => photoHosts().some((x) => host === x || host.endsWith(`.${x}`));
function photoHostOk(host, home) {
  const h = String(host).toLowerCase();
  if (sameSite(h, home.hostname) || baseDomain(h) === baseDomain(home.hostname)) return true;
  return onPhotoCdn(h);
}

function checkUrl(u, home, { photo = false } = {}) {
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  if (u.port && !['80', '443'].includes(u.port) && !allowPrivate()) return false;
  if (u.username || u.password) return false;
  return photo ? photoHostOk(u.hostname, home) : sameSite(u.hostname, home.hostname);
}

async function fetchPage(startUrl, home, opts = {}) {
  let url = startUrl;
  for (let hop = 0; hop <= 3; hop++) {
    if (!checkUrl(url, home, { photo: Boolean(opts.image) })) throw new Error('Left the website');
    const r = await getOnce(url, opts);
    if (r.redirect) { url = new URL(r.redirect, url); continue; }
    return { url: url.toString(), html: r.html || '', body: r.body || null, status: r.status, type: r.type };
  }
  throw new Error('Too many redirects');
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", naira: '₦', pound: '£', euro: '€' };
function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&([a-z#0-9]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
const squash = (s) => decode(s).replace(/\s+/g, ' ').trim();

export function extractPage(html) {
  const clean = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)[\s\S]*?<\/\1>/gi, ' ');
  const title = squash((clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const meta = squash((clean.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || '');
  const alts = [...clean.matchAll(/<img[^>]+alt=["']([^"']{3,120})["']/gi)].map((m) => squash(m[1])).filter(Boolean);
  const images = [];
  const og = (clean.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || [])[1];
  if (og) images.push({ src: decode(og), alt: 'Main picture' });
  for (const m of clean.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    let src = (tag.match(/\s(?:data-src|data-lazy-src|data-original|src)=["']([^"']+)["']/i) || [])[1];
    if (!src || /^data:/i.test(src)) {
      // srcset only: take the largest picture
      const set = (tag.match(/\s(?:data-srcset|srcset)=["']([^"']+)["']/i) || [])[1];
      src = set ? set.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop() : '';
    }
    if (!src || /^data:/i.test(src)) continue;
    const alt = squash((tag.match(/\salt=["']([^"']*)["']/i) || [])[1] || '');
    images.push({ src: decode(src), alt });
  }
  // background images in inline styles (many templates use them for covers)
  for (const m of clean.matchAll(/background(?:-image)?\s*:\s*url\((['"]?)([^'")]+)\1\)/gi)) {
    if (!/^data:/i.test(m[2])) images.push({ src: decode(m[2]), alt: '' });
  }
  const links = [...clean.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1], text: squash(m[2].replace(/<[^>]+>/g, ' ')) }));
  // Keep block structure as new lines, then strip tags
  const body = (clean.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [null, clean])[1]
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<h([1-3])[^>]*>/gi, '\n## ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  const lines = decode(body).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1);
  const seen = new Set();
  const text = lines.filter((l) => (seen.has(l) ? false : seen.add(l))).join('\n');
  return { title, meta, alts: [...new Set(alts)].slice(0, 25), links, text, images };
}

const INTERESTING = /(propert|listing|rooms?|suite|menu|food|shop|store|product|catalog|collection|service|work|project|portfolio|gallery|about|pricing|price|book|treatment|packages?|events?)/i;

/**
 * @param {string} siteUrl the website address saved for this user
 * @returns {Promise<{ ok: boolean, pages: {url:string,title:string}[], text: string, error?: string }>}
 */
export async function readWebsite(siteUrl) {
  let home;
  try {
    home = new URL(siteUrl);
  } catch {
    return { ok: false, pages: [], text: '', photos: [], error: 'This website has no valid address yet.' };
  }
  const pages = [];
  const parts = [];
  const photos = [];
  let total = 0;
  const addPhotos = (list, pageUrl) => {
    for (const im of list || []) {
      if (photos.length >= MAX_PHOTOS) return;
      try {
        const u = new URL(im.src, pageUrl);
        u.hash = '';
        if (!checkUrl(u, home, { photo: true })) continue;
        // Photo CDNs often have no ".jpg" in the address (e.g. images.unsplash.com/photo-123?w=1600)
        if (!onPhotoCdn(u.hostname.toLowerCase()) && !/\.(jpe?g|png|webp)(\?|$)/i.test(u.pathname + u.search) && !/\/(uploads|media|images?|img|photos?)\//i.test(u.pathname)) continue;
        if (/\.(svg|gif|ico)(\?|$)/i.test(u.pathname)) continue;
        if (/\/logos?\//i.test(u.pathname)) continue; // the logo is added on the last screen separately
        if (/(favicon|sprite|icon-|\/icons?\/|placeholder|blank\.)/i.test(u.pathname)) continue;
        const url = u.toString();
        if (photos.some((p) => p.url === url)) continue;
        photos.push({ url, alt: String(im.alt || '').slice(0, 120), page: pageUrl });
      } catch { /* bad url */ }
    }
  };
  try {
    const first = await fetchPage(home, home);
    const p = extractPage(first.html);
    pages.push({ url: first.url, title: p.title });
    addPhotos(p.images, first.url);
    const head = [`PAGE: ${first.url}`, p.title && `Title: ${p.title}`, p.meta && `Description: ${p.meta}`,
      p.alts.length ? `Picture labels: ${p.alts.join('; ')}` : '', p.text].filter(Boolean).join('\n');
    parts.push(head.slice(0, 6000));
    total += Math.min(head.length, 6000);

    // A few more pages from the same site that look useful (listings, menu, rooms, products...)
    const next = [];
    for (const l of p.links) {
      try {
        const u = new URL(l.href, first.url);
        u.hash = '';
        if (!checkUrl(u, home)) continue;
        if (u.toString() === first.url || next.some((x) => x.toString() === u.toString())) continue;
        if (/\.(jpe?g|png|webp|gif|pdf|zip|mp4|svg)$/i.test(u.pathname)) continue;
        if (/(admin|login|logout|cart|checkout|account|wp-|\.php\?.*(delete|remove))/i.test(u.pathname + u.search)) continue;
        if (INTERESTING.test(u.pathname + ' ' + u.search + ' ' + l.text)) next.push(u);
      } catch { /* bad link */ }
      if (next.length >= MAX_PAGES - 1) break;
    }
    for (const u of next) {
      if (total >= MAX_CHARS) break;
      try {
        const pg = await fetchPage(u, home);
        const e = extractPage(pg.html);
        if (!e.text) continue;
        pages.push({ url: pg.url, title: e.title });
        addPhotos(e.images, pg.url);
        const chunk = [`PAGE: ${pg.url}`, e.title && `Title: ${e.title}`, e.text].filter(Boolean).join('\n').slice(0, 4000);
        parts.push(chunk);
        total += chunk.length;
      } catch { /* skip pages that fail */ }
    }
    const text = parts.join('\n\n').slice(0, MAX_CHARS);
    return { ok: text.length > 40, pages, text, photos, error: text.length > 40 ? undefined : 'The website looks empty.' };
  } catch (err) {
    const msg = /Blocked private/.test(String(err?.message)) ? 'This website address is not allowed.' : 'We could not open your website right now.';
    return { ok: false, pages, text: parts.join('\n\n'), photos, error: msg };
  }
}

// Look at the first bytes: is it really a JPEG / PNG / WEBP?
export function imageKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Download one photo from the user's own website (same safety rules as pages).
 * @returns {Promise<{ body: Buffer, type: string } | null>}
 */
export async function fetchImage(imageUrl, siteUrl) {
  try {
    const home = new URL(siteUrl);
    const u = new URL(imageUrl);
    const r = await fetchPage(u, home, { image: true });
    const type = imageKind(r.body);
    if (!r.body || !type) return null;
    return { body: r.body, type };
  } catch {
    return null;
  }
}
