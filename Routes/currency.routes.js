import { Router } from 'express';
import { getAllRates, refreshCurrencyRates } from '../Services/currency/currencyService.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';

const router = Router();

// Public - anyone can see current rates
router.get('/rates', async (req, res) => {
  try {
    const rates = await getAllRates();
    res.json({ success: true, rates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch rates' });
  }
});

// Superadmin only - manually trigger a refresh from the live source
//router.post('/refresh', requireAuth, requireRole('superadmin'), async (req, res) => {
  router.post('/refresh', requireAuth, requirePermission('currency-rates'), async (req, res) => {
    try {
    const count = await refreshCurrencyRates();
    res.json({ success: true, message: `Updated ${count} currencies` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not refresh rates' });
  }
});

export default router;