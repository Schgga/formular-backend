import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import {
  sendEmail, renderCampaign, renderConfirm, getSender, isHttpUrl, isImageSrc, API_BASE, APP_BASE, SENDING_DOMAIN,
  sanitizeDesign, designOf, campaignLinks, DEFAULT_THEME, personalize
} from './email.service.js';

// =====================================================================
// EMAIL CAMPAIGNS
//   Owner (logged in):
//     GET    /api/email/mine                         websites, sender details, audience, allowance
//     PUT    /api/email/sender/:websiteId            { fromName, replyTo, postalAddress }
//     GET    /api/email/audience/:websiteId?tag=     how many people would get it
//     GET    /api/email/campaigns/:websiteId         list
//     POST   /api/email/campaigns/:websiteId         { template }   new draft
//     GET    /api/email/campaign/:id
//     PUT    /api/email/campaign/:id                 edit a draft
//     DELETE /api/email/campaign/:id
//     GET    /api/email/campaign/:id/preview         the email as HTML
//     POST   /api/email/campaign/:id/test            { to }   send a test to yourself
//     POST   /api/email/campaign/:id/send            { sendAt }   now, or a future date/time
//     POST   /api/email/campaign/:id/cancel          scheduled → draft, sending → paused
//     POST   /api/email/campaign/:id/resume
//     POST   /api/email/upload/:websiteId            upload a picture (body = the image file) → its link
//   Public:
//     GET  /api/email/o/:token.gif                   counts an open
//     GET  /api/email/c/:token                       counts a click, then goes to the button link
//     POST /api/email/webhook                        bounce/spam reports from Brevo
//     GET  /api/email/img/:file                      uploaded pictures
//
// .env:  EMAIL_MONTHLY_LIMIT=500        emails per user per month (unless set in email_allowances)
//        EMAIL_DAILY_LIMIT_NEW=300      per day during a user's first 14 days of sending
//        EMAIL_DAILY_LIMIT=2000         per day after that
//        EMAIL_WEBHOOK_SECRET=...       any long random text; also put it in the Brevo webhook
//        EMAIL_WORKER=off               only if you run several backend copies and want one to send
//        EMAIL_UPLOAD_DIR=uploads/email where uploaded pictures are saved (default)
// =====================================================================

const router = Router();

const T = (heading, text, button, extra = []) => [
  { type: 'heading', text: heading, align: 'left', size: 'large' },
  { type: 'text', text, align: 'left' },
  ...extra,
  ...(button ? [{ type: 'button', text: button, url: '', align: 'left' }] : [])
];
const TEMPLATES = {
  blank: { name: 'New email', subject: '', blocks: [{ type: 'heading', text: '', align: 'left', size: 'large' }, { type: 'text', text: 'Hi {name},\n\n', align: 'left' }] },
  offer: {
    name: 'Special offer', subject: 'A little something for you, {name} 🎁',
    blocks: T('This week only: a special offer', 'Hi {name},\n\nAs a thank-you for being on our list, we have something just for you.\n\n**[Describe your offer here, e.g. 15% off everything until Sunday.]**\n\nSee you soon!', 'Claim the offer')
  },
  new_arrivals: {
    name: 'New arrivals', subject: 'Just in: new arrivals',
    blocks: T('Fresh in this week', 'Hi {name},\n\nWe just got new [products / services] in, and you are among the first to know.\n\n[Tell them what is new and why they will love it.]', 'Take a look')
  },
  miss_you: {
    name: 'We miss you', subject: 'We miss you, {name}!',
    blocks: T('It has been a while', 'Hi {name},\n\nWe have not seen you in a while and wanted to say hello.\n\n[Add a reason to come back, e.g. a small discount on their next visit.]', 'Book a visit')
  },
  thank_you: {
    name: 'Thank you', subject: 'Thank you for choosing us',
    blocks: T('Thank you!', 'Hi {name},\n\nThank you for being one of our customers. It means a lot to a small business like ours.\n\n[Share a short update or what is coming next.]', '')
  }
};

const clean = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
};
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e || '');
const n = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

// Who can be emailed: agreed to email, confirmed their address, not unsubscribed, not bounced.
const ELIGIBLE = `c.email IS NOT NULL AND c.consent_email AND c.email_confirmed_at IS NOT NULL
                  AND c.unsubscribed_at IS NULL AND c.email_bounced_at IS NULL`;

