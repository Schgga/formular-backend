import fs from 'fs';
import path from 'path';
import { pool } from '../db.js';
import { siteName, poweredBy } from './siteName.js';

// =====================================================================
// EMAIL SERVICE — one place that actually sends emails.
//
// .env settings:
//   EMAIL_PROVIDER=log        log = don't send, save emails to the "email-outbox" folder (for localhost)
//                  brevo      send through Brevo (needs BREVO_API_KEY)
//                  resend     send through Resend (needs RESEND_API_KEY)
//   BREVO_API_KEY=...         (secret — only ever in .env on the server)
//   EMAIL_SENDING_DOMAIN=mail.yourdomain.com   the domain you authenticated with Brevo
//   EMAIL_FROM_OVERRIDE=you@gmail.com          TESTING ONLY, before you have a domain: send everything
//                                              from this verified Brevo sender instead
//   PUBLIC_API_URL=https://api.yourdomain.com  your backend address (used in links inside emails)
//   PUBLIC_APP_URL=https://app.yourdomain.com  your Formular frontend address
// =====================================================================

const PROVIDER = () => (process.env.EMAIL_PROVIDER || 'log').toLowerCase();
export const SENDING_DOMAIN = () => (process.env.EMAIL_SENDING_DOMAIN || 'mail.example.com').toLowerCase();
export const API_BASE = () => (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '');
export const APP_BASE = () => (process.env.PUBLIC_APP_URL || 'http://localhost:5173').replace(/\/$/, '');

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isHttpUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };

/**
 * Send one email. Returns { id } (the provider's message id).
 * Throws an Error with .permanent = true when retrying will not help (e.g. invalid address).
 */
