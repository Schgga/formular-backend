import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

// =====================================================================
// GOOGLE MAPS SETUP (checklist)
//   GET /api/google-setup/mine                      websites + details to copy + progress
//   PUT /api/google-setup/:websiteId                { done: [step keys], profileUrl }
//   PUT /api/google-setup/:websiteId/review-link    { url }  saves the Google review link into Reviews Booster
// =====================================================================

const router = Router();
const STEPS = ['check', 'create', 'name', 'location', 'contact', 'verify', 'description', 'photos', 'review-link', 'posts', 'reply', 'share'];
const newCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
const clean = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

function googleUrlOk(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return /(^|\.)google\.[a-z.]{2,8}$/.test(h) || ['g.page', 'goo.gl', 'maps.app.goo.gl', 'g.co'].includes(h);
  } catch { return false; }
}
async function optional(sql, params) {
  try { return (await pool.query(sql, params)).rows[0] || null; } catch { return null; }
}
async function ownsWebsite(websiteId, userId) {
  try {
    return (await pool.query('SELECT id FROM user_websites WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [websiteId, userId])).rows[0] || null;
  } catch { return null; }
}

router.get('/mine', requireAuth, async (req, res) => {
  try {
    const sites = (await pool.query(
      `SELECT uw.id, uw.business_name, uw.description, uw.logo_url, uw.site_url, uw.support_phone, uw.support_whatsapp, uw.support_email, wcl.name AS class_name
       FROM user_websites uw
       LEFT JOIN website_catalog wc ON wc.id = uw.catalog_id
       LEFT JOIN website_classes wcl ON wcl.id = wc.class_id
       WHERE uw.user_id = $1 AND uw.deleted_at IS NULL ORDER BY uw.created_at DESC`, [req.user.id])).rows;
    const websites = [];
    for (const s of sites) {
      const g = (await pool.query('SELECT done, profile_url FROM google_setup WHERE website_id = $1', [s.id])).rows[0];
      const l = await optional('SELECT short_description, address, city, region, country, phone, whatsapp, email, opening_hours, category FROM directory_listings WHERE website_id = $1', [s.id]);
      const r = await optional('SELECT google_review_url, code, is_enabled FROM review_pages WHERE website_id = $1', [s.id]);
      const c = await optional('SELECT biz_type FROM content_settings WHERE website_id = $1', [s.id]); // chosen in Content Ideas
      websites.push({
        website_id: s.id, business_name: s.business_name, logo_url: s.logo_url, class_name: s.class_name || '', bizType: c?.biz_type || '',
        details: {
          website: s.site_url || '', description: l?.short_description || s.description || '',
          address: [l?.address, l?.city, l?.region, l?.country].filter(Boolean).join(', '), city: l?.city || '',
          phone: l?.phone || s.support_phone || s.support_whatsapp || '', email: l?.email || s.support_email || '',
          hours: l?.opening_hours || '', category: l?.category || ''
        },
        googleReviewUrl: r?.google_review_url || '',
        reviewsOn: !!r?.is_enabled,
        done: (g?.done || []).filter((k) => STEPS.includes(k)),
        profileUrl: g?.profile_url || ''
      });
    }
    res.json({ success: true, websites });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load the Google setup' });
  }
});

router.put('/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const b = req.body || {};
    const done = [...new Set((Array.isArray(b.done) ? b.done : []).map(String).filter((k) => STEPS.includes(k)))];
    const url = clean(b.profileUrl, 500);
    if (url && !googleUrlOk(url)) return res.status(400).json({ success: false, error: 'Please paste the link from Google Maps (it starts with https://maps.app.goo.gl/ or https://www.google.com/maps/...).' });
    await pool.query(
      `INSERT INTO google_setup (website_id, done, profile_url, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (website_id) DO UPDATE SET done = EXCLUDED.done, profile_url = EXCLUDED.profile_url, updated_at = NOW()`,
      [site.id, done, url]);
    res.json({ success: true, done, profileUrl: url || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save your progress' });
  }
});

router.put('/:websiteId/review-link', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const url = clean(req.body?.url, 500);
    if (url && !googleUrlOk(url)) return res.status(400).json({ success: false, error: 'Please paste the review link from your Google Business Profile (it starts with https://g.page/ or https://search.google.com/...).' });
    try {
      await pool.query(
        `INSERT INTO review_pages (website_id, code, google_review_url) VALUES ($1, $2, $3)
         ON CONFLICT (website_id) DO UPDATE SET google_review_url = EXCLUDED.google_review_url, updated_at = NOW()`,
        [site.id, newCode(), url]);
    } catch (e) {
      if (e.code === '42P01') return res.status(400).json({ success: false, error: 'Install Reviews Booster first to save the review link.' });
      throw e;
    }
    res.json({ success: true, googleReviewUrl: url || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save the review link' });
  }
});

export default router;