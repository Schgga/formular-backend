import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';

const router = Router();

router.get('/stats', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const [users, revenue, websites, domains] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query(`SELECT COALESCE(SUM(amount_usd_cents), 0) AS total FROM wallet_transactions WHERE type = 'topup'`),
      pool.query('SELECT COUNT(*) FROM user_websites'),
      pool.query('SELECT COUNT(*) FROM user_domains')
    ]);

    res.json({
      success: true,
      stats: {
        totalUsers: Number(users.rows[0].count),
        totalRevenueCents: Number(revenue.rows[0].total),
        totalWebsites: Number(websites.rows[0].count),
        totalDomains: Number(domains.rows[0].count)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch stats' });
  }
});

router.get('/users', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await pool.query(`
  SELECT u.id, u.email, u.full_name, u.role, u.status, u.created_at,
         w.balance_usd_cents, sp.name AS plan_name, sp.plan_key, us.current_period_end
  FROM users u
  LEFT JOIN wallets w ON w.user_id = u.id
  LEFT JOIN user_subscriptions us ON us.user_id = u.id
  LEFT JOIN subscription_plans sp ON sp.id = us.plan_id
  ORDER BY u.created_at DESC
  LIMIT 200
`);
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch users' });
  }
});

//router.put('/users/:id/status', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  router.put('/users/:id/status', requireAuth, requirePermission('users'), async (req, res) => {
    try {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    const result = await pool.query(
      'UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, status',
      [status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update user' });
  }
});

router.put('/users/:id/role', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin', 'superadmin'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }

    const result = await pool.query(
      'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, role',
      [role, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update role' });
  }
});

router.get('/complaints', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, u.email AS user_email
      FROM complaints c
      JOIN users u ON u.id = c.user_id
      ORDER BY c.created_at DESC
    `);
    res.json({ success: true, complaints: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch complaints' });
  }
});

router.put('/complaints/:id/status', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { status } = req.body;
    const result = await pool.query(
      'UPDATE complaints SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    res.json({ success: true, complaint: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update complaint' });
  }
});

router.get('/messages', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM messages ORDER BY created_at DESC');
    res.json({ success: true, messages: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch messages' });
  }
});

router.put('/messages/:id/status', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { status } = req.body;
    const result = await pool.query(
      'UPDATE messages SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update message' });
  }
});

router.get('/domains', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ud.*, u.email AS user_email
      FROM user_domains ud
      JOIN users u ON u.id = ud.user_id
      ORDER BY ud.created_at DESC
    `);
    res.json({ success: true, domains: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch domains' });
  }
});

router.get('/studio-analytics', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const byUser = await pool.query(`
      SELECT u.email, wt.service_key,
             COUNT(*) AS session_ticks,
             SUM(wt.amount_usd_cents) AS total_spent_cents
      FROM wallet_transactions wt
      JOIN wallets w ON w.id = wt.wallet_id
      JOIN users u ON u.id = w.user_id
      WHERE wt.service_key LIKE 'studio_%' OR wt.service_key LIKE 'record_%'
      GROUP BY u.email, wt.service_key
      ORDER BY total_spent_cents DESC
      LIMIT 100
    `);
    res.json({ success: true, usage: byUser.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch analytics' });
  }
});

router.get('/permissions', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  const result = await pool.query('SELECT * FROM admin_permissions');
  res.json({ success: true, permissions: result.rows });
});

router.put('/permissions/:pageKey', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { locked, hidden } = req.body;
  const result = await pool.query(
    `INSERT INTO admin_permissions (page_key, locked_for_admin, hidden_for_admin) VALUES ($1, $2, $3)
     ON CONFLICT (page_key) DO UPDATE SET
       locked_for_admin = COALESCE($2, admin_permissions.locked_for_admin),
       hidden_for_admin = COALESCE($3, admin_permissions.hidden_for_admin),
       updated_at = NOW()
     RETURNING *`,
    [req.params.pageKey, locked ?? false, hidden ?? false]
  );
  res.json({ success: true, permission: result.rows[0] });
});