async function ownsWebsite(websiteId, userId) {
  const r = await pool.query('SELECT id, user_id, business_name FROM user_websites WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [websiteId, userId]);
  return r.rows[0] || null;
}
async function ownCampaign(id, userId) {
  if (!/^\d+$/.test(String(id))) return null;
  const r = await pool.query(
    `SELECT ec.* FROM email_campaigns ec JOIN user_websites uw ON uw.id = ec.website_id
     WHERE ec.id = $1 AND uw.user_id = $2 AND uw.deleted_at IS NULL`, [id, userId]);
  return r.rows[0] || null;
}

async function audienceCount(websiteId, tag) {
  const params = [websiteId];
  let extra = '';
  if (tag) { params.push(tag); extra = ' AND $2 = ANY(c.tags)'; }
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM contacts c WHERE c.website_id = $1 AND ${ELIGIBLE}${extra}`, params);
  return r.rows[0].n;
}

// ---------------------------------------------------------------------
// Allowance: monthly emails (plan) + top-up credits, and a daily cap
// ---------------------------------------------------------------------
export async function getAllowance(userId) {
  const a = (await pool.query('SELECT monthly_limit, extra_credits FROM email_allowances WHERE user_id = $1', [userId])).rows[0];
  const monthlyLimit = a?.monthly_limit ?? n(process.env.EMAIL_MONTHLY_LIMIT, 500);
  const extra = a?.extra_credits ?? 0;
  const u = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE er.sent_at >= date_trunc('month', NOW()))::int AS month,
            COUNT(*) FILTER (WHERE er.sent_at >= date_trunc('day', NOW()))::int AS today,
            (SELECT MIN(ec2.started_at) FROM email_campaigns ec2 JOIN user_websites uw2 ON uw2.id = ec2.website_id WHERE uw2.user_id = $1) AS first_send
     FROM email_recipients er JOIN email_campaigns ec ON ec.id = er.campaign_id JOIN user_websites uw ON uw.id = ec.website_id
     WHERE uw.user_id = $1 AND er.sent_at IS NOT NULL`, [userId])).rows[0];
  const isNew = !u.first_send || new Date(u.first_send) > new Date(Date.now() - 14 * 864e5);
  const dailyLimit = isNew ? n(process.env.EMAIL_DAILY_LIMIT_NEW, 300) : n(process.env.EMAIL_DAILY_LIMIT, 2000);
  const monthLeft = Math.max(0, monthlyLimit - u.month);
  return {
    monthlyLimit, usedThisMonth: u.month, extraCredits: extra,
    left: monthLeft + extra, monthLeft,
    dailyLimit, usedToday: u.today, dailyLeft: Math.max(0, dailyLimit - u.today), isNewSender: isNew
  };
}

// ---------------------------------------------------------------------
// Owner: overview
// ---------------------------------------------------------------------
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const sites = (await pool.query(
      `SELECT id, business_name, logo_url FROM user_websites WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [req.user.id])).rows;
    const websites = [];
    for (const s of sites) {
      const sender = await getSender(s.id);
      const tags = (await pool.query(
        `SELECT DISTINCT UNNEST(c.tags) AS t FROM contacts c WHERE c.website_id = $1 AND ${ELIGIBLE} ORDER BY 1`, [s.id])).rows.map((x) => x.t);
      const unconfirmed = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM contacts c WHERE c.website_id = $1 AND c.email IS NOT NULL AND c.consent_email
         AND c.email_confirmed_at IS NULL AND c.unsubscribed_at IS NULL`, [s.id])).rows[0].n;
      websites.push({
        website_id: s.id, business_name: s.business_name, logo_url: s.logo_url,
        sender: {
          fromName: sender.from_name, fromEmail: sender.from_email, replyTo: sender.reply_to || '', postalAddress: sender.postal_address || '',
          logoUrl: sender.logo_url || '', brandColor: sender.brand_color || DEFAULT_THEME.brandColor
        },
        audience: await audienceCount(s.id, null), unconfirmed, tags
      });
    }
    res.json({
      success: true, websites, allowance: await getAllowance(req.user.id),
      testMode: (process.env.EMAIL_PROVIDER || 'log').toLowerCase() === 'log', sendingDomain: SENDING_DOMAIN(), apiBase: API_BASE(), templates: Object.entries(TEMPLATES).map(([k, t]) => ({ key: k, name: t.name }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load email campaigns' });
  }
});

router.put('/sender/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const b = req.body || {};
    const replyTo = clean(b.replyTo, 190);
    if (replyTo && !isEmail(replyTo)) return res.status(400).json({ success: false, error: 'Please check the reply-to email address.' });
    const logoUrl = clean(b.logoUrl, 500);
    if (logoUrl && !isImageSrc(logoUrl)) return res.status(400).json({ success: false, error: 'Upload your logo, or use a picture link that starts with https://' });
    const brandColor = /^#[0-9a-f]{6}$/i.test(b.brandColor || '') ? b.brandColor : null;
    await getSender(req.params.websiteId);
    await pool.query(
      `UPDATE email_senders SET from_name = $2, reply_to = $3, postal_address = $4, logo_url = $5, brand_color = $6, updated_at = NOW() WHERE website_id = $1`,
      [req.params.websiteId, clean(b.fromName, 80), replyTo, clean(b.postalAddress, 300), logoUrl, brandColor]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

router.get('/audience/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    res.json({ success: true, count: await audienceCount(req.params.websiteId, clean(req.query.tag, 30)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not count' });
  }
});

