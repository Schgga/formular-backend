import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireServiceGate } from '../Middleware/serviceGate.middleware.js';
import { isPremiumUser, getPrice, debit, inTransaction, makeLimiter, OutOfFundsError } from '../Services/studio/walletService.js';

const router = Router();

// OLD per-5-second charge. The new Studio page uses /api/studio/session/* instead
// (money is held on the server before the stream starts). This stays only so an
// old open browser tab keeps working, and it is now safe:
//   - seconds must be a whole number from 1 to 10 (no negative or huge numbers)
//   - engine and service must be real, active ones
//   - at most one charge every 4 seconds per user
const tickLimiter = makeLimiter(1, 4000);
const SERVICE_TYPES = ['studio', 'record'];

router.post('/tick', requireAuth, requireServiceGate('studio'), async (req, res) => {
  try {
    const { engineKey, serviceType } = req.body || {};
    const seconds = Number(req.body?.seconds);

    if (!engineKey || !SERVICE_TYPES.includes(serviceType) || !Number.isInteger(seconds) || seconds < 1 || seconds > 10) {
      return res.status(400).json({ success: false, error: 'Invalid billing request' });
    }
    if (!tickLimiter(String(req.user.id))) {
      return res.status(429).json({ success: false, error: 'Too many billing requests' });
    }

    const eng = await pool.query('SELECT 1 FROM engines WHERE engine_key = $1 AND is_active = true', [String(engineKey).slice(0, 60)]);
    if (!eng.rows.length) return res.status(404).json({ success: false, error: 'Engine not found' });

    const serviceKey = `${serviceType}_${engineKey}_per_second`;
    const premium = await isPremiumUser(pool, req.user.id);
    const perSecond = await getPrice(pool, serviceKey, premium);
    if (perSecond === null) return res.status(400).json({ success: false, error: `No pricing found for ${serviceKey}` });

    const out = await inTransaction(pool, (client) =>
      debit(client, req.user.id, Math.ceil(perSecond * seconds), serviceKey,
        `${serviceType === 'record' ? 'Record Video' : 'Live Studio'} - ${engineKey} (${seconds}s)`));

    res.json({ success: true, charged_cents: out.charged, remaining_balance_cents: out.balance });
  } catch (err) {
    if (err instanceof OutOfFundsError) {
      return res.status(402).json({ success: false, error: 'Insufficient balance', outOfFunds: true });
    }
    console.error(err);
    res.status(500).json({ success: false, error: 'Billing error' });
  }
});

export default router;