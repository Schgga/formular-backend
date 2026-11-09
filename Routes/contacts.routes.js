import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { sendEmail, renderConfirm, getSender, simplePage, API_BASE } from './email.service.js';
import { queueImportConfirmations, getAllowance } from './campaigns.routes.js';

// =====================================================================
// CUSTOMER LIST BUILDER
//   Owner (logged in):  GET    /api/contacts/mine                     websites + sign-up link + numbers
//                       PUT    /api/contacts/form/:websiteId          { isEnabled, headline, offerText, askEmail, askWhatsapp }
//                       GET    /api/contacts/list/:websiteId?q=&tag=&status=active|unsubscribed|all
//                       POST   /api/contacts/add/:websiteId           { name, email, whatsapp, tags, agreeEmail, agreeWhatsapp, confirmed }
//                       PUT    /api/contacts/contact/:id              { name, tags, notes }
//                       DELETE /api/contacts/contact/:id
//                       GET    /api/contacts/export/:websiteId        CSV file
//   Public (no login):  GET  /api/contacts/f/:code                    sign-up page info
//                       POST /api/contacts/f/:code                    { name, email, whatsapp, agreeEmail, agreeWhatsapp, source }
//                       GET  /api/contacts/u/:token                   unsubscribe page info
//                       POST /api/contacts/u/:token                   unsubscribe
//                       GET  /api/contacts/confirm/:token             "confirm your email" link (from the email)
//   Import (logged in):  POST /api/contacts/import/:websiteId           { rows: [{ name, email, whatsapp }], tag, agreed, agreedWhatsapp, confirmFirst }  (max 500 rows per call)
//                        confirmFirst = true  → they get campaigns after answering "Do you still want to hear from us?"
//                        confirmFirst = false → the owner says they already agreed: they can get campaigns straight away
//                        POST /api/contacts/import/:websiteId/confirm   send the "do you still want to hear from us?" emails
//
// Rules built in: people only get on a list by agreeing (ticking the box, or the owner confirming
// they agreed in person). The exact words they agreed to and the time are saved. Anyone can leave
// with one click, and owners cannot put them back on.
// =====================================================================

const router = Router();

const SOURCES = ['qr', 'link', 'nearme', 'review', 'website', 'manual'];
const newCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
const newToken = () => crypto.randomBytes(20).toString('hex');
const clean = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s.slice(0, max);
};
const cleanEmail = (v) => {
  const s = clean(v, 190)?.toLowerCase() || null;
  return s && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s) ? s : (s ? false : null);
};
// WhatsApp numbers are kept as +<country code><number>, 8–15 digits.
const cleanWhatsapp = (v) => {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  return d.length >= 8 && d.length <= 15 ? `+${d}` : false;
};
const cleanTags = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(','))
  .map((t) => String(t).trim().slice(0, 30)).filter(Boolean))].slice(0, 10);

function ipHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  return crypto.createHash('sha256').update(`${process.env.CONTACTS_SALT || 'formular-contacts'}|${ip}`).digest('hex');
}

function consentText(business, email, whatsapp) {
  const ways = [email && 'email', whatsapp && 'WhatsApp'].filter(Boolean).join(' and ');
  return `I agree to receive offers and news from ${business} by ${ways}. I can unsubscribe at any time.`;
}

