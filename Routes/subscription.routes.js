import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';
import { calculateCadencePrice, CADENCE_OPTIONS, cadenceDays } from '../Services/pricing/pricingCalculator.js';

const router = Router();

function calculatePeriodEnd(unit, interval) {
  const periodEnd = new Date();
  if (unit === 'week') periodEnd.setDate(periodEnd.getDate() + 7 * interval);
  else periodEnd.setMonth(periodEnd.getMonth() + interval);
  return periodEnd;
}

// Public - list all active plans
router.get('/plans', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM subscription_plans WHERE is_active = true ORDER BY sort_order'
    );
    res.json({ success: true, plans: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch plans' });
  }
});

// Public — every cadence's real price for one plan, computed from its base
// monthly price. The frontend only ever displays what this returns, never
// calculates a price itself.
router.get('/plans/:planKey/pricing', async (req, res) => {
  try {
    const planResult = await pool.query(
      'SELECT price_usd_cents FROM subscription_plans WHERE plan_key = $1 AND is_active = true',
      [req.params.planKey]
    );
    if (planResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Plan not found' });
    const monthlyPrice = planResult.rows[0].price_usd_cents;

    const options = CADENCE_OPTIONS.map((c) => ({
      ...c,
      price_usd_cents: calculateCadencePrice(monthlyPrice, c.unit, c.interval)
    }));
    res.json({ success: true, options });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not calculate pricing' });
  }
});

// Current user's subscription, joined with plan details
router.get('/', requireAuth, async (req, res) => {
  try {
    let result = await pool.query(
      `SELECT us.*, sp.plan_key, sp.name AS plan_name, sp.price_usd_cents, sp.max_websites, sp.features, sp.rank_level
       FROM user_subscriptions us
       JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.user_id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      const freePlan = await pool.query("SELECT id FROM subscription_plans WHERE plan_key = 'free'");
      await pool.query(
        `INSERT INTO user_subscriptions (user_id, status, plan_id) VALUES ($1, 'free', $2)`,
        [req.user.id, freePlan.rows[0].id]
      );
      result = await pool.query(
        `SELECT us.*, sp.plan_key, sp.name AS plan_name, sp.price_usd_cents, sp.max_websites, sp.features, sp.rank_level
         FROM user_subscriptions us
         JOIN subscription_plans sp ON sp.id = us.plan_id
         WHERE us.user_id = $1`,
        [req.user.id]
      );
    }

    res.json({ success: true, subscription: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch subscription' });
  }
});

// Real upgrade — now takes a chosen cadence (unit + interval), calculates
// that cadence's real price, prorates against whatever's left of the
// user's current plan (if it's still active), and charges only the
// difference. Same safe locking/transaction pattern as billing.routes.js.
router.post('/upgrade', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { planKey, unit, interval } = req.body;
    if (!planKey) {
      client.release();
      return res.status(400).json({ success: false, error: 'planKey is required' });
    }
    const chosenUnit = unit === 'week' ? 'week' : 'month';
    const chosenInterval = Number(interval) > 0 ? Number(interval) : 1;

    const planResult = await client.query(
      'SELECT * FROM subscription_plans WHERE plan_key = $1 AND is_active = true',
      [planKey]
    );
    if (planResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }
    const plan = planResult.rows[0];

    const currentResult = await client.query(
      `SELECT us.*, sp.plan_key, sp.price_usd_cents, sp.billing_unit AS cur_unit, sp.billing_interval AS cur_interval
       FROM user_subscriptions us
       JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.user_id = $1`,
      [req.user.id]
    );
    const current = currentResult.rows[0];

    // Switching to Free is always free, no proration needed.
    if (plan.plan_key === 'free') {
      const result = await client.query(
        `INSERT INTO user_subscriptions (user_id, plan_id, status, current_period_end)
         VALUES ($1, $2, 'free', NULL)
         ON CONFLICT (user_id)
         DO UPDATE SET plan_id = $2, status = 'free', current_period_end = NULL, updated_at = NOW()
         RETURNING *`,
        [req.user.id, plan.id]
      );
      client.release();
      return res.json({ success: true, subscription: result.rows[0], chargedCents: 0 });
    }

    const newCadencePrice = calculateCadencePrice(plan.price_usd_cents, chosenUnit, chosenInterval);

    // Calculate proration credit from whatever's left of their current paid
    // plan, if it's genuinely still active (hasn't expired yet).
    let creditCents = 0;
    if (current && current.plan_key !== 'free' && current.current_period_end && new Date(current.current_period_end) > new Date()) {
      const totalDays = cadenceDays(current.cur_unit || 'month', current.cur_interval || 1);
      const msRemaining = new Date(current.current_period_end).getTime() - Date.now();
      const daysRemaining = Math.max(0, msRemaining / (1000 * 60 * 60 * 24));
      const dailyRate = Number(current.price_usd_cents) / totalDays;
      creditCents = Math.round(dailyRate * daysRemaining);
    }

    const costCents = Math.max(0, newCadencePrice - creditCents);

    // Re-subscribing to the exact same plan+cadence they're already on
    // (while still active) naturally costs $0 here — the credit cancels
    // the new price out. Nothing special-cased, the math just handles it.

    await client.query('BEGIN');

    if (costCents > 0) {
      const walletResult = await client.query(
        'SELECT id, balance_usd_cents FROM wallets WHERE user_id = $1 FOR UPDATE',
        [req.user.id]
      );
      if (walletResult.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ success: false, error: 'Wallet not found' });
      }
      const wallet = walletResult.rows[0];

      if (Number(wallet.balance_usd_cents) < costCents) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(402).json({
          success: false,
          error: 'Your wallet balance is too low for this plan',
          outOfFunds: true,
          neededCents: costCents,
          balanceCents: Number(wallet.balance_usd_cents)
        });
      }

      await client.query(
        'UPDATE wallets SET balance_usd_cents = balance_usd_cents - $1, updated_at = NOW() WHERE id = $2',
        [costCents, wallet.id]
      );
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount_usd_cents, service_key, description)
         VALUES ($1, 'debit', $2, 'subscription', $3)`,
        [wallet.id, costCents, `Switched to ${plan.name}${creditCents > 0 ? ` (${(creditCents / 100).toFixed(2)} credited from previous plan)` : ''}`]
      );
    }

    const periodEnd = calculatePeriodEnd(chosenUnit, chosenInterval);

    const result = await client.query(
      `INSERT INTO user_subscriptions (user_id, plan_id, status, current_period_end)
       VALUES ($1, $2, 'active', $3)
       ON CONFLICT (user_id)
       DO UPDATE SET plan_id = $2, status = 'active', current_period_end = $3, updated_at = NOW()
       RETURNING *`,
      [req.user.id, plan.id, periodEnd]
    );

    await client.query('COMMIT');
    client.release();
    res.json({ success: true, subscription: result.rows[0], chargedCents: costCents, creditedCents: creditCents });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    client.release();
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not change plan' });
  }
});

