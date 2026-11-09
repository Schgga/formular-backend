import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import {
  checkDomainAvailability,
  createCustomer,
  getCustomerByEmail,
  getDefaultContact,
  registerDomain
} from '../Services/domains/resellerClubClient.js';
import { createZone, createHostingRecord } from '../Services/domains/cloudflareClient.js';

const router = Router();

const SUPPORTED_TLDS = ['com', 'net', 'org', 'io', 'co', 'info', 'biz', 'xyz'];

function generateValidPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 12; i++) {
    pass += chars[crypto.randomInt(0, chars.length)];
  }
  return pass + '!9Aa';
}

// List current user's domains, with connected website info if any
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ud.*, uw.business_name AS connected_website_name, uw.site_url AS connected_website_url
       FROM user_domains ud
       LEFT JOIN user_websites uw ON uw.id = ud.connected_website_id
       WHERE ud.user_id = $1
       ORDER BY ud.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, domains: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch domains' });
  }
});

router.get('/check', requireAuth, async (req, res) => {
  try {
    let { name } = req.query;
    if (!name) {
      return res.status(400).json({ success: false, error: 'Domain name is required' });
    }

    const baseName = name.trim().toLowerCase().split('.')[0];

    const results = await checkDomainAvailability(baseName, SUPPORTED_TLDS);

    const priceResult = await pool.query(
      `SELECT service_key, free_price_usd_cents, premium_price_usd_cents
       FROM pricing WHERE category = 'domains' AND is_active = true`
    );
    const priceMap = {};
    priceResult.rows.forEach((row) => {
      const tld = row.service_key.replace('domain_', '');
      priceMap[tld] = row;
    });

    const enrichedResults = {};
    Object.entries(results).forEach(([domain, info]) => {
      const tld = domain.split('.').pop();
      const price = priceMap[tld];
      enrichedResults[domain] = {
        ...info,
        free_price_usd_cents: price?.free_price_usd_cents ?? null,
        premium_price_usd_cents: price?.premium_price_usd_cents ?? null
      };
    });

    res.json({ success: true, results: enrichedResults });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message || 'Could not check domain availability' });
  }
});

router.get('/registrant-profile', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_registrant_profiles WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ success: true, profile: result.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch profile' });
  }
});

