import { Router } from 'express';
import { pool } from '../db.js';
import { siteName } from './siteName.js';

// =====================================================================
// NEAR ME — PUBLIC PAGES FOR GOOGLE (server-made HTML, no login, no JavaScript needed)
//
//   /places                         all cities
//   /places/in/:city                businesses in a city   (?category=...)
//   /places/:slug-:id               one business
//   /places/go/:id/:type            counts a Call/WhatsApp/Directions/Website tap, then sends the visitor on
//   /places/badge/:id.svg           "Find us on Near Me" badge for the owner's own website
//   /places/sitemap.xml             list of every page, for Google
//   /places/robots.txt
//
// Mount in your server file:   app.use('/places', directoryPages);
// Optional env:  PUBLIC_PLACES_URL=https://near.yourdomain.com/places   (when served behind another domain)
//                PUBLIC_APP_URL=https://app.yourdomain.com              (your Formular app, for the search page link)
// =====================================================================

const router = Router();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 70) || 'business';
const digits = (s) => String(s || '').replace(/\D/g, '');

function baseUrl(req) {
  if (process.env.PUBLIC_PLACES_URL) return process.env.PUBLIC_PLACES_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto']?.split(',')[0] || req.protocol;
  return `${proto}://${req.get('host')}${req.baseUrl}`;
}
const appUrl = () => (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
const bizPath = (r) => `/${slugify(`${r.business_name} ${r.city || ''}`)}-${r.listing_id}`;
const cityPath = (city) => `/in/${slugify(city)}`;

const LISTED = `dl.is_listed AND uw.deleted_at IS NULL AND uw.status = 'active' AND dl.lat IS NOT NULL`;
const COLS = `dl.id AS listing_id, uw.business_name, uw.logo_url, uw.site_url, COALESCE(dl.short_description, uw.description) AS description,
              dl.category, dl.address, dl.city, dl.region, dl.country, dl.lat, dl.lng, dl.phone, dl.whatsapp, dl.email, dl.opening_hours, dl.updated_at`;

// ---------------------------------------------------------------------
// Page shell (light, fast, phone-friendly)
// ---------------------------------------------------------------------
function page({ title, description, canonical, body, jsonLd, image }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="summary">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#15181d;background:#f5f6f8}
a{color:inherit}.wrap{width:min(960px,100% - 32px);margin:0 auto}
header{background:#0f1115;color:#fff}header .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:800}.logo i{width:34px;height:34px;border-radius:10px;background:#00c46a;display:grid;place-items:center;font-style:normal}
.hbtn{font-size:14px;font-weight:700;padding:9px 14px;border-radius:99px;border:1px solid rgba(255,255,255,.25);text-decoration:none}
main{padding:28px 0 50px}h1{font-size:clamp(26px,5vw,38px);line-height:1.15;margin:0 0 6px}h2{font-size:20px;margin:34px 0 12px}
.muted{color:#5d6470}.crumbs{font-size:13px;color:#5d6470;margin-bottom:14px}.crumbs a{text-decoration:none}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:16px;padding:18px}
.biz{display:flex;gap:14px;align-items:flex-start}.biz img,.ph{width:64px;height:64px;border-radius:14px;object-fit:cover;flex:none;background:#e8f8f0;color:#00a45a;display:grid;place-items:center;font-weight:800;font-size:24px}
.tag{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;background:#e8f8f0;color:#00804a}
.btns{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-top:16px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:46px;border-radius:12px;border:1px solid #d5d9df;background:#fff;text-decoration:none;font-weight:700;font-size:15px}
.btn.main{background:#00c46a;border-color:#00c46a;color:#05230f}
.list{display:grid;gap:10px}.row{display:flex;justify-content:space-between;gap:12px;align-items:center;text-decoration:none}
.row b{display:block}.row small{color:#5d6470}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.chip{font-size:13px;font-weight:600;padding:7px 12px;border-radius:99px;border:1px solid #d5d9df;background:#fff;text-decoration:none}.chip.on{background:#15181d;color:#fff;border-color:#15181d}
iframe{width:100%;height:280px;border:0;border-radius:14px;margin-top:16px;background:#e3e6ea}
dl.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:14px 0 0}dl.facts dt{color:#5d6470}dl.facts dd{margin:0}
.stars{color:#f5a400;letter-spacing:1px}.rating{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:14px}
.rev{border-top:1px solid #eef0f2;padding:14px 0}.rev:first-child{border-top:0;padding-top:0}.rev p{margin:6px 0 0}
.rev .reply{margin-top:8px;padding-left:12px;border-left:3px solid #00c46a;font-size:14px;color:#3d434c}
footer{border-top:1px solid #e3e6ea;padding:22px 0;font-size:13px;color:#5d6470}footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px}
</style></head><body>
<header><div class="wrap"><a class="logo" href="${esc(canonical.split('/places')[0])}/places"><i>📍</i>Near Me</a>
${appUrl() ? `<a class="hbtn" href="${esc(appUrl())}/near">Search near me</a>` : ''}</div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap"><span>© ${new Date().getFullYear()} ${siteName() ? `${esc(siteName())} · ` : ''}Near Me</span>
${appUrl() ? `<a href="${esc(appUrl())}/register">Own a business? List it free</a>` : ''}</div></footer>
</body></html>`;
}

const notFound = (res, base) => res.status(404).type('html').send(page({
  title: 'Not found — Near Me', description: 'This business is no longer listed.', canonical: `${base}`,
  body: `<h1>This business is no longer listed</h1><p class="muted">It may have moved or switched off its listing.</p><p><a class="btn main" style="max-width:260px" href="${esc(base)}">See businesses near you</a></p>`
}));

function bizRow(base, r, extra = '') {
  return `<a class="card row" href="${esc(base + bizPath(r))}"><span><b>${esc(r.business_name)}</b><small>${esc([r.category, r.city].filter(Boolean).join(' · '))}${extra}</small></span><span aria-hidden="true">›</span></a>`;
}

// ---------------------------------------------------------------------
// robots.txt + sitemap.xml
// ---------------------------------------------------------------------
router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /go/\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
});

router.get('/sitemap.xml', async (req, res) => {
  try {
    const base = baseUrl(req);
    const r = await pool.query(`SELECT ${COLS} FROM directory_listings dl JOIN user_websites uw ON uw.id = dl.website_id WHERE ${LISTED} ORDER BY dl.id LIMIT 45000`);
    const cities = [...new Set(r.rows.map((x) => x.city).filter(Boolean).map(slugify))];
    const urls = [
      `<url><loc>${esc(base)}</loc></url>`,
      ...cities.map((c) => `<url><loc>${esc(`${base}/in/${c}`)}</loc></url>`),
      ...r.rows.map((x) => `<url><loc>${esc(base + bizPath(x))}</loc><lastmod>${new Date(x.updated_at).toISOString().slice(0, 10)}</lastmod></url>`)
    ];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
  } catch (err) {
    console.error(err);
    res.status(500).type('text/plain').send('sitemap error');
  }
});

// ---------------------------------------------------------------------
// Click counter + redirect (works even without JavaScript)
// ---------------------------------------------------------------------
const GO = { call: 'call_clicks', whatsapp: 'whatsapp_clicks', directions: 'direction_clicks', website: 'website_clicks' };
router.get('/go/:id/:type', async (req, res) => {
  const col = GO[req.params.type];
  const id = Number(req.params.id);
  if (!col || !Number.isInteger(id)) return res.redirect(302, baseUrl(req));
  try {
    const r = await pool.query(`SELECT ${COLS} FROM directory_listings dl JOIN user_websites uw ON uw.id = dl.website_id WHERE dl.id = $1 AND ${LISTED}`, [id]);
    const b = r.rows[0];
    if (!b) return res.redirect(302, baseUrl(req));
    let to = null;
    if (req.params.type === 'call' && b.phone) to = `tel:${String(b.phone).replace(/[^\d+]/g, '')}`;
    if (req.params.type === 'whatsapp' && digits(b.whatsapp)) to = `https://wa.me/${digits(b.whatsapp)}`;
    if (req.params.type === 'directions') to = `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}`;
    if (req.params.type === 'website' && /^https?:\/\//i.test(b.site_url || '')) to = b.site_url;
    if (!to) return res.redirect(302, baseUrl(req) + bizPath(b));
    pool.query(`UPDATE directory_listings SET ${col} = ${col} + 1 WHERE id = $1`, [id]).catch(() => {});
    res.set('X-Robots-Tag', 'noindex').redirect(302, to);
  } catch {
    res.redirect(302, baseUrl(req));
  }
});

// ---------------------------------------------------------------------
// Badge for the owner's own website
// ---------------------------------------------------------------------
router.get('/badge/:id.svg', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(
`<svg xmlns="http://www.w3.org/2000/svg" width="190" height="44" viewBox="0 0 190 44" role="img" aria-label="Find us on Near Me">
<rect width="190" height="44" rx="12" fill="#0f1115"/><circle cx="24" cy="22" r="12" fill="#00c46a"/>
<path d="M24 14.5a5.5 5.5 0 0 0-5.5 5.5c0 4.1 5.5 9.5 5.5 9.5s5.5-5.4 5.5-9.5a5.5 5.5 0 0 0-5.5-5.5zm0 7.7a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4z" fill="#05230f"/>
<text x="44" y="18" font-family="system-ui,Segoe UI,Arial" font-size="10" fill="#9aa3ad">Find us on</text>
<text x="44" y="33" font-family="system-ui,Segoe UI,Arial" font-size="15" font-weight="700" fill="#fff">Near Me</text>
</svg>`);
});

// ---------------------------------------------------------------------
// Home: all cities
// ---------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const base = baseUrl(req);
    const r = await pool.query(
      `SELECT dl.city, MAX(dl.country) AS country, COUNT(*)::int AS n FROM directory_listings dl JOIN user_websites uw ON uw.id = dl.website_id
       WHERE ${LISTED} AND dl.city IS NOT NULL GROUP BY dl.city ORDER BY n DESC, dl.city LIMIT 300`);
    const body = `<h1>Find businesses near you</h1>
<p class="muted">Hotels, shops, salons, restaurants and services, with one-tap call, WhatsApp and directions.</p>
${appUrl() ? `<p><a class="btn main" style="max-width:300px" href="${esc(appUrl())}/near">📍 Search near my location</a></p>` : ''}
<h2>Browse by city</h2>
${r.rows.length ? `<div class="grid">${r.rows.map((c) => `<a class="card row" href="${esc(base + cityPath(c.city))}"><span><b>${esc(c.city)}</b><small>${c.n} business${c.n === 1 ? '' : 'es'}${c.country ? ' · ' + esc(c.country) : ''}</small></span><span>›</span></a>`).join('')}</div>` : '<p class="muted">No businesses listed yet.</p>'}`;
    res.type('html').send(page({ title: 'Near Me — find local businesses near you', description: 'Find hotels, shops, salons, restaurants and services near you, with one-tap call, WhatsApp and directions.', canonical: base, body }));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

// ---------------------------------------------------------------------
// City page
// ---------------------------------------------------------------------
router.get('/in/:city', async (req, res) => {
  const base = baseUrl(req);
  try {
    const all = await pool.query(`SELECT ${COLS} FROM directory_listings dl JOIN user_websites uw ON uw.id = dl.website_id WHERE ${LISTED} AND dl.city IS NOT NULL`);
    const inCity = all.rows.filter((r) => slugify(r.city) === req.params.city);
    if (!inCity.length) return notFound(res, base);
    const cityName = inCity[0].city;
    const cats = [...new Set(inCity.map((r) => r.category))].sort();
    const cat = cats.includes(req.query.category) ? req.query.category : null;
    const rows = (cat ? inCity.filter((r) => r.category === cat) : inCity).sort((a, b) => a.business_name.localeCompare(b.business_name));
    const canonical = `${base}${cityPath(cityName)}${cat ? `?category=${encodeURIComponent(cat)}` : ''}`;
    const title = `${cat || 'Businesses'} in ${cityName} — Near Me`;
    const body = `<div class="crumbs"><a href="${esc(base)}">Near Me</a> › ${esc(cityName)}</div>
<h1>${esc(cat || 'Local businesses')} in ${esc(cityName)}</h1>
<p class="muted">${rows.length} listed · call, WhatsApp or get directions in one tap.</p>
<div class="chips"><a class="chip${cat ? '' : ' on'}" href="${esc(base + cityPath(cityName))}">All</a>${cats.map((c) => `<a class="chip${c === cat ? ' on' : ''}" href="${esc(`${base}${cityPath(cityName)}?category=${encodeURIComponent(c)}`)}">${esc(c)}</a>`).join('')}</div>
<div class="list">${rows.map((r) => bizRow(base, r)).join('')}</div>`;
    res.type('html').send(page({
      title, description: `Find ${cat ? cat.toLowerCase() : 'local businesses'} in ${cityName}: ${rows.slice(0, 5).map((r) => r.business_name).join(', ')}.`, canonical, body,
      jsonLd: { '@context': 'https://schema.org', '@type': 'ItemList', name: title, itemListElement: rows.slice(0, 50).map((r, i) => ({ '@type': 'ListItem', position: i + 1, url: base + bizPath(r), name: r.business_name })) }
    }));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

// ---------------------------------------------------------------------
// Business page:  /places/<name-city>-<id>
// ---------------------------------------------------------------------
router.get('/:slugId', async (req, res, next) => {
  const m = /^(.*)-(\d+)$/.exec(req.params.slugId);
  if (!m) return next();
  const base = baseUrl(req);
  try {
    const r = await pool.query(`SELECT ${COLS} FROM directory_listings dl JOIN user_websites uw ON uw.id = dl.website_id WHERE dl.id = $1 AND ${LISTED}`, [Number(m[2])]);
    const b = r.rows[0];
    if (!b) return notFound(res, base);
    const path = bizPath(b);
    if (`/${req.params.slugId}` !== path) return res.redirect(301, base + path); // name changed → keep one address

    const near = await pool.query(
      `SELECT * FROM (SELECT ${COLS}, 6371 * 2 * ASIN(SQRT(POWER(SIN(RADIANS(dl.lat - $1) / 2), 2) + COS(RADIANS($1)) * COS(RADIANS(dl.lat)) * POWER(SIN(RADIANS(dl.lng - $2) / 2), 2))) AS km
       FROM directory_listings dl JOIN user_websites uw ON uw.id = dl.website_id WHERE ${LISTED} AND dl.id <> $3
       AND dl.lat BETWEEN $1 - 0.3 AND $1 + 0.3 AND dl.lng BETWEEN $2 - 0.3 AND $2 + 0.3) x ORDER BY km LIMIT 6`,
      [b.lat, b.lng, b.listing_id]);

    pool.query('UPDATE directory_listings SET impressions = impressions + 1 WHERE id = $1', [b.listing_id]).catch(() => {});

    // Reviews (Reviews Booster). The average counts every rating, including private ones,
    // so unhappy customers who wrote privately still count. Only public reviews show their text.
    let reviews = [], stats = { n: 0, avg: null }, reviewCode = null;
    try {
      const rv = await pool.query(
        `SELECT r.rating, r.customer_name, r.comment, r.owner_reply, r.created_at FROM reviews r JOIN directory_listings dl ON dl.website_id = r.website_id
         WHERE dl.id = $1 AND r.is_public AND NOT r.is_hidden ORDER BY r.created_at DESC LIMIT 20`, [b.listing_id]);
      const st = await pool.query(
        `SELECT COUNT(*)::int AS n, ROUND(AVG(r.rating)::numeric, 1)::float AS avg FROM reviews r JOIN directory_listings dl ON dl.website_id = r.website_id
         WHERE dl.id = $1 AND NOT r.is_hidden`, [b.listing_id]);
      const rp = await pool.query(
        `SELECT rp.code FROM review_pages rp JOIN directory_listings dl ON dl.website_id = rp.website_id WHERE dl.id = $1 AND rp.is_enabled`, [b.listing_id]);
      reviews = rv.rows; stats = st.rows[0]; reviewCode = rp.rows[0]?.code || null;
    } catch { /* Reviews Booster not installed yet */ }
    let joinCode = null;
    try {
      const cf = await pool.query(
        `SELECT cf.code FROM contact_forms cf JOIN directory_listings dl ON dl.website_id = cf.website_id WHERE dl.id = $1 AND cf.is_enabled`, [b.listing_id]);
      joinCode = cf.rows[0]?.code || null;
    } catch { /* Customer List Builder not installed yet */ }
    const joinUrl = joinCode && appUrl() ? `${appUrl()}/join/${joinCode}?s=nearme` : null;
    const starText = (n) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));
    const writeUrl = reviewCode && appUrl() ? `${appUrl()}/r/${reviewCode}` : null;

    const where = [b.city, b.region, b.country].filter(Boolean).join(', ');
    const title = `${b.business_name}${b.city ? ` — ${b.category} in ${b.city}` : ` — ${b.category}`}`;
    const description = (b.description ? `${b.description} ` : '') + `${b.category}${where ? ` in ${where}` : ''}. Call, WhatsApp or get directions.`;
    const d = 0.01;
    const go = (t) => `${base}/go/${b.listing_id}/${t}`;
    const body = `<div class="crumbs"><a href="${esc(base)}">Near Me</a>${b.city ? ` › <a href="${esc(base + cityPath(b.city))}">${esc(b.city)}</a>` : ''} › ${esc(b.business_name)}</div>
<div class="card">
  <div class="biz">${b.logo_url ? `<img src="${esc(b.logo_url)}" alt="${esc(b.business_name)} logo">` : `<span class="ph">${esc((b.business_name || '?')[0])}</span>`}
    <div><h1>${esc(b.business_name)}</h1>${stats.n ? `<div class="rating"><span class="stars" aria-hidden="true">${starText(stats.avg)}</span><b>${stats.avg}</b><span class="muted">(${stats.n} rating${stats.n === 1 ? '' : 's'})</span></div>` : ''}<span class="tag">${esc(b.category)}</span>${where ? ` <span class="muted">· ${esc(where)}</span>` : ''}</div></div>
  ${b.description ? `<p>${esc(b.description)}</p>` : ''}
  <dl class="facts">
    ${b.address ? `<dt>Address</dt><dd>${esc(b.address)}</dd>` : ''}
    ${b.opening_hours ? `<dt>Hours</dt><dd>${esc(b.opening_hours)}</dd>` : ''}
    ${b.phone ? `<dt>Phone</dt><dd>${esc(b.phone)}</dd>` : ''}
    ${b.email ? `<dt>Email</dt><dd><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></dd>` : ''}
  </dl>
  <div class="btns">
    ${b.phone ? `<a class="btn" href="${esc(go('call'))}" rel="nofollow">📞 Call</a>` : ''}
    ${digits(b.whatsapp) ? `<a class="btn" href="${esc(go('whatsapp'))}" rel="nofollow">💬 WhatsApp</a>` : ''}
    <a class="btn main" href="${esc(go('directions'))}" rel="nofollow">🧭 Directions</a>
    ${b.site_url ? `<a class="btn" href="${esc(go('website'))}" rel="nofollow">🌐 Website</a>` : ''}
  </div>
  ${joinUrl ? `<a class="btn" style="margin-top:8px" href="${esc(joinUrl)}" rel="nofollow">🎁 Join our list for offers</a>` : ''}
  <iframe title="Map" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${b.lng - d},${b.lat - d},${b.lng + d},${b.lat + d}&layer=mapnik&marker=${b.lat},${b.lng}"></iframe>
  <p class="muted" style="font-size:12px;margin:6px 0 0">Map © OpenStreetMap contributors</p>
</div>
${stats.n || writeUrl ? `<h2>Reviews</h2><div class="card">
  ${reviews.map((r) => `<div class="rev"><span class="stars" aria-label="${r.rating} out of 5">${starText(r.rating)}</span> <b>${esc(r.customer_name || 'A customer')}</b> <span class="muted" style="font-size:13px">· ${new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
    ${r.comment ? `<p>${esc(r.comment)}</p>` : ''}${r.owner_reply ? `<div class="reply"><b>Reply from the owner:</b> ${esc(r.owner_reply)}</div>` : ''}</div>`).join('')}
  ${!reviews.length ? `<p class="muted" style="margin:0">${stats.n ? 'Customers have rated this business, but no written reviews are public yet.' : 'No reviews yet.'}</p>` : ''}
  ${writeUrl ? `<p style="margin:14px 0 0"><a class="btn" style="max-width:240px" href="${esc(writeUrl)}" rel="nofollow">⭐ Write a review</a></p>` : ''}
</div>` : ''}
${near.rows.length ? `<h2>More businesses nearby</h2><div class="list">${near.rows.map((x) => bizRow(base, x, ` · ${x.km < 1 ? Math.round(x.km * 1000) + ' m' : (Math.round(x.km * 10) / 10) + ' km'} away`)).join('')}</div>` : ''}`;

    const jsonLd = {
      '@context': 'https://schema.org', '@type': 'LocalBusiness', name: b.business_name, url: base + path,
      description: b.description || undefined, image: b.logo_url || undefined, telephone: b.phone || undefined, email: b.email || undefined,
      address: { '@type': 'PostalAddress', streetAddress: b.address || undefined, addressLocality: b.city || undefined, addressRegion: b.region || undefined, addressCountry: b.country || undefined },
      geo: { '@type': 'GeoCoordinates', latitude: b.lat, longitude: b.lng },
      sameAs: b.site_url ? [b.site_url] : undefined,
      aggregateRating: stats.n ? { '@type': 'AggregateRating', ratingValue: stats.avg, ratingCount: stats.n, bestRating: 5, worstRating: 1 } : undefined,
      review: reviews.length ? reviews.slice(0, 10).map((r) => ({
        '@type': 'Review', reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5 },
        author: { '@type': 'Person', name: r.customer_name || 'A customer' }, datePublished: new Date(r.created_at).toISOString().slice(0, 10),
        reviewBody: r.comment || undefined
      })) : undefined
    };
    res.type('html').send(page({ title, description, canonical: base + path, body, jsonLd, image: b.logo_url }));
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

export default router;