// ---------------------------------------------------------------------
// Owner: campaigns
// ---------------------------------------------------------------------
const LIST_COLS = `id, kind, name, subject, status, paused_reason, last_error, audience_tag, scheduled_at, started_at, finished_at,
  recipients_total, sent_count, failed_count, open_count, click_count, bounce_count, complaint_count, unsub_count, created_at, updated_at`;

router.get('/campaigns/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const r = await pool.query(`SELECT ${LIST_COLS} FROM email_campaigns WHERE website_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.params.websiteId]);
    res.json({ success: true, campaigns: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load campaigns' });
  }
});

router.post('/campaigns/:websiteId', requireAuth, async (req, res) => {
  try {
    if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
    const t = TEMPLATES[req.body?.template] || TEMPLATES.blank;
    const s = await getSender(req.params.websiteId);
    const design = sanitizeDesign({ theme: { ...DEFAULT_THEME, brandColor: s.brand_color || DEFAULT_THEME.brandColor }, blocks: t.blocks });
    // Template buttons start without a link: keep them so the owner fills the link in
    t.blocks.forEach((b, i) => { if (b.type === 'button') design.blocks[i] = { ...b }; });
    const r = await pool.query(
      `INSERT INTO email_campaigns (website_id, name, subject, design) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.websiteId, t.name, t.subject || null, JSON.stringify(design)]);
    res.json({ success: true, campaign: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create the campaign' });
  }
});

router.get('/campaign/:id', requireAuth, async (req, res) => {
  const c = await ownCampaign(req.params.id, req.user.id).catch(() => null);
  if (!c) return res.status(404).json({ success: false, error: 'Campaign not found' });
  res.json({ success: true, campaign: { ...c, design: designOf(c), raw_design: c.design } });
});

router.put('/campaign/:id', requireAuth, async (req, res) => {
  try {
    const c = await ownCampaign(req.params.id, req.user.id);
    if (!c) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (c.status !== 'draft') return res.status(400).json({ success: false, error: 'Only drafts can be edited. Cancel the schedule first.' });
    const b = req.body || {};
    for (const x of (Array.isArray(b.design?.blocks) ? b.design.blocks : [])) {
      if (x?.type === 'image' && x.src && !isImageSrc(x.src)) return res.status(400).json({ success: false, error: 'A picture link must start with https:// (or upload the picture).' });
      if (x?.type === 'image' && x.link && !isHttpUrl(x.link)) return res.status(400).json({ success: false, error: 'A picture link must start with https:// or http://' });
      if (x?.type === 'button' && x.url && !isHttpUrl(x.url)) return res.status(400).json({ success: false, error: 'A button link must start with https:// or http://' });
      if (x?.type === 'gallery' && (Array.isArray(x.images) ? x.images : []).some((g) => (g?.src && !isImageSrc(g.src)) || (g?.link && !isHttpUrl(g.link)))) {
        return res.status(400).json({ success: false, error: 'A gallery picture or its link is not valid. Upload the picture, and use links that start with https://' });
      }
    }
    const design = sanitizeDesign(b.design);
    await pool.query(
      `UPDATE email_campaigns SET name = $2, subject = $3, preheader = $4, audience_tag = $5, design = $6, updated_at = NOW() WHERE id = $1`,
      [c.id, clean(b.name, 120), clean(b.subject, 150), clean(b.preheader, 150), clean(b.audienceTag, 30), JSON.stringify(design)]);
    res.json({ success: true });
  } catch (err) {
    if (err.userMessage) return res.status(400).json({ success: false, error: err.userMessage });
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

router.delete('/campaign/:id', requireAuth, async (req, res) => {
  try {
    const c = await ownCampaign(req.params.id, req.user.id);
    if (!c) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (c.status === 'sending') return res.status(400).json({ success: false, error: 'Pause it first, then delete.' });
    await pool.query('DELETE FROM email_campaigns WHERE id = $1', [c.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete' });
  }
});

router.get('/campaign/:id/preview', requireAuth, async (req, res) => {
  try {
    const c = await ownCampaign(req.params.id, req.user.id);
    if (!c) return res.status(404).send('Not found');
    const s = await getSender(c.website_id);
    // The preview shows pictures from this backend's real address, whatever PUBLIC_API_URL says
    const imageBase = `${String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0]}://${req.get('host')}`;
    if (c.kind === 'confirm') {
      return res.type('html').send(renderConfirm({ businessName: s.from_name, logoUrl: s.logo_url, brandColor: s.brand_color, imported: true, confirmUrl: '#', unsubscribeUrl: '#', imageBase }).html);
    }
    const { html } = renderCampaign(c, {
      imageBase,
      businessName: s.from_name, logoUrl: s.logo_url, postalAddress: s.postal_address, unsubscribeUrl: '#', firstName: clean(req.query.name, 40) || 'Sarah'
    });
    res.type('html').send(html);
  } catch (err) {
    console.error('[email] preview failed:', err);
    res.status(500).type('text/plain').send(`Preview failed: ${err.message}`);
  }
});

