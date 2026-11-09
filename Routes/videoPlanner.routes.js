import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { isPremiumUser, debit, credit, inTransaction, makeLimiter, OutOfFundsError } from '../Services/studio/walletService.js';
import { listWritersForUser, getActiveWriter, openKey } from '../Services/ai/writers.js';
import { callAI, AiError } from '../Services/ai/aiProviders.js';
import { readWebsite } from '../Services/ai/siteReader.js';
import {
  KINDS, PLATFORMS, LENGTHS, LANGUAGES, TONES, PLAN_SCHEMA,
  buildSystemPrompt, buildUserPrompt, cleanPlan, guessType, suggestKind
} from '../Services/ai/videoPlan.js';

// =====================================================================
// VIDEO PLANNER (users)
//   GET    /api/video-planner/options        choices + AI writers (names and prices only)
//   GET    /api/video-planner/websites       the user's own websites
//   POST   /api/video-planner/generate       write a plan (charges the wallet; refunds if it fails)
//   GET    /api/video-planner/plans          saved plans
//   GET    /api/video-planner/plans/:id
//   DELETE /api/video-planner/plans/:id
//   POST   /api/video-planner/plans/:id/feedback   { rating 1-5, useful, comment }
//
// .env (optional): VIDEO_PLANNER_DAILY_LIMIT=30
// =====================================================================

const router = Router();
const DAILY_LIMIT = () => Math.max(1, Number(process.env.VIDEO_PLANNER_DAILY_LIMIT) || 30);
const working = new Set();                         // one plan at a time per user
const genLimiter = makeLimiter(6, 10 * 60 * 1000); // max 6 tries per 10 minutes

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const isId = (v) => /^\d{1,18}$/.test(String(v));

async function ownWebsite(websiteId, userId) {
  try {
    const r = await pool.query(
      `SELECT uw.id, uw.business_name, uw.site_url, uw.logo_url, wcl.name AS class_name
       FROM user_websites uw
       LEFT JOIN website_catalog wc ON wc.id = uw.catalog_id
       LEFT JOIN website_classes wcl ON wcl.id = wc.class_id
       WHERE uw.id = $1 AND uw.user_id = $2 AND uw.deleted_at IS NULL`, [websiteId, userId]);
    return r.rows[0] || null;
  } catch { return null; } // badly formed id
}

const pick = (obj) => Object.entries(obj).map(([value, v]) => ({ value, label: typeof v === 'string' ? v : v.label, ...(v.help && { help: v.help }), ...(v.aspect && { aspect: v.aspect }) }));

