import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireServiceGate } from '../Middleware/serviceGate.middleware.js';
import { createRealtimeToken } from '../Services/decart/decartService.js';
import { getReactorSessionToken } from '../Services/reactor/reactorService.js';
import { pool } from '../db.js';
import {
  isPremiumUser, getPrice, debit, credit, inTransaction, makeLimiter, OutOfFundsError
} from '../Services/studio/walletService.js';

// =====================================================================
// STUDIO SESSIONS (Live + Record)
//
//   POST /api/studio/session/start           { engineKey, mode: 'live' | 'record' }
//   POST /api/studio/session/:id/heartbeat   every ~10s while the page is open
//   POST /api/studio/session/:id/end         Stop button / leaving the page
//
// How billing works now (all on the server):
//   1. Start: we check the balance and HOLD the money for one block of time
//      (STUDIO_SEGMENT_SECONDS, default 5 minutes, or less if the wallet is lower).
//      The provider token is only created AFTER the money is held.
//   2. Decart is told to close the session itself when that time is used up.
//   3. Stop: the unused part of the hold goes back to the wallet, measured with
//      the server's clock (never the browser's).
//   4. If the page stops sending heartbeats, the session is closed and nothing
//      is returned (we cannot tell how long it really ran).
//
// Optional .env settings:
//   STUDIO_SEGMENT_SECONDS=300            longest single session (60–3600)
//   STUDIO_MIN_SECONDS=30                 do not start with less paid time than this
//   STUDIO_MAX_SESSIONS_PER_DAY=60
//   STUDIO_REFUNDS=on                     set to off to stop returning unused time
//   STUDIO_ALLOWED_ORIGINS=https://app.yoursite.com,http://localhost:5173
//   DECART_ALLOWED_MODELS=lucy-2.5
// =====================================================================

const router = Router();

const num = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : d;
};
const SEGMENT = () => num(process.env.STUDIO_SEGMENT_SECONDS, 300, 60, 3600);
const MIN_SECONDS = () => num(process.env.STUDIO_MIN_SECONDS, 30, 10, 600);
const MAX_PER_DAY = () => num(process.env.STUDIO_MAX_SESSIONS_PER_DAY, 60, 1, 1000);
const REFUNDS_ON = () => String(process.env.STUDIO_REFUNDS || 'on').toLowerCase() !== 'off';
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const HEARTBEAT_GRACE = 45; // seconds without a heartbeat before we close a session

const startLimiter = makeLimiter(8, 10 * 60 * 1000);   // 8 starts per 10 minutes per user
const beatLimiter = makeLimiter(30, 60 * 1000);        // heartbeats: 30 per minute per user

const newPublicId = () => crypto.randomBytes(18).toString('base64url');
const SERVICE_TYPE = { live: 'studio', record: 'record' };

// Close a session. Returns money for unused time only when asked and allowed.
async function closeSession(client, s, reason, { refund }) {
  let refunded = 0;
  if (refund && REFUNDS_ON()) {
    const usedSec = Math.max(0, (Date.now() - new Date(s.started_at).getTime()) / 1000);
    const unusedSec = Math.max(0, Number(s.held_seconds) - Math.ceil(usedSec));
    const back = Math.min(Number(s.held_cents), Math.floor(unusedSec * Number(s.per_second_cents)));
    if (back > 0) {
      const label = s.mode === 'record' ? 'Record Video' : 'Live Studio';
      refunded = (await credit(client, s.user_id, back, s.service_key, `${label} - unused time returned (${unusedSec}s)`)).credited;
    }
  }
  await client.query(
    `UPDATE studio_sessions SET status = 'ended', end_reason = $2, ended_at = NOW(), refunded_cents = $3
     WHERE id = $1 AND status = 'active'`,
    [s.id, reason, refunded]
  );
  return refunded;
}

// Old endpoint: tokens are now only given out by /session/start (after payment).
router.post('/token', requireAuth, (req, res) => {
  res.status(410).json({ success: false, error: 'Studio was updated. Please refresh the page.' });
});