async function ownsWebsite(websiteId, userId) {
  const r = await pool.query('SELECT id, business_name FROM user_websites WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [websiteId, userId]);
  return r.rows[0] || null;
}
async function ownsContact(id, userId) {
  const r = await pool.query(
    `SELECT c.id FROM contacts c JOIN user_websites uw ON uw.id = c.website_id
     WHERE c.id = $1 AND uw.user_id = $2 AND uw.deleted_at IS NULL`, [id, userId]);
  return r.rows.length > 0;
}

// ---------------------------------------------------------------------
// Owner: websites, each with its sign-up link and numbers
// ---------------------------------------------------------------------
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const missing = await pool.query(
      `SELECT uw.id FROM user_websites uw LEFT JOIN contact_forms cf ON cf.website_id = uw.id
       WHERE uw.user_id = $1 AND uw.deleted_at IS NULL AND cf.id IS NULL`, [req.user.id]);
    for (const w of missing.rows) {
      for (let i = 0; i < 3; i++) {
        try {
          await pool.query('INSERT INTO contact_forms (website_id, code) VALUES ($1, $2) ON CONFLICT (website_id) DO NOTHING', [w.id, newCode()]);
          break;
        } catch (e) {
          if (e.code !== '23505') throw e;
        }
      }
    }

    const r = await pool.query(
      `SELECT uw.id AS website_id, uw.business_name, uw.logo_url,
              cf.code, cf.is_enabled, cf.headline, cf.offer_text, cf.ask_email, cf.ask_whatsapp, cf.opens,
              COALESCE(s.active, 0)::int AS active, COALESCE(s.emails, 0)::int AS emails, COALESCE(s.unconfirmed, 0)::int AS unconfirmed, COALESCE(s.import_unasked, 0)::int AS import_unasked, COALESCE(s.whatsapps, 0)::int AS whatsapps,
              COALESCE(s.week, 0)::int AS week, COALESCE(s.left_list, 0)::int AS left_list, COALESCE(s.sources, '{}'::json) AS sources
       FROM user_websites uw
       JOIN contact_forms cf ON cf.website_id = uw.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*) FILTER (WHERE unsubscribed_at IS NULL) AS active,
                COUNT(*) FILTER (WHERE unsubscribed_at IS NULL AND consent_email AND email IS NOT NULL
                                   AND email_confirmed_at IS NOT NULL AND email_bounced_at IS NULL) AS emails,
                COUNT(*) FILTER (WHERE unsubscribed_at IS NULL AND consent_email AND email IS NOT NULL AND email_confirmed_at IS NULL) AS unconfirmed,
                COUNT(*) FILTER (WHERE unsubscribed_at IS NULL AND consent_email AND email IS NOT NULL AND email_confirmed_at IS NULL
                                   AND source = 'import' AND confirm_sent_at IS NULL) AS import_unasked,
                COUNT(*) FILTER (WHERE unsubscribed_at IS NULL AND consent_whatsapp AND whatsapp IS NOT NULL) AS whatsapps,
                COUNT(*) FILTER (WHERE unsubscribed_at IS NULL AND created_at > NOW() - INTERVAL '7 days') AS week,
                COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL) AS left_list,
                (SELECT json_object_agg(source, n) FROM (
                   SELECT source, COUNT(*) AS n FROM contacts WHERE website_id = uw.id AND unsubscribed_at IS NULL GROUP BY source) x) AS sources
         FROM contacts WHERE website_id = uw.id
       ) s ON true
       WHERE uw.user_id = $1 AND uw.deleted_at IS NULL
       ORDER BY uw.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, websites: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your customer lists' });
  }
});

// ---------------------------------------------------------------------
// Owner: sign-up page settings
// ---------------------------------------------------------------------
router.put('/form/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const b = req.body || {};
    const askEmail = b.askEmail !== false;
    const askWhatsapp = b.askWhatsapp !== false;
    if (!askEmail && !askWhatsapp) return res.status(400).json({ success: false, error: 'Ask for at least email or WhatsApp.' });
    const r = await pool.query(
      `INSERT INTO contact_forms (website_id, code, is_enabled, headline, offer_text, ask_email, ask_whatsapp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (website_id) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, headline = EXCLUDED.headline,
         offer_text = EXCLUDED.offer_text, ask_email = EXCLUDED.ask_email, ask_whatsapp = EXCLUDED.ask_whatsapp, updated_at = NOW()
       RETURNING code, is_enabled, headline, offer_text, ask_email, ask_whatsapp`,
      [req.params.websiteId, newCode(), b.isEnabled !== false, clean(b.headline, 120), clean(b.offerText, 200), askEmail, askWhatsapp]
    );
    res.json({ success: true, form: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

// ---------------------------------------------------------------------
// Owner: list contacts
// ---------------------------------------------------------------------
router.get('/list/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const params = [req.params.websiteId];
    let where = 'website_id = $1';
    const status = req.query.status || 'active';
    if (status === 'active') where += ' AND unsubscribed_at IS NULL';
    if (status === 'unsubscribed') where += ' AND unsubscribed_at IS NOT NULL';
    const q = clean(req.query.q, 80);
    if (q) {
      params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
      where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR whatsapp ILIKE $${params.length})`;
    }
    const tag = clean(req.query.tag, 30);
    if (tag) { params.push(tag); where += ` AND $${params.length} = ANY(tags)`; }

    const r = await pool.query(
      `SELECT id, name, email, whatsapp, tags, notes, source, consent_email, consent_whatsapp, consent_text, consent_at, unsubscribed_at, created_at,
              email_confirmed_at, email_bounced_at, confirm_sent_at
       FROM contacts WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params);
    const t = await pool.query(
      `SELECT DISTINCT UNNEST(tags) AS tag FROM contacts WHERE website_id = $1 ORDER BY 1`, [req.params.websiteId]);
    res.json({ success: true, contacts: r.rows, tags: t.rows.map((x) => x.tag) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load contacts' });
  }
});

// ---------------------------------------------------------------------
// Owner: add a customer who agreed in person
// ---------------------------------------------------------------------
router.post('/add/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const b = req.body || {};
    if (b.confirmed !== true) return res.status(400).json({ success: false, error: 'Please confirm the customer agreed to receive your messages.' });
    const email = cleanEmail(b.email);
    const whatsapp = cleanWhatsapp(b.whatsapp);
    if (email === false) return res.status(400).json({ success: false, error: 'Please check the email address.' });
    if (whatsapp === false) return res.status(400).json({ success: false, error: 'Please enter the WhatsApp number with country code, e.g. +234 803 123 4567.' });
    const agreeEmail = !!(email && b.agreeEmail !== false);
    const agreeWhatsapp = !!(whatsapp && b.agreeWhatsapp !== false);
    if (!agreeEmail && !agreeWhatsapp) return res.status(400).json({ success: false, error: 'Add an email or a WhatsApp number.' });

    const dup = await pool.query(
      `SELECT id, unsubscribed_at FROM contacts WHERE website_id = $1 AND ((email IS NOT NULL AND LOWER(email) = $2) OR (whatsapp IS NOT NULL AND whatsapp = $3)) LIMIT 1`,
      [req.params.websiteId, email || '', whatsapp || '']);
    if (dup.rows[0]) {
      return res.status(409).json({
        success: false,
        error: dup.rows[0].unsubscribed_at
          ? 'This customer unsubscribed. Only they can join again, using your sign-up link.'
          : 'This customer is already on your list.'
      });
    }

    const r = await pool.query(
      `INSERT INTO contacts (website_id, name, email, whatsapp, tags, notes, source, consent_email, consent_whatsapp, consent_text, consent_at, unsubscribe_token, email_confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8, $9, NOW(), $10, CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END) RETURNING id`,
      [req.params.websiteId, clean(b.name, 100), email, whatsapp, cleanTags(b.tags), clean(b.notes, 500), agreeEmail, agreeWhatsapp,
       `Added by the business owner, who confirmed the customer agreed in person. ${consentText(site.business_name, agreeEmail, agreeWhatsapp)}`, newToken()]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not add the customer' });
  }
});

// ---------------------------------------------------------------------
// Owner: edit name / tags / notes (not consent — only the customer can change that)
// ---------------------------------------------------------------------
router.put('/contact/:id', requireAuth, async (req, res) => {
  try {
    if (!(await ownsContact(req.params.id, req.user.id))) return res.status(404).json({ success: false, error: 'Contact not found' });
    const b = req.body || {};
    await pool.query('UPDATE contacts SET name = $1, tags = $2, notes = $3, updated_at = NOW() WHERE id = $4',
      [clean(b.name, 100), cleanTags(b.tags), clean(b.notes, 500), req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

// Owner: delete a contact for good (e.g. the customer asked to be forgotten)
router.delete('/contact/:id', requireAuth, async (req, res) => {
  try {
    if (!(await ownsContact(req.params.id, req.user.id))) return res.status(404).json({ success: false, error: 'Contact not found' });
    await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

// ---------------------------------------------------------------------
// Owner: download as a spreadsheet (CSV, opens in Excel / Google Sheets)
// ---------------------------------------------------------------------
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^\+\d{8,15}$/.test(s)) s = `'${s}`; // stops spreadsheet formulas sneaking in (plain phone numbers are fine)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

router.get('/export/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const r = await pool.query(
      `SELECT name, email, whatsapp, tags, source, consent_email, consent_whatsapp, consent_at, consent_text, unsubscribed_at, created_at, notes,
              email_confirmed_at, email_bounced_at
       FROM contacts WHERE website_id = $1 ORDER BY created_at`, [req.params.websiteId]);
    const head = ['Name', 'Email', 'WhatsApp', 'Tags', 'Joined from', 'Email OK', 'WhatsApp OK', 'Email confirmed', 'Agreed on', 'What they agreed to', 'Status', 'Added', 'Notes'];
    const lines = [head.join(',')].concat(r.rows.map((c) => [
      c.name, c.email, c.whatsapp, c.tags, c.source, c.consent_email && !c.unsubscribed_at ? 'yes' : 'no',
      c.consent_whatsapp && !c.unsubscribed_at ? 'yes' : 'no',
      !c.email ? '' : c.email_bounced_at ? 'bounced' : c.email_confirmed_at ? 'yes' : 'waiting', c.consent_at, c.consent_text,
      c.unsubscribed_at ? 'Unsubscribed - do not message' : 'Subscribed', c.created_at, c.notes
    ].map(csvCell).join(',')));
    const fname = `${site.business_name.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '') || 'customers'}-customers.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${fname}"`).send('﻿' + lines.join('\r\n'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not export' });
  }
});

// ---------------------------------------------------------------------
// Public: sign-up page
// ---------------------------------------------------------------------
async function findForm(code) {
  const r = await pool.query(
    `SELECT cf.*, uw.business_name, uw.logo_url FROM contact_forms cf JOIN user_websites uw ON uw.id = cf.website_id
     WHERE cf.code = $1 AND uw.deleted_at IS NULL`, [String(code).slice(0, 16)]);
  return r.rows[0];
}

router.get('/f/:code', async (req, res) => {
  try {
    const f = await findForm(req.params.code);
    if (!f || !f.is_enabled) return res.status(404).json({ success: false, error: 'This sign-up link is not active.' });
    pool.query('UPDATE contact_forms SET opens = opens + 1 WHERE id = $1', [f.id]).catch(() => {});
    res.json({
      success: true,
      form: {
        businessName: f.business_name, logoUrl: f.logo_url, headline: f.headline, offerText: f.offer_text,
        askEmail: f.ask_email, askWhatsapp: f.ask_whatsapp
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.post('/f/:code', async (req, res) => {
  try {
    const f = await findForm(req.params.code);
    if (!f || !f.is_enabled) return res.status(404).json({ success: false, error: 'This sign-up link is not active.' });
    const b = req.body || {};
    if (b.website) return res.json({ success: true }); // trap field: only robots fill it in

    const email = f.ask_email ? cleanEmail(b.email) : null;
    const whatsapp = f.ask_whatsapp ? cleanWhatsapp(b.whatsapp) : null;
    if (email === false) return res.status(400).json({ success: false, error: 'Please check your email address.' });
    if (whatsapp === false) return res.status(400).json({ success: false, error: 'Please enter your WhatsApp number with country code, e.g. +44 7700 900123.' });
    const agreeEmail = !!(email && b.agreeEmail === true);
    const agreeWhatsapp = !!(whatsapp && b.agreeWhatsapp === true);
    if (!email && !whatsapp) return res.status(400).json({ success: false, error: 'Please enter your email or WhatsApp number.' });
    if (!agreeEmail && !agreeWhatsapp) return res.status(400).json({ success: false, error: 'Please tick the box to agree to receive messages.' });

    const hash = ipHash(req);
    const burst = await pool.query(
      `SELECT COUNT(*)::int AS n FROM contacts WHERE website_id = $1 AND consent_ip_hash = $2 AND updated_at > NOW() - INTERVAL '1 hour'`, [f.website_id, hash]);
    if (burst.rows[0].n >= 5) return res.status(429).json({ success: false, error: 'Too many sign-ups from this device. Please try again later.' });

    const source = SOURCES.includes(b.source) && b.source !== 'manual' ? b.source : 'link';
    const text = consentText(f.business_name, agreeEmail, agreeWhatsapp);
    const name = clean(b.name, 100);

    const byEmail = agreeEmail ? (await pool.query('SELECT * FROM contacts WHERE website_id = $1 AND LOWER(email) = $2', [f.website_id, email])).rows[0] : null;
    const byWa = agreeWhatsapp ? (await pool.query('SELECT * FROM contacts WHERE website_id = $1 AND whatsapp = $2', [f.website_id, whatsapp])).rows[0] : null;

    // Gives permission for one channel on an existing contact. If they had left the list,
    // they are back on it for this channel only.
    const OTHER = { email: 'whatsapp', whatsapp: 'email' };
    async function grant(id, ch, value) {
      await pool.query(
        `UPDATE contacts SET ${ch} = COALESCE(${ch}, $2), consent_${ch} = true,
           consent_${OTHER[ch]} = CASE WHEN unsubscribed_at IS NOT NULL THEN false ELSE consent_${OTHER[ch]} END,
           unsubscribed_at = NULL, name = COALESCE(name, $3), consent_text = $4, consent_at = NOW(), consent_ip_hash = $5, updated_at = NOW()
         WHERE id = $1`,
        [id, value, name, text, hash]);
    }

    let newEmail = false;
    let newWa = false;
    if (agreeEmail) {
      if (byEmail) await grant(byEmail.id, 'email', null);
      else if (byWa && !byWa.email) await grant(byWa.id, 'email', email);
      else newEmail = true;
    }
    if (agreeWhatsapp) {
      if (byWa) await grant(byWa.id, 'whatsapp', null);
      else if (byEmail && !byEmail.whatsapp) await grant(byEmail.id, 'whatsapp', whatsapp);
      else newWa = true;
    }
    if (newEmail || newWa) {
      const withEmail = newEmail;
      const withWa = newWa;
      await pool.query(
        `INSERT INTO contacts (website_id, name, email, whatsapp, source, consent_email, consent_whatsapp, consent_text, consent_at, consent_ip_hash, unsubscribe_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, $10)`,
        [f.website_id, name, withEmail ? email : null, withWa ? whatsapp : null, source, withEmail, withWa, text, hash, newToken()]
      );
    }
    // "Confirm your email": a new email address only counts once its owner clicks the link we send.
    let confirmEmail = false;
    if (agreeEmail) {
      const row = (await pool.query(
        'SELECT id, email_confirmed_at, confirm_sent_at FROM contacts WHERE website_id = $1 AND LOWER(email) = $2', [f.website_id, email])).rows[0];
      if (row && !row.email_confirmed_at) {
        confirmEmail = true;
        if (!row.confirm_sent_at || new Date(row.confirm_sent_at) < new Date(Date.now() - 10 * 60 * 1000)) {
          const token = newToken();
          await pool.query('UPDATE contacts SET confirm_token = $2, confirm_sent_at = NOW() WHERE id = $1', [row.id, token]);
          try {
            const s = await getSender(f.website_id);
            const { html, text: plain } = renderConfirm({ businessName: s.from_name, logoUrl: s.logo_url, confirmUrl: `${API_BASE()}/api/contacts/confirm/${token}` });
            await sendEmail({
              to: email, toName: name || undefined, fromName: s.from_name, fromEmail: s.from_email, replyTo: s.reply_to,
              subject: `Please confirm your email for ${s.from_name}`, html, text: plain, tags: ['formular-confirm']
            });
          } catch (e) {
            console.error('[contacts] confirmation email failed:', e.message);
          }
        }
      }
    }
    res.json({ success: true, offerText: f.offer_text || null, confirmEmail });
  } catch (err) {
    if (err.code === '23505') return res.json({ success: true }); // already on the list
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not sign you up. Please try again.' });
  }
});

// ---------------------------------------------------------------------
// Public: unsubscribe (link goes at the bottom of every message)
// ---------------------------------------------------------------------
const maskEmail = (e) => (e ? e.replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => `${a}${'•'.repeat(Math.min(b.length, 6))}${c}`) : null);
const maskWa = (w) => (w ? `${w.slice(0, 4)}•••••${w.slice(-3)}` : null);

async function findByToken(token) {
  const t = String(token || '');
  if (!/^[a-f0-9]{40}$/.test(t)) return null;
  const r = await pool.query(
    `SELECT c.id, c.email, c.whatsapp, c.unsubscribed_at, uw.business_name FROM contacts c JOIN user_websites uw ON uw.id = c.website_id
     WHERE c.unsubscribe_token = $1`, [t]);
  return r.rows[0] || null;
}

router.get('/u/:token', async (req, res) => {
  try {
    const c = await findByToken(req.params.token);
    if (!c) return res.status(404).json({ success: false, error: 'This link is not valid. You may already have been removed.' });
    res.json({ success: true, businessName: c.business_name, email: maskEmail(c.email), whatsapp: maskWa(c.whatsapp), unsubscribed: !!c.unsubscribed_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.post('/u/:token', async (req, res) => {
  try {
    const c = await findByToken(req.params.token);
    if (!c) return res.status(404).json({ success: false, error: 'This link is not valid. You may already have been removed.' });
    await pool.query(
      `UPDATE contacts SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()), consent_email = false, consent_whatsapp = false, updated_at = NOW() WHERE id = $1`, [c.id]);
    // Came from a campaign email: count it on that campaign (once).
    const r = String(req.query.r || req.body?.r || '');
    if (!c.unsubscribed_at && /^[a-f0-9]{32}$/.test(r)) {
      pool.query(
        `UPDATE email_campaigns SET unsub_count = unsub_count + 1 WHERE id = (SELECT campaign_id FROM email_recipients WHERE token = $1 AND contact_id = $2)`,
        [r, c.id]).catch(() => {});
    }
    res.json({ success: true, businessName: c.business_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not unsubscribe. Please try again.' });
  }
});

// ---------------------------------------------------------------------
// Owner: import an existing customer list (from a spreadsheet)
// The owner chooses: send to them straight away (they already agreed), or ask them to
// confirm first with a one-time "Do you still want to hear from us?" email (safer for old lists).
// People already on the list get the tag added (so a campaign for that tag reaches them),
// but their permission is never changed, and anyone who unsubscribed stays unsubscribed.
// ---------------------------------------------------------------------
router.post('/import/:websiteId', requireAuth, async (req, res) => {
  try {
    const site = await ownsWebsite(req.params.websiteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const b = req.body || {};
    if (b.agreed !== true) return res.status(400).json({ success: false, error: 'Please confirm these people agreed to hear from your business.' });
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 500) : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'No rows to import.' });
    const tags = cleanTags(b.tag ? [b.tag] : []);

    const confirmFirst = b.confirmFirst !== false;
    const counts = { added: 0, already: 0, invalid: 0, duplicates: 0, noPermission: 0, unsubscribed: 0 };
    const seen = new Set();
    const clean_ = [];
    for (const row of rows) {
      let email = cleanEmail(row?.email);
      let wa = cleanWhatsapp(row?.whatsapp);
      if (email === false) email = null;
      if (wa === false) wa = null;
      if (!b.agreedWhatsapp) wa = wa && email ? wa : null; // keep the number only when they also agreed to WhatsApp, or alongside an email
      if (!email && !wa) { counts[row?.whatsapp && !b.agreedWhatsapp ? 'noPermission' : 'invalid']++; continue; }
      const key = email || wa;
      if (seen.has(key)) { counts.duplicates++; continue; }
      seen.add(key);
      clean_.push({ name: clean(row?.name, 100), email, wa });
    }

    if (clean_.length) {
      const emails = clean_.map((x) => x.email).filter(Boolean);
      const was = clean_.map((x) => x.wa).filter(Boolean);
      const existing = (await pool.query(
        `SELECT id, LOWER(email) AS email, whatsapp, unsubscribed_at FROM contacts WHERE website_id = $1 AND (LOWER(email) = ANY($2) OR whatsapp = ANY($3))`,
        [req.params.websiteId, emails, was])).rows;
      const exEmail = new Map(existing.filter((x) => x.email).map((x) => [x.email, x]));
      const exWa = new Map(existing.filter((x) => x.whatsapp).map((x) => [x.whatsapp, x]));
      const consentText = `Imported from the business's own customer list. The owner confirmed these people agreed to receive messages from ${site.business_name}.`
        + (confirmFirst ? ' Email campaigns start only after the person confirms by email.' : '');
      const tagged = [];
      for (const x of clean_) {
        const found = (x.email && exEmail.get(x.email)) || (x.wa && exWa.get(x.wa));
        if (found) { // already on the list: only add the tag
          if (found.unsubscribed_at) counts.unsubscribed++; else counts.already++;
          if (tags.length) tagged.push(found.id);
          continue;
        }
        const r = await pool.query(
          `INSERT INTO contacts (website_id, name, email, whatsapp, tags, source, consent_email, consent_whatsapp, consent_text, consent_at, unsubscribe_token, email_confirmed_at)
           VALUES ($1, $2, $3, $4, $5, 'import', $6, $7, $8, NOW(), $9, $10) ON CONFLICT DO NOTHING RETURNING id`,
          [req.params.websiteId, x.name, x.email, x.wa, tags, !!x.email, !!(x.wa && b.agreedWhatsapp), consentText, newToken(),
           !confirmFirst && x.email ? new Date() : null]);
        if (r.rows[0]) counts.added++; else counts.already++;
      }
      if (tagged.length) {
        await pool.query(
          `UPDATE contacts SET tags = array_append(tags, $2), updated_at = NOW() WHERE id = ANY($1) AND NOT ($2 = ANY(tags))`, [tagged, tags[0]]);
      }
      // "They already agreed": people waiting to confirm from an earlier import can now get emails too
      const waiting = clean_.map((x) => x.email && exEmail.get(x.email)).filter((f) => f && !f.unsubscribed_at).map((f) => f.id);
      if (!confirmFirst && waiting.length) {
        await pool.query(
          `UPDATE contacts SET email_confirmed_at = NOW(), updated_at = NOW()
           WHERE id = ANY($1) AND email_confirmed_at IS NULL AND consent_email AND unsubscribed_at IS NULL AND email_bounced_at IS NULL`, [waiting]);
      }
    }
    res.json({ success: true, ...counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not import' });
  }
});

router.post('/import/:websiteId/confirm', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const pending = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM contacts WHERE website_id = $1 AND source = 'import' AND consent_email AND email IS NOT NULL
       AND email_confirmed_at IS NULL AND confirm_sent_at IS NULL AND unsubscribed_at IS NULL AND email_bounced_at IS NULL`, [req.params.websiteId])).rows[0].n;
    if (!pending) return res.json({ success: true, count: 0 });
    const allowance = await getAllowance(req.user.id);
    if (allowance.left < pending) {
      return res.status(400).json({
        success: false,
        error: `Asking ${pending} people to confirm uses ${pending} emails, but you have ${allowance.left} left this month. Upgrade your plan or buy more emails, then try again.`
      });
    }
    const out = await queueImportConfirmations(req.params.websiteId);
    res.json({ success: true, count: out.count, dailyLimit: allowance.dailyLimit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not send the confirmation emails' });
  }
});

// ---------------------------------------------------------------------
// Public: "confirm your email" link
// ---------------------------------------------------------------------
router.get('/confirm/:token', async (req, res) => {
  try {
    const t = String(req.params.token || '');
    if (!/^[a-f0-9]{40}$/.test(t)) return res.status(404).type('html').send(simplePage('Link not valid', 'This confirmation link is not valid or was already used.'));
    const r = (await pool.query(
      `UPDATE contacts c SET email_confirmed_at = COALESCE(c.email_confirmed_at, NOW()), confirm_token = NULL, updated_at = NOW()
       FROM user_websites uw WHERE uw.id = c.website_id AND c.confirm_token = $1 RETURNING uw.business_name`, [t])).rows[0];
    if (!r) return res.status(404).type('html').send(simplePage('Link not valid', 'This confirmation link is not valid or was already used.'));
    res.type('html').send(simplePage('Email confirmed ✓', `Thanks! You're on ${r.business_name}'s list. You can unsubscribe at any time with the link in every email.`));
  } catch (err) {
    console.error(err);
    res.status(500).type('html').send(simplePage('Something went wrong', 'Please try the link again in a moment.'));
  }
});

export default router;