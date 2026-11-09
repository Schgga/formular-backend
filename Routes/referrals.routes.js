import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

// =====================================================================
// REFERRAL REWARDS
//   Owner (logged in):
//     GET    /api/referrals/mine                      websites + programme + numbers
//     PUT    /api/referrals/program/:websiteId        { isEnabled, rewardReferrer, rewardFriend, rules }
//     GET    /api/referrals/list/:websiteId           friends (newest first) + top sharers
//     POST   /api/referrals/friend/:id/status         { status: pending | bought | rewarded | rejected }
//     POST   /api/referrals/people/:websiteId         { name, phone }  owner gives a customer their own link
//     DELETE /api/referrals/people/:id
//   Public (no login):
//     GET  /api/referrals/p/:code                     programme page info      (page: /refer/<code>)
//     POST /api/referrals/p/:code                     { name, phone }  → the customer's own share link
//     GET  /api/referrals/i/:code                     invite page info         (page: /invite/<code>)
//     POST /api/referrals/i/:code                     { name, phone }  friend claims their welcome reward
//
// Formular never sends messages by itself: customers share their own link, and the
// owner confirms purchases by hand ("They bought" → "Reward given").
// =====================================================================

const router = Router();
const newCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
const clean = (v, max) => {
  const s = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const APP_BASE = () => (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
const ipHash = (req) => crypto.createHash('sha256')
  .update(`${process.env.REVIEWS_SALT || 'formular-referrals'}|${(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim()}`).digest('hex');
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// Phone numbers: "+234 803 123 4567", "2348031234567" or a local "0803 123 4567"
// (a local number gets the same country code as the business's WhatsApp number)
const CODES = ['234', '233', '254', '256', '255', '260', '237', '225', '221', '27', '44', '353', '1'];
function cleanPhone(v, businessNumber) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) {
    const biz = String(businessNumber || '').replace(/\D/g, '');
    const cc = CODES.find((c) => biz.startsWith(c));
    if (!cc) return false;
    d = cc + d.slice(1);
  }
  return d.length >= 8 && d.length <= 15 ? `+${d}` : false;
}

