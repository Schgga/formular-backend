import { pool } from '../../db.js';
import { sendEmail } from '../../Routes/email.service.js';

// =====================================================================
// Emails the platform sends to a site owner.
//
// These are NOT campaign emails — they come from you, not from the
// customer's own sending address. They go out through the same sender as
// everything else (Routes/email.service.js → Brevo), so the power to send
// comes from BREVO_API_KEY. The settings below only decide what is written
// on the envelope and what the email looks like.
//
//   PLATFORM_NAME=Pagebase
//   PLATFORM_LOGO_URL=https://.../logo.png     your logo, shown in the header
//   PLATFORM_BRAND_COLOR=#16a34a               buttons and highlights
//   PLATFORM_FROM_EMAIL=hello@pagebase.com     used once that domain is
//                                              authenticated in Brevo
//   EMAIL_FROM_OVERRIDE=you@gmail.com          while no domain is authenticated
//   PUBLIC_APP_URL / PUBLIC_API_URL
//
// Brevo refuses any sender it has not verified, so EMAIL_FROM_OVERRIDE takes
// priority exactly as it does for campaigns.
//
// Written with tables and inline styles on purpose: Outlook ignores most
// modern CSS, and every email program hides pictures until the reader allows
// them. Nothing important is ever inside an image.
// =====================================================================