router.post('/register', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      domainName, tld, years = 1,
      name, company, addressLine1, city, state, country, zipcode, phoneCc, phone,
      connectedWebsiteId
    } = req.body;

    if (!domainName || !tld || !name || !addressLine1 || !city || !state || !country || !zipcode || !phone) {
      return res.status(400).json({ success: false, error: 'Missing required registrant details' });
    }

    const fullDomain = `${domainName}.${tld}`;
    const serviceKey = `domain_${tld}`;

    await client.query('BEGIN');

    const subResult = await client.query(
      `SELECT sp.plan_key FROM user_subscriptions us
       JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.user_id = $1`,
      [req.user.id]
    );
    const isPremium = subResult.rows[0]?.plan_key !== 'free';

    const priceResult = await client.query(
      'SELECT free_price_usd_cents, premium_price_usd_cents FROM pricing WHERE service_key = $1 AND is_active = true',
      [serviceKey]
    );
    if (priceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'No pricing found for this TLD' });
    }
    const priceRow = priceResult.rows[0];
    const costCents = (isPremium ? priceRow.premium_price_usd_cents : priceRow.free_price_usd_cents) * years;

    const walletResult = await client.query(
      'SELECT id, balance_usd_cents FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (walletResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }
    const wallet = walletResult.rows[0];
    if (Number(wallet.balance_usd_cents) < costCents) {
      await client.query('ROLLBACK');
      return res.status(402).json({ success: false, error: 'Insufficient balance', outOfFunds: true });
    }

    // If a websiteId was provided, confirm it actually belongs to this user
    let validatedWebsiteId = null;
    if (connectedWebsiteId && connectedWebsiteId !== 'none') {
      const websiteCheck = await client.query(
        'SELECT id FROM user_websites WHERE id = $1 AND user_id = $2',
        [connectedWebsiteId, req.user.id]
      );
      if (websiteCheck.rows.length > 0) {
        validatedWebsiteId = connectedWebsiteId;
      }
    }

    const userResult = await client.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const userEmail = userResult.rows[0].email;

    await client.query('COMMIT');

    let customerId = await getCustomerByEmail(userEmail);

    if (!customerId) {
      const randomPassword = generateValidPassword();
      customerId = await createCustomer({
        email: userEmail,
        password: randomPassword,
        name, company, addressLine1, city, state, country, zipcode, phoneCc: phoneCc || '1', phone
      });
    }

    const contactId = await getDefaultContact(customerId);

        const zoneResult = await createZone(fullDomain);
    const nameservers = zoneResult.nameservers;

    const orderResult = await registerDomain({
      domainName: fullDomain,
      years,
      nameservers,
      customerId,
      contactId
    });

    // Domain is fully platform-owned, so nameservers are guaranteed active almost immediately - safe to add the hosting record now
    try {
      await createHostingRecord(zoneResult.zoneId, fullDomain);
    } catch (dnsErr) {
      console.error('Could not create hosting DNS record (domain still registered fine):', dnsErr);
    }

    const chargeClient = await pool.connect();
    try {
      await chargeClient.query('BEGIN');
      await chargeClient.query(
        'UPDATE wallets SET balance_usd_cents = balance_usd_cents - $1, updated_at = NOW() WHERE id = $2',
        [costCents, wallet.id]
      );
      await chargeClient.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount_usd_cents, service_key, description)
         VALUES ($1, 'debit', $2, $3, $4)`,
        [wallet.id, costCents, serviceKey, `Domain registration - ${fullDomain}`]
      );

      const domainInsert = await chargeClient.query(
        `INSERT INTO user_domains (user_id, domain_name, years, resellerclub_customer_id, resellerclub_order_id, nameservers, connected_website_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         RETURNING *`,
        [req.user.id, fullDomain, years, customerId, orderResult.entityid || null, JSON.stringify(nameservers), validatedWebsiteId]
      );

      await chargeClient.query(
        `INSERT INTO user_registrant_profiles (user_id, resellerclub_customer_id, name, company, address_line1, city, state, country, zipcode, phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id)
         DO UPDATE SET resellerclub_customer_id = $2, name = $3, company = $4, address_line1 = $5, city = $6, state = $7, country = $8, zipcode = $9, phone = $10, updated_at = NOW()`,
        [req.user.id, customerId, name, company || null, addressLine1, city, state, country, zipcode, phone]
      );

      await chargeClient.query('COMMIT');

      res.status(201).json({ success: true, domain: domainInsert.rows[0] });
    } catch (chargeErr) {
      await chargeClient.query('ROLLBACK');
      console.error('Charge/save failed after successful registration:', chargeErr);
      res.status(500).json({ success: false, error: 'Domain was registered but there was an error saving it. Contact support.' });
    } finally {
      chargeClient.release();
    }
  } catch (err) {
    console.error('Domain registration failed:', err);
    res.status(500).json({ success: false, error: err.message || 'Could not register domain' });
  } finally {
    client.release();
  }
});

// Connect an existing (unconnected) domain to one of the user's websites
router.put('/:id/connect', requireAuth, async (req, res) => {
  try {
    const { websiteId } = req.body;
    if (!websiteId) {
      return res.status(400).json({ success: false, error: 'websiteId is required' });
    }

    const websiteCheck = await pool.query(
      'SELECT id FROM user_websites WHERE id = $1 AND user_id = $2',
      [websiteId, req.user.id]
    );
    if (websiteCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Website not found' });
    }

    const result = await pool.query(
      `UPDATE user_domains
       SET connected_website_id = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [websiteId, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Domain not found' });
    }

    res.json({ success: true, domain: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not connect domain' });
  }
});

export default router;