router.post('/session/start', requireAuth, requireServiceGate('studio'), async (req, res) => {
  const userId = req.user.id;
  const engineKey = String(req.body?.engineKey || '').slice(0, 60);
  const mode = req.body?.mode === 'record' ? 'record' : req.body?.mode === 'live' ? 'live' : null;
  if (!engineKey || !mode) return res.status(400).json({ success: false, error: 'engineKey and mode are required' });
  if (!startLimiter(String(userId))) {
    return res.status(429).json({ success: false, error: 'Too many sessions started. Please wait a few minutes.' });
  }

  try {
    const eng = await pool.query('SELECT provider FROM engines WHERE engine_key = $1 AND is_active = true', [engineKey]);
    if (!eng.rows.length) return res.status(404).json({ success: false, error: 'Engine not found' });
    const provider = eng.rows[0].provider;
    if (!['decart', 'reactor'].includes(provider)) return res.status(400).json({ success: false, error: 'Unknown provider' });

    const today = await pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE end_reason = 'no_heartbeat' AND started_at > NOW() - INTERVAL '1 hour')::int AS lost
       FROM studio_sessions WHERE user_id = $1 AND started_at > NOW() - INTERVAL '24 hours'`, [userId]);
    if (today.rows[0].n >= MAX_PER_DAY()) {
      return res.status(429).json({ success: false, error: 'Daily session limit reached. Try again tomorrow.' });
    }
    if (today.rows[0].lost >= 4) {
      return res.status(429).json({ success: false, error: 'Your last sessions lost connection several times. Please check your internet and try again in a few minutes.' });
    }

    const serviceKey = `${SERVICE_TYPE[mode]}_${engineKey}_per_second`;
    const premium = await isPremiumUser(pool, userId);
    const rate = await getPrice(pool, serviceKey, premium);
    if (rate === null) return res.status(400).json({ success: false, error: 'This engine has no price set yet.' });

    // Hold the money first
    const held = await inTransaction(pool, async (client) => {
      // Any session still open for this user is closed first (one session at a time)
      const open = await client.query(
        `SELECT * FROM studio_sessions WHERE user_id = $1 AND status = 'active' FOR UPDATE`, [userId]);
      for (const s of open.rows) {
        const recent = Date.now() - new Date(s.last_seen_at).getTime() < 30_000;
        await closeSession(client, s, 'replaced', { refund: recent });
      }

      const w = await client.query('SELECT balance_usd_cents FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      const balance = w.rows.length ? Number(w.rows[0].balance_usd_cents) : 0;
      const affordable = rate > 0 ? Math.floor(balance / rate) : SEGMENT();
      const seconds = Math.min(SEGMENT(), affordable);
      if (seconds < MIN_SECONDS()) throw new OutOfFundsError(balance);

      const cents = Math.ceil(seconds * rate);
      const label = mode === 'record' ? 'Record Video' : 'Live Studio';
      const paid = await debit(client, userId, cents, serviceKey, `${label} - ${engineKey} (up to ${seconds}s, unused time returned)`);
      const publicId = newPublicId();
      const ins = await client.query(
        `INSERT INTO studio_sessions (public_id, user_id, engine_key, mode, service_key, per_second_cents, held_seconds, held_cents, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [publicId, userId, engineKey, mode, serviceKey, rate, seconds, cents, String(req.ip || '').slice(0, 64)]);
      return { session: ins.rows[0], balance: paid.balance };
    });

    // Then ask the provider for a short-lived token
    let token;
    try {
      if (provider === 'decart') {
        token = await createRealtimeToken({
          expiresIn: 60,
          allowedModels: list(process.env.DECART_ALLOWED_MODELS),
          allowedOrigins: list(process.env.STUDIO_ALLOWED_ORIGINS),
          maxSessionDuration: held.session.held_seconds + 5
        });
      } else {
        token = await getReactorSessionToken();
      }
    } catch (err) {
      console.error('Studio token failed:', err?.message || err);
      // Provider failed: give everything back
      await inTransaction(pool, async (client) => {
        const s = (await client.query('SELECT * FROM studio_sessions WHERE id = $1 FOR UPDATE', [held.session.id])).rows[0];
        await credit(client, userId, s.held_cents, s.service_key, 'Studio - could not connect, refunded');
        await client.query(`UPDATE studio_sessions SET status = 'ended', end_reason = 'error', ended_at = NOW(), refunded_cents = held_cents WHERE id = $1`, [s.id]);
      });
      return res.status(502).json({ success: false, error: 'The video engine is busy. You were not charged. Please try again.' });
    }

    res.json({
      success: true,
      sessionId: held.session.public_id,
      provider,
      token,
      heldSeconds: held.session.held_seconds,
      heldCents: Number(held.session.held_cents),
      perSecondCents: Number(rate),
      balance: held.balance,
      refunds: REFUNDS_ON()
    });
  } catch (err) {
    if (err instanceof OutOfFundsError) {
      return res.status(402).json({ success: false, outOfFunds: true, error: 'Not enough balance to start. Please top up your wallet.' });
    }
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not start the session' });
  }
});

