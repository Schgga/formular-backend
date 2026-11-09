import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { createNowPayment, getAvailableCurrencies } from '../Services/nowpayments/nowpaymentsClient.js';
import { verifyNowPaymentsSignature } from '../Services/nowpayments/nowpaymentsWebhook.js';

const router = Router();

// List crypto currencies available to pay with
router.get('/nowpayments/currencies', requireAuth, async (req, res) => {
  try {
    const data = await getAvailableCurrencies();
    res.json({ success: true, currencies: data.currencies });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch currencies' });
  }
});

// Start a crypto top-up
router.post('/nowpayments/create', requireAuth, async (req, res) => {
  try {
    const { amountUsd, payCurrency } = req.body;

    if (!amountUsd || amountUsd < 1 || !payCurrency) {
      return res.status(400).json({ success: false, error: 'Valid amountUsd and payCurrency are required' });
    }

    const orderId = `wallet-${req.user.id}-${Date.now()}`;
    const ipnCallbackUrl = `${process.env.PUBLIC_API_URL}/api/payments/nowpayments/webhook`;

    const payment = await createNowPayment({ amountUsd, payCurrency, orderId, ipnCallbackUrl });

    await pool.query(
      `INSERT INTO payments (user_id, provider, provider_payment_id, amount_usd_cents, pay_currency, status, raw_payload)
       VALUES ($1, 'nowpayments', $2, $3, $4, $5, $6)`,
      [req.user.id, payment.payment_id, Math.round(amountUsd * 100), payCurrency, payment.payment_status, JSON.stringify(payment)]
    );

    res.json({ success: true, payment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create payment' });
  }
});

// Webhook - NOWPayments calls this when payment status changes
router.post('/nowpayments/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    const isValid = await verifyNowPaymentsSignature(req.body, signature);

    if (!isValid) {
      console.error('Invalid NOWPayments webhook signature');
      return res.status(401).json({ success: false, error: 'Invalid signature' });
    }

    const { payment_id, payment_status } = req.body;

    const paymentResult = await pool.query(
      'SELECT * FROM payments WHERE provider_payment_id = $1',
      [String(payment_id)]
    );

    if (paymentResult.rows.length === 0) {
      console.error('Webhook for unknown payment:', payment_id);
      return res.status(404).json({ success: false });
    }

    const payment = paymentResult.rows[0];

    await pool.query(
      `UPDATE payments SET status = $1, raw_payload = $2, updated_at = NOW() WHERE id = $3`,
      [payment_status, JSON.stringify(req.body), payment.id]
    );

    // Only credit the wallet once, when payment is confirmed - never on 'confirming' or repeat calls
    if (payment_status === 'finished' && payment.status !== 'finished') {
      const wallet = await pool.query('SELECT id FROM wallets WHERE user_id = $1', [payment.user_id]);
      if (wallet.rows.length > 0) {
        await pool.query(
          'UPDATE wallets SET balance_usd_cents = balance_usd_cents + $1, updated_at = NOW() WHERE id = $2',
          [payment.amount_usd_cents, wallet.rows[0].id]
        );
        await pool.query(
          `INSERT INTO wallet_transactions (wallet_id, type, amount_usd_cents, description)
           VALUES ($1, 'topup', $2, 'Crypto top-up via NOWPayments')`,
          [wallet.rows[0].id, payment.amount_usd_cents]
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ success: false });
  }
});

export default router;