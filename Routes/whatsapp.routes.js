import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { poweredBy } from './siteName.js';

// =====================================================================
// WHATSAPP TOOLS
//   Owner (logged in):
//     GET    /api/wa/mine                          websites + WhatsApp settings + numbers
//     PUT    /api/wa/profile/:websiteId            { number, message, buttonText, buttonColor, position, greeting, isEnabled }
//     GET    /api/wa/links/:websiteId              "Order on WhatsApp" links
//     POST   /api/wa/links/:websiteId              { label, message }
//     PUT    /api/wa/link/:id                      { label, message }
//     DELETE /api/wa/link/:id
//     GET    /api/wa/replies/:websiteId            quick replies
//     POST   /api/wa/replies/:websiteId            { title, body }      (or { starter: true } to add a ready-made set)
//     PUT    /api/wa/reply/:id                     { title, body }
//     POST   /api/wa/reply/:id/used                counts a copy
//     DELETE /api/wa/reply/:id
//     GET    /api/wa/broadcasts/:websiteId         "Message my customers" lists
//     POST   /api/wa/broadcasts/:websiteId         { message, tag }
//     GET    /api/wa/broadcast/:id                 who to message, and who is done
//     POST   /api/wa/broadcast/:id/mark            { recipientId, status: sent | skipped | pending | stopped }
//     DELETE /api/wa/broadcast/:id
//     GET    /api/wa/stats/:websiteId?days=30      Results: chats by source, top products, saves
//     GET    /api/wa/contacts-vcf/:websiteId?tag=  download customers as phone contacts (.vcf)
//   Public (no login):
//     GET /api/wa/go/:code?s=<source>              short link → opens the WhatsApp chat (counts the tap and where it came from)
//     GET /api/wa/save/:code                       "Save our number" page for customers
//     GET /api/wa/vcard/:code.vcf                  the business as a phone contact
//     GET /api/wa/widget/:code.js                  WhatsApp button for the business's own website
//
// Sending is done by the owner, one chat at a time, only to customers who agreed to WhatsApp
// messages. Formular never sends WhatsApp messages by itself (WhatsApp does not allow that
// without its official paid business service).
// =====================================================================

const router = Router();

const newCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
const clean = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
};
const cleanNumber = (v) => {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  return d.length >= 8 && d.length <= 15 ? `+${d}` : false;
};
const waUrl = (number, text) => `https://wa.me/${String(number).replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
// Where a tap came from. Each link the owner copies carries one of these (?s=...).
const SOURCES = ['instagram', 'tiktok', 'facebook', 'status', 'qr', 'website', 'save', 'flyer', 'email', 'other'];
const pickSource = (s, fallback = 'other') => (SOURCES.includes(String(s)) ? String(s) : fallback);
const track = (websiteId, linkId, kind, source) => pool.query(
  'INSERT INTO wa_clicks (website_id, link_id, kind, source) VALUES ($1, $2, $3, $4)', [websiteId, linkId, kind, source]).catch(() => {});

const API_BASE = () => (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');

async function ownsWebsite(websiteId, userId) {
  const r = await pool.query('SELECT id, business_name, support_whatsapp FROM user_websites WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [websiteId, userId]);
  return r.rows[0] || null;
}
async function ownsRow(table, id, userId) {
  if (!/^\d+$/.test(String(id))) return null;
  const r = await pool.query(
    `SELECT t.* FROM ${table} t JOIN user_websites uw ON uw.id = t.website_id WHERE t.id = $1 AND uw.user_id = $2 AND uw.deleted_at IS NULL`, [id, userId]);
  return r.rows[0] || null;
}
async function insertWithCode(sql, params) { // retries if the random code is already taken
  for (let i = 0; i < 4; i++) {
    try {
      return (await pool.query(sql, [...params, newCode()])).rows[0];
    } catch (e) {
      if (e.code !== '23505') throw e;
    }
  }
  throw new Error('Could not create a unique link');
}

// ---------------------------------------------------------------------
// Owner: overview (creates the WhatsApp settings the first time)
// ---------------------------------------------------------------------
async function ensureProfile(site) {
  let p = (await pool.query('SELECT * FROM wa_profiles WHERE website_id = $1', [site.id])).rows[0];
  if (p) return p;
  let number = cleanNumber(site.support_whatsapp) || null;
  if (!number) {
    try {
      const d = (await pool.query('SELECT whatsapp FROM directory_listings WHERE website_id = $1', [site.id])).rows[0];
      number = cleanNumber(d?.whatsapp) || null;
    } catch { /* Near Me not installed */ }
  }
  await insertWithCode(
    `INSERT INTO wa_profiles (website_id, number, message, button_text, button_color, greeting, code)
     VALUES ($1, $2, $3, 'Chat with us', '#25D366', $4, $5) ON CONFLICT (website_id) DO NOTHING RETURNING id`,
    [site.id, number, `Hi ${site.business_name}, I'd like to know more.`, `Hi there 👋 Questions? Chat with ${site.business_name} on WhatsApp.`]);
  return (await pool.query('SELECT * FROM wa_profiles WHERE website_id = $1', [site.id])).rows[0];
}