router.put('/users/:id/wallet', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { amountCents, reason } = req.body;
  const wallet = await pool.query('SELECT id FROM wallets WHERE user_id = $1', [req.params.id]);
  if (wallet.rows.length === 0) return res.status(404).json({ success: false, error: 'Wallet not found' });

  await pool.query('UPDATE wallets SET balance_usd_cents = balance_usd_cents + $1, updated_at = NOW() WHERE id = $2', [amountCents, wallet.rows[0].id]);
  await pool.query(
    `INSERT INTO wallet_transactions (wallet_id, type, amount_usd_cents, description) VALUES ($1, $2, $3, $4)`,
    [wallet.rows[0].id, amountCents >= 0 ? 'topup' : 'debit', Math.abs(amountCents), reason || 'Admin adjustment']
  );
  res.json({ success: true });
});


// Admin override — directly sets a user's plan and/or renewal date, with no
// wallet deduction at all. Separate from the real /api/subscription/upgrade
// a user goes through themselves, which DOES charge their wallet.
router.put('/users/:id/subscription', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const { planKey, currentPeriodEnd } = req.body;
    if (!planKey) return res.status(400).json({ success: false, error: 'planKey is required' });

    const planResult = await pool.query('SELECT id FROM subscription_plans WHERE plan_key = $1', [planKey]);
    if (planResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Plan not found' });
    const planId = planResult.rows[0].id;

    const status = planKey === 'free' ? 'free' : 'active';
    const periodEnd = planKey === 'free' ? null : (currentPeriodEnd || null);

    const result = await pool.query(
      `INSERT INTO user_subscriptions (user_id, plan_id, status, current_period_end)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id)
       DO UPDATE SET plan_id = $2, status = $3, current_period_end = $4, updated_at = NOW()
       RETURNING *`,
      [req.params.id, planId, status, periodEnd]
    );

    res.json({ success: true, subscription: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update subscription' });
  }
});

router.put('/users/:id', requireAuth, requirePermission('users'), async (req, res) => {
  try {
    const { fullName, email } = req.body;
    const result = await pool.query(
      `UPDATE users SET full_name = COALESCE($1, full_name), email = COALESCE($2, email), updated_at = NOW()
       WHERE id = $3 RETURNING id, email, full_name`,
      [fullName, email, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update user' });
  }
});

//users domains selection
router.get('/platform-domains', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  const result = await pool.query('SELECT * FROM platform_domains ORDER BY created_at DESC');
  res.json({ success: true, domains: result.rows });
});

router.post('/platform-domains', requireAuth, requirePermission('platform-domains'), async (req, res) => {
  try {
    const { domainName, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO platform_domains (domain_name, notes) VALUES ($1, $2) RETURNING *',
      [domainName.toLowerCase().trim(), notes || null]
    );
    res.status(201).json({ success: true, domain: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'Domain already added' });
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not add domain' });
  }
});

router.delete('/platform-domains/:id', requireAuth, requirePermission('platform-domains'), async (req, res) => {
  await pool.query('DELETE FROM platform_domains WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});


router.get('/managed-domains', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  const result = await pool.query('SELECT * FROM managed_domains ORDER BY created_at DESC');
  res.json({ success: true, domains: result.rows });
});

router.post('/managed-domains', requireAuth, requirePermission('website-catalog'), async (req, res) => {
  try {
    const { domain, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO managed_domains (domain, notes) VALUES ($1, $2) RETURNING *',
      [domain.toLowerCase().trim(), notes || null]
    );
    res.status(201).json({ success: true, domain: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'That domain is already registered' });
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not add domain' });
  }
});

router.delete('/managed-domains/:id', requireAuth, requirePermission('website-catalog'), async (req, res) => {
  await pool.query('DELETE FROM managed_domains WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});


router.get('/service-gates', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  const result = await pool.query('SELECT * FROM service_gates ORDER BY service_key');
  res.json({ success: true, gates: result.rows });
});

/*
router.put('/service-gates/:key', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { requiresSubscription, requiresBalance } = req.body;
  const result = await pool.query(
    `UPDATE service_gates SET requires_subscription = $1, requires_balance = $2, updated_at = NOW()
     WHERE service_key = $3 RETURNING *`,
    [requiresSubscription, requiresBalance, req.params.key]
  );
  res.json({ success: true, gate: result.rows[0] });
});
**/

router.put('/service-gates/:key', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { requiresSubscription, requiresBalance, temporarilyFree, temporarilyFreeUntil } = req.body;
  // Upsert — creates the row the first time, updates it every time after.
  // This is what lets you add a brand-new tool's gate just by saving it
  // once, without a separate "create" step.
  const result = await pool.query(
    `INSERT INTO service_gates (service_key, requires_subscription, requires_balance, temporarily_free, temporarily_free_until)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (service_key) DO UPDATE SET
       requires_subscription = $2, requires_balance = $3,
       temporarily_free = $4, temporarily_free_until = $5,
       updated_at = NOW()
     RETURNING *`,
    [req.params.key, requiresSubscription || false, requiresBalance || false, temporarilyFree || false, temporarilyFreeUntil || null]
  );
  res.json({ success: true, gate: result.rows[0] });
});

// ============================================================
// Per-class website limits
// ============================================================

router.get('/plan-class-limits', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const plansResult = await pool.query('SELECT id, plan_key, name, sort_order FROM subscription_plans WHERE is_active = true ORDER BY sort_order');
    const classesResult = await pool.query('SELECT id, name FROM website_classes ORDER BY name');
    const limitsResult = await pool.query('SELECT plan_id, class_id, max_websites FROM plan_class_limits');

    const limitMap = {};
    limitsResult.rows.forEach((l) => { limitMap[`${l.plan_id}_${l.class_id}`] = l.max_websites; });

    res.json({ success: true, plans: plansResult.rows, classes: classesResult.rows, limits: limitMap });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load limits' });
  }
});

router.put('/plan-class-limits', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const { planId, classId, maxWebsites } = req.body;
    // -1 is a real, deliberate value meaning "unlimited" — only an empty
    // or zero value means "hide this class entirely."
    const limit = maxWebsites === -1 || maxWebsites === '-1' ? -1 : Number(maxWebsites) || 0;

    if (limit === 0) {
      await pool.query('DELETE FROM plan_class_limits WHERE plan_id = $1 AND class_id = $2', [planId, classId]);
      return res.json({ success: true, maxWebsites: 0 });
    }

    await pool.query(
      `INSERT INTO plan_class_limits (plan_id, class_id, max_websites)
       VALUES ($1, $2, $3)
       ON CONFLICT (plan_id, class_id) DO UPDATE SET max_websites = $3`,
      [planId, classId, limit]
    );
    res.json({ success: true, maxWebsites: limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save limit' });
  }
});

router.get('/my-class-limits', requireAuth, async (req, res) => {
  try {
    const subResult = await pool.query(
      `SELECT sp.id AS plan_id FROM user_subscriptions us JOIN subscription_plans sp ON sp.id = us.plan_id WHERE us.user_id = $1`,
      [req.user.id]
    );
    if (subResult.rows.length === 0) return res.json({ success: true, classLimits: [] });
    const planId = subResult.rows[0].plan_id;

    const result = await pool.query(
      `SELECT pcl.class_id, wc.name AS class_name, pcl.max_websites,
              (SELECT COUNT(*) FROM user_websites uw
               JOIN website_catalog wc2 ON wc2.id = uw.catalog_id
               WHERE uw.user_id = $1 AND wc2.class_id = pcl.class_id AND uw.deleted_at IS NULL) AS used_count
       FROM plan_class_limits pcl
       JOIN website_classes wc ON wc.id = pcl.class_id
       WHERE pcl.plan_id = $2 AND pcl.max_websites > 0`,
      [req.user.id, planId]
    );
    res.json({ success: true, classLimits: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your limits' });
  }
});

export default router;