import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

const router = Router();

// Get current user's balance
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT balance_usd_cents FROM wallets WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    res.json({ success: true, balance_usd_cents: result.rows[0].balance_usd_cents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch balance' });
  }
});

// Get current user's transaction history
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const wallet = await pool.query('SELECT id FROM wallets WHERE user_id = $1', [req.user.id]);

    if (wallet.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    const result = await pool.query(
      `SELECT * FROM wallet_transactions
       WHERE wallet_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [wallet.rows[0].id]
    );

    res.json({ success: true, transactions: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch transactions' });
  }
});

export default router;