export async function sendEmail({ to, toName, fromName, fromEmail, replyTo, subject, html, text, headers = {}, tags = [] }) {
  const provider = PROVIDER();

  if (provider === 'brevo') {
    if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY is missing in .env');
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: fromName, email: fromEmail },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        subject, htmlContent: html, textContent: text,
        // Brevo refuses empty "headers" or "tags", so only send them when there is something in them
        ...(headers && Object.keys(headers).length ? { headers } : {}),
        ...(tags && tags.length ? { tags } : {})
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Brevo ${res.status}: ${data.message || data.code || 'send failed'}`);
      err.permanent = res.status === 400;
      throw err;
    }
    return { id: data.messageId || null };
  }

  if (provider === 'resend') {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is missing in .env');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${fromName.replace(/[<>"]/g, '')} <${fromEmail}>`, to: [to], subject, html, text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
        ...(tags && tags.length ? { tags: tags.map((t) => ({ name: 'tag', value: String(t).replace(/[^\w-]/g, '_') })) } : {})
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Resend ${res.status}: ${data.message || 'send failed'}`);
      err.permanent = res.status === 422;
      throw err;
    }
    return { id: data.id || null };
  }

  // "log" mode: nothing is sent. The email is saved as a file you can open in your browser.
  const dir = path.resolve(process.cwd(), 'email-outbox');
  fs.mkdirSync(dir, { recursive: true });
  const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `${id}.html`);
  const info = `<div style="font:13px monospace;background:#fff8d6;padding:10px;border-bottom:1px solid #e6d77a">
    TEST MODE (EMAIL_PROVIDER=log) — not sent.<br>From: ${esc(fromName)} &lt;${esc(fromEmail)}&gt;<br>To: ${esc(to)}<br>Reply-To: ${esc(replyTo || '')}<br>Subject: ${esc(subject)}</div>`;
  fs.writeFileSync(file, info + html);
  console.log(`[email:log] To ${to} | ${subject} | saved to ${file}`);
  return { id };
}

// ---------------------------------------------------------------------
// Email designs
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// EMAIL DESIGN
// A design is { theme, blocks }:
//   theme:  { brandColor, bgColor, font: 'sans'|'serif', headerAlign: 'left'|'center', showLogo }
//   blocks: [{ type: 'heading'|'text'|'image'|'gallery'|'button'|'divider'|'spacer', ... }]
// Pictures uploaded in Formular are saved as "/api/email/img/<file>" and turned into full links here.
// ---------------------------------------------------------------------
const FONTS = {
  sans: 'Segoe UI,Roboto,Helvetica,Arial,sans-serif',
  serif: "Georgia,'Times New Roman',Times,serif"
};
const COLOR = /^#[0-9a-f]{6}$/i;
const ALIGN = ['left', 'center', 'right'];
const UPLOAD_PATH = /^\/api\/email\/img\/[a-z0-9]{24}\.(png|jpe?g|gif|webp)$/;
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/gi;

export const DEFAULT_THEME = { brandColor: '#111418', bgColor: '#f2f3f5', font: 'sans', headerAlign: 'left', showLogo: true };

const str = (v, max) => String(v ?? '').slice(0, max);
const pick = (v, list, d) => (list.includes(v) ? v : d);

// Is this an image address we can put in an email? (https link, or a picture uploaded in Formular)
export const isImageSrc = (u) => UPLOAD_PATH.test(String(u || '')) || /^https:\/\//i.test(String(u || ''));
// Full address of an image (uploads are served by this backend)
export const imageSrc = (u, base) => (UPLOAD_PATH.test(String(u || '')) ? `${base || API_BASE()}${u}` : u);

/** Clean up a design sent from the browser. Anything unknown is dropped. */
export function sanitizeDesign(d) {
  const t = d?.theme || {};
  const theme = {
    brandColor: COLOR.test(t.brandColor) ? t.brandColor : DEFAULT_THEME.brandColor,
    bgColor: COLOR.test(t.bgColor) ? t.bgColor : DEFAULT_THEME.bgColor,
    font: pick(t.font, ['sans', 'serif'], 'sans'),
    headerAlign: pick(t.headerAlign, ['left', 'center'], 'left'),
    showLogo: t.showLogo !== false
  };
  const color = (v) => (COLOR.test(v || '') ? v : '');
  const num = (v, min, max) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(max, Math.max(min, Math.round(Number(v)))) : null);
  const image = (x) => ({
    src: str(x.src, 500), alt: str(x.alt, 120), link: isHttpUrl(x.link) ? str(x.link, 500) : '',
    original: isImageSrc(x.original) ? str(x.original, 500) : '' // the uncropped picture, so the shape can be changed later
  });
  const SHAPES = ['original', 'square', 'landscape', 'wide', 'banner', 'portrait'];
  const blocks = [];
  for (const b of (Array.isArray(d?.blocks) ? d.blocks : []).slice(0, 40)) {
    const align = pick(b?.align, ALIGN, 'left');
    if (b?.type === 'heading') {
      blocks.push({ type: 'heading', text: str(b.text, 200), align, size: pick(b.size, ['xl', 'large', 'medium', 'small'], 'large'), color: color(b.color) });
    } else if (b?.type === 'text') {
      blocks.push({ type: 'text', text: str(b.text, 5000), align, size: pick(b.size, ['small', 'normal', 'large', 'xl'], 'normal'), color: color(b.color) });
    } else if (b?.type === 'image' && isImageSrc(b.src)) {
      blocks.push({
        type: 'image', ...image(b), width: pick(b.width, ['full', 'large', 'medium', 'small'], 'full'),
        widthPct: num(b.widthPct, 20, 100), height: num(b.height, 40, 800), shape: pick(b.shape, SHAPES, 'original'), rounded: b.rounded !== false
      });
    } else if (b?.type === 'gallery') {
      const images = (Array.isArray(b.images) ? b.images : []).filter((x) => isImageSrc(x?.src)).slice(0, 6).map(image);
      blocks.push({
        type: 'gallery', images, columns: pick(Number(b.columns), [2, 3], 2), shape: pick(b.shape, SHAPES, 'original'), rounded: b.rounded !== false,
        widthPct: num(b.widthPct, 30, 100), height: num(b.height, 40, 500)
      });
    } else if (b?.type === 'button') {
      blocks.push({
        type: 'button', text: str(b.text, 40), url: isHttpUrl(b.url) ? str(b.url, 500) : '', align: pick(b?.align, ALIGN, 'center'),
        color: color(b.color), textColor: color(b.textColor), size: pick(b.size, ['small', 'medium', 'large'], 'medium'),
        shape: pick(b.shape, ['pill', 'rounded', 'square'], 'pill'), fullWidth: b.fullWidth === true
      });
    } else if (b?.type === 'divider') blocks.push({ type: 'divider', color: color(b.color) });
    else if (b?.type === 'spacer') blocks.push({ type: 'spacer', size: pick(b.size, ['small', 'medium', 'large'], 'medium') });
  }
  return { theme, blocks };
}

/** Old campaigns (before the designer) are turned into blocks. */
export function legacyDesign(c) {
  const blocks = [];
  if (c.image_url) blocks.push({ type: 'image', src: c.image_url, width: 'full', alt: '' });
  if (c.heading) blocks.push({ type: 'heading', text: c.heading, align: 'left', size: 'large' });
  if (c.body) blocks.push({ type: 'text', text: c.body, align: 'left' });
  if (c.button_text) blocks.push({ type: 'button', text: c.button_text, url: c.button_url || '', align: 'left' });
  return sanitizeDesign({ theme: DEFAULT_THEME, blocks });
}

export const designOf = (c) => (c.design && Array.isArray(c.design.blocks) ? sanitizeDesign(c.design) : legacyDesign(c));

/** {name} → the person's first name, or "there" */
export const personalize = (s, firstName) => String(s ?? '').replace(/\{\s*(first_?)?name\s*\}/gi, firstName || 'there');

// Black or white text, whichever is easier to read on this colour
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111418' : '#ffffff';
}

/**
 * Turn a design into email HTML + plain text.
 * ctx.track(url) returns the tracked link for a URL (or the URL itself when not tracking).
 * Returns { html, text, links } — links = every clickable URL in order (used for click tracking).
 */
export function renderDesign(design, ctx) {
  const { theme, blocks } = design;
  const font = FONTS[theme.font];
  const links = [];
  const link = (u) => { links.push(u); return ctx.track ? ctx.track(u, links.length - 1) : u; };
  const name = ctx.firstName;
  const textLines = [];

  const richText = (raw) => {
    const s = personalize(raw, name);
    let out = '';
    let last = 0;
    for (const m of s.matchAll(URL_IN_TEXT)) {
      out += fmt(s.slice(last, m.index));
      out += `<a href="${esc(link(m[0]))}" style="color:${theme.brandColor};text-decoration:underline">${esc(m[0])}</a>`;
      last = m.index + m[0].length;
    }
    return out + fmt(s.slice(last));
  };
  const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

  const imgTag = (src, alt, style, widthAttr) => `<img src="${esc(imageSrc(src, ctx.imageBase))}" alt="${esc(alt)}"${widthAttr ? ` width="${widthAttr}"` : ''} style="display:block;border:0;${style}">`;
  // A picture with a set height: cropped to fit (never stretched). Old Outlook for Windows ignores the
  // crop, so it gets the whole picture at the right width instead.
  const fixedHeight = (src, alt, w, h, radius, center = true) => `<!--[if mso]>${imgTag(src, alt, `width:${w}px;height:auto;`, w)}<![endif]-->`
    + `<!--[if !mso]><!--><div style="${center ? 'margin:0 auto;' : ''}max-width:${w}px;height:${h}px;overflow:hidden;${radius}">`
    + `${imgTag(src, alt, `width:100%;height:${h}px;object-fit:cover;${radius}`, w)}</div><!--<![endif]-->`;
  const linked = (x, html) => {
    if (!x.link) return html;
    const href = link(x.link);
    textLines.push(`${x.alt || 'Picture'}: ${href}`, '');
    return `<a href="${esc(href)}" style="text-decoration:none">${html}</a>`;
  };

  const rows = blocks.map((b) => {
    if (b.type === 'heading') {
      const t = personalize(b.text, name);
      if (!t.trim()) return '';
      textLines.push(t, '');
      const px = { xl: 32, large: 27, medium: 22, small: 18 }[b.size];
      return `<tr><td style="padding:10px 32px 4px;text-align:${b.align}"><h1 style="margin:0;font-family:${font};font-size:${px}px;line-height:1.25;color:${b.color || '#14171c'}">${esc(t)}</h1></td></tr>`;
    }
    if (b.type === 'text') {
      if (!b.text.trim()) return '';
      textLines.push(personalize(b.text, name).replace(/\*\*/g, ''), '');
      const px = { small: 14, normal: 16, large: 19, xl: 23 }[b.size];
      const paras = b.text.trim().split(/\n\s*\n/).map((p) => `<p style="margin:0 0 14px;font-family:${font};font-size:${px}px;line-height:1.6;color:${b.color || '#2b3038'}">${richText(p)}</p>`).join('');
      return `<tr><td style="padding:8px 32px 0;text-align:${b.align}">${paras}</td></tr>`;
    }
    if (b.type === 'image') {
      const edge = b.width === 'full' && (!b.widthPct || b.widthPct === 100); // picture from edge to edge
      const w = edge ? 600 : b.widthPct ? Math.round(536 * b.widthPct / 100) : { full: 536, large: 480, medium: 340, small: 200 }[b.width];
      const radius = edge || !b.rounded ? '' : 'border-radius:10px;';
      const style = `margin:0 auto;width:100%;max-width:${w}px;height:auto;${radius}`; // height follows the width, so pictures never stretch
      const pic = b.height ? fixedHeight(b.src, b.alt, w, b.height, radius) : imgTag(b.src, b.alt, style, w);
      return `<tr><td style="padding:${edge ? '0' : '10px 32px'};text-align:center" align="center">${linked(b, pic)}</td></tr>`;
    }
    if (b.type === 'gallery') {
      if (!b.images.length) return '';
      const cols = b.columns;
      const gap = 8;
      const total = Math.round(536 * (b.widthPct || 100) / 100);
      const cellW = Math.floor((total - gap * (cols - 1)) / cols);
      const radius = b.rounded ? 'border-radius:8px;' : '';
      const style = `width:100%;max-width:${cellW}px;height:auto;${radius}`; // same shape = same height (pictures are cropped when uploaded)
      const cells = b.images.map((x) => `<td width="${Math.floor(100 / cols)}%" valign="top" style="padding:${gap / 2}px">${linked(x,
        b.height ? fixedHeight(x.src, x.alt, cellW, b.height, radius, false) : imgTag(x.src, x.alt, style, cellW))}</td>`);
      const trs = [];
      for (let i = 0; i < cells.length; i += cols) {
        const row = cells.slice(i, i + cols);
        while (row.length < cols) row.push(`<td width="${Math.floor(100 / cols)}%" style="padding:${gap / 2}px"></td>`);
        trs.push(`<tr>${row.join('')}</tr>`);
      }
      return `<tr><td style="padding:6px ${32 - gap / 2}px" align="center"><table role="presentation" width="${total === 536 ? '100%' : total + gap}" cellpadding="0" cellspacing="0" align="center" style="table-layout:fixed;margin:0 auto;max-width:${total + gap}px;width:100%">${trs.join('')}</table></td></tr>`;
    }
    if (b.type === 'button') {
      if (!b.text.trim() || !b.url) return '';
      const href = link(b.url);
      textLines.push(`${personalize(b.text, name)}: ${href}`, '');
      const bg = b.color || theme.brandColor;
      const fg = b.textColor || textOn(bg);
      const [pad, fs] = { small: ['10px 20px', 14], medium: ['14px 30px', 16], large: ['18px 42px', 19] }[b.size];
      const radius = { pill: 999, rounded: 10, square: 0 }[b.shape];
      const display = b.fullWidth ? 'display:block;text-align:center;' : 'display:inline-block;';
      return `<tr><td style="padding:12px 32px 18px;text-align:${b.align}" align="${b.align}"><a href="${esc(href)}" style="${display}background:${bg};color:${fg};font-family:${font};font-weight:700;font-size:${fs}px;line-height:1.2;text-decoration:none;padding:${pad};border-radius:${radius}px">${esc(personalize(b.text, name))}</a></td></tr>`;
    }
    if (b.type === 'divider') return `<tr><td style="padding:14px 32px"><div style="border-top:1px solid ${b.color || '#e4e6ea'};font-size:0;line-height:0">&nbsp;</div></td></tr>`;
    if (b.type === 'spacer') return `<tr><td style="height:${{ small: 12, medium: 24, large: 44 }[b.size]}px;font-size:0;line-height:0">&nbsp;</td></tr>`;
    return '';
  }).join('\n');

  const logo = theme.showLogo && ctx.logoUrl && isImageSrc(ctx.logoUrl)
    ? `<img src="${esc(imageSrc(ctx.logoUrl, ctx.imageBase))}" alt="${esc(ctx.businessName)}" height="44" style="height:44px;max-width:180px;border:0;vertical-align:middle;${theme.headerAlign === 'center' ? 'display:block;margin:0 auto 8px;' : 'margin-right:10px;'}">` : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ctx.businessName)}</title></head>
<body style="margin:0;padding:0;background:${theme.bgColor}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(personalize(ctx.preheader || '', name))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${theme.bgColor}"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="padding:22px 32px;border-bottom:3px solid ${theme.brandColor};text-align:${theme.headerAlign};font-family:${font}">${logo}<span style="font-size:18px;font-weight:700;color:#14171c;vertical-align:middle">${esc(ctx.businessName)}</span></td></tr>
<tr><td style="height:14px;font-size:0;line-height:0">&nbsp;</td></tr>
${rows}
<tr><td style="height:18px;font-size:0;line-height:0">&nbsp;</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px"><tr><td style="padding:18px 24px;font:12px/1.6 ${font};color:#7a808a;text-align:center">${ctx.footer || ''}</td></tr></table>
</td></tr></table>${ctx.openUrl ? `<img src="${esc(ctx.openUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : ''}</body></html>`;

  return { html, text: textLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), links };
}

