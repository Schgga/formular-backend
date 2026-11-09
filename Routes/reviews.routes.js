import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

// =====================================================================
// REVIEWS BOOSTER
//   Owner (logged in):  GET /api/reviews/mine                      websites + review link + stats
//                       PUT /api/reviews/page/:websiteId           { isEnabled, googleReviewUrl, thankYouMessage }
//                       GET /api/reviews/list/:websiteId?filter=   all | public | private | hidden
//                       PUT /api/reviews/reply/:reviewId           { reply }   ('' removes it)
//                       PUT /api/reviews/hide/:reviewId            { hidden, reason: spam | offensive | not_customer }
//   Public (no login):  GET  /api/reviews/p/:code                  review page info
//                       POST /api/reviews/p/:code                  { rating, name, comment, contact, isPublic }
//                       POST /api/reviews/p/:code/google           counts a "Review us on Google" tap
//
// Honesty rules built in:
//   - Every customer sees the Google button, whatever star rating they give (Google forbids asking only happy customers).
//   - Owners cannot write, edit or delete reviews. They can reply, and report spam/offensive/fake ones,
//     which hides them. Low ratings cannot be hidden just for being low.
// =====================================================================

const router = Router();

const HIDE_REASONS = ['spam', 'offensive', 'not_customer'];
const clean = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s.slice(0, max);
};
const newCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');

function ipHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  return crypto.createHash('sha256').update(`${process.env.REVIEWS_SALT || 'formular-reviews'}|${ip}`).digest('hex');
}

// Only real Google review links are accepted, so a review page can never send customers somewhere unsafe.
function googleUrlOk(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return /(^|\.)google\.[a-z.]{2,8}$/.test(h) || h === 'g.page' || h === 'goo.gl' || h === 'maps.app.goo.gl' || h === 'g.co';
  } catch {
    return false;
  }
}