async function findOwnSession(publicId, userId) {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(String(publicId))) return null;
  const r = await pool.query('SELECT * FROM studio_sessions WHERE public_id = $1 AND user_id = $2', [publicId, userId]);
  return r.rows[0] || null;
}

router.post('/session/:id/heartbeat', requireAuth, async (req, res) => {
  try {
    if (!beatLimiter(String(req.user.id))) return res.status(429).json({ success: false, error: 'Slow down' });
    const s = await findOwnSession(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ success: false, error: 'Session not found' });
    if (s.status !== 'active') return res.json({ success: true, ended: true, reason: s.end_reason });

    const elapsed = (Date.now() - new Date(s.started_at).getTime()) / 1000;
    if (elapsed > Number(s.held_seconds) + 10) {
      await inTransaction(pool, (client) => closeSession(client, s, 'time_up', { refund: false }));
      return res.json({ success: true, ended: true, reason: 'time_up' });
    }
    await pool.query(`UPDATE studio_sessions SET last_seen_at = NOW() WHERE id = $1 AND status = 'active'`, [s.id]);
    res.json({ success: true, ended: false, remaining: Math.max(0, Math.floor(Number(s.held_seconds) - elapsed)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Heartbeat failed' });
  }
});

router.post('/session/:id/end', requireAuth, async (req, res) => {
  try {
    const s = await findOwnSession(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ success: false, error: 'Session not found' });
    if (s.status !== 'active') return res.json({ success: true, refundedCents: Number(s.refunded_cents || 0) });
    // Only return unused time if the page was still sending heartbeats
    const recent = Date.now() - new Date(s.last_seen_at).getTime() < 30_000;
    const refunded = await inTransaction(pool, async (client) => {
      const locked = (await client.query('SELECT * FROM studio_sessions WHERE id = $1 FOR UPDATE', [s.id])).rows[0];
      if (locked.status !== 'active') return Number(locked.refunded_cents || 0);
      return closeSession(client, locked, 'stopped', { refund: recent });
    });
    res.json({ success: true, refundedCents: refunded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not end the session' });
  }
});

// Close sessions whose page went quiet, or whose paid time is used up (runs every 20s)
async function sweep() {
  try {
    const stale = await pool.query(
      `SELECT * FROM studio_sessions WHERE status = 'active' AND
         (last_seen_at < NOW() - make_interval(secs => $1)
          OR started_at + make_interval(secs => held_seconds + 15) < NOW())
       LIMIT 200`, [HEARTBEAT_GRACE]);
    for (const s of stale.rows) {
      const timeUp = new Date(s.started_at).getTime() + (Number(s.held_seconds) + 15) * 1000 < Date.now();
      await inTransaction(pool, (client) => closeSession(client, s, timeUp ? 'time_up' : 'no_heartbeat', { refund: false }));
    }
  } catch (err) {
    if (!/studio_sessions/.test(String(err?.message))) console.error('Studio sweep failed:', err?.message || err);
  }
}
setInterval(sweep, 20_000).unref?.();

export default router;