router.get('/options', requireAuth, async (req, res) => {
  try {
    const premium = await isPremiumUser(pool, req.user.id);
    const writers = await listWritersForUser(premium);
    res.json({
      success: true,
      writers,
      kinds: pick(KINDS),
      platforms: pick(PLATFORMS),
      lengths: LENGTHS,
      languages: pick(LANGUAGES),
      tones: pick(TONES)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load the Video Planner' });
  }
});

router.get('/websites', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT uw.id, uw.business_name, uw.site_url, uw.logo_url, wcl.name AS class_name
       FROM user_websites uw
       LEFT JOIN website_catalog wc ON wc.id = uw.catalog_id
       LEFT JOIN website_classes wcl ON wcl.id = wc.class_id
       WHERE uw.user_id = $1 AND uw.deleted_at IS NULL
       ORDER BY uw.created_at DESC`, [req.user.id]);
    res.json({
      success: true,
      websites: r.rows.map((w) => ({
        id: w.id,
        name: w.business_name,
        url: w.site_url || '',
        logo: w.logo_url || '',
        type: guessType(w.class_name),
        suggestedKind: suggestKind(w.class_name)
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your websites' });
  }
});

router.post('/generate', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const b = req.body || {};
  const kind = KINDS[b.kind] ? b.kind : null;
  const platform = PLATFORMS[b.platform] ? b.platform : null;
  const length = LENGTHS.includes(Number(b.length)) ? Number(b.length) : null;
  const language = LANGUAGES[b.language] ? b.language : 'english';
  const tone = TONES[b.tone] ? b.tone : 'friendly';
  const focus = clean(b.focus, 300);
  const notes = clean(b.notes, 1500);
  if (!kind || !platform || !length || !isId(b.writerId)) {
    return res.status(400).json({ success: false, error: 'Please choose a video type, platform, length and AI writer.' });
  }
  if (working.has(String(userId))) return res.status(429).json({ success: false, error: 'Your last plan is still being written. Please wait for it.' });
  if (!genLimiter(String(userId))) return res.status(429).json({ success: false, error: 'Too many plans in a short time. Please wait a few minutes.' });

  working.add(String(userId));
  let planId = null;
  try {
    const site = await ownWebsite(b.websiteId, userId);
    if (!site) return res.status(404).json({ success: false, error: 'Website not found' });
    const writer = await getActiveWriter(Number(b.writerId));
    if (!writer) return res.status(400).json({ success: false, error: 'That AI writer is not available right now.' });

    const today = await pool.query(`SELECT COUNT(*)::int AS n FROM video_plans WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [userId]);
    if (today.rows[0].n >= DAILY_LIMIT()) return res.status(429).json({ success: false, error: `Daily limit of ${DAILY_LIMIT()} plans reached. Try again tomorrow.` });

    const premium = await isPremiumUser(pool, userId);
    const price = Number(premium ? writer.premium_price_usd_cents : writer.price_usd_cents) || 0;
    const serviceKey = `video_plan_${writer.id}`;

    // 1. Charge first, and save a "working" plan
    const started = await inTransaction(pool, async (client) => {
      const paid = await debit(client, userId, price, serviceKey, `Video Planner - ${writer.display_name}`);
      const ins = await client.query(
        `INSERT INTO video_plans (user_id, website_id, writer_id, writer_name, kind, platform, length_sec, language, tone, focus, notes, cost_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [userId, site.id, writer.id, writer.display_name, kind, platform, length, language, tone, focus || null, notes || null, paid.charged]);
      return { id: ins.rows[0].id, charged: paid.charged };
    });
    planId = started.id;

    // 2. Read the website, 3. ask the AI
    const t0 = Date.now();
    const read = site.site_url ? await readWebsite(site.site_url) : { ok: false, text: '', pages: [], error: 'This website has no address yet.' };
    const result = await callAI({
      provider: writer.provider,
      model: writer.model_name,
      apiKey: openKey(writer),
      system: buildSystemPrompt(),
      prompt: buildUserPrompt({
        business: { name: site.business_name, type: guessType(site.class_name), url: site.site_url, website_link: site.site_url },
        kind, platform, length, language, tone, focus, notes,
        site: read.text
      }),
      schema: PLAN_SCHEMA,
      schemaName: 'video_plan',
      maxTokens: Math.min(32000, Math.max(1500, Number(writer.max_output_tokens) || 6000))
    });
    const plan = cleanPlan(result.data, { length });
    plan.source = { readWebsite: read.ok, pages: read.pages.map((p) => p.url).slice(0, 5), note: read.ok ? '' : read.error };

    await pool.query(
      `UPDATE video_plans SET status = 'done', title = $2, plan = $3, tokens_in = $4, tokens_out = $5, ms = $6 WHERE id = $1`,
      [planId, plan.title, JSON.stringify(plan), result.tokensIn, result.tokensOut, Date.now() - t0]);

    res.json({ success: true, plan: { id: String(planId), title: plan.title, kind, platform, length, language, tone, website: site.business_name, writer: writer.display_name, costCents: started.charged, created_at: new Date().toISOString(), plan } });
  } catch (err) {
    if (err instanceof OutOfFundsError) {
      return res.status(402).json({ success: false, outOfFunds: true, error: 'Not enough balance. Please top up your wallet.' });
    }
    const userMsg = err instanceof AiError ? err.message : 'Something went wrong while writing your plan.';
    console.error('Video plan failed:', err?.message, err?.adminDetail || '');
    // Give the money back
    if (planId) {
      try {
        await inTransaction(pool, async (client) => {
          const row = (await client.query('SELECT * FROM video_plans WHERE id = $1 FOR UPDATE', [planId])).rows[0];
          if (row && !row.refunded && Number(row.cost_cents) > 0) {
            await credit(client, userId, row.cost_cents, `video_plan_${row.writer_id}`, 'Video Planner - refunded (plan failed)');
          }
          await client.query(`UPDATE video_plans SET status = 'failed', error = $2, refunded = true WHERE id = $1`, [planId, String(userMsg).slice(0, 300)]);
        });
      } catch (e) { console.error('Refund failed for plan', planId, e?.message); }
    }
    res.status(502).json({ success: false, error: `${userMsg} You were not charged.`, retryable: err?.retryable !== false });
  } finally {
    working.delete(String(userId));
  }
});

router.get('/plans', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT vp.id::text, vp.title, vp.kind, vp.platform, vp.length_sec AS length, vp.language, vp.status, vp.cost_cents,
              vp.writer_name AS writer, vp.created_at, uw.business_name AS website, fb.rating
       FROM video_plans vp
       LEFT JOIN user_websites uw ON uw.id = vp.website_id
       LEFT JOIN video_plan_feedback fb ON fb.plan_id = vp.id
       WHERE vp.user_id = $1 AND vp.status = 'done'
       ORDER BY vp.created_at DESC LIMIT 60`, [req.user.id]);
    res.json({ success: true, plans: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your plans' });
  }
});

router.get('/plans/:id', requireAuth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Plan not found' });
    const r = await pool.query(
      `SELECT vp.id::text, vp.title, vp.kind, vp.platform, vp.length_sec AS length, vp.language, vp.tone, vp.focus, vp.status,
              vp.cost_cents AS "costCents", vp.writer_name AS writer, vp.created_at, vp.plan, uw.business_name AS website,
              fb.rating, fb.useful, fb.comment
       FROM video_plans vp
       LEFT JOIN user_websites uw ON uw.id = vp.website_id
       LEFT JOIN video_plan_feedback fb ON fb.plan_id = vp.id
       WHERE vp.id = $1 AND vp.user_id = $2 AND vp.status = 'done'`, [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Plan not found' });
    res.json({ success: true, plan: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load the plan' });
  }
});

router.delete('/plans/:id', requireAuth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Plan not found' });
    const r = await pool.query('DELETE FROM video_plans WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Plan not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete the plan' });
  }
});

router.post('/plans/:id/feedback', requireAuth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ success: false, error: 'Plan not found' });
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ success: false, error: 'Please choose 1 to 5 stars.' });
    const useful = typeof req.body?.useful === 'boolean' ? req.body.useful : null;
    const comment = clean(req.body?.comment, 1000) || null;
    const p = await pool.query(`SELECT id, writer_id FROM video_plans WHERE id = $1 AND user_id = $2 AND status = 'done'`, [req.params.id, req.user.id]);
    if (!p.rows.length) return res.status(404).json({ success: false, error: 'Plan not found' });
    await pool.query(
      `INSERT INTO video_plan_feedback (plan_id, user_id, writer_id, rating, useful, comment)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (plan_id) DO UPDATE SET rating = EXCLUDED.rating, useful = EXCLUDED.useful, comment = EXCLUDED.comment, updated_at = NOW()`,
      [p.rows[0].id, req.user.id, p.rows[0].writer_id, rating, useful, comment]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save your feedback' });
  }
});

export default router;