// Cancel - downgrades to free plan
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const freePlan = await pool.query("SELECT id FROM subscription_plans WHERE plan_key = 'free'");

    const result = await pool.query(
      `UPDATE user_subscriptions
       SET plan_id = $1, status = 'free', current_period_end = NULL, updated_at = NOW()
       WHERE user_id = $2
       RETURNING *`,
      [freePlan.rows[0].id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Subscription not found' });
    }

    res.json({ success: true, subscription: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not cancel' });
  }
});

// Admin/Superadmin — create a brand new plan
router.post('/plans', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const { planKey, name, priceUsdCents, maxWebsites, description, features, sortOrder, rankLevel } = req.body;
    const result = await pool.query(
      `INSERT INTO subscription_plans
         (plan_key, name, price_usd_cents, max_websites, description, features, sort_order, rank_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [planKey, name, priceUsdCents, maxWebsites || null, description, JSON.stringify(features), sortOrder || 0, Number(rankLevel) || 0]
    );
    res.status(201).json({ success: true, plan: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create plan' });
  }
});

// Admin — update an existing plan
router.put('/plans/:id', requireAuth, requirePermission('subscription-plans'), async (req, res) => {
  try {
    const { name, priceUsdCents, maxWebsites, description, features, isActive, rankLevel } = req.body;
    const result = await pool.query(
      `UPDATE subscription_plans SET
         name = COALESCE($1, name),
         price_usd_cents = COALESCE($2, price_usd_cents),
         max_websites = $3,
         description = COALESCE($4, description),
         features = COALESCE($5, features),
         is_active = COALESCE($6, is_active),
         rank_level = COALESCE($7, rank_level),
         updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [name, priceUsdCents, maxWebsites, description, features ? JSON.stringify(features) : null, isActive, rankLevel !== undefined ? Number(rankLevel) : null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }
    res.json({ success: true, plan: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update plan' });
  }
});

// Admin — deactivate a plan (soft delete, existing subscribers keep it)
router.delete('/plans/:id', requireAuth, requirePermission('subscription-plans'), async (req, res) => {
  try {
    await pool.query('UPDATE subscription_plans SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete plan' });
  }
});

// Public — a plan's real per-class website limits, for display on both
// the admin Subscription Plans page and the user-facing Premium page.
router.get('/plans/:planId/class-limits', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT wc.name AS class_name, pcl.max_websites
       FROM plan_class_limits pcl
       JOIN website_classes wc ON wc.id = pcl.class_id
       WHERE pcl.plan_id = $1
       ORDER BY wc.name`,
      [req.params.planId]
    );
    res.json({ success: true, classLimits: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load class limits' });
  }
});

export default router;