router.get('/mine', requireAuth, async (req, res) => {
  try {
    const sites = (await pool.query(
      `SELECT id, business_name, logo_url, support_whatsapp FROM user_websites WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [req.user.id])).rows;
    const websites = [];
    for (const s of sites) {
      const p = await ensureProfile(s);
      let audience = 0;
      let tags = [];
      try {
        audience = (await pool.query(
          `SELECT COUNT(*)::int AS n FROM contacts WHERE website_id = $1 AND whatsapp IS NOT NULL AND consent_whatsapp AND unsubscribed_at IS NULL`, [s.id])).rows[0].n;
        tags = (await pool.query(
          `SELECT DISTINCT UNNEST(tags) AS t FROM contacts WHERE website_id = $1 AND whatsapp IS NOT NULL AND consent_whatsapp AND unsubscribed_at IS NULL ORDER BY 1`, [s.id])).rows.map((x) => x.t);
      } catch { /* Customer List Builder not installed */ }
      websites.push({
        website_id: s.id, business_name: s.business_name, logo_url: s.logo_url, audience, tags,
        profile: {
          code: p.code, number: p.number || '', message: p.message || '', buttonText: p.button_text || 'Chat with us', buttonColor: p.button_color || '#25D366',
          position: p.position, greeting: p.greeting || '', isEnabled: p.is_enabled, clicks: p.clicks, saves: p.saves ?? 0
        }
      });
    }
    res.json({ success: true, websites, apiBase: API_BASE() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load WhatsApp tools' });
  }
});

router.put('/profile/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    await ensureProfile(site);
    const b = req.body || {};
    const number = cleanNumber(b.number);
    if (number === false) return res.status(400).json({ success: false, error: 'Please enter the WhatsApp number with country code, e.g. +234 803 123 4567.' });
    const color = /^#[0-9a-f]{6}$/i.test(b.buttonColor || '') ? b.buttonColor : '#25D366';
    await pool.query(
      `UPDATE wa_profiles SET number = $2, message = $3, button_text = $4, button_color = $5, position = $6, greeting = $7, is_enabled = $8, updated_at = NOW()
       WHERE website_id = $1`,
      [site.id, number, clean(b.message, 500), clean(b.buttonText, 40), color, b.position === 'left' ? 'left' : 'right', clean(b.greeting, 160), b.isEnabled !== false]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

// ---------------------------------------------------------------------
// Owner: "Order on WhatsApp" links
// ---------------------------------------------------------------------
router.get('/links/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const r = await pool.query('SELECT id, code, label, message, clicks, created_at FROM wa_links WHERE website_id = $1 ORDER BY created_at DESC', [req.params.websiteId]);
    res.json({ success: true, links: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load links' });
  }
});

router.post('/links/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const label = clean(req.body?.label, 120);
    if (!label) return res.status(400).json({ success: false, error: 'Type the product or service name.' });
    const count = (await pool.query('SELECT COUNT(*)::int AS n FROM wa_links WHERE website_id = $1', [req.params.websiteId])).rows[0].n;
    if (count >= 500) return res.status(400).json({ success: false, error: 'You have reached 500 order links. Delete some old ones first.' });
    const message = clean(req.body?.message, 500) || `Hi, I'd like to order: ${label}`;
    const row = await insertWithCode(
      'INSERT INTO wa_links (website_id, label, message, code) VALUES ($1, $2, $3, $4) RETURNING id, code, label, message, clicks, created_at',
      [req.params.websiteId, label, message]);
    res.json({ success: true, link: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create the link' });
  }
});

router.put('/link/:id', requireAuth, async (req, res) => {
  try {
    const l = await ownsRow('wa_links', req.params.id, req.user.id);
    if (!l) return res.status(404).json({ success: false, error: 'Link not found' });
    const label = clean(req.body?.label, 120);
    const message = clean(req.body?.message, 500);
    if (!label || !message) return res.status(400).json({ success: false, error: 'Name and message are both needed.' });
    await pool.query('UPDATE wa_links SET label = $2, message = $3 WHERE id = $1', [l.id, label, message]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

router.delete('/link/:id', requireAuth, async (req, res) => {
  try {
    const l = await ownsRow('wa_links', req.params.id, req.user.id);
    if (!l) return res.status(404).json({ success: false, error: 'Link not found' });
    await pool.query('DELETE FROM wa_links WHERE id = $1', [l.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

// ---------------------------------------------------------------------
// Owner: quick replies
// ---------------------------------------------------------------------
const STARTER_REPLIES = (name) => [
  ['Welcome', `Hi! Thank you for contacting ${name} 😊 How can we help you today?`],
  ['Price list', 'Here are our prices:\n\n• [Item 1] – [price]\n• [Item 2] – [price]\n• [Item 3] – [price]\n\nWhich one would you like?'],
  ['Location', `We are at [your address]. Here's the map: [Google Maps link]\n\nOpen [days], [hours].`],
  ['Delivery', 'Yes, we deliver! 🚚\n\n• [Area 1]: [price], [time]\n• [Area 2]: [price], [time]\n\nPlease send your full address.'],
  ['How to pay', 'You can pay by:\n\n• Bank transfer: [bank], [account number], [account name]\n• [Other ways to pay]\n\nPlease send a screenshot after paying. Thank you!'],
  ['Order confirmed', 'Thank you! Your order is confirmed ✅\n\nWe will let you know as soon as it is on the way.'],
  ['Thank you', `Thank you for choosing ${name}! 🙏 If you were happy, we'd love a quick review: [review link]`]
];

router.get('/replies/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const r = await pool.query('SELECT id, title, body, uses FROM wa_replies WHERE website_id = $1 ORDER BY created_at, id', [req.params.websiteId]);
    res.json({ success: true, replies: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load replies' });
  }
});

router.post('/replies/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const count = (await pool.query('SELECT COUNT(*)::int AS n FROM wa_replies WHERE website_id = $1', [site.id])).rows[0].n;
    if (req.body?.starter) {
      const have = new Set((await pool.query('SELECT title FROM wa_replies WHERE website_id = $1', [site.id])).rows.map((x) => x.title));
      for (const [t, body] of STARTER_REPLIES(site.business_name)) {
        if (!have.has(t)) await pool.query('INSERT INTO wa_replies (website_id, title, body) VALUES ($1, $2, $3)', [site.id, t, body]);
      }
      return res.json({ success: true });
    }
    if (count >= 100) return res.status(400).json({ success: false, error: 'You can save up to 100 quick replies.' });
    const title = clean(req.body?.title, 60);
    const body = clean(req.body?.body, 1500);
    if (!title || !body) return res.status(400).json({ success: false, error: 'Give the reply a short name and write the message.' });
    const r = await pool.query('INSERT INTO wa_replies (website_id, title, body) VALUES ($1, $2, $3) RETURNING id, title, body, uses', [site.id, title, body]);
    res.json({ success: true, reply: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save the reply' });
  }
});

router.put('/reply/:id', requireAuth, async (req, res) => {
  try {
    const r = await ownsRow('wa_replies', req.params.id, req.user.id);
    if (!r) return res.status(404).json({ success: false, error: 'Reply not found' });
    const title = clean(req.body?.title, 60);
    const body = clean(req.body?.body, 1500);
    if (!title || !body) return res.status(400).json({ success: false, error: 'Give the reply a short name and write the message.' });
    await pool.query('UPDATE wa_replies SET title = $2, body = $3 WHERE id = $1', [r.id, title, body]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

router.post('/reply/:id/used', requireAuth, async (req, res) => {
  try {
    const r = await ownsRow('wa_replies', req.params.id, req.user.id);
    if (r) await pool.query('UPDATE wa_replies SET uses = uses + 1 WHERE id = $1', [r.id]);
  } catch { /* not important */ }
  res.json({ success: true });
});

router.delete('/reply/:id', requireAuth, async (req, res) => {
  try {
    const r = await ownsRow('wa_replies', req.params.id, req.user.id);
    if (!r) return res.status(404).json({ success: false, error: 'Reply not found' });
    await pool.query('DELETE FROM wa_replies WHERE id = $1', [r.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

// ---------------------------------------------------------------------
// Owner: "Message my customers" (one by one, only people who agreed)
// ---------------------------------------------------------------------
router.get('/broadcasts/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const r = await pool.query(
      `SELECT b.id, b.message, b.audience_tag, b.total, b.created_at,
              COUNT(r.id) FILTER (WHERE r.status <> 'pending')::int AS done,
              COUNT(r.id) FILTER (WHERE r.status = 'sent')::int AS sent
       FROM wa_broadcasts b LEFT JOIN wa_broadcast_recipients r ON r.broadcast_id = b.id
       WHERE b.website_id = $1 GROUP BY b.id ORDER BY b.created_at DESC LIMIT 50`, [req.params.websiteId]);
    res.json({ success: true, broadcasts: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load' });
  }
});

router.post('/broadcasts/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const message = clean(req.body?.message, 1500);
    if (!message) return res.status(400).json({ success: false, error: 'Write your message first.' });
    const tag = clean(req.body?.tag, 30);
    const params = [req.params.websiteId];
    let extra = '';
    if (tag) { params.push(tag); extra = ' AND $2 = ANY(tags)'; }
    const people = (await pool.query(
      `SELECT id, name, whatsapp FROM contacts WHERE website_id = $1 AND whatsapp IS NOT NULL AND consent_whatsapp AND unsubscribed_at IS NULL${extra}
       ORDER BY created_at LIMIT 2000`, params)).rows;
    if (!people.length) {
      return res.status(400).json({ success: false, error: 'Nobody on your list has agreed to WhatsApp messages yet. Share your sign-up link or QR code first.' });
    }
    const b = (await pool.query(
      'INSERT INTO wa_broadcasts (website_id, message, audience_tag, total) VALUES ($1, $2, $3, $4) RETURNING id', [req.params.websiteId, message, tag, people.length])).rows[0];
    await pool.query(
      `INSERT INTO wa_broadcast_recipients (broadcast_id, contact_id, name, whatsapp)
       SELECT $1, x.id, x.name, x.whatsapp FROM UNNEST($2::bigint[], $3::text[], $4::text[]) AS x(id, name, whatsapp)`,
      [b.id, people.map((p) => p.id), people.map((p) => p.name), people.map((p) => p.whatsapp)]);
    res.json({ success: true, id: b.id, total: people.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create the list' });
  }
});

router.get('/broadcast/:id', requireAuth, async (req, res) => {
  try {
    const b = await ownsRow('wa_broadcasts', req.params.id, req.user.id);
    if (!b) return res.status(404).json({ success: false, error: 'Not found' });
    const r = await pool.query(
      `SELECT r.id, r.name, r.whatsapp, r.status, r.done_at, (c.unsubscribed_at IS NOT NULL OR c.id IS NULL OR NOT c.consent_whatsapp) AS left_list
       FROM wa_broadcast_recipients r LEFT JOIN contacts c ON c.id = r.contact_id
       WHERE r.broadcast_id = $1 ORDER BY r.id`, [b.id]);
    res.json({ success: true, broadcast: { id: b.id, message: b.message, audience_tag: b.audience_tag, total: b.total, created_at: b.created_at }, recipients: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load' });
  }
});

router.post('/broadcast/:id/mark', requireAuth, async (req, res) => {
  try {
    const b = await ownsRow('wa_broadcasts', req.params.id, req.user.id);
    if (!b) return res.status(404).json({ success: false, error: 'Not found' });
    const status = ['sent', 'skipped', 'pending', 'stopped'].includes(req.body?.status) ? req.body.status : null;
    if (!status || !/^\d+$/.test(String(req.body?.recipientId))) return res.status(400).json({ success: false, error: 'Bad request' });
    const r = (await pool.query(
      `UPDATE wa_broadcast_recipients SET status = $3, done_at = $4
       WHERE id = $1 AND broadcast_id = $2 RETURNING contact_id`, [req.body.recipientId, b.id, status, status === 'pending' ? null : new Date()])).rows[0];
    if (!r) return res.status(404).json({ success: false, error: 'Not found' });
    // The customer replied STOP: take them off WhatsApp messages for good
    if (status === 'stopped' && r.contact_id) {
      await pool.query(
        `UPDATE contacts SET consent_whatsapp = false,
           unsubscribed_at = CASE WHEN consent_email THEN unsubscribed_at ELSE COALESCE(unsubscribed_at, NOW()) END, updated_at = NOW()
         WHERE id = $1`, [r.contact_id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update' });
  }
});

router.delete('/broadcast/:id', requireAuth, async (req, res) => {
  try {
    const b = await ownsRow('wa_broadcasts', req.params.id, req.user.id);
    if (!b) return res.status(404).json({ success: false, error: 'Not found' });
    await pool.query('DELETE FROM wa_broadcasts WHERE id = $1', [b.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

// ---------------------------------------------------------------------
// Public: short link → WhatsApp chat (counts each tap)
// ---------------------------------------------------------------------
const notReady = (res) => res.status(404).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Not available</title></head>
<body style="font-family:system-ui,sans-serif;background:#f2f3f5;margin:0"><div style="max-width:420px;margin:60px auto;background:#fff;border-radius:16px;padding:28px;text-align:center">
<h1 style="font-size:20px;margin:0 0 8px">This chat link is not available</h1><p style="color:#5d6470;margin:0">The business may have changed its WhatsApp number.</p></div></body></html>`);

router.get('/go/:code', async (req, res) => {
  try {
    const code = String(req.params.code).slice(0, 16);
    const p = (await pool.query(
      `SELECT p.id, p.website_id, p.number, p.message, p.is_enabled FROM wa_profiles p JOIN user_websites uw ON uw.id = p.website_id
       WHERE p.code = $1 AND uw.deleted_at IS NULL`, [code])).rows[0];
    if (p) {
      if (!p.is_enabled || !p.number) return notReady(res);
      pool.query('UPDATE wa_profiles SET clicks = clicks + 1 WHERE id = $1', [p.id]).catch(() => {});
      track(p.website_id, null, 'chat', pickSource(req.query.s));
      return res.redirect(302, waUrl(p.number, p.message));
    }
    const l = (await pool.query(
      `SELECT l.id, l.website_id, l.message, p.number, p.is_enabled FROM wa_links l JOIN wa_profiles p ON p.website_id = l.website_id
       JOIN user_websites uw ON uw.id = l.website_id WHERE l.code = $1 AND uw.deleted_at IS NULL`, [code])).rows[0];
    if (!l || !l.is_enabled || !l.number) return notReady(res);
    pool.query('UPDATE wa_links SET clicks = clicks + 1 WHERE id = $1', [l.id]).catch(() => {});
    track(l.website_id, l.id, 'chat', pickSource(req.query.s));
    res.redirect(302, waUrl(l.number, l.message));
  } catch (err) {
    console.error(err);
    notReady(res);
  }
});

// ---------------------------------------------------------------------
// "Save our number": customers save the business as a contact in one tap.
// WhatsApp only shows your Status (and broadcast lists) to people who saved your number.
// ---------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const vEsc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

function vcard({ name, number, url, note }) {
  return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vEsc(name)}`, `ORG:${vEsc(name)}`, `TEL;TYPE=CELL:${number}`,
    ...(url ? [`URL:${vEsc(url)}`] : []), ...(note ? [`NOTE:${vEsc(note)}`] : []), 'END:VCARD'].join('\r\n');
}

async function profileByCode(code) {
  return (await pool.query(
    `SELECT p.*, uw.business_name, uw.logo_url, uw.site_url FROM wa_profiles p JOIN user_websites uw ON uw.id = p.website_id
     WHERE p.code = $1 AND uw.deleted_at IS NULL`, [String(code).slice(0, 16)])).rows[0];
}

router.get('/save/:code', async (req, res) => {
  try {
    const p = await profileByCode(req.params.code);
    if (!p || !p.is_enabled || !p.number) return notReady(res);
    const base = API_BASE();
    const name = esc(p.business_name);
    const logo = /^https:\/\//i.test(p.logo_url || '') ? `<img src="${esc(p.logo_url)}" alt="" style="width:76px;height:76px;border-radius:20px;object-fit:cover;margin:0 auto 14px;display:block">`
      : `<div style="width:76px;height:76px;border-radius:20px;background:#25D366;color:#fff;font-size:34px;font-weight:800;display:flex;align-items:center;justify-content:center;margin:0 auto 14px">${esc((p.business_name || '?')[0])}</div>`;
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Save ${name} to your contacts</title><meta name="robots" content="noindex"></head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f0f2f5;color:#111b21">
<div style="max-width:420px;margin:0 auto;padding:28px 16px">
<div style="background:#fff;border-radius:22px;padding:28px 22px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.06)">
${logo}<h1 style="font-size:22px;margin:0 0 6px">${name}</h1>
<p style="color:#54656f;margin:0 0 22px;line-height:1.5">Save our number to see our <b>new arrivals and offers on WhatsApp Status</b>.</p>
<a href="${base}/api/wa/vcard/${p.code}.vcf" style="display:block;background:#25D366;color:#fff;text-decoration:none;font-weight:700;font-size:17px;padding:16px;border-radius:14px">① Save our number</a>
<a href="${base}/api/wa/go/${p.code}?s=save" style="display:block;margin-top:10px;background:#fff;color:#111b21;border:2px solid #25D366;text-decoration:none;font-weight:700;font-size:16px;padding:14px;border-radius:14px">② Say hi on WhatsApp</a>
<p style="color:#8696a0;font-size:12px;margin:18px 0 0;line-height:1.5">Step ① adds ${name} to your phone's contacts. Tap "Save" or "Add contact" when your phone asks.<br>Step ② opens a chat, so we know it's you.</p>
</div><p style="text-align:center;color:#8696a0;font-size:11px;margin-top:16px">${esc(poweredBy())}</p></div></body></html>`);
  } catch (err) {
    console.error(err);
    notReady(res);
  }
});

router.get('/vcard/:code.vcf', async (req, res) => {
  try {
    const p = await profileByCode(req.params.code);
    if (!p || !p.is_enabled || !p.number) return notReady(res);
    pool.query('UPDATE wa_profiles SET saves = saves + 1 WHERE id = $1', [p.id]).catch(() => {});
    track(p.website_id, null, 'save', 'save');
    const file = (p.business_name || 'contact').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '') || 'contact';
    res.set({ 'Content-Type': 'text/vcard; charset=utf-8', 'Content-Disposition': `inline; filename="${file}.vcf"` })
      .send(vcard({ name: p.business_name, number: p.number, url: /^https?:\/\//i.test(p.site_url || '') ? p.site_url : '', note: 'WhatsApp us for orders and offers.' }));
  } catch (err) {
    console.error(err);
    notReady(res);
  }
});

// Owner: download customers (who agreed to WhatsApp) as phone contacts, to add them to the phone in one go
router.get('/contacts-vcf/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const params = [site.id];
    let extra = '';
    const tag = clean(req.query.tag, 30);
    if (tag) { params.push(tag); extra = ' AND $2 = ANY(tags)'; }
    const people = (await pool.query(
      `SELECT name, whatsapp FROM contacts WHERE website_id = $1 AND whatsapp IS NOT NULL AND consent_whatsapp AND unsubscribed_at IS NULL${extra} ORDER BY created_at`, params)).rows;
    const body = people.map((x, i) => vcard({ name: x.name || `Customer ${i + 1}`, number: x.whatsapp, note: `Customer of ${site.business_name}` })).join('\r\n');
    const file = `${(site.business_name || 'customers').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '')}-customers.vcf`;
    res.set({ 'Content-Type': 'text/vcard; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"`, 'X-Count': String(people.length) }).send(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create the file' });
  }
});

// ---------------------------------------------------------------------
// Owner: Results
// ---------------------------------------------------------------------
router.get('/stats/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const since = `NOW() - INTERVAL '${days} days'`;
    const sources = (await pool.query(
      `SELECT source, COUNT(*)::int AS n FROM wa_clicks WHERE website_id = $1 AND kind = 'chat' AND created_at > ${since} GROUP BY source ORDER BY n DESC`, [site.id])).rows;
    const daily = (await pool.query(
      `SELECT to_char(d::date, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS n
       FROM generate_series((NOW() - INTERVAL '${days - 1} days')::date, NOW()::date, '1 day') d
       LEFT JOIN (SELECT created_at::date AS day, COUNT(*) AS n FROM wa_clicks WHERE website_id = $1 AND kind = 'chat' AND created_at > ${since} GROUP BY 1) c
         ON c.day = d::date ORDER BY d`, [site.id])).rows;
    const products = (await pool.query(
      `SELECT l.label, COUNT(c.id)::int AS n FROM wa_clicks c JOIN wa_links l ON l.id = c.link_id
       WHERE c.website_id = $1 AND c.kind = 'chat' AND c.created_at > ${since} GROUP BY l.label ORDER BY n DESC LIMIT 8`, [site.id])).rows;
    const saves = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM wa_clicks WHERE website_id = $1 AND kind = 'save' AND created_at > ${since}`, [site.id])).rows[0].n;
    let nearMe = null;
    try {
      nearMe = (await pool.query('SELECT whatsapp_clicks FROM directory_listings WHERE website_id = $1', [site.id])).rows[0]?.whatsapp_clicks ?? null;
    } catch { /* Near Me not installed */ }
    res.json({ success: true, days, total: sources.reduce((a, x) => a + x.n, 0), sources, daily, products, saves, nearMeAllTime: nearMe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load results' });
  }
});

// ---------------------------------------------------------------------
// Public: WhatsApp button for the business's own website
// Paste on the website:  <script src="<PUBLIC_API_URL>/api/wa/widget/<code>.js" async></script>
// ---------------------------------------------------------------------
router.get('/widget/:code.js', async (req, res) => {
  res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  try {
    const p = (await pool.query(
      `SELECT p.* FROM wa_profiles p JOIN user_websites uw ON uw.id = p.website_id WHERE p.code = $1 AND uw.deleted_at IS NULL`,
      [String(req.params.code).slice(0, 16)])).rows[0];
    if (!p || !p.is_enabled || !p.number) return res.send('/* WhatsApp button is switched off */');
    const config = {
      link: `${API_BASE()}/api/wa/go/${p.code}?s=website`,
      text: p.button_text || 'Chat with us',
      color: /^#[0-9a-f]{6}$/i.test(p.button_color || '') ? p.button_color : '#25D366',
      side: p.position === 'left' ? 'left' : 'right',
      greeting: p.greeting || ''
    };
    const json = JSON.stringify(config).replace(/</g, '\\u003c');
    res.send(`(function(){
if (window.__formularWa) return; window.__formularWa = 1;
var c = ${json};
function go(){
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;bottom:20px;' + c.side + ':20px;z-index:2147483000;display:flex;flex-direction:column;align-items:' + (c.side === 'left' ? 'flex-start' : 'flex-end') + ';gap:10px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  if (c.greeting) {
    var g = document.createElement('div');
    g.style.cssText = 'max-width:250px;background:#fff;color:#1b1e23;font-size:14px;line-height:1.45;padding:12px 30px 12px 14px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.18);position:relative;display:none';
    g.textContent = c.greeting;
    var x = document.createElement('button');
    x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.textContent = '\\u00d7';
    x.style.cssText = 'position:absolute;top:4px;right:6px;border:0;background:none;font-size:18px;line-height:1;color:#888;cursor:pointer';
    x.onclick = function(){ g.style.display = 'none'; try { sessionStorage.setItem('fmwa_closed', '1'); } catch (e) {} };
    g.appendChild(x);
    box.appendChild(g);
    var closed = false; try { closed = sessionStorage.getItem('fmwa_closed') === '1'; } catch (e) {}
    if (!closed) setTimeout(function(){ g.style.display = 'block'; }, 2500);
  }
  var a = document.createElement('a');
  a.href = c.link; a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('aria-label', c.text);
  a.style.cssText = 'display:inline-flex;align-items:center;gap:9px;background:' + c.color + ';color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 18px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.22)';
  a.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.5A8.4 8.4 0 1 1 21 11.5z"/></svg><span></span>';
  a.querySelector('span').textContent = c.text;
  box.appendChild(a);
  document.body.appendChild(box);
}
if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
})();`);
  } catch (err) {
    console.error(err);
    res.send('/* WhatsApp button unavailable */');
  }
});

export default router;