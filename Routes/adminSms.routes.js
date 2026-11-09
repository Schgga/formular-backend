import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';

const router = Router();

router.get('/sms-profit', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const byService = await pool.query(`
      SELECT provider, country, service, COUNT(*) AS orders,
        SUM(charged_usd_cents) AS revenue_cents, SUM(provider_cost_usd_cents) AS cost_cents,
        SUM(charged_usd_cents - provider_cost_usd_cents) AS profit_cents
      FROM sms_verification_orders WHERE status = 'SUCCESSFUL'
      GROUP BY provider, country, service ORDER BY profit_cents DESC
    `);
    const totals = await pool.query(`
      SELECT COUNT(*) AS orders, SUM(charged_usd_cents) AS revenue_cents,
        SUM(provider_cost_usd_cents) AS cost_cents, SUM(charged_usd_cents - provider_cost_usd_cents) AS profit_cents
      FROM sms_verification_orders WHERE status = 'SUCCESSFUL'
    `);
    res.json({ success: true, byService: byService.rows, totals: totals.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load profit report' });
  }
});

router.get('/sms-pricing-settings', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sms_pricing_settings WHERE id = 1');
    res.json({ success: true, settings: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not load pricing settings' });
  }
});

router.put('/sms-pricing-settings', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { defaultMarkupCents, defaultMarkupPercent } = req.body;
    await pool.query(
      'UPDATE sms_pricing_settings SET default_markup_usd_cents = $1, default_markup_percent = $2 WHERE id = 1',
      [defaultMarkupCents, defaultMarkupPercent]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not save pricing settings' });
  }
});


router.get('/sms-provider-labels', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sms_provider_labels');
    res.json({ success: true, labels: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not load labels' });
  }
});

router.put('/sms-provider-labels/:key', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { displayName } = req.body;
    if (!displayName?.trim()) return res.status(400).json({ success: false, error: 'Name is required' });
    await pool.query('UPDATE sms_provider_labels SET display_name = $1 WHERE provider_key = $2', [displayName.trim(), req.params.key]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not save' });
  }
});

router.get('/sms-pricing-overrides', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sms_service_pricing ORDER BY id DESC');
    res.json({ success: true, overrides: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not load overrides' });
  }
});

router.post('/sms-pricing-overrides', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { provider, country, service, markupCents, markupPercent } = req.body;
    if (!country?.trim() || !service?.trim()) return res.status(400).json({ success: false, error: 'Country and service are required' });
    await pool.query(
      `INSERT INTO sms_service_pricing (provider, country, service, markup_usd_cents, markup_percent)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider, country, service) DO UPDATE SET markup_usd_cents = $4, markup_percent = $5`,
      [provider === '5sim' ? '5sim' : 'smspool', country.trim(), service.trim(), markupCents || 0, markupPercent || 0]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not save override' });
  }
});

router.delete('/sms-pricing-overrides/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM sms_service_pricing WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not delete override' });
  }
});

export default router;