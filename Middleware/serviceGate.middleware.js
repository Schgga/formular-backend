import { pool } from '../db.js';

// Checks a service's gate requirements against the current user.
// Pass skipIfFreeTemplate=true + a way to detect the template's is_free flag
// at the call site for website creation specifically.
export function requireServiceGate(serviceKey) {
  return async (req, res, next) => {
    try {
      const gateResult = await pool.query(
        'SELECT * FROM service_gates WHERE service_key = $1',
        [serviceKey]
      );
      const gate = gateResult.rows[0];

      if (!gate) return next(); // no gate configured, allow through

      if (gate.requires_subscription) {
        const subResult = await pool.query(
          `SELECT sp.plan_key FROM user_subscriptions us
           JOIN subscription_plans sp ON sp.id = us.plan_id
           WHERE us.user_id = $1`,
          [req.user.id]
        );
        const planKey = subResult.rows[0]?.plan_key;
        if (!planKey || planKey === 'free') {
          return res.status(402).json({
            success: false,
            error: 'This requires an active subscription',
            gateReason: 'subscription'
          });
        }
      }

      if (gate.requires_balance) {
        const walletResult = await pool.query(
          'SELECT balance_usd_cents FROM wallets WHERE user_id = $1',
          [req.user.id]
        );
        const balance = Number(walletResult.rows[0]?.balance_usd_cents || 0);
        if (balance <= 0) {
          return res.status(402).json({
            success: false,
            error: 'Your wallet balance is too low',
            gateReason: 'balance'
          });
        }
      }

      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Gate check failed' });
    }
  };
}