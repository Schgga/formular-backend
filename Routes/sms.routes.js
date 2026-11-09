import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireServiceGate } from '../Middleware/serviceGate.middleware.js';
import { getDecryptedApiKey } from '../Utils/encryption.js';

const router = Router();

const SMSPool_BASE = 'https://api.smspool.net';
const FiveSim_BASE = 'https://5sim.net/v1';
const ORDER_TIMEOUT_MS = 10 * 60 * 1000;
const activePolls = new Map();

// ---------- SMSPool helpers ----------
async function smspoolPurchase(country, service) {
  const apiKey = await getDecryptedApiKey('smspool_api_key');
  const res = await fetch(`${SMSPool_BASE}/purchase/sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: apiKey, country, service })
  });
  const data = await res.json();
  if (!data.success || data.success === 0) return null;
  return { orderId: data.order_id, phoneNumber: data.number, costCents: Math.round(parseFloat(data.price || 0) * 100) };
}

async function smspoolCheckActive() {
  const apiKey = await getDecryptedApiKey('smspool_api_key');
  const res = await fetch(`${SMSPool_BASE}/request/active?key=${apiKey}`);
  return res.json();
}

async function smspoolCancel(orderId) {
  const apiKey = await getDecryptedApiKey('smspool_api_key');
  await fetch(`${SMSPool_BASE}/sms/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: apiKey, orderid: orderId })
  }).catch(() => {});
}

// ---------- 5SIM helpers ----------
async function fivesimPurchase(country, service) {
  const apiKey = await getDecryptedApiKey('fivesim_api_key');
  const res = await fetch(`${FiveSim_BASE}/user/buy/activation/${country}/any/${service}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  });
  const data = await res.json();
  if (!data.id) return null;
  return { orderId: String(data.id), phoneNumber: data.phone, costCents: Math.round(parseFloat(data.price || 0) * 100) };
}

async function fivesimCheck(orderId) {
  const apiKey = await getDecryptedApiKey('fivesim_api_key');
  const res = await fetch(`${FiveSim_BASE}/user/check/${orderId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  });
  return res.json();
}

