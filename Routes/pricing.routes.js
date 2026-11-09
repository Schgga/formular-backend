import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';

const router = Router();

// PUBLIC — anyone (even logged out) can see current pricing,
// so the frontend can display "how much does this cost" before signup
router.get('/', async (req, res) => {
  try {
    // LEFT JOIN, not INNER — a service with no gate configured yet should
    // still show up, just without a "Balance" or "Plan" badge.
    const result = await pool.query(
      `SELECT p.*, sg.requires_subscription, sg.requires_balance
       FROM pricing p
       LEFT JOIN service_gates sg ON sg.service_key = p.service_key
       WHERE p.is_active = true
       ORDER BY p.category, p.engine`
    );
    res.json({ success: true, pricing: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load pricing' });
  }
});

// ADMIN/SUPERADMIN ONLY — update a price

//router.put('/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
router.put('/:id', requireAuth, requirePermission('pricing'), async (req, res) => {
  try {
    const { id } = req.params;
    const { free_price_usd_cents, premium_price_usd_cents, is_active } = req.body;

    const result = await pool.query(
      `UPDATE pricing
       SET free_price_usd_cents = COALESCE($1, free_price_usd_cents),
           premium_price_usd_cents = COALESCE($2, premium_price_usd_cents),
           is_active = COALESCE($3, is_active),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [free_price_usd_cents, premium_price_usd_cents, is_active, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Pricing entry not found' });
    }

    res.json({ success: true, pricing: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update pricing' });
  }
});

// SUPERADMIN ONLY — create a brand new pricing entry (e.g. a new service)
router.post('/', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const { service_key, service_name, category, engine, free_price_usd_cents, premium_price_usd_cents, unit } = req.body;

    const result = await pool.query(
      `INSERT INTO pricing (service_key, service_name, category, engine, free_price_usd_cents, premium_price_usd_cents, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [service_key, service_name, category, engine || null, free_price_usd_cents, premium_price_usd_cents, unit]
    );

    res.status(201).json({ success: true, pricing: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'A service with that key already exists' });
    }
    res.status(500).json({ success: false, error: 'Could not create pricing entry' });
  }
});

export default router;