// Test sends: max 15 per user per hour
const testLog = new Map();
router.post('/campaign/:id/test', requireAuth, async (req, res) => {
  try {
    const c = await ownCampaign(req.params.id, req.user.id);
    if (!c) return res.status(404).json({ success: false, error: 'Campaign not found' });
    const to = clean(req.body?.to, 190);
    if (!isEmail(to)) return res.status(400).json({ success: false, error: 'Enter the email address to send the test to.' });
    const recent = (testLog.get(String(req.user.id)) || []).filter((t) => t > Date.now() - 36e5);
    if (recent.length >= 15) return res.status(429).json({ success: false, error: 'Too many tests this hour. Try again later.' });
    testLog.set(String(req.user.id), [...recent, Date.now()]);
    if (!c.subject) return res.status(400).json({ success: false, error: 'Add a subject first.' });
    const s = await getSender(c.website_id);
    const { html, text } = renderCampaign(c, { businessName: s.from_name, logoUrl: s.logo_url, postalAddress: s.postal_address, unsubscribeUrl: `${APP_BASE()}/grow/email` });
    await sendEmail({ to, fromName: s.from_name, fromEmail: s.from_email, replyTo: s.reply_to, subject: `[Test] ${personalize(c.subject, null)}`, html, text, tags: ['formular-test'] });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: `The test could not be sent: ${err.message}` });
  }
});

router.post('/campaign/:id/send', requireAuth, async (req, res) => {
  try {
    const c = await ownCampaign(req.params.id, req.user.id);
    if (!c) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (c.status !== 'draft') return res.status(400).json({ success: false, error: 'This campaign was already sent or scheduled.' });
    const d = designOf(c);
    if (!c.subject) return res.status(400).json({ success: false, error: 'Add a subject first.' });
    if (!d.blocks.some((b) => (b.type === 'text' || b.type === 'heading') && b.text.replace(/\{\s*name\s*\}|hi|,/gi, '').trim())) {
      return res.status(400).json({ success: false, error: 'Write a message first.' });
    }
    if (d.blocks.some((b) => b.type === 'button' && b.text.trim() && !b.url)) {
      return res.status(400).json({ success: false, error: 'One of your buttons has no link. Add a link, or delete the button.' });
    }
    const s = await getSender(c.website_id);
    if (!s.reply_to) return res.status(400).json({ success: false, error: 'Add your reply-to email in "Sender details" so customers can answer you.' });
    if (!s.postal_address) return res.status(400).json({ success: false, error: 'Add your business address in "Sender details". The law requires it in marketing emails.' });
    const count = await audienceCount(c.website_id, c.audience_tag);
    if (count === 0) return res.status(400).json({ success: false, error: 'Nobody can receive this yet. People must join your list and confirm their email first.' });
    const allowance = await getAllowance(req.user.id);
    if (allowance.left < count) {
      return res.status(400).json({ success: false, error: `This would send ${count} emails but you have ${allowance.left} left this month. Upgrade your plan or buy more emails.` });
    }
    let when = new Date();
    if (req.body?.sendAt) {
      when = new Date(req.body.sendAt);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ success: false, error: 'Please pick a valid date and time.' });
      if (when > new Date(Date.now() + 90 * 864e5)) return res.status(400).json({ success: false, error: 'You can schedule up to 90 days ahead.' });
      if (when < new Date()) when = new Date();
    }
    await pool.query(`UPDATE email_campaigns SET status = 'scheduled', scheduled_at = $2, paused_reason = NULL, last_error = NULL, updated_at = NOW() WHERE id = $1`, [c.id, when]);
    kickEmailWorker();
    res.json({ success: true, scheduledAt: when, recipients: count, dailyLimit: allowance.dailyLimit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not schedule the campaign' });
  }
});