export function renderCampaign(c, { businessName, logoUrl, postalAddress, openUrl, unsubscribeUrl, firstName, track, imageBase }) {
  const footer = `You are getting this email because you joined ${esc(businessName)}'s list.<br>
${postalAddress ? `${esc(businessName)} · ${esc(postalAddress)}<br>` : ''}<a href="${esc(unsubscribeUrl)}" style="color:#7a808a">Unsubscribe</a>`;
  const out = renderDesign(designOf(c), { businessName, logoUrl, preheader: c.preheader, footer, openUrl, firstName, track, imageBase });
  out.text += `\n\n—\nYou are getting this email because you joined ${businessName}'s list.${postalAddress ? `\n${businessName} · ${postalAddress}` : ''}\nUnsubscribe: ${unsubscribeUrl}`;
  return out;
}

/** Every clickable link in a campaign, in order (for safe click tracking). */
export const campaignLinks = (c) => renderDesign(designOf(c), { businessName: '', track: null }).links;

export function renderConfirm({ businessName, logoUrl, brandColor, confirmUrl, imported, unsubscribeUrl, imageBase }) {
  const blocks = imported
    ? [
      { type: 'heading', text: `Do you still want to hear from ${businessName}?`, align: 'left', size: 'medium' },
      { type: 'text', text: `You are on ${businessName}'s customer list. We'd love to keep sending you our offers and news, but only if you want them.\n\nTap the button below to say yes. If you don't, we won't email you again.`, align: 'left' }
    ]
    : [
      { type: 'heading', text: 'Please confirm your email', align: 'left', size: 'medium' },
      { type: 'text', text: `You asked to join ${businessName}'s list. Tap the button to confirm it's you.`, align: 'left' }
    ];
  blocks.push({ type: 'button', text: imported ? 'Yes, keep me on the list' : 'Yes, confirm my email', url: confirmUrl, align: 'left' });
  blocks.push({ type: 'text', text: imported ? "If you don't recognise this business, simply ignore this email." : "If this wasn't you, ignore this email and you won't hear from us.", align: 'left' });
  const footer = `Sent ${siteName() ? `by ${esc(siteName())} ` : ''}on behalf of ${esc(businessName)}.${unsubscribeUrl ? `<br><a href="${esc(unsubscribeUrl)}" style="color:#7a808a">Unsubscribe</a>` : ''}`;
  const design = sanitizeDesign({ theme: { ...DEFAULT_THEME, brandColor: brandColor || DEFAULT_THEME.brandColor }, blocks });
  // The confirm link is not an http(s) link check problem: it is our own API address
  design.blocks.find((b) => b.type === 'button').url = confirmUrl;
  const out = renderDesign(design, { businessName, logoUrl, footer, imageBase, preheader: imported ? `Tap to keep getting offers from ${businessName}` : `Confirm you want offers and news from ${businessName}` });
  return { html: out.html, text: out.text };
}