async function ownsWebsite(websiteId, userId) {
  const r = await pool.query('SELECT id FROM user_websites WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [websiteId, userId]);
  return r.rows.length > 0;
}

async function ownsReview(reviewId, userId) {
  const r = await pool.query(
    `SELECT rv.id FROM reviews rv JOIN user_websites uw ON uw.id = rv.website_id
     WHERE rv.id = $1 AND uw.user_id = $2 AND uw.deleted_at IS NULL`, [reviewId, userId]);
  return r.rows.length > 0;
}

// ---------------------------------------------------------------------
// Owner: my websites, each with its review link and numbers
// ---------------------------------------------------------------------
router.get('/mine', requireAuth, async (req, res) => {
  try {
    // Give every website a review page (and link) the first time.
    const missing = await pool.query(
      `SELECT uw.id FROM user_websites uw LEFT JOIN review_pages rp ON rp.website_id = uw.id
       WHERE uw.user_id = $1 AND uw.deleted_at IS NULL AND rp.id IS NULL`, [req.user.id]);
    for (const w of missing.rows) {
      for (let i = 0; i < 3; i++) {
        try {
          await pool.query('INSERT INTO review_pages (website_id, code) VALUES ($1, $2) ON CONFLICT (website_id) DO NOTHING', [w.id, newCode()]);
          break;
        } catch (e) {
          if (e.code !== '23505') throw e; // code already used: try another
        }
      }
    }

    const result = await pool.query(
      `SELECT uw.id AS website_id, uw.business_name, uw.logo_url, uw.status,
              rp.code, rp.is_enabled, rp.google_review_url, rp.thank_you_message, rp.link_opens, rp.google_clicks,
              COALESCE(s.total, 0)::int AS total, s.average, COALESCE(s.public_count, 0)::int AS public_count,
              COALESCE(s.private_count, 0)::int AS private_count, COALESCE(s.to_answer, 0)::int AS to_answer,
              COALESCE(s.five, 0)::int AS five, COALESCE(s.four, 0)::int AS four, COALESCE(s.three, 0)::int AS three,
              COALESCE(s.two, 0)::int AS two, COALESCE(s.one, 0)::int AS one
       FROM user_websites uw
       JOIN review_pages rp ON rp.website_id = uw.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS total, ROUND(AVG(rating)::numeric, 1)::float AS average,
                COUNT(*) FILTER (WHERE is_public) AS public_count,
                COUNT(*) FILTER (WHERE NOT is_public) AS private_count,
                COUNT(*) FILTER (WHERE owner_reply IS NULL AND (NOT is_public OR rating <= 3)) AS to_answer,
                COUNT(*) FILTER (WHERE rating = 5) AS five, COUNT(*) FILTER (WHERE rating = 4) AS four,
                COUNT(*) FILTER (WHERE rating = 3) AS three, COUNT(*) FILTER (WHERE rating = 2) AS two,
                COUNT(*) FILTER (WHERE rating = 1) AS one
         FROM reviews WHERE website_id = uw.id AND NOT is_hidden
       ) s ON true
       WHERE uw.user_id = $1 AND uw.deleted_at IS NULL
       ORDER BY uw.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, websites: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your reviews' });
  }
});

// ---------------------------------------------------------------------
// Owner: settings for a website's review page
// ---------------------------------------------------------------------
router.put('/page/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const b = req.body || {};
    const googleUrl = clean(b.googleReviewUrl, 500);
    if (googleUrl && !googleUrlOk(googleUrl)) {
      return res.status(400).json({ success: false, error: 'Please paste the review link from your Google Business Profile (it starts with https://g.page/ or https://search.google.com/...).' });
    }
    const r = await pool.query(
      `INSERT INTO review_pages (website_id, code, is_enabled, google_review_url, thank_you_message)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (website_id) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, google_review_url = EXCLUDED.google_review_url,
         thank_you_message = EXCLUDED.thank_you_message, updated_at = NOW()
       RETURNING code, is_enabled, google_review_url, thank_you_message`,
      [req.params.websiteId, newCode(), b.isEnabled !== false, googleUrl, clean(b.thankYouMessage, 300)]
    );
    res.json({ success: true, page: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

// ---------------------------------------------------------------------
// Owner: list reviews
// ---------------------------------------------------------------------
router.get('/list/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const filters = {
      all: 'NOT is_hidden',
      public: 'is_public AND NOT is_hidden',
      private: 'NOT is_public AND NOT is_hidden',
      hidden: 'is_hidden'
    };
    const where = filters[req.query.filter] || filters.all;
    const r = await pool.query(
      `SELECT id, rating, customer_name, comment, contact, is_public, is_hidden, hidden_reason, owner_reply, replied_at, created_at
       FROM reviews WHERE website_id = $1 AND ${where} ORDER BY created_at DESC LIMIT 200`,
      [req.params.websiteId]
    );
    res.json({ success: true, reviews: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load reviews' });
  }
});

// ---------------------------------------------------------------------
// Owner: reply to a review (shown under it when the review is public)
// ---------------------------------------------------------------------
router.put('/reply/:reviewId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsReview(req.params.reviewId, req.user.id))) return res.status(404).json({ success: false, error: 'Review not found' });
    const reply = clean(req.body?.reply, 1000);
    await pool.query('UPDATE reviews SET owner_reply = $1, replied_at = $2 WHERE id = $3', [reply, reply ? new Date() : null, req.params.reviewId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save your reply' });
  }
});

// ---------------------------------------------------------------------
// Owner: report a review (spam / offensive / not a real customer) — or undo
// ---------------------------------------------------------------------
router.put('/hide/:reviewId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsReview(req.params.reviewId, req.user.id))) return res.status(404).json({ success: false, error: 'Review not found' });
    const hidden = !!req.body?.hidden;
    const reason = req.body?.reason;
    if (hidden && !HIDE_REASONS.includes(reason)) {
      return res.status(400).json({ success: false, error: 'Choose why: spam, offensive, or not a real customer.' });
    }
    await pool.query('UPDATE reviews SET is_hidden = $1, hidden_reason = $2 WHERE id = $3', [hidden, hidden ? reason : null, req.params.reviewId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update the review' });
  }
});

// ---------------------------------------------------------------------
// Public: review page info
// ---------------------------------------------------------------------
async function findPage(code) {
  const r = await pool.query(
    `SELECT rp.id, rp.website_id, rp.is_enabled, rp.google_review_url, rp.thank_you_message, uw.business_name, uw.logo_url
     FROM review_pages rp JOIN user_websites uw ON uw.id = rp.website_id
     WHERE rp.code = $1 AND uw.deleted_at IS NULL`, [String(code).slice(0, 16)]);
  return r.rows[0];
}

router.get('/p/:code', async (req, res) => {
  try {
    const p = await findPage(req.params.code);
    if (!p || !p.is_enabled) return res.status(404).json({ success: false, error: 'This review link is not active.' });
    pool.query('UPDATE review_pages SET link_opens = link_opens + 1 WHERE id = $1', [p.id]).catch(() => {});
    res.json({ success: true, page: { businessName: p.business_name, logoUrl: p.logo_url, googleReviewUrl: p.google_review_url || null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// ---------------------------------------------------------------------
// Public: leave a review
// ---------------------------------------------------------------------
router.post('/p/:code', async (req, res) => {
  try {
    const p = await findPage(req.params.code);
    if (!p || !p.is_enabled) return res.status(404).json({ success: false, error: 'This review link is not active.' });
    const b = req.body || {};
    if (b.website) return res.json({ success: true }); // hidden trap field: only robots fill it in

    const rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ success: false, error: 'Please choose 1 to 5 stars.' });

    const hash = ipHash(req);
    const recent = await pool.query(
      `SELECT 1 FROM reviews WHERE website_id = $1 AND ip_hash = $2 AND created_at > NOW() - INTERVAL '12 hours' LIMIT 1`, [p.website_id, hash]);
    if (recent.rows.length) return res.status(429).json({ success: false, error: 'Thanks! You already left a review recently.' });

    await pool.query(
      `INSERT INTO reviews (website_id, rating, customer_name, comment, contact, is_public, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [p.website_id, rating, clean(b.name, 80), clean(b.comment, 1000), clean(b.contact, 120), b.isPublic !== false, hash]
    );
    let joinCode = null;
    try {
      const cf = await pool.query('SELECT code FROM contact_forms WHERE website_id = $1 AND is_enabled', [p.website_id]);
      joinCode = cf.rows[0]?.code || null;
    } catch { /* Customer List Builder not installed yet */ }
    res.json({ success: true, googleReviewUrl: p.google_review_url || null, thankYouMessage: p.thank_you_message || null, joinCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not send your review. Please try again.' });
  }
});

// Public: count a "Review us on Google" tap
router.post('/p/:code/google', async (req, res) => {
  try {
    await pool.query('UPDATE review_pages SET google_clicks = google_clicks + 1 WHERE code = $1', [String(req.params.code).slice(0, 16)]);
  } catch { /* not important */ }
  res.json({ success: true });
});

export default router;