router.post('/campaign/:id/cancel', requireAuth, async (req, res) => {
  try {
    const c = await ownCampaign(req.params.id, req.user.id);
    if (!c) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (c.status === 'scheduled') await pool.query(`UPDATE email_campaigns SET status = 'draft', scheduled_at = NULL, updated_at = NOW() WHERE id = $1`, [c.id]);
    else if (c.status === 'sending') await pool.query(`UPDATE email_campaigns SET status = 'paused', paused_reason = 'owner', updated_at = NOW() WHERE id = $1`, [c.id]);
    else return res.status(400).json({ success: false, error: 'Nothing to cancel.' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not cancel' });
  }
});

router.post('/campaign/:id/resume', requireAuth, async (req, res) => {
  try {
    const c = await ownCampaign(req.params.id, req.user.id);
    if (!c) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (c.status !== 'paused') return res.status(400).json({ success: false, error: 'This campaign is not paused.' });
    if (c.paused_reason === 'safety') {
      return res.status(400).json({ success: false, error: 'This campaign was stopped because too many emails bounced or were marked as spam. It cannot be restarted.' });
    }
    await pool.query(`UPDATE email_campaigns SET status = 'sending', paused_reason = NULL, last_error = NULL, updated_at = NOW() WHERE id = $1`, [c.id]);
    kickEmailWorker();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not resume' });
  }
});

// ---------------------------------------------------------------------
// Public: open + click tracking
// ---------------------------------------------------------------------
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const okToken = (t) => /^[a-f0-9]{32}$/.test(String(t || ''));

router.get('/o/:token.gif', async (req, res) => {
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(GIF);
  if (!okToken(req.params.token)) return;
  try {
    const r = await pool.query(`UPDATE email_recipients SET opened_at = NOW() WHERE token = $1 AND opened_at IS NULL RETURNING campaign_id`, [req.params.token]);
    if (r.rows[0]) await pool.query('UPDATE email_campaigns SET open_count = open_count + 1 WHERE id = $1', [r.rows[0].campaign_id]);
  } catch (err) { console.error(err); }
});

router.get('/c/:token', async (req, res) => {
  try {
    if (!okToken(req.params.token)) return res.redirect(302, APP_BASE());
    const r = (await pool.query(
      `SELECT ec.*, er.id AS r_id, er.clicked_at AS r_clicked_at, er.opened_at AS r_opened_at FROM email_recipients er
       JOIN email_campaigns ec ON ec.id = er.campaign_id WHERE er.token = $1`, [req.params.token])).rows[0];
    if (!r) return res.redirect(302, APP_BASE());
    // Only links that are really in this email can be opened (no open redirects).
    const links = campaignLinks(r);
    const i = Number.isInteger(Number(req.query.i)) ? Number(req.query.i) : 0;
    const target = links[i] || links[0];
    if (!target || !isHttpUrl(target)) return res.redirect(302, APP_BASE());
    if (!r.r_clicked_at) { // count each person once, however many links they click
      await pool.query(`UPDATE email_recipients SET clicked_at = NOW(), opened_at = COALESCE(opened_at, NOW()) WHERE id = $1`, [r.r_id]);
      await pool.query(
        `UPDATE email_campaigns SET click_count = click_count + 1, open_count = open_count + $2 WHERE id = $1`, [r.id, r.r_opened_at ? 0 : 1]);
    }
    res.redirect(302, target);
  } catch (err) {
    console.error(err);
    res.redirect(302, APP_BASE());
  }
});

// ---------------------------------------------------------------------
// Pictures: upload (owner) and show (public, used inside emails)
// The browser sends the image file itself as the request body.
// ---------------------------------------------------------------------
const UPLOAD_DIR = () => path.resolve(process.cwd(), process.env.EMAIL_UPLOAD_DIR || 'uploads/email');
const IMAGE_TYPES = {
  'image/png': { ext: 'png', ok: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', ok: (b) => b.slice(0, 4).toString('ascii') === 'GIF8' },
  'image/webp': { ext: 'webp', ok: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' }
};
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

router.post('/upload/:websiteId', requireAuth,
  express.raw({ type: Object.keys(IMAGE_TYPES), limit: '3mb' }),
  async (req, res) => {
    try {
      if (!(await ownsWebsite(req.params.websiteId, req.user.id))) return res.status(404).json({ success: false, error: 'Website not found' });
      const type = IMAGE_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()];
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      if (!type || !body || body.length < 12) return res.status(400).json({ success: false, error: 'Please choose a PNG, JPG, GIF or WEBP picture.' });
      if (!type.ok(body)) return res.status(400).json({ success: false, error: 'This file is not a real picture.' });
      const used = (await pool.query('SELECT COUNT(*)::int AS n FROM email_images WHERE website_id = $1', [req.params.websiteId])).rows[0].n;
      if (used >= 300) return res.status(400).json({ success: false, error: 'You have reached the limit of 300 pictures for this website.' });
      const file = `${crypto.randomBytes(12).toString('hex')}.${type.ext}`;
      fs.mkdirSync(UPLOAD_DIR(), { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR(), file), body);
      await pool.query('INSERT INTO email_images (website_id, file_name, bytes) VALUES ($1, $2, $3)', [req.params.websiteId, file, body.length]);
      const p = `/api/email/img/${file}`;
      res.json({ success: true, path: p, url: `${API_BASE()}${p}` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Could not upload the picture' });
    }
  },
  (err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err?.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'This picture is too big. Please use one under 3 MB.' });
    res.status(400).json({ success: false, error: 'Could not read the picture' });
  });

router.get('/img/:file', (req, res) => {
  const m = /^([a-f0-9]{24})\.(png|jpg|jpeg|gif|webp)$/.exec(req.params.file || '');
  if (!m) return res.status(404).end();
  const full = path.join(UPLOAD_DIR(), req.params.file);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.set({
    'Content-Type': MIME_BY_EXT[m[2]], 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
    // lets the designer crop a picture you uploaded earlier into a new shape
    'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'
  });
  fs.createReadStream(full).pipe(res);
});

// ---------------------------------------------------------------------
// Public: Brevo webhook (bounces, spam complaints, unsubscribes)
// URL to give Brevo:  <PUBLIC_API_URL>/api/email/webhook?secret=<EMAIL_WEBHOOK_SECRET>
// ---------------------------------------------------------------------
async function safetyCheck(campaignId) {
  const c = (await pool.query('SELECT sent_count, bounce_count, complaint_count FROM email_campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!c || c.sent_count < 50) return;
  if (c.bounce_count / c.sent_count > 0.05 || c.complaint_count / c.sent_count > 0.003) {
    await pool.query(
      `UPDATE email_campaigns SET status = 'paused', paused_reason = 'safety', updated_at = NOW() WHERE id = $1 AND status IN ('sending', 'scheduled')`, [campaignId]);
  }
}

router.post('/webhook', async (req, res) => {
  const secret = process.env.EMAIL_WEBHOOK_SECRET;
  const given = req.query.secret || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || given !== secret) return res.status(401).json({ success: false });
  const events = Array.isArray(req.body) ? req.body : [req.body];
  try {
    for (const e of events) {
      const type = e?.event;
      const msgId = e?.['message-id'];
      if (!type || !msgId) continue;
      const r = (await pool.query('SELECT id, campaign_id, contact_id, status FROM email_recipients WHERE provider_id = $1', [msgId])).rows[0];
      if (!r) continue;
      if (['hard_bounce', 'invalid_email', 'blocked'].includes(type) && r.status !== 'bounced') {
        await pool.query(`UPDATE email_recipients SET status = 'bounced', error = $2 WHERE id = $1`, [r.id, String(e.reason || type).slice(0, 300)]);
        await pool.query('UPDATE email_campaigns SET bounce_count = bounce_count + 1 WHERE id = $1', [r.campaign_id]);
        if (r.contact_id) await pool.query('UPDATE contacts SET email_bounced_at = COALESCE(email_bounced_at, NOW()) WHERE id = $1', [r.contact_id]);
        await safetyCheck(r.campaign_id);
      } else if (type === 'spam' && r.status !== 'complained') {
        await pool.query(`UPDATE email_recipients SET status = 'complained' WHERE id = $1`, [r.id]);
        await pool.query('UPDATE email_campaigns SET complaint_count = complaint_count + 1 WHERE id = $1', [r.campaign_id]);
        if (r.contact_id) {
          await pool.query(`UPDATE contacts SET unsubscribed_at = COALESCE(unsubscribed_at, NOW()), consent_email = false, consent_whatsapp = false WHERE id = $1`, [r.contact_id]);
        }
        await safetyCheck(r.campaign_id);
      } else if (type === 'unsubscribed' && r.contact_id) {
        const u = await pool.query(
          `UPDATE contacts SET unsubscribed_at = NOW(), consent_email = false, consent_whatsapp = false WHERE id = $1 AND unsubscribed_at IS NULL RETURNING id`, [r.contact_id]);
        if (u.rows[0]) await pool.query('UPDATE email_campaigns SET unsub_count = unsub_count + 1 WHERE id = $1', [r.campaign_id]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// =====================================================================
// SENDER: works through the queue in the background, a batch at a time,
// so the server stays fast and the daily/monthly limits are respected.
// It starts as soon as something is sent and keeps going until the queue is empty.
// =====================================================================
const BATCH = 50;
const PARALLEL = 6;
const WORKER_ON = process.env.EMAIL_WORKER !== 'off';
let busy = false;
let again = false;

// Imported contacts who still need to say "yes, keep me on the list"
const IMPORT_PENDING = `c.email IS NOT NULL AND c.consent_email AND c.source = 'import' AND c.email_confirmed_at IS NULL
                        AND c.unsubscribed_at IS NULL AND c.email_bounced_at IS NULL`;

/** Start sending right away (instead of waiting for the next check). */
export function kickEmailWorker() {
  if (!WORKER_ON) return;
  if (busy) { again = true; return; }
  setTimeout(tick, 50);
}

/** Queue "please confirm" emails for everyone imported who has not had one yet. */
export async function queueImportConfirmations(websiteId) {
  const pending = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM contacts c WHERE c.website_id = $1 AND ${IMPORT_PENDING} AND c.confirm_sent_at IS NULL`, [websiteId])).rows[0].n;
  if (!pending) return { id: null, count: 0 };
  const existing = (await pool.query(
    `SELECT id FROM email_campaigns WHERE website_id = $1 AND kind = 'confirm' AND status = 'scheduled' LIMIT 1`, [websiteId])).rows[0];
  let id = existing?.id;
  if (!id) {
    id = (await pool.query(
      `INSERT INTO email_campaigns (website_id, kind, name, subject, status, scheduled_at)
       VALUES ($1, 'confirm', 'Confirmation emails for imported contacts', 'Do you still want to hear from us?', 'scheduled', NOW()) RETURNING id`,
      [websiteId])).rows[0].id;
  }
  kickEmailWorker();
  return { id, count: pending };
}

async function startDueCampaigns() {
  const due = (await pool.query(
    `SELECT id FROM email_campaigns WHERE status = 'scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at LIMIT 10`)).rows;
  for (const { id } of due) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = (await client.query(`SELECT * FROM email_campaigns WHERE id = $1 AND status = 'scheduled' FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (!c) { await client.query('ROLLBACK'); continue; }
      const params = [c.id, c.website_id];
      let who = ELIGIBLE;
      if (c.kind === 'confirm') who = `${IMPORT_PENDING} AND c.confirm_sent_at IS NULL`;
      else if (c.audience_tag) { params.push(c.audience_tag); who += ' AND $3 = ANY(c.tags)'; }
      const ins = await client.query(
        `INSERT INTO email_recipients (campaign_id, contact_id, email, token)
         SELECT $1, c.id, c.email, md5(random()::text || clock_timestamp()::text || c.id::text)
         FROM contacts c WHERE c.website_id = $2 AND ${who}
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`, params);
      const total = ins.rowCount;
      await client.query(
        `UPDATE email_campaigns SET status = $2, started_at = NOW(), recipients_total = $3, finished_at = $4, updated_at = NOW() WHERE id = $1`,
        [c.id, total ? 'sending' : 'sent', total, total ? null : new Date()]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[email] could not start campaign', id, err.message);
    } finally {
      client.release();
    }
  }
}

async function runPool(items, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

const firstNameOf = (name) => (String(name || '').trim().split(/\s+/)[0] || '').slice(0, 40) || null;

/** Sends one batch per campaign. Returns true if there may be more to send right away. */
async function sendBatches() {
  let more = false;
  const campaigns = (await pool.query(
    `SELECT ec.*, uw.user_id FROM email_campaigns ec JOIN user_websites uw ON uw.id = ec.website_id
     WHERE ec.status = 'sending' AND uw.deleted_at IS NULL ORDER BY ec.started_at LIMIT 20`)).rows;

  for (const c of campaigns) {
    // Contacts deleted since the campaign started have no row in "contacts": drop them.
    await pool.query(`UPDATE email_recipients SET status = 'failed', error = 'Contact deleted' WHERE campaign_id = $1 AND status = 'queued' AND contact_id IS NULL`, [c.id]);
    const waiting = (await pool.query(`SELECT COUNT(*)::int AS n FROM email_recipients WHERE campaign_id = $1 AND status IN ('queued', 'sending')`, [c.id])).rows[0].n;
    if (!waiting) {
      await pool.query(`UPDATE email_campaigns SET status = 'sent', finished_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1 AND status = 'sending'`, [c.id]);
      continue;
    }

    const allowance = await getAllowance(c.user_id);
    const room = Math.min(BATCH, allowance.left, allowance.dailyLeft);
    if (room <= 0) {
      const reason = allowance.left <= 0 ? 'Monthly email allowance used up.' : `Daily limit of ${allowance.dailyLimit} reached. It continues tomorrow.`;
      if (allowance.left <= 0) {
        await pool.query(`UPDATE email_campaigns SET status = 'paused', paused_reason = 'limit', last_error = $2, updated_at = NOW() WHERE id = $1`, [c.id, reason]);
      } else {
        await pool.query(`UPDATE email_campaigns SET last_error = $2 WHERE id = $1`, [c.id, reason]);
      }
      continue;
    }

    const stillOk = (c.kind === 'confirm' ? IMPORT_PENDING : ELIGIBLE).replace(/\n/g, ' ');
    const batch = (await pool.query(
      `UPDATE email_recipients er SET status = 'sending'
       FROM contacts c
       WHERE er.id IN (SELECT id FROM email_recipients WHERE campaign_id = $1 AND status = 'queued' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
         AND c.id = er.contact_id
       RETURNING er.id, er.email, er.token, er.contact_id, c.name, c.unsubscribe_token, (${stillOk}) AS still_ok`, [c.id, room])).rows;

    if (!batch.length) continue;

    const s = await getSender(c.website_id);
    let sent = 0;
    let failed = 0;
    let stopError = null;

    await runPool(batch, async (r) => {
      if (stopError) {
        await pool.query(`UPDATE email_recipients SET status = 'queued' WHERE id = $1`, [r.id]);
        return;
      }
      if (!r.still_ok) { // unsubscribed, bounced (or already confirmed) since the campaign started
        await pool.query(`UPDATE email_recipients SET status = 'failed', error = 'No longer needed' WHERE id = $1`, [r.id]);
        return;
      }
      const unsubscribeUrl = `${APP_BASE()}/unsubscribe/${r.unsubscribe_token}?r=${r.token}`;
      const oneClick = `${API_BASE()}/api/contacts/u/${r.unsubscribe_token}?r=${r.token}`;
      let html;
      let text;
      let subject;
      if (c.kind === 'confirm') {
        const confirmToken = crypto.randomBytes(20).toString('hex');
        await pool.query('UPDATE contacts SET confirm_token = $2, confirm_sent_at = NOW() WHERE id = $1', [r.contact_id, confirmToken]);
        ({ html, text } = renderConfirm({
          businessName: s.from_name, logoUrl: s.logo_url, brandColor: s.brand_color, imported: true, unsubscribeUrl,
          confirmUrl: `${API_BASE()}/api/contacts/confirm/${confirmToken}`
        }));
        subject = `Do you still want to hear from ${s.from_name}?`;
      } else {
        ({ html, text } = renderCampaign(c, {
          businessName: s.from_name, logoUrl: s.logo_url, postalAddress: s.postal_address, unsubscribeUrl,
          firstName: firstNameOf(r.name),
          openUrl: `${API_BASE()}/api/email/o/${r.token}.gif`,
          track: (url, i) => `${API_BASE()}/api/email/c/${r.token}?i=${i}`
        }));
        subject = personalize(c.subject, firstNameOf(r.name));
      }
      try {
        const out = await sendEmail({
          to: r.email, toName: r.name || undefined, fromName: s.from_name, fromEmail: s.from_email, replyTo: s.reply_to,
          subject, html, text, tags: [`campaign-${c.id}`],
          headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        });
        await pool.query(`UPDATE email_recipients SET status = 'sent', sent_at = NOW(), provider_id = $2 WHERE id = $1`, [r.id, out.id]);
        sent++;
      } catch (err) {
        if (err.permanent) {
          await pool.query(`UPDATE email_recipients SET status = 'failed', error = $2 WHERE id = $1`, [r.id, err.message.slice(0, 300)]);
          failed++;
        } else {
          // Something is wrong with the sending service (wrong key, service down): put it back and pause.
          stopError = err.message;
          await pool.query(`UPDATE email_recipients SET status = 'queued' WHERE id = $1`, [r.id]);
        }
      }
    });

    await pool.query(`UPDATE email_campaigns SET sent_count = sent_count + $2, failed_count = failed_count + $3, updated_at = NOW() WHERE id = $1`, [c.id, sent, failed]);

    // Emails beyond the monthly allowance come out of the top-up credits.
    const fromCredits = Math.max(0, sent - allowance.monthLeft);
    if (fromCredits > 0) {
      await pool.query('UPDATE email_allowances SET extra_credits = GREATEST(0, extra_credits - $2), updated_at = NOW() WHERE user_id = $1', [c.user_id, fromCredits]);
    }

    if (stopError) {
      console.error(`[email] campaign ${c.id} paused: ${stopError}`);
      await pool.query(`UPDATE email_campaigns SET status = 'paused', paused_reason = 'error', last_error = $2, updated_at = NOW() WHERE id = $1`,
        [c.id, `Sending service problem: ${stopError}`.slice(0, 300)]);
    } else {
      more = true;
    }
  }
  return more;
}

async function tick() {
  if (busy) { again = true; return; }
  busy = true;
  let more = false;
  try {
    await startDueCampaigns();
    more = await sendBatches();
  } catch (err) {
    if (err.code !== '42P01') console.error('[email] worker error:', err.message); // 42P01 = tables not created yet
  } finally {
    busy = false;
    if (more || again) { again = false; setTimeout(tick, 250); }
  }
}

if (WORKER_ON) {
  // A campaign interrupted by a restart: anything stuck "sending" goes back in the queue.
  setTimeout(() => {
    pool.query(`UPDATE email_recipients SET status = 'queued' WHERE status = 'sending'`).catch(() => {});
  }, 2000);
  setInterval(tick, Number(process.env.EMAIL_WORKER_INTERVAL_MS) || 15000).unref?.();
  setTimeout(tick, 4000);
}

export default router;