// A tiny HTML page for links people open from emails (confirm, etc.)
export function simplePage(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="margin:0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f2f3f5;color:#1b1e23">
<div style="max-width:440px;margin:60px auto;padding:0 16px"><div style="background:#fff;border-radius:16px;padding:32px;text-align:center">
<h1 style="font-size:22px;margin:0 0 10px">${esc(title)}</h1><p style="margin:0;color:#5d6470;line-height:1.6">${esc(message)}</p></div>
<p style="text-align:center;font-size:12px;color:#9aa0a8;margin-top:18px">${esc(poweredBy())}</p></div></body></html>`;
}

// ---------------------------------------------------------------------
// Who a website's emails come from. Created the first time it is needed.
//   From:     <Business name> <slug@EMAIL_SENDING_DOMAIN>
//   Reply-To: the business's own email (so replies reach the owner)
// ---------------------------------------------------------------------
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '').slice(0, 40) || 'business';

export async function getSender(websiteId) {
  const site = (await pool.query(
    'SELECT id, business_name, logo_url, support_email FROM user_websites WHERE id = $1', [websiteId])).rows[0];
  if (!site) return null;
  let row = (await pool.query('SELECT * FROM email_senders WHERE website_id = $1', [websiteId])).rows[0];
  if (!row) {
    let address = null;
    try {
      address = (await pool.query(
        `SELECT NULLIF(CONCAT_WS(', ', address, city, region, country), '') AS a FROM directory_listings WHERE website_id = $1`, [websiteId])).rows[0]?.a || null;
    } catch { /* Near Me not installed */ }
    const base = slugify(site.business_name);
    for (let i = 0; i < 20 && !row; i++) {
      const slug = i === 0 ? base : `${base}${i + 1}`;
      try {
        row = (await pool.query(
          `INSERT INTO email_senders (website_id, slug, from_name, reply_to, postal_address) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (website_id) DO UPDATE SET website_id = EXCLUDED.website_id RETURNING *`,
          [websiteId, slug, site.business_name, site.support_email || null, address])).rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e; // that name is taken by another business: try the next number
      }
    }
  }
  return {
    ...row,
    business_name: site.business_name,
    logo_url: row.logo_url || site.logo_url,
    brand_color: row.brand_color || null,
    from_name: row.from_name || site.business_name,
    // EMAIL_FROM_OVERRIDE: for testing before you have your own domain. Every email is sent
    // from this one verified Brevo sender (e.g. your Gmail). Remove it once your domain is set up.
    from_email: process.env.EMAIL_FROM_OVERRIDE || `${row.slug}@${SENDING_DOMAIN()}`
  };
}