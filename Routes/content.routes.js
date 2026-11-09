import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

// =====================================================================
// CONTENT IDEAS & CAPTIONS
//   Owner (logged in):
//     GET    /api/content/mine                      websites + their links (WhatsApp, reviews, sign-up) + settings
//     PUT    /api/content/settings/:websiteId       { bizType, city, country, tone, emojis, perWeek, ownHashtags }
//     GET    /api/content/plan/:websiteId?from=YYYY-MM-DD&to=YYYY-MM-DD
//     POST   /api/content/plan/:websiteId           { date, ideaKey, title, caption, platform, status }  (saves or updates)
//     DELETE /api/content/plan/item/:id
//     GET    /api/content/best-times/:websiteId?tz=Africa/Lagos
//            when customers really tapped the business's WhatsApp links (last 90 days)
//
// The ideas and captions themselves are written in the page (contentLibrary.js),
// so they work instantly, cost nothing and need no outside AI service.
// =====================================================================

const router = Router();

const TYPES = ['restaurant', 'salon', 'store', 'hotel', 'realestate', 'celebrity', 'business'];
const TONES = ['friendly', 'pro', 'fun', 'naija'];
const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'status', 'x', 'other'];
const clean = (v, max) => {
  const s = String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return s ? s.slice(0, max) : null;
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
const API_BASE = () => (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
const APP_BASE = () => (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');

function guessType(className) {
  const c = String(className || '').toLowerCase();
  if (/restaurant|food|eat|kitchen|cafe/.test(c)) return 'restaurant';
  if (/salon|spa|beauty|barb|nail/.test(c)) return 'salon';
  if (/hotel|guest|lodg/.test(c)) return 'hotel';
  if (/real estate|estate|property|shortlet/.test(c)) return 'realestate';
  if (/celebr|public figure|artist|musician/.test(c)) return 'celebrity';
  if (/store|shop|fashion|boutique/.test(c)) return 'store';
  return 'business';
}
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 70) || 'business';
const COUNTRY_CODES = { nigeria: 'NG', ghana: 'GH', kenya: 'KE', 'south africa': 'ZA', 'united kingdom': 'GB', uk: 'GB', 'united states': 'US', usa: 'US', canada: 'CA' };
const toCountryCode = (c) => {
  const s = String(c || '').trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY_CODES[s.toLowerCase()] || null;
};

// One query that never fails just because another Grow tool is not installed yet
async function optional(sql, params) {
  try { return (await pool.query(sql, params)).rows[0] || null; } catch { return null; }
}

async function ownsWebsite(websiteId, userId) {
  try {
    const r = await pool.query('SELECT id, business_name FROM user_websites WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [websiteId, userId]);
    return r.rows[0] || null;
  } catch { return null; } // e.g. a badly formed id
}

router.get('/mine', requireAuth, async (req, res) => {
  try {
    const sites = (await pool.query(
      `SELECT uw.id, uw.business_name, uw.logo_url, uw.site_url, uw.support_whatsapp, wcl.name AS class_name
       FROM user_websites uw
       LEFT JOIN website_catalog wc ON wc.id = uw.catalog_id
       LEFT JOIN website_classes wcl ON wcl.id = wc.class_id
       WHERE uw.user_id = $1 AND uw.deleted_at IS NULL ORDER BY uw.created_at DESC`, [req.user.id])).rows;
    const apiBase = API_BASE();
    const appBase = APP_BASE();
    const websites = [];
    for (const s of sites) {
      const set = (await pool.query('SELECT * FROM content_settings WHERE website_id = $1', [s.id])).rows[0];
      const listing = await optional('SELECT id, is_listed, city, country, category FROM directory_listings WHERE website_id = $1', [s.id]);
      const wa = await optional('SELECT code, number FROM wa_profiles WHERE website_id = $1 AND is_enabled', [s.id]);
      const review = await optional('SELECT code FROM review_pages WHERE website_id = $1 AND is_enabled', [s.id]);
      const join = await optional('SELECT code FROM contact_forms WHERE website_id = $1 AND is_enabled', [s.id]);
      const refer = await optional('SELECT code FROM ref_programs WHERE website_id = $1 AND is_enabled', [s.id]);
      const posted = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM content_posts WHERE website_id = $1 AND status = 'posted' AND plan_date > CURRENT_DATE - 30`, [s.id])).rows[0].n;
      websites.push({
        website_id: s.id,
        business_name: s.business_name,
        logo_url: s.logo_url,
        site_url: s.site_url || '',
        class_name: s.class_name || '',
        postedLast30: posted,
        settings: {
          bizType: set?.biz_type || guessType(s.class_name),
          city: set?.city || listing?.city || '',
          country: set?.country || toCountryCode(listing?.country) || '',
          tone: set?.tone || 'friendly',
          emojis: set ? set.emojis : true,
          perWeek: set?.per_week || 5,
          ownHashtags: set?.own_hashtags || ''
        },
        links: {
          // ?s=<place> is added in the page, so Results shows which app brought each chat
          whatsapp: wa?.code && wa?.number ? `${apiBase}/api/wa/go/${wa.code}` : '',
          save: wa?.code && wa?.number ? `${apiBase}/api/wa/save/${wa.code}` : '',
          review: review?.code && appBase ? `${appBase}/r/${review.code}` : '',
          join: join?.code && appBase ? `${appBase}/join/${join.code}` : '',
          refer: refer?.code && appBase ? `${appBase}/refer/${refer.code}` : '',
          map: listing?.is_listed ? `${apiBase}/places/${slugify(`${s.business_name} ${listing.city || ''}`)}-${listing.id}` : '',
          site: s.site_url || ''
        },
        // Tells the page which tools still need setting up (to show friendly tips)
        missing: {
          whatsapp: !(wa?.code && wa?.number),
          review: !review?.code,
          join: !join?.code,
          appUrl: !appBase
        }
      });
    }
    res.json({ success: true, websites });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load Content Ideas' });
  }
});

router.put('/settings/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const b = req.body || {};
    const perWeek = [3, 5, 7].includes(Number(b.perWeek)) ? Number(b.perWeek) : 5;
    const country = /^[A-Za-z]{2}$/.test(String(b.country || '')) ? String(b.country).toUpperCase() : null;
    const tags = clean(String(b.ownHashtags || '').split(/[\s,]+/).filter(Boolean)
      .map((t) => `#${t.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`).filter((t) => t.length > 1).slice(0, 8).join(' '), 300);
    await pool.query(
      `INSERT INTO content_settings (website_id, biz_type, city, country, tone, emojis, per_week, own_hashtags, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (website_id) DO UPDATE SET biz_type = EXCLUDED.biz_type, city = EXCLUDED.city, country = EXCLUDED.country,
         tone = EXCLUDED.tone, emojis = EXCLUDED.emojis, per_week = EXCLUDED.per_week, own_hashtags = EXCLUDED.own_hashtags, updated_at = NOW()`,
      [site.id, TYPES.includes(b.bizType) ? b.bizType : 'business', clean(b.city, 80), country,
        TONES.includes(b.tone) ? b.tone : 'friendly', b.emojis !== false, perWeek, tags]);
    res.json({ success: true, ownHashtags: tags || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save your settings' });
  }
});

router.get('/plan/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const from = isDate(req.query.from) ? req.query.from : null;
    const to = isDate(req.query.to) ? req.query.to : null;
    const items = (await pool.query(
      `SELECT id, to_char(plan_date, 'YYYY-MM-DD') AS date, idea_key, title, caption, platform, status, posted_at
       FROM content_posts
       WHERE website_id = $1 AND plan_date >= COALESCE($2::date, CURRENT_DATE - 60) AND plan_date <= COALESCE($3::date, CURRENT_DATE + 90)
       ORDER BY plan_date, id`, [site.id, from, to])).rows;
    res.json({ success: true, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your plan' });
  }
});

router.post('/plan/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const b = req.body || {};
    if (!isDate(b.date)) return res.status(400).json({ success: false, error: 'Please pick a date.' });
    const key = clean(b.ideaKey, 40);
    if (!key || !/^[a-z0-9:_-]+$/i.test(key)) return res.status(400).json({ success: false, error: 'Missing idea.' });
    const status = b.status === 'posted' ? 'posted' : 'planned';
    const r = await pool.query(
      `INSERT INTO content_posts (website_id, plan_date, idea_key, title, caption, platform, status, posted_at)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (website_id, plan_date, idea_key) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, content_posts.title),
         caption = COALESCE(EXCLUDED.caption, content_posts.caption),
         platform = COALESCE(EXCLUDED.platform, content_posts.platform),
         status = EXCLUDED.status,
         posted_at = CASE WHEN EXCLUDED.status = 'posted' THEN COALESCE(content_posts.posted_at, NOW()) ELSE NULL END,
         updated_at = NOW()
       RETURNING id, to_char(plan_date, 'YYYY-MM-DD') AS date, idea_key, title, caption, platform, status, posted_at`,
      [site.id, b.date, key, clean(b.title, 140), clean(b.caption, 5000), PLATFORMS.includes(b.platform) ? b.platform : null, status,
        status === 'posted' ? new Date() : null]);
    res.json({ success: true, item: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save to your plan' });
  }
});

router.delete('/plan/item/:id', requireAuth, async (req, res) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ success: false, error: 'Not found' });
    const r = await pool.query(
      `DELETE FROM content_posts cp USING user_websites uw
       WHERE cp.id = $1 AND uw.id = cp.website_id AND uw.user_id = $2 AND uw.deleted_at IS NULL`, [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not remove it' });
  }
});

// When do THIS business's customers actually respond? (from real WhatsApp link taps)
router.get('/best-times/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    let tz = 'UTC';
    const asked = String(req.query.tz || '').slice(0, 60);
    if (asked) {
      const ok = await pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [asked]);
      if (ok.rowCount) tz = asked;
    }
    let rows = [];
    let sources = [];
    try {
      rows = (await pool.query(
        `SELECT EXTRACT(DOW FROM created_at AT TIME ZONE $2)::int AS dow, EXTRACT(HOUR FROM created_at AT TIME ZONE $2)::int AS hour, COUNT(*)::int AS n
         FROM wa_clicks WHERE website_id = $1 AND kind = 'chat' AND created_at > NOW() - INTERVAL '90 days'
         GROUP BY 1, 2`, [site.id, tz])).rows;
      sources = (await pool.query(
        `SELECT source, COUNT(*)::int AS n FROM wa_clicks
         WHERE website_id = $1 AND kind = 'chat' AND created_at > NOW() - INTERVAL '90 days' GROUP BY 1 ORDER BY n DESC`, [site.id])).rows;
    } catch { /* WhatsApp Tools update 2 not installed */ }
    const total = rows.reduce((a, r) => a + r.n, 0);
    res.json({ success: true, tz, total, cells: rows, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your best times' });
  }
});

export default router;