async function fivesimCancel(orderId) {
  const apiKey = await getDecryptedApiKey('fivesim_api_key');
  await fetch(`${FiveSim_BASE}/user/cancel/${orderId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  }).catch(() => {});
}

// ---------- Pricing ----------
async function getRetailPrice(country, service, providerCostCents, provider = 'smspool') {
  const overrideResult = await pool.query('SELECT * FROM sms_service_pricing WHERE provider = $1 AND country = $2 AND service = $3', [provider, country, service]);
  
  let markupCents, markupPercent;

  if (overrideResult.rows.length > 0) {
    markupCents = overrideResult.rows[0].markup_usd_cents;
    markupPercent = overrideResult.rows[0].markup_percent;
  } else {
    const defaults = await pool.query('SELECT * FROM sms_pricing_settings WHERE id = 1');
    markupCents = defaults.rows[0]?.default_markup_usd_cents || 50;
    markupPercent = defaults.rows[0]?.default_markup_percent || 0;
  }

  let price = providerCostCents + markupCents;
  if (markupPercent > 0) price += Math.round(providerCostCents * (markupPercent / 100));
  return price;
}

// ---------- CATALOG: SMSPool ----------
router.get('/countries', requireAuth, async (req, res) => {
  try {
    const apiKey = await getDecryptedApiKey('smspool_api_key');
    const res1 = await fetch(`${SMSPool_BASE}/country/retrieve_all?key=${apiKey}`);
    const countries = await res1.json();
    res.json({ success: true, countries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load countries' });
  }
});

router.get('/services', requireAuth, async (req, res) => {
  try {
    const apiKey = await getDecryptedApiKey('smspool_api_key');
    const res1 = await fetch(`${SMSPool_BASE}/service/retrieve_all?key=${apiKey}`);
    const services = await res1.json();
    res.json({ success: true, services });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load services' });
  }
});

// ---------- CATALOG: 5SIM ----------
router.get('/5sim/countries', requireAuth, async (req, res) => {
  try {
    const res1 = await fetch(`${FiveSim_BASE}/guest/countries`);
    const data = await res1.json();
    const countries = Object.entries(data).map(([key, val]) => ({
      ID: key,
      name: val.text_en,
      iso: Object.keys(val.iso || {})[0] || null
    }));
    res.json({ success: true, countries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load 5SIM countries' });
  }
});

router.get('/5sim/services', requireAuth, async (req, res) => {
  try {
    const { country } = req.query;
    const res1 = await fetch(`${FiveSim_BASE}/guest/products/${country || 'any'}/any`);
    const data = await res1.json();
    const services = await Promise.all(
      Object.entries(data)
        .filter(([, val]) => val.Category === 'activation')
        .map(async ([key, val]) => {
          const costCents = Math.round(parseFloat(val.Price || 0) * 100);
          const retailCents = await getRetailPrice(country || 'any', key, costCents, '5sim');
          return { ID: key, name: key.charAt(0).toUpperCase() + key.slice(1), retailCents };
        })
    );
    res.json({ success: true, services });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load 5SIM services' });
  }
});

router.get('/price', requireAuth, async (req, res) => {
  try {
    const { provider, country, service } = req.query;
    const apiKey = await getDecryptedApiKey('smspool_api_key');
    const res1 = await fetch(`${SMSPool_BASE}/request/price?key=${apiKey}&country=${country}&service=${service}`);
    const data = await res1.json();
    const costCents = data?.price ? Math.round(parseFloat(data.price) * 100) : null;
    if (costCents === null) return res.status(404).json({ success: false, error: 'Price not available for this combination' });
    /**const retailCents = await getRetailPrice(country, service, costCents); **/
      const retailCents = await getRetailPrice(country, service, costCents, 'smspool');
    res.json({ success: true, retailCents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch price' });
  }
});


// ---------- PURCHASE ----------
router.post('/purchase', requireAuth, requireServiceGate('sms_verification'), async (req, res) => {
  try {
    const { country, service, provider: requestedProvider, quotedPriceCents, countryName, serviceName } = req.body;
    if (!country || !service) return res.status(400).json({ success: false, error: 'country and service are required' });

    const provider = requestedProvider === '5sim' ? '5sim' : 'smspool';
    const purchaseResult = provider === '5sim'
      ? await fivesimPurchase(country, service).catch(() => null)
      : await smspoolPurchase(country, service).catch(() => null);

    if (!purchaseResult) {
      return res.status(409).json({ success: false, error: 'No numbers currently available for this country/service. Please try again shortly.' });
    }

    const liveRetailPriceCents = await getRetailPrice(country, service, purchaseResult.costCents, provider);
    // Honor whatever price the user was actually shown — never charge more than that,
    // even if the provider's live cost turned out higher. We absorb the difference.
    const retailPriceCents = (quotedPriceCents && quotedPriceCents < liveRetailPriceCents)
      ? quotedPriceCents
      : liveRetailPriceCents;

    const walletResult = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
    const wallet = walletResult.rows[0];
    if (!wallet || wallet.balance_usd_cents < retailPriceCents) {
      if (provider === 'smspool') await smspoolCancel(purchaseResult.orderId);
      else await fivesimCancel(purchaseResult.orderId);
      return res.status(402).json({ success: false, error: 'Insufficient balance' });
    }

    const expiresAt = new Date(Date.now() + ORDER_TIMEOUT_MS);

    const client = await pool.connect();
    let order;
    try {
      await client.query('BEGIN');
      await client.query('UPDATE wallets SET balance_usd_cents = balance_usd_cents - $1 WHERE user_id = $2', [retailPriceCents, req.user.id]);
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, amount_usd_cents, type, description) VALUES ($1, $2, 'hold', $3)`,
        [wallet.id, -retailPriceCents, `SMS verification hold: ${service} (${country})`]
      );
      const orderResult = await client.query(
  `INSERT INTO sms_verification_orders (user_id, provider, provider_order_id, country, service, country_name, service_name, phone_number, held_usd_cents, provider_cost_usd_cents, expires_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
  [req.user.id, provider, purchaseResult.orderId, country, service, countryName || country, serviceName || service, purchaseResult.phoneNumber, retailPriceCents, purchaseResult.costCents, expiresAt]
);
      order = orderResult.rows[0];
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    startPolling(order.id, provider, purchaseResult.orderId, expiresAt);

    res.status(201).json({ success: true, order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not purchase number' });
  }
});

// ---------- POLLING LOOP ----------
function startPolling(dbOrderId, provider, providerOrderId, expiresAt) {
  const interval = setInterval(async () => {
    try {
      if (Date.now() > new Date(expiresAt).getTime()) {
        clearInterval(interval);
        activePolls.delete(dbOrderId);
        await expireOrder(dbOrderId);
        return;
      }

      let smsCode = null;

      if (provider === 'smspool') {
        const activeOrders = await smspoolCheckActive();
        const match = Array.isArray(activeOrders) ? activeOrders.find(o => String(o.order_id ?? o.id) === String(providerOrderId)) : null;
        if (match && (match.sms || match.code)) smsCode = match.sms || match.code;
      } else {
        const data = await fivesimCheck(providerOrderId);
        if (data?.sms?.length > 0) smsCode = data.sms[0].code;
      }

      if (smsCode) {
        clearInterval(interval);
        activePolls.delete(dbOrderId);
        await completeOrder(dbOrderId, smsCode);
      }
    } catch (err) {
      console.error(`Polling error for order ${dbOrderId}:`, err);
    }
  }, 4500);

  activePolls.set(dbOrderId, interval);
}

async function completeOrder(dbOrderId, smsCode) {
  const orderResult = await pool.query('SELECT * FROM sms_verification_orders WHERE id = $1', [dbOrderId]);
  const order = orderResult.rows[0];
  if (!order || order.status !== 'PENDING_SMS') return;

  await pool.query(
    `UPDATE sms_verification_orders SET status = 'SUCCESSFUL', otp_code = $1, charged_usd_cents = held_usd_cents, resolved_at = NOW() WHERE id = $2`,
    [smsCode, dbOrderId]
  );
}

async function expireOrder(dbOrderId) {
  const orderResult = await pool.query('SELECT * FROM sms_verification_orders WHERE id = $1', [dbOrderId]);
  const order = orderResult.rows[0];
  if (!order || order.status !== 'PENDING_SMS') return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE wallets SET balance_usd_cents = balance_usd_cents + $1 WHERE user_id = $2', [order.held_usd_cents, order.user_id]);
    const wallet = await client.query('SELECT id FROM wallets WHERE user_id = $1', [order.user_id]);
    await client.query(
      `INSERT INTO wallet_transactions (wallet_id, amount_usd_cents, type, description) VALUES ($1, $2, 'refund', $3)`,
      [wallet.rows[0].id, order.held_usd_cents, `SMS verification expired, refunded: ${order.service}`]
    );
    await client.query(`UPDATE sms_verification_orders SET status = 'EXPIRED', resolved_at = NOW() WHERE id = $1`, [dbOrderId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
  } finally {
    client.release();
  }
}

// ---------- STATUS / CANCEL ----------
router.get('/orders/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sms_verification_orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, order: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load order' });
  }
});

router.post('/orders/:id/cancel', requireAuth, async (req, res) => {
  try {
    const orderResult = await pool.query('SELECT * FROM sms_verification_orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (order.status !== 'PENDING_SMS') return res.status(400).json({ success: false, error: 'This order can no longer be cancelled' });

    if (activePolls.has(order.id)) { clearInterval(activePolls.get(order.id)); activePolls.delete(order.id); }
    if (order.provider === 'smspool') await smspoolCancel(order.provider_order_id);
    else await fivesimCancel(order.provider_order_id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE wallets SET balance_usd_cents = balance_usd_cents + $1 WHERE user_id = $2', [order.held_usd_cents, req.user.id]);
      const wallet = await client.query('SELECT id FROM wallets WHERE user_id = $1', [req.user.id]);
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, amount_usd_cents, type, description) VALUES ($1, $2, 'refund', $3)`,
        [wallet.rows[0].id, order.held_usd_cents, `SMS verification cancelled: ${order.service}`]
      );
      await client.query(`UPDATE sms_verification_orders SET status = 'CANCELLED', resolved_at = NOW() WHERE id = $1`, [order.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not cancel order' });
  }
});


//add here
router.get('/provider-labels', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT provider_key, display_name FROM sms_provider_labels');
    const labels = {};
    result.rows.forEach((r) => { labels[r.provider_key] = r.display_name; });
    res.json({ success: true, labels });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not load labels' });
  }
});


router.get('/orders', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sms_verification_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load history' });
  }
});

export default router;