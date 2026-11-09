import { pool } from '../db.js';

// email.service.js sits in different places depending on how the email add-on
// was installed, so it is looked up at run time rather than imported at the top.
// If it cannot be found the server still starts — only the emails are skipped.
let _send = null;
async function mailer() {
  if (_send) return _send;
  const tries = ['../Routes/email.service.js', '../routes/email.service.js', '../email.service.js', '../Services/email.service.js'];
  for (const path of tries) {
    try {
      const mod = await import(path);
      if (typeof mod.sendEmail === 'function') { _send = mod.sendEmail; return _send; }
    } catch { /* try the next one */ }
  }
  throw new Error('The email service is not installed on this server (email.service.js was not found).');
}
const sendEmail = async (opts) => (await mailer())(opts);

// =====================================================================
// Emails the platform itself sends to a site owner.
//
// These are NOT campaign emails — they come from you, not from the
// customer's own sending address, so they use the platform sender set
// in .env:
//
//   PLATFORM_NAME=Pagebase
//   PLATFORM_FROM_EMAIL=hello@pagebase.com
//   PUBLIC_APP_URL=https://app.pagebase.com      (already used elsewhere)
//
// Nothing here ever throws into the caller: a website is still created
// even if the email cannot go out. Failures are logged instead.
// =====================================================================

const NAME = () => process.env.PLATFORM_NAME || 'Formular';
const FROM = () => process.env.PLATFORM_FROM_EMAIL || '';
const APP = () => (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A plain, readable email. No images, so it renders everywhere including slow connections. */
function wrap(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f3f5;
    font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b1f26">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 26px">
      <h1 style="margin:0 0 18px;font-size:21px;line-height:1.3">${esc(title)}</h1>
      ${bodyHtml}
      <p style="margin:26px 0 0;padding-top:18px;border-top:1px solid #e6e8ec;color:#6b7280;font-size:13px">
        ${esc(NAME())}${APP() ? ` &middot; <a href="${esc(APP())}" style="color:#6b7280">${esc(APP().replace(/^https?:\/\//, ''))}</a>` : ''}
      </p>
    </div></body></html>`;
}

const row = (label, value) =>
  `<p style="margin:0 0 4px;color:#6b7280;font-size:13px">${esc(label)}</p>
   <p style="margin:0 0 16px;font-size:16px;font-weight:600">${value}</p>`;

const link = (url) => `<a href="${esc(url)}" style="color:#1d4ed8;word-break:break-all">${esc(url)}</a>`;

/**
 * "Your website is ready" — sent once, right after a site is provisioned.
 * The password is NEVER included, even when the owner chose email login.
 */
export async function sendSiteReadyEmail(userId, website) {
  try {
    if (!FROM()) { console.warn('[siteEmails] PLATFORM_FROM_EMAIL is not set — welcome email skipped'); return; }

    const user = (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
    if (!user?.email) return;

    const name = website.business_name || 'your website';
    const siteUrl = website.site_url || '';
    const adminUrl = website.admin_url || (siteUrl ? `${siteUrl.replace(/\/$/, '')}/admin-console/` : '');
    const byCode = (website.admin_login_method || 'access_code') === 'access_code';

    const signIn = byCode && website.admin_access_code
      ? row('Your access code',
          `<span style="display:inline-block;background:#f2f3f5;border-radius:8px;padding:8px 14px;
            font:700 20px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em">${esc(website.admin_access_code)}</span>`)
      : row('How to sign in', 'With the email address and password you chose.');

    const html = wrap(`${name} is ready`, [
      `<p style="margin:0 0 22px">Your website is live. Here is everything you need.</p>`,
      siteUrl ? row('Your website', link(siteUrl)) : '',
      adminUrl ? row('Where you manage it', link(adminUrl)) : '',
      signIn,
      byCode
        ? `<p style="margin:18px 0 0;color:#6b7280;font-size:14px">Keep this code private — anyone with it can change your website. You can change it any time from My Websites in your dashboard.</p>`
        : `<p style="margin:18px 0 0;color:#6b7280;font-size:14px">We never send passwords by email. If you forget it, reset it from My Websites in your dashboard.</p>`,
      `<p style="margin:22px 0 0">Next: sign in and add your photos, prices and contact details — that is what turns visitors into customers.</p>`
    ].filter(Boolean).join(''));

    const text = [
      `${name} is ready.`, '',
      siteUrl ? `Your website: ${siteUrl}` : '',
      adminUrl ? `Manage it here: ${adminUrl}` : '',
      byCode && website.admin_access_code ? `Access code: ${website.admin_access_code}` : 'Sign in with the email and password you chose.',
      '', byCode ? 'Keep this code private.' : 'We never send passwords by email.'
    ].filter(Boolean).join('\n');

    await sendEmail({
      to: user.email,
      fromName: NAME(),
      fromEmail: FROM(),
      subject: `${name} is ready`,
      html,
      text,
      tags: ['site-ready']
    });
  } catch (err) {
    // A website being created must never fail because an email did not go out
    console.error('[siteEmails] welcome email failed:', err?.message);
  }
}

/**
 * "Here is your admin login" — sent when an owner asks to be reminded.
 * Goes only to the email on the Formular account that owns the site.
 */
export async function sendAdminLoginReminder(userId, website) {
  if (!FROM()) throw new Error('PLATFORM_FROM_EMAIL is not set on the server');

  const user = (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
  if (!user?.email) throw new Error('No email address on your account');

  const name = website.business_name || 'your website';
  const adminUrl = website.admin_url || '';
  const byCode = (website.admin_login_method || 'access_code') === 'access_code';

  const body = byCode && website.admin_access_code
    ? [row('Website', esc(name)),
       adminUrl ? row('Sign in here', link(adminUrl)) : '',
       row('Your access code',
         `<span style="display:inline-block;background:#f2f3f5;border-radius:8px;padding:8px 14px;
           font:700 20px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em">${esc(website.admin_access_code)}</span>`),
       `<p style="margin:18px 0 0;color:#6b7280;font-size:14px">If you did not ask for this, you can ignore it — nothing has changed.</p>`
      ].filter(Boolean).join('')
    : [row('Website', esc(name)),
       adminUrl ? row('Sign in here', link(adminUrl)) : '',
       row('How to sign in', `With <b>${esc(website.admin_email || 'your email address')}</b> and your password.`),
       `<p style="margin:18px 0 0;color:#6b7280;font-size:14px">We cannot send passwords, because we never store them in a readable form. If you have forgotten it, set a new one from My Websites in your dashboard.</p>`
      ].filter(Boolean).join('');

  await sendEmail({
    to: user.email,
    fromName: NAME(),
    fromEmail: FROM(),
    subject: `Your login for ${name}`,
    html: wrap(`Your login for ${name}`, body),
    text: [
      `Your login for ${name}`, '',
      adminUrl ? `Sign in here: ${adminUrl}` : '',
      byCode && website.admin_access_code
        ? `Access code: ${website.admin_access_code}`
        : `Sign in with ${website.admin_email || 'your email address'} and your password. We cannot send passwords.`
    ].filter(Boolean).join('\n'),
    tags: ['admin-login-reminder']
  });
}