async function ownsWebsite(websiteId, userId) {
  try {
    const r = await pool.query('SELECT id, business_name, logo_url, support_whatsapp FROM user_websites WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [websiteId, userId]);
    return r.rows[0] || null;
  } catch { return null; }
}
async function businessNumber(site) {
  try {
    const p = (await pool.query('SELECT number FROM wa_profiles WHERE website_id = $1 AND is_enabled', [site.id ?? site.website_id])).rows[0];
    if (p?.number) return String(p.number).replace(/\D/g, '');
  } catch { /* WhatsApp Tools not installed */ }
  return String(site.support_whatsapp || '').replace(/\D/g, '');
}
async function insertWithCode(sql, params) {
  for (let i = 0; i < 5; i++) {
    try { return (await pool.query(sql, [newCode(), ...params])).rows[0]; } catch (e) { if (e.code !== '23505' || !/code/.test(e.constraint || e.detail || '')) throw e; }
  }
  throw new Error('Could not create a unique code');
}
async function ensureProgram(websiteId) {
  const r = await pool.query('SELECT * FROM ref_programs WHERE website_id = $1', [websiteId]);
  if (r.rows[0]) return r.rows[0];
  await insertWithCode(
    `INSERT INTO ref_programs (code, website_id, reward_referrer, reward_friend) VALUES ($1, $2, $3, $4) ON CONFLICT (website_id) DO NOTHING RETURNING *`,
    [websiteId, '₦2,000 off your next order', '10% off your first order']);
  return (await pool.query('SELECT * FROM ref_programs WHERE website_id = $1', [websiteId])).rows[0];
}
async function getOrCreatePerson(websiteId, name, phone) {
  const found = (await pool.query('SELECT * FROM ref_people WHERE website_id = $1 AND phone = $2', [websiteId, phone])).rows[0];
  if (found) return found;
  const made = await insertWithCode(
    `INSERT INTO ref_people (code, website_id, name, phone) VALUES ($1, $2, $3, $4) ON CONFLICT (website_id, phone) DO NOTHING RETURNING *`,
    [websiteId, name, phone]);
  return made || (await pool.query('SELECT * FROM ref_people WHERE website_id = $1 AND phone = $2', [websiteId, phone])).rows[0];
}

// ---------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const sites = (await pool.query(
      'SELECT id, business_name, logo_url, support_whatsapp FROM user_websites WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [req.user.id])).rows;
    const websites = [];
    for (const s of sites) {
      const p = await ensureProgram(s.id);
      const counts = (await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status <> 'rejected')::int AS friends,
                COUNT(*) FILTER (WHERE status IN ('bought', 'rewarded'))::int AS bought,
                COUNT(*) FILTER (WHERE status = 'bought')::int AS to_reward,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM ref_friends WHERE website_id = $1`, [s.id])).rows[0];
      const sharers = (await pool.query('SELECT COUNT(*)::int AS n FROM ref_people WHERE website_id = $1', [s.id])).rows[0].n;
      websites.push({
        website_id: s.id, business_name: s.business_name, logo_url: s.logo_url,
        hasNumber: !!(await businessNumber(s)),
        program: { code: p.code, isEnabled: p.is_enabled, rewardReferrer: p.reward_referrer || '', rewardFriend: p.reward_friend || '', rules: p.rules || '', opens: p.opens },
        stats: { ...counts, sharers }
      });
    }
    res.json({ success: true, websites, appBase: APP_BASE() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load Referral Rewards' });
  }
});

router.put('/program/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    await ensureProgram(site.id);
    const b = req.body || {};
    const rr = clean(b.rewardReferrer, 160);
    const rf = clean(b.rewardFriend, 160);
    if (!rr) return res.status(400).json({ success: false, error: 'Please write what your customer gets for each friend who buys.' });
    await pool.query(
      `UPDATE ref_programs SET is_enabled = $2, reward_referrer = $3, reward_friend = $4, rules = $5, updated_at = NOW() WHERE website_id = $1`,
      [site.id, b.isEnabled !== false, rr, rf, clean(b.rules, 300)]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

router.get('/list/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const friends = (await pool.query(
      `SELECT f.id, f.name, f.phone, f.status, f.created_at, f.bought_at, f.rewarded_at, p.id AS referrer_id, p.name AS referrer_name, p.phone AS referrer_phone
       FROM ref_friends f JOIN ref_people p ON p.id = f.referrer_id
       WHERE f.website_id = $1 ORDER BY f.created_at DESC LIMIT 500`, [site.id])).rows;
    const people = (await pool.query(
      `SELECT p.id, p.code, p.name, p.phone, p.opens, p.created_at,
              COUNT(f.id) FILTER (WHERE f.status <> 'rejected')::int AS friends,
              COUNT(f.id) FILTER (WHERE f.status IN ('bought', 'rewarded'))::int AS bought,
              COUNT(f.id) FILTER (WHERE f.status = 'bought')::int AS to_reward
       FROM ref_people p LEFT JOIN ref_friends f ON f.referrer_id = p.id
       WHERE p.website_id = $1 GROUP BY p.id ORDER BY bought DESC, friends DESC, p.created_at DESC LIMIT 500`, [site.id])).rows;
    res.json({ success: true, friends, people });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load referrals' });
  }
});

router.post('/friend/:id/status', requireAuth, async (req, res) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ success: false, error: 'Not found' });
    const status = ['pending', 'bought', 'rewarded', 'rejected'].includes(req.body?.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ success: false, error: 'Unknown status' });
    const now = new Date();
    const r = await pool.query(
      `UPDATE ref_friends f SET status = $3::varchar,
         bought_at = CASE WHEN $3::varchar IN ('bought', 'rewarded') THEN COALESCE(f.bought_at, $4::timestamptz) ELSE NULL END,
         rewarded_at = CASE WHEN $3::varchar = 'rewarded' THEN COALESCE(f.rewarded_at, $4::timestamptz) ELSE NULL END
       FROM user_websites uw
       WHERE f.id = $1 AND uw.id = f.website_id AND uw.user_id = $2 AND uw.deleted_at IS NULL
       RETURNING f.id, f.status`, [req.params.id, req.user.id, status, now]);
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, friend: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update' });
  }
});

router.post('/people/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const name = clean(req.body?.name, 80);
    const phone = cleanPhone(req.body?.phone, await businessNumber(site));
    if (!name) return res.status(400).json({ success: false, error: 'Please enter the customer\'s name.' });
    if (!phone) return res.status(400).json({ success: false, error: 'Please enter their WhatsApp number with country code, e.g. +234 803 123 4567.' });
    const person = await getOrCreatePerson(site.id, name, phone);
    res.json({ success: true, person: { id: person.id, code: person.code, name: person.name, phone: person.phone } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not add this customer' });
  }
});

router.delete('/people/:id', requireAuth, async (req, res) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) return res.status(404).json({ success: false, error: 'Not found' });
    const r = await pool.query(
      `DELETE FROM ref_people p USING user_websites uw WHERE p.id = $1 AND uw.id = p.website_id AND uw.user_id = $2 AND uw.deleted_at IS NULL`,
      [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not remove' });
  }
});

// ---------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------
async function programByCode(code) {
  const r = await pool.query(
    `SELECT p.*, uw.business_name, uw.logo_url, uw.support_whatsapp FROM ref_programs p
     JOIN user_websites uw ON uw.id = p.website_id AND uw.deleted_at IS NULL WHERE p.code = $1`, [String(code).slice(0, 16)]);
  return r.rows[0] || null;
}
const publicProgram = (p) => ({ businessName: p.business_name, logoUrl: p.logo_url, rewardReferrer: p.reward_referrer, rewardFriend: p.reward_friend, rules: p.rules });

router.get('/p/:code', async (req, res) => {
  try {
    const p = await programByCode(req.params.code);
    if (!p || !p.is_enabled) return res.status(404).json({ success: false, error: 'This referral link is not active.' });
    pool.query('UPDATE ref_programs SET opens = opens + 1 WHERE id = $1', [p.id]).catch(() => {});
    res.json({ success: true, program: publicProgram(p) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.post('/p/:code', async (req, res) => {
  try {
    const p = await programByCode(req.params.code);
    if (!p || !p.is_enabled) return res.status(404).json({ success: false, error: 'This referral link is not active.' });
    const b = req.body || {};
    if (b.website) return res.json({ success: true, code: 'x' }); // trap field: only robots fill it
    const name = clean(b.name, 80);
    const phone = cleanPhone(b.phone, await businessNumber({ id: p.website_id, support_whatsapp: p.support_whatsapp }));
    if (!name) return res.status(400).json({ success: false, error: 'Please enter your name.' });
    if (!phone) return res.status(400).json({ success: false, error: 'Please enter your WhatsApp number with country code, e.g. +234 803 123 4567.' });
    const person = await getOrCreatePerson(p.website_id, name, phone);
    res.json({ success: true, code: person.code, name: firstName(person.name) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

async function personByCode(code) {
  const r = await pool.query(
    `SELECT rp.id, rp.website_id, rp.name, rp.phone, p.is_enabled, p.reward_friend, p.reward_referrer, p.rules, p.code AS program_code,
            uw.business_name, uw.logo_url, uw.support_whatsapp
     FROM ref_people rp JOIN ref_programs p ON p.website_id = rp.website_id
     JOIN user_websites uw ON uw.id = rp.website_id AND uw.deleted_at IS NULL
     WHERE rp.code = $1`, [String(code).slice(0, 16)]);
  return r.rows[0] || null;
}

router.get('/i/:code', async (req, res) => {
  try {
    const x = await personByCode(req.params.code);
    if (!x || !x.is_enabled) return res.status(404).json({ success: false, error: 'This invite link is not active.' });
    pool.query('UPDATE ref_people SET opens = opens + 1 WHERE id = $1', [x.id]).catch(() => {});
    res.json({
      success: true,
      invite: { businessName: x.business_name, logoUrl: x.logo_url, from: firstName(x.name), rewardFriend: x.reward_friend, rules: x.rules, programCode: x.program_code }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.post('/i/:code', async (req, res) => {
  try {
    const x = await personByCode(req.params.code);
    if (!x || !x.is_enabled) return res.status(404).json({ success: false, error: 'This invite link is not active.' });
    const b = req.body || {};
    if (b.website) return res.json({ success: true });
    const bizNumber = await businessNumber({ id: x.website_id, support_whatsapp: x.support_whatsapp });
    const name = clean(b.name, 80);
    const phone = cleanPhone(b.phone, bizNumber);
    if (!name) return res.status(400).json({ success: false, error: 'Please enter your name.' });
    if (!phone) return res.status(400).json({ success: false, error: 'Please enter your WhatsApp number with country code, e.g. +234 803 123 4567.' });
    if (phone === x.phone) return res.status(400).json({ success: false, error: 'This is your own invite link. Share it with friends instead!' });

    // The welcome reward is for NEW customers only
    const isSharer = (await pool.query('SELECT 1 FROM ref_people WHERE website_id = $1 AND phone = $2 AND created_at < NOW() - INTERVAL \'1 day\'', [x.website_id, phone])).rowCount;
    if (isSharer) return res.status(400).json({ success: false, error: `This welcome offer is for new customers of ${x.business_name}.` });
    const hash = ipHash(req);
    const recent = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM ref_friends WHERE website_id = $1 AND ip_hash = $2 AND created_at > NOW() - INTERVAL '1 hour'`, [x.website_id, hash])).rows[0].n;
    if (recent >= 5) return res.status(429).json({ success: false, error: 'Too many tries. Please try again later.' });

    const r = await pool.query(
      `INSERT INTO ref_friends (website_id, referrer_id, name, phone, ip_hash) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (website_id, phone) DO NOTHING RETURNING id`, [x.website_id, x.id, name, phone, hash]);
    if (!r.rowCount) return res.status(400).json({ success: false, error: `This number has already claimed a welcome offer from ${x.business_name}.` });

    const ref = `REF-${req.params.code.slice(0, 6).toUpperCase()}`;
    const text = `Hi ${x.business_name}! I'm ${firstName(name)}. ${firstName(x.name)} invited me (code ${ref}).${x.reward_friend ? ` I'd like to claim my welcome offer: ${x.reward_friend}.` : ''}`;
    res.json({
      success: true, ref,
      whatsappUrl: bizNumber ? `https://wa.me/${bizNumber}?text=${encodeURIComponent(text)}` : null,
      rewardFriend: x.reward_friend, programCode: x.program_code
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

export default router;