const NAME = () => process.env.PLATFORM_NAME || 'Formular';
const FROM = () => process.env.EMAIL_FROM_OVERRIDE || process.env.PLATFORM_FROM_EMAIL || '';
const APP = () => (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
const API = () => (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
const BRAND = () => (/^#[0-9a-f]{6}$/i.test(process.env.PLATFORM_BRAND_COLOR || '') ? process.env.PLATFORM_BRAND_COLOR : '#111827');

const INK = '#0f1419';
const MUTED = '#6b7280';
const LINE = '#e8eaed';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Turn whatever is stored as a logo into an address an email program can load.
 * Returns '' when it cannot, so the caller falls back to text rather than
 * showing a broken picture.
 */
function logoUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return '';
  if (/^https:\/\/\S+/i.test(u)) return u;
  if (/^http:\/\/\S+/i.test(u)) return u.replace(/^http:/i, 'https:');  // email blocks mixed content
  if (u.startsWith('/') && API()) return API() + u;
  return '';
}

// Said once at startup so a mistyped address is obvious instead of silent
let warned = false;
function platformLogo() {
  const raw = process.env.PLATFORM_LOGO_URL || '';
  const url = logoUrl(raw);
  if (!url && raw && !warned) {
    warned = true;
    console.warn(`[siteEmails] PLATFORM_LOGO_URL is set to "${raw}" but is not a usable address — `
      + 'it must start with https:// or be a path like /uploads/logo.png (with PUBLIC_API_URL set). '
      + 'Falling back to the platform name in the header.');
  }
  return url;
}

const initialsOf = (name) => {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase();
};

// ---------------------------------------------------------------- pieces

/** A real button — a table cell with a background, which Outlook also renders. */
const button = (label, href) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px">
    <tr><td align="center" bgcolor="${BRAND()}" style="border-radius:10px">
      <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font:600 15px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:10px">${esc(label)}</a>
    </td></tr>
  </table>`;

/** One labelled detail, with a hairline above it. */
const detail = (label, valueHtml) => `
  <tr><td style="padding:14px 0 0;border-top:1px solid ${LINE}">
    <p style="margin:0 0 3px;font:600 11px -apple-system,'Segoe UI',Roboto,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:${MUTED}">${esc(label)}</p>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:${INK}">${valueHtml}</p>
  </td></tr>`;

const linkTo = (url) => `<a href="${esc(url)}" style="color:${BRAND()};text-decoration:none;word-break:break-all">${esc(String(url).replace(/^https?:\/\//, ''))}</a>`;

/** The access code, boxed so it is impossible to miss. */
const codeBox = (code) => `
  <tr><td style="padding:4px 0 16px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
      style="background:#f7f8f9;border:1px solid ${LINE};border-radius:12px">
      <tr><td style="padding:16px 18px">
        <p style="margin:0 0 6px;font:600 11px -apple-system,'Segoe UI',Roboto,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:${MUTED}">Access code</p>
        <p style="margin:0;font:700 24px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.1em;color:${INK}">${esc(code)}</p>
      </td></tr>
    </table>
  </td></tr>`;

const note = (text) => `
  <tr><td style="padding:0 0 4px">
    <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED}">${text}</p>
  </td></tr>`;

/**
 * The shell: your logo in the header, the message in a white card, a quiet
 * footer. `siteName` is the customer's business — shown as a small line of
 * context, never relied upon for the layout.
 */
function shell({ title, intro, rowsHtml, siteName = '' }) {
  const logo = platformLogo();
  const header = logo
    ? `<img src="${esc(logo)}" alt="${esc(NAME())}" height="28"
         style="display:block;height:28px;width:auto;max-height:28px;border:0;outline:none;text-decoration:none">`
    : `<span style="font:700 19px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:-.01em;color:${INK}">${esc(NAME())}</span>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#eef0f3;-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(intro)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef0f3">
    <tr><td align="center" style="padding:32px 16px">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
        style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;
               box-shadow:0 1px 3px rgba(16,24,40,.06)">

        <tr><td style="padding:26px 32px;border-bottom:1px solid ${LINE}">${header}</td></tr>

        <tr><td style="padding:32px 32px 8px">
          <h1 style="margin:0 0 8px;font:700 26px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:-.02em;color:${INK}">${esc(title)}</h1>
          <p style="margin:0 0 ${siteName ? '22' : '26'}px;font-size:16px;line-height:1.6;color:${MUTED}">${intro}</p>
        </td></tr>

        <tr><td style="padding:0 32px 28px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${rowsHtml}
          </table>
        </td></tr>

        <tr><td style="padding:20px 32px 26px;border-top:1px solid ${LINE};background:#fbfbfc">
          <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED}">
            Sent by <span style="color:${INK};font-weight:600">${esc(NAME())}</span>${APP() ? ` &middot; <a href="${esc(APP())}" style="color:${MUTED};text-decoration:underline">${esc(APP().replace(/^https?:\/\//, ''))}</a>` : ''}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ---------------------------------------------------------------- emails

/**
 * "<name> is now live" — sent once, right after provisioning.
 * The password is NEVER included, even for email-login sites.
 */
export async function sendSiteReadyEmail(userId, website) {
  try {
    if (!FROM()) {
      console.warn('[siteEmails] No sender address — set EMAIL_FROM_OVERRIDE or PLATFORM_FROM_EMAIL in .env. Welcome email skipped.');
      return;
    }
    const user = (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
    if (!user?.email) return;

    const site = website.business_name || 'your website';
    const siteUrl = website.site_url || '';
    const adminUrl = website.admin_url || (siteUrl ? `${siteUrl.replace(/\/$/, '')}/admin-console/` : '');
    const byCode = (website.admin_login_method || 'access_code') === 'access_code';

    const rows = [
      siteUrl ? `<tr><td style="padding:0 0 22px">${button('Open my website', siteUrl)}</td></tr>` : '',
      siteUrl ? detail('Your website', linkTo(siteUrl)) : '',
      adminUrl ? detail('Where you manage it', linkTo(adminUrl)) : '',
      byCode && website.admin_access_code
        ? codeBox(website.admin_access_code) + note('Keep this code private — anyone who has it can change your website. You can change it any time from My Websites.')
        : detail('How to sign in', `With <b style="color:${INK}">${esc(website.admin_email || 'your email address')}</b> and the password you chose.`)
          + note('We never send passwords by email. If you forget it, set a new one from My Websites.'),
      note('<br>Next: sign in and add your photos, prices and contact details — that is what turns visitors into customers.')
    ].filter(Boolean).join('');

    const html = shell({
      title: `${site} is now live`,
      intro: 'Your website is on the internet and ready to share.',
      rowsHtml: rows,
      siteName: site
    });

    const text = [
      `${NAME()} — ${site} is now live.`, '',
      siteUrl ? `Your website: ${siteUrl}` : '',
      adminUrl ? `Manage it here: ${adminUrl}` : '',
      byCode && website.admin_access_code ? `Access code: ${website.admin_access_code}` : 'Sign in with the email and password you chose.',
      '', byCode ? 'Keep this code private.' : 'We never send passwords by email.'
    ].filter(Boolean).join('\n');

    await sendEmail({
      to: user.email,
      fromName: NAME(),
      fromEmail: FROM(),
      subject: `${NAME()} — ${site} is now live`,
      html,
      text,
      tags: ['site-ready']
    });
  } catch (err) {
    // A website being created must never fail because an email did not go out
    console.error('[siteEmails] welcome email failed:', err?.message);
  }
}

/** "Your admin login" — sent when an owner asks to be reminded. */
export async function sendAdminLoginReminder(userId, website) {
  if (!FROM()) throw new Error('No sender address is set on the server (EMAIL_FROM_OVERRIDE or PLATFORM_FROM_EMAIL)');

  const user = (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
  if (!user?.email) throw new Error('No email address on your account');

  const site = website.business_name || 'your website';
  const adminUrl = website.admin_url || '';
  const byCode = (website.admin_login_method || 'access_code') === 'access_code';

  const rows = [
    adminUrl ? `<tr><td style="padding:0 0 22px">${button('Go to my admin', adminUrl)}</td></tr>` : '',
    adminUrl ? detail('Sign in here', linkTo(adminUrl)) : '',
    byCode && website.admin_access_code
      ? codeBox(website.admin_access_code) + note('If you did not ask for this, you can ignore it — nothing has changed.')
      : detail('How to sign in', `With <b style="color:${INK}">${esc(website.admin_email || 'your email address')}</b> and your password.`)
        + note('We cannot send passwords, because we never store them in a readable form. If you have forgotten it, set a new one from My Websites.')
  ].filter(Boolean).join('');

  await sendEmail({
    to: user.email,
    fromName: NAME(),
    fromEmail: FROM(),
    subject: `${NAME()} — your admin login for ${site}`,
    html: shell({
      title: `Your admin login for ${site}`,
      intro: 'Here are the details you asked for.',
      rowsHtml: rows,
      siteName: site
    }),
    text: [
      `${NAME()} — your admin login for ${site}`, '',
      adminUrl ? `Sign in here: ${adminUrl}` : '',
      byCode && website.admin_access_code
        ? `Access code: ${website.admin_access_code}`
        : `Sign in with ${website.admin_email || 'your email address'} and your password. We cannot send passwords.`
    ].filter(Boolean).join('\n'),
    tags: ['admin-login-reminder']
  });
}

export { initialsOf, logoUrl };
