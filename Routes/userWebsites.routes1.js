import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { provisionWebsite, deprovisionWebsite, ProvisionError } from '../Services/websites/provisioningService.js';
import { createZone, getZoneByName, checkZoneStatus, createHostingRecord } from '../Services/domains/cloudflareClient.js';
import bcrypt from 'bcryptjs';
import { getDecryptedApiKey } from '../Utils/encryption.js';


const router = Router();

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// List current user's sites
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
  `SELECT uw.*, wc.name AS template_name, wcl.name AS class_name, wcl.requires_design_key AS is_support_page
   FROM user_websites uw
   JOIN website_catalog wc ON wc.id = uw.catalog_id
   JOIN website_classes wcl ON wcl.id = wc.class_id
   WHERE uw.user_id = $1 AND uw.deleted_at IS NULL
   ORDER BY uw.created_at DESC`,
  [req.user.id]
);
    res.json({ success: true, websites: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch websites' });
  }
});

// ---- Helpers for creating sites ----------------------------------------------------------

// Addresses nobody may use as a subdomain.
const RESERVED_SUBDOMAINS = new Set(['www', 'mail', 'webmail', 'admin', 'api', 'ftp', 'cpanel', 'whm', 'smtp', 'imap', 'pop', 'ns1', 'ns2', 'root', 'support', 'help', 'test', 'dev', 'staging', 'autodiscover', 'autoconfig']);

function checkSubdomainFormat(clean) {
  if (!clean) return 'Please enter a subdomain.';
  if (clean.length < 2) return 'The subdomain must be at least 2 characters.';
  if (clean.length > 40) return 'The subdomain can be at most 40 characters.';
  if (RESERVED_SUBDOMAINS.has(clean)) return 'That subdomain is reserved. Please choose another.';
  return null;
}

// Is <sub>.<base domain> already used by any live site or alias (across every template on that domain)?
async function addressInUse({ managedDomainId, baseDomain, sub }) {
  const fullHost = `${sub}.${baseDomain}`;
  const result = await pool.query(
    `SELECT 1 FROM user_websites uw
      WHERE uw.deleted_at IS NULL AND COALESCE(uw.status, '') <> 'failed'
        AND (uw.site_url IN ($1, $2)
             OR (uw.subdomain = $3 AND uw.catalog_id IN (SELECT catalog_id FROM catalog_domains WHERE managed_domain_id = $4)))
     UNION
     SELECT 1 FROM website_domain_aliases WHERE domain = $5
     LIMIT 1`,
    [`https://${fullHost}`, `http://${fullHost}`, sub, managedDomainId, fullHost]
  );
  return result.rows.length > 0;
}

function suggestSubdomains(clean) {
  const year = String(new Date().getFullYear()).slice(2);
  const base = clean.slice(0, 32);
  return [`${base}hq`, `${base}-online`, `get${base}`, `${base}${year}`, `the${base}`, `${base}-official`]
    .filter((s, i, a) => a.indexOf(s) === i && !RESERVED_SUBDOMAINS.has(s));
}

// Remove a site record whose setup failed, so it does not count against the plan or block the address.
async function discardFailedSite(websiteId) {
  try {
    await pool.query('DELETE FROM user_website_support_links WHERE website_id = $1', [websiteId]);
    await pool.query('DELETE FROM user_websites WHERE id = $1', [websiteId]);
  } catch (err) {
    // Another table still points to it: keep it hidden as a failed, deleted record instead.
    await pool.query(`UPDATE user_websites SET status = 'failed', deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [websiteId]).catch(() => {});
  }
}

// Live check used by the create form while the user types.
router.get('/check-subdomain', requireAuth, async (req, res) => {
  try {
    const { catalogId, domainId, subdomain } = req.query;
    const clean = slugify(String(subdomain || ''));
    const formatError = checkSubdomainFormat(clean);
    if (formatError) return res.json({ success: true, available: false, clean, reason: 'invalid', message: formatError });

    const domainResult = await pool.query(
      `SELECT md.domain FROM catalog_domains cd JOIN managed_domains md ON md.id = cd.managed_domain_id
       WHERE cd.catalog_id = $1 AND cd.managed_domain_id = $2 AND md.is_active = true`,
      [catalogId, domainId]
    );
    if (domainResult.rows.length === 0) return res.json({ success: true, available: false, clean, reason: 'invalid', message: 'That domain is not available for this template.' });

    const taken = await addressInUse({ managedDomainId: domainId, baseDomain: domainResult.rows[0].domain, sub: clean });
    res.json({
      success: true, clean, available: !taken,
      reason: taken ? 'taken' : null,
      message: taken ? `${clean}.${domainResult.rows[0].domain} is already taken.` : null,
      suggestions: taken ? suggestSubdomains(clean) : []
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not check that address' });
  }
});

// Create + provision a new site
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      catalogId, domainType, domainId, subdomain, ownedDomainId, customDomain, businessName, logoUrl, description,
      primaryCurrency, adminLoginMethod, adminAccessCode, adminEmail, adminPassword,
      visitorSupportMode, liveChatScript, supportPosition, supportEmail, supportPhone, supportWhatsapp, supportTelegram,
      supportFacebook, supportInstagram, supportX, supportTiktok, customSupportLinks
    } = req.body;

    if (!catalogId || !businessName) {
      return res.status(400).json({ success: false, error: 'catalogId and businessName are required' });
    }
    if (domainType === 'subdomain' && (!domainId || !subdomain)) {
      return res.status(400).json({ success: false, error: 'Please choose a domain and subdomain' });
    }
    if (domainType === 'owned' && !ownedDomainId) {
      return res.status(400).json({ success: false, error: 'Please select one of your domains' });
    }
    if (domainType === 'external' && !customDomain) {
      return res.status(400).json({ success: false, error: 'Please enter your domain' });
    }

    const cleanSubdomain = slugify(String(subdomain || ''));
    const formatError = checkSubdomainFormat(cleanSubdomain);
    if (formatError) {
      return res.status(400).json({ success: false, error: formatError, reason: 'invalid', field: 'subdomain' });
    }

    const catalogResult = await pool.query(
      'SELECT * FROM website_catalog WHERE id = $1 AND is_active = true',
      [catalogId]
    );
    if (catalogResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    const catalogEntry = catalogResult.rows[0];

    // Per-class, lifetime limit — counts every site ever created in this class, including
    // soft-deleted ones (so delete-and-recreate can't get around the cap). Setups that
    // failed don't count: nothing was created for the user.
    const subResult = await pool.query(
      `SELECT sp.id AS plan_id FROM user_subscriptions us JOIN subscription_plans sp ON sp.id = us.plan_id WHERE us.user_id = $1`,
      [req.user.id]
    );
    const planId = subResult.rows[0]?.plan_id;

    const limitResult = await pool.query(
      'SELECT max_websites FROM plan_class_limits WHERE plan_id = $1 AND class_id = $2',
      [planId, catalogEntry.class_id]
    );
    if (limitResult.rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Your current plan does not include this type of website.', classLimitReached: true });
    }
    const classLimit = limitResult.rows[0].max_websites;

    // -1 genuinely means unlimited — skip the count check entirely.
    if (classLimit !== -1) {
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM user_websites WHERE user_id = $1 AND COALESCE(status, '') <> 'failed' AND catalog_id IN
         (SELECT id FROM website_catalog WHERE class_id = $2)`,
        [req.user.id, catalogEntry.class_id]
      );
      if (Number(countResult.rows[0].count) >= classLimit) {
        return res.status(403).json({
          success: false,
          error: `Your plan allows up to ${classLimit} website${classLimit === 1 ? '' : 's'} in this category.`,
          classLimitReached: true
        });
      }
    }

    // Subscription / balance gates — checked BEFORE anything is created on the template server.
    if (!catalogEntry.is_free) {
      const gateResult = await pool.query('SELECT * FROM service_gates WHERE service_key = $1', ['website_creation']);
      const gate = gateResult.rows[0];

      if (gate?.requires_subscription) {
        const subCheck = await pool.query(
          `SELECT sp.plan_key FROM user_subscriptions us
           JOIN subscription_plans sp ON sp.id = us.plan_id
           WHERE us.user_id = $1`,
          [req.user.id]
        );
        const planKey = subCheck.rows[0]?.plan_key;
        if (!planKey || planKey === 'free') {
          return res.status(402).json({ success: false, error: 'This template requires an active subscription', gateReason: 'subscription' });
        }
      }

      if (gate?.requires_balance) {
        const walletCheck = await pool.query('SELECT balance_usd_cents FROM wallets WHERE user_id = $1', [req.user.id]);
        const balance = Number(walletCheck.rows[0]?.balance_usd_cents || 0);
        if (balance <= 0) {
          return res.status(402).json({ success: false, error: 'Your wallet balance is too low', gateReason: 'balance' });
        }
      }
    }

    // Resolve the chosen domain and confirm it's actually allowed for this template
    const domainResult = await pool.query(
      `SELECT md.domain FROM catalog_domains cd
       JOIN managed_domains md ON md.id = cd.managed_domain_id
       WHERE cd.catalog_id = $1 AND cd.managed_domain_id = $2 AND md.is_active = true`,
      [catalogId, domainId]
    );
    if (domainResult.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'That domain is not available for this template' });
    }
    const baseDomain = domainResult.rows[0].domain;

    // The address must be free across every template that uses this domain (they share one server).
    if (await addressInUse({ managedDomainId: domainId, baseDomain, sub: cleanSubdomain })) {
      return res.status(409).json({
        success: false, reason: 'taken', field: 'subdomain',
        error: `${cleanSubdomain}.${baseDomain} is already taken.`,
        address: `${cleanSubdomain}.${baseDomain}`,
        suggestions: suggestSubdomains(cleanSubdomain)
      });
    }

    // Create the record first as 'provisioning'
    const insertResult = await pool.query(
      `INSERT INTO user_websites (
         user_id, catalog_id, subdomain, business_name, logo_url, description, status,
         primary_currency, admin_login_method, admin_email,
         visitor_support_mode, live_chat_script, support_position,
         support_email, support_phone, support_whatsapp, support_telegram,
         support_facebook, support_instagram, support_x, support_tiktok
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'provisioning', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING *`,
      [
        req.user.id, catalogId, cleanSubdomain, businessName, logoUrl || null, description || null,
        primaryCurrency || null, adminLoginMethod || 'access_code', adminEmail || null,
        visitorSupportMode || 'off', liveChatScript || null, supportPosition || 'right',
        supportEmail || null, supportPhone || null, supportWhatsapp || null, supportTelegram || null,
        supportFacebook || null, supportInstagram || null, supportX || null, supportTiktok || null
      ]
    );
    const website = insertResult.rows[0];

    // Save any custom support links (Twitch, Reddit, etc.) tied to this new site
    if (Array.isArray(customSupportLinks)) {
      for (let i = 0; i < customSupportLinks.length; i++) {
        const link = customSupportLinks[i];
        if (link.label && link.url) {
          await pool.query(
            `INSERT INTO user_website_support_links (website_id, label, url, sort_order) VALUES ($1, $2, $3, $4)`,
            [website.id, link.label, link.url, i]
          );
        }
      }
    }

    let provisionResult;
    try {
      provisionResult = await provisionWebsite({
        catalogEntry: { ...catalogEntry, base_domain: baseDomain },
        subdomain: cleanSubdomain,
        businessName,
        logoUrl,
        description,
        primaryCurrency: primaryCurrency || null,
        adminLoginMethod: adminLoginMethod || 'access_code',
        adminAccessCode: adminAccessCode || null,
        adminEmail: adminEmail || null,
        adminPassword: adminPassword || null,
        visitorSupportMode, liveChatScript, supportPosition,
        supportEmail, supportPhone, supportWhatsapp, supportTelegram,
        supportFacebook, supportInstagram, supportX, supportTiktok
      });
    } catch (provisionErr) {
      console.error('Provisioning failed:', provisionErr);
      let reason = provisionErr instanceof ProvisionError ? provisionErr.reason : 'unknown';
      // Templates answer 409 for a used address OR a used admin access code.
      if (reason === 'taken' && adminLoginMethod === 'access_code' && adminAccessCode) reason = 'taken_or_code';

      // Nothing usable was created for the user: remove the record so it doesn't
      // count against their plan or block the address.
      await discardFailedSite(website.id);

      // If the request may have reached the server (e.g. it timed out while the site was
      // being created), quietly ask the template to remove any half-made site too.
      if (provisionErr?.sent && ['timeout', 'server_error', 'bad_response'].includes(reason)) {
        deprovisionWebsite({ catalogEntry, subdomain: cleanSubdomain, fullHost: `${cleanSubdomain}.${baseDomain}` })
          .catch((e) => console.error('Cleanup after failed provisioning did not finish:', e.message));
      }

      return res.status(reason.startsWith('taken') ? 409 : 502).json({
        success: false,
        reason,
        error: provisionErr?.message || 'The website could not be set up.',
        detail: provisionErr?.detail || null,
        address: `${cleanSubdomain}.${baseDomain}`,
        suggestions: reason === 'taken' ? suggestSubdomains(cleanSubdomain) : [],
        nothingCreated: true
      });
    }

    let finalSiteUrl = provisionResult.siteUrl;
    let nameserverInfo = null;

    if (domainType === 'owned' && ownedDomainId) {
      await pool.query(
        `UPDATE user_domains SET connected_website_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
        [website.id, ownedDomainId, req.user.id]
      );
      const ownedDomainResult = await pool.query('SELECT domain_name FROM user_domains WHERE id = $1', [ownedDomainId]);
      const domainName = ownedDomainResult.rows[0]?.domain_name;
      if (domainName) {
        finalSiteUrl = `https://${domainName}`;
        try {
          const zone = await getZoneByName(domainName).catch(() => createZone(domainName));
          await createHostingRecord(zone.zoneId, domainName);
        } catch (dnsErr) {
          console.error('Could not link owned domain DNS (site still created fine):', dnsErr);
        }
      }
    }

    if (domainType === 'external' && customDomain) {
      try {
        const zone = await createZone(customDomain);
        nameserverInfo = zone.nameservers;
        finalSiteUrl = `https://${customDomain}`;
        await pool.query(
          `UPDATE user_websites SET domain_type = 'external', custom_domain = $1, nameserver_1 = $2, nameserver_2 = $3 WHERE id = $4`,
          [customDomain, zone.nameservers[0] || null, zone.nameservers[1] || null, website.id]
        );
      } catch (dnsErr) {
        console.error('Could not create Cloudflare zone for external domain:', dnsErr);
      }
    }

    const updateResult = await pool.query(
      `UPDATE user_websites
       SET status = 'active', site_url = $1, admin_url = $2, admin_access_code = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [finalSiteUrl, provisionResult.adminUrl, provisionResult.accessCode, website.id]
    );

    res.status(201).json({ success: true, website: updateResult.rows[0], nameservers: nameserverInfo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create website', reason: 'formular_error' });
  }
});


router.get('/:id/full', requireAuth, async (req, res) => {
  try {
    const siteResult = await pool.query(
      `SELECT uw.*, wc.class_id FROM user_websites uw
       JOIN website_catalog wc ON wc.id = uw.catalog_id
       WHERE uw.id = $1 AND uw.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (siteResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });

    //const classResult = await pool.query('SELECT requires_banking_fields FROM website_classes WHERE id = $1', [siteResult.rows[0].class_id]);
    const classResult = await pool.query('SELECT requires_banking_fields, requires_design_key FROM website_classes WHERE id = $1', [siteResult.rows[0].class_id]);
    const linksResult = await pool.query('SELECT * FROM user_website_support_links WHERE website_id = $1 ORDER BY sort_order', [req.params.id]);
    const catalogFullResult = await pool.query('SELECT has_support_page FROM website_catalog WHERE id = $1', [siteResult.rows[0].catalog_id]);

    res.json({
  success: true,
  website: siteResult.rows[0],
  requiresBankingFields: classResult.rows[0]?.requires_banking_fields || false,
  isSupportPage: classResult.rows[0]?.requires_design_key || false,
  customLinks: linksResult.rows,
  hasSupportPage: catalogFullResult.rows[0]?.has_support_page || false
});
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load website details' });
  }
});

// Edit your own website's display info
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const {
      businessName, description, logoUrl, primaryCurrency,
      visitorSupportMode, liveChatScript, supportPosition,
      supportEmail, supportPhone, supportWhatsapp, supportTelegram,
      supportFacebook, supportInstagram, supportX, supportTiktok,
      customSupportLinks
    } = req.body;

    const result = await pool.query(
      `UPDATE user_websites
       SET business_name = COALESCE($1, business_name),
           description = COALESCE($2, description),
           logo_url = COALESCE($3, logo_url),
           primary_currency = COALESCE($4, primary_currency),
           visitor_support_mode = COALESCE($5, visitor_support_mode),
           live_chat_script = COALESCE($6, live_chat_script),
           support_position = COALESCE($7, support_position),
           support_email = COALESCE($8, support_email),
           support_phone = COALESCE($9, support_phone),
           support_whatsapp = COALESCE($10, support_whatsapp),
           support_telegram = COALESCE($11, support_telegram),
           support_facebook = COALESCE($12, support_facebook),
           support_instagram = COALESCE($13, support_instagram),
           support_x = COALESCE($14, support_x),
           support_tiktok = COALESCE($15, support_tiktok),
           updated_at = NOW()
       WHERE id = $16 AND user_id = $17
       RETURNING *`,
      [
        businessName, description, logoUrl, primaryCurrency,
        visitorSupportMode, liveChatScript, supportPosition,
        supportEmail, supportPhone, supportWhatsapp, supportTelegram,
        supportFacebook, supportInstagram, supportX, supportTiktok,
        req.params.id, req.user.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Website not found' });
    }

        const website = result.rows[0];

// Push logo update to the live site when logoUrl is explicitly provided
if (logoUrl !== undefined) {
  try {
    const catalogResult = await pool.query('SELECT provision_endpoint, provision_api_key_name FROM website_catalog WHERE id = $1', [website.catalog_id]);
    const catalog = catalogResult.rows[0];
    const apiKey = await getDecryptedApiKey(catalog.provision_api_key_name).catch(() => null);
    const fullHost = new URL(website.site_url).hostname;
    if (apiKey) {
      await fetch(catalog.provision_endpoint.replace('/provision', '/update-logo'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ fullHost, logoUrl: logoUrl || null })
      }).catch(() => {});
    }
  } catch (pushErr) {
    console.error('Could not push logo update to live site:', pushErr);
  }
}

if (visitorSupportMode !== undefined) {
  try {
    const catalogResult = await pool.query('SELECT provision_endpoint, provision_api_key_name FROM website_catalog WHERE id = $1', [website.catalog_id]);
    const catalog = catalogResult.rows[0];
    const apiKey = await getDecryptedApiKey(catalog.provision_api_key_name).catch(() => null);
    const fullHost = new URL(website.site_url).hostname;
    if (apiKey) {
      await fetch(catalog.provision_endpoint.replace('/provision', '/update-support'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          fullHost,
          visitor_support_mode: visitorSupportMode,
          live_chat_script: liveChatScript,
          support_position: supportPosition,
          support_email: supportEmail,
          support_phone: supportPhone,
          support_whatsapp: supportWhatsapp,
          support_telegram: supportTelegram,
          support_facebook: supportFacebook,
          support_instagram: supportInstagram,
          support_x: supportX,
          support_tiktok: supportTiktok,
          custom_links: customSupportLinks
        })
      }).catch(() => {});
    }
  } catch (pushErr) {
    console.error('Could not push support settings to live site:', pushErr);
  }
}

    if (Array.isArray(customSupportLinks)) {
      await pool.query('DELETE FROM user_website_support_links WHERE website_id = $1', [req.params.id]);
      for (let i = 0; i < customSupportLinks.length; i++) {
        const link = customSupportLinks[i];
        if (link.label && link.url) {
          await pool.query(
            `INSERT INTO user_website_support_links (website_id, label, url, sort_order) VALUES ($1, $2, $3, $4)`,
            [req.params.id, link.label, link.url, i]
          );
        }
      }
    }

    res.json({ success: true, website: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update website' });
  }
});

// Delete your own website
// Delete your own website
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const siteResult = await pool.query(
      `SELECT uw.*, wc.provision_endpoint, wc.provision_api_key_name
       FROM user_websites uw
       JOIN website_catalog wc ON wc.id = uw.catalog_id
       WHERE uw.id = $1 AND uw.user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (siteResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Website not found' });
    }
    const site = siteResult.rows[0];

    // Try to remove it from the actual template server first
        // Try to remove it from the actual template server first
        // Try to remove it from the actual template server first
    try {
      const fullHost = site.site_url ? new URL(site.site_url).hostname : null;
      if (!fullHost) throw new Error('No site_url on record for this site — skipping remote deprovision');
      await deprovisionWebsite({
        catalogEntry: { provision_endpoint: site.provision_endpoint, provision_api_key_name: site.provision_api_key_name },
        subdomain: site.subdomain,
        fullHost
      });
    } catch (deprovisionErr) {
      console.error('Deprovisioning failed (continuing with local delete anyway):', deprovisionErr);
      // We still proceed to delete locally - a site that's unreachable/already
      // gone on the template side shouldn't permanently block the user from
      // clearing it out of their own Formular account.
    }

    // Soft delete only — the row stays, so it still counts toward the
// lifetime per-class limit. This is the real fix for delete-and-recreate abuse.
await pool.query('UPDATE user_websites SET deleted_at = NOW() WHERE id = $1', [req.params.id]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete website' });
  }
});






router.post('/:id/deactivate', requireAuth, async (req, res) => {
  try {
    const siteResult = await pool.query('SELECT status FROM user_websites WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (siteResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });

    await pool.query(
      `UPDATE user_websites SET status_before_deactivation = status, status = 'deactivated', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not deactivate website' });
  }
});

router.post('/:id/reactivate', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE user_websites SET status = COALESCE(status_before_deactivation, 'active'), status_before_deactivation = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });
    res.json({ success: true, website: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not reactivate website' });
  }
});

router.get('/:id/admin-info', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT admin_login_method, admin_access_code, admin_email, admin_url FROM user_websites WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });
    res.json({ success: true, info: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load admin info' });
  }
});

router.post('/:id/admin-reset', requireAuth, async (req, res) => {
  try {
    const { newAccessCode, newEmail, newPassword } = req.body;

    const siteResult = await pool.query(
      `SELECT uw.*, wc.provision_endpoint, wc.provision_api_key_name FROM user_websites uw
       JOIN website_catalog wc ON wc.id = uw.catalog_id
       WHERE uw.id = $1 AND uw.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (siteResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });
    const site = siteResult.rows[0];

    const targetMethod = req.body.method || site.admin_login_method;
    const fullHost = new URL(site.site_url).hostname;
    const resetUrl = site.provision_endpoint.replace('/provision', '/admin-reset');

    // The website itself is what people actually log in to, so IT is the source of
    // truth. We only record the change here AFTER the website has accepted it —
    // otherwise this page says "changed" while the real login never moved.
    async function pushToSite(body) {
      let apiKey;
      try {
        apiKey = await getDecryptedApiKey(site.provision_api_key_name);
      } catch {
        apiKey = null;
      }
      if (!apiKey) return { ok: false, error: 'This website type has no API key set up yet. Ask the admin to add it on the API Keys page.' };

      let r;
      try {
        r = await fetch(resetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ fullHost, ...body }),
          signal: AbortSignal.timeout(20_000)
        });
      } catch (e) {
        console.error('admin-reset push failed:', fullHost, e?.message);
        return { ok: false, error: 'Could not reach your website to change the login. Please try again in a moment.' };
      }

      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      if (!r.ok || !data?.success) {
        console.error('admin-reset refused:', fullHost, r.status, text.slice(0, 300));
        return { ok: false, error: data?.error || `Your website would not accept the change (code ${r.status}).` };
      }
      return { ok: true };
    }

    if (targetMethod === 'access_code') {
      const code = newAccessCode || Math.random().toString(36).slice(2, 10).toUpperCase();
      const push = await pushToSite({ accessCode: code });
      if (!push.ok) return res.status(502).json({ success: false, error: push.error });

      await pool.query(
        `UPDATE user_websites SET admin_access_code = $1, admin_email = NULL,
           admin_login_method = 'access_code', updated_at = NOW() WHERE id = $2`,
        [code, req.params.id]
      );
      return res.json({ success: true, newAccessCode: code });
    }

    // ---- email + password ----
    if (!newEmail && !newPassword) {
      return res.status(400).json({ success: false, error: 'Enter a new email and/or password' });
    }
    // Switching over for the first time needs BOTH, or the website has no password
    // to check against and the login would be impossible.
    if (site.admin_login_method !== 'email_password' && (!newEmail || !newPassword)) {
      return res.status(400).json({ success: false, error: 'To switch to email login, enter both an email and a password.' });
    }
    if (newPassword && String(newPassword).length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const push = await pushToSite({ email: newEmail || null, password: newPassword || null });
    if (!push.ok) return res.status(502).json({ success: false, error: push.error });

    await pool.query(
      `UPDATE user_websites SET admin_login_method = 'email_password', admin_access_code = NULL,
         admin_email = COALESCE($1, admin_email), updated_at = NOW() WHERE id = $2`,
      [newEmail || null, req.params.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not reset admin credentials' });
  }
});

router.post('/:id/transfer/initiate', requireAuth, async (req, res) => {
  try {
    const { toEmail, password, confirmed } = req.body;
    if (!toEmail || !password || !confirmed) {
      return res.status(400).json({ success: false, error: 'Please fill in all fields and confirm the checkbox' });
    }

    const siteResult = await pool.query('SELECT * FROM user_websites WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (siteResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });

    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const validPassword = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!validPassword) return res.status(401).json({ success: false, error: 'Incorrect password' });

    const recipientResult = await pool.query('SELECT id FROM users WHERE email = $1', [toEmail]);
    if (recipientResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'That email is not a member of the platform' });
    }
    const recipientId = recipientResult.rows[0].id;

    const existingPending = await pool.query(
      `SELECT id FROM website_transfers WHERE website_id = $1 AND status = 'pending'`,
      [req.params.id]
    );
    if (existingPending.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'A transfer is already pending for this site' });
    }

    const result = await pool.query(
      `INSERT INTO website_transfers (website_id, from_user_id, to_email, to_user_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, req.user.id, toEmail, recipientId]
    );

    res.status(201).json({ success: true, transfer: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not initiate transfer' });
  }
});

router.post('/:id/transfer/cancel', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE website_transfers SET status = 'cancelled', resolved_at = NOW()
       WHERE website_id = $1 AND from_user_id = $2 AND status = 'pending'`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not cancel transfer' });
  }
});


router.get('/transfers/incoming', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT wt.*, uw.business_name, uw.site_url, u.email AS from_email
       FROM website_transfers wt
       JOIN user_websites uw ON uw.id = wt.website_id
       JOIN users u ON u.id = wt.from_user_id
       WHERE wt.to_user_id = $1 AND wt.status = 'pending'
       ORDER BY wt.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, transfers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load incoming transfers' });
  }
});

router.post('/transfers/:transferId/accept', requireAuth, async (req, res) => {
  try {
    const transferResult = await pool.query(
      `SELECT wt.*, uw.catalog_id FROM website_transfers wt
       JOIN user_websites uw ON uw.id = wt.website_id
       WHERE wt.id = $1 AND wt.to_user_id = $2 AND wt.status = 'pending'`,
      [req.params.transferId, req.user.id]
    );
    if (transferResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Transfer not found' });
    const transfer = transferResult.rows[0];

    const subResult = await pool.query(
      `SELECT sp.max_websites FROM user_subscriptions us
       JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.user_id = $1`,
      [req.user.id]
    );
    const maxWebsites = subResult.rows[0]?.max_websites;
    if (maxWebsites === undefined) {
      return res.status(402).json({ success: false, error: 'You need an active paid plan to accept this transfer' });
    }
    if (maxWebsites !== null) {
      const countResult = await pool.query(`SELECT COUNT(*) FROM user_websites WHERE user_id = $1 AND status != 'failed'`, [req.user.id]);
      if (Number(countResult.rows[0].count) >= maxWebsites) {
        return res.status(402).json({ success: false, error: `Your plan allows up to ${maxWebsites} sites. Upgrade first, or free up a slot.` });
      }
    }

    await pool.query(
      `UPDATE user_websites SET user_id = $1, status = 'deactivated', status_before_deactivation = 'active', updated_at = NOW() WHERE id = $2`,
      [req.user.id, transfer.website_id]
    );
    await pool.query(`UPDATE website_transfers SET status = 'accepted', resolved_at = NOW() WHERE id = $1`, [transfer.id]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not accept transfer' });
  }
});

router.post('/transfers/:transferId/decline', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE website_transfers SET status = 'declined', resolved_at = NOW() WHERE id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [req.params.transferId, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not decline transfer' });
  }
});



router.get('/:id/domain-status', requireAuth, async (req, res) => {
  try {
    const siteResult = await pool.query('SELECT domain_type, custom_domain FROM user_websites WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (siteResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });
    const site = siteResult.rows[0];

    if (site.domain_type !== 'external') return res.json({ success: true, status: 'n/a' });

    const zone = await getZoneByName(site.custom_domain);
    if (zone.status === 'active') {
      await createHostingRecord(zone.zoneId, site.custom_domain).catch(() => {});
      await pool.query(`UPDATE user_websites SET domain_connected = true WHERE id = $1`, [req.params.id]);
    }

    res.json({ success: true, status: zone.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not check domain status' });
  }
});



// ============================================================
// Add these two routes to user-websites.routes.js, anywhere among the
// other router.get/post/put/delete calls (order doesn't matter).
// ============================================================

// List a site's alias domains
router.get('/:id/aliases', requireAuth, async (req, res) => {
  try {
    const siteResult = await pool.query('SELECT id FROM user_websites WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (siteResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });

    const result = await pool.query('SELECT * FROM website_domain_aliases WHERE website_id = $1 ORDER BY created_at', [req.params.id]);
    res.json({ success: true, aliases: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load domains' });
  }
});

// Add a new alias domain — an existing owned domain, or a brand-new external one
router.post('/:id/aliases', requireAuth, async (req, res) => {
  try {
    const { domainType, domainId, subdomain, ownedDomainId, customDomain } = req.body;

    const siteResult = await pool.query(
      `SELECT uw.*, wc.provision_endpoint, wc.provision_api_key_name
       FROM user_websites uw JOIN website_catalog wc ON wc.id = uw.catalog_id
       WHERE uw.id = $1 AND uw.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (siteResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });
    const site = siteResult.rows[0];
    const primaryDomain = new URL(site.site_url).hostname;

    let newDomain, nameserver1 = null, nameserver2 = null;

    if (domainType === 'subdomain') {
  if (!domainId || !subdomain) return res.status(400).json({ success: false, error: 'Please choose a domain and enter a subdomain' });
  const baseDomainResult = await pool.query(
    `SELECT md.domain FROM catalog_domains cd
     JOIN managed_domains md ON md.id = cd.managed_domain_id
     WHERE cd.managed_domain_id = $1 AND cd.catalog_id = $2`,
    [domainId, site.catalog_id]
  );
  if (baseDomainResult.rows.length === 0) return res.status(400).json({ success: false, error: 'Invalid domain selected' });
  const cleanSubdomain = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
  newDomain = `${cleanSubdomain}.${baseDomainResult.rows[0].domain}`;

} else if (domainType === 'owned') {
      if (!ownedDomainId) return res.status(400).json({ success: false, error: 'Please select a domain you own' });
      const domainResult = await pool.query('SELECT domain_name FROM user_domains WHERE id = $1 AND user_id = $2 AND connected_website_id IS NULL', [ownedDomainId, req.user.id]);
      if (domainResult.rows.length === 0) return res.status(400).json({ success: false, error: 'That domain is not available' });
      newDomain = domainResult.rows[0].domain_name;

      await pool.query('UPDATE user_domains SET connected_website_id = $1, updated_at = NOW() WHERE id = $2', [site.id, ownedDomainId]);
      try {
        const zone = await getZoneByName(newDomain).catch(() => createZone(newDomain));
        await createHostingRecord(zone.zoneId, newDomain);
      } catch (dnsErr) {
        console.error('Could not link owned alias domain DNS (continuing anyway):', dnsErr);
      }

    } else if (domainType === 'external') {
      if (!customDomain) return res.status(400).json({ success: false, error: 'Please enter a domain' });
      newDomain = customDomain.trim();
      try {
        const zone = await createZone(newDomain);
        nameserver1 = zone.nameservers[0] || null;
        nameserver2 = zone.nameservers[1] || null;
      } catch (dnsErr) {
        console.error('Could not create Cloudflare zone for alias domain:', dnsErr);
        return res.status(502).json({ success: false, error: 'Could not set up that domain right now' });
      }
    } else {
      return res.status(400).json({ success: false, error: 'domainType must be "owned" or "external"' });
    }

       // Block adding a domain that's already someone else's primary site, or
// already someone else's alias — without this, a confusing silent
// collision happens where messages land on the WRONG user's dashboard.
const conflictCheck = await pool.query(
  `SELECT 1 FROM user_websites WHERE site_url IN ($1, $2) AND deleted_at IS NULL
   UNION
   SELECT 1 FROM website_domain_aliases WHERE domain = $3`,
  [`https://${newDomain}`, `http://${newDomain}`, newDomain]
);
/**
 * const conflictCheck = await pool.query(
  `SELECT 1 FROM user_websites WHERE site_url ILIKE $1 AND deleted_at IS NULL
   UNION
   SELECT 1 FROM website_domain_aliases WHERE domain = $2`,
  [`%${newDomain}`, newDomain]
);
 */
if (conflictCheck.rows.length > 0) {
  return res.status(409).json({ success: false, error: 'That domain is already in use by another site.' });
}

const insertResult = await pool.query(
  `INSERT INTO website_domain_aliases (website_id, domain, domain_type, nameserver_1, nameserver_2)
   VALUES ($1, $2, $3, $4, $5) RETURNING *`,
  [site.id, newDomain, domainType, nameserver1, nameserver2]
);


    // Tell the site's own backend to treat this new domain as an alias,
    // sharing the same chat identity as the primary domain.
    try {
      const apiKey = await getDecryptedApiKey(site.provision_api_key_name).catch(() => null);
      if (apiKey) {
        await fetch(site.provision_endpoint.replace('/provision.php', '/register-alias.php').replace('/provision', '/register-alias'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ primaryDomain, aliasDomain: newDomain })
        }).catch(() => {});
      }
    } catch (aliasErr) {
      console.error('Could not register alias with template backend (domain still saved):', aliasErr);
    }

    res.status(201).json({ success: true, alias: insertResult.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not add domain' });
  }
});

// Remove an alias domain
router.delete('/:id/aliases/:aliasId', requireAuth, async (req, res) => {
  try {
    const siteResult = await pool.query('SELECT id FROM user_websites WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (siteResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });

    const aliasResult = await pool.query('SELECT domain FROM website_domain_aliases WHERE id = $1 AND website_id = $2', [req.params.aliasId, req.params.id]);
    if (aliasResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Domain not found' });
    const domain = aliasResult.rows[0].domain;

    await pool.query('UPDATE user_domains SET connected_website_id = NULL WHERE domain_name = $1', [domain]);
    await pool.query('DELETE FROM website_domain_aliases WHERE id = $1', [req.params.aliasId]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not remove domain' });
  }
});

router.get('/:id/catalog-domains', requireAuth, async (req, res) => {
  try {
    const siteResult = await pool.query('SELECT catalog_id FROM user_websites WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (siteResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });

    const domainsResult = await pool.query(
      `SELECT md.id, md.domain FROM catalog_domains cd
       JOIN managed_domains md ON md.id = cd.managed_domain_id
       WHERE cd.catalog_id = $1`,
      [siteResult.rows[0].catalog_id]
    );
    res.json({ success: true, domains: domainsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load domains' });
  }
});


// ─── Add this route to userWebsites.routes.js ────────────────────────────────
// Place it AFTER `router.get('/', ...)` and BEFORE `router.get('/:id/full', ...)`
// so Express doesn't match the literal string "my-class-limits" as an :id param.

// Get current user's per-class website usage vs. their plan limits
router.get('/my-class-limits', requireAuth, async (req, res) => {
  try {
    const subResult = await pool.query(
      `SELECT sp.id AS plan_id
       FROM user_subscriptions us
       JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.user_id = $1
       LIMIT 1`,
      [req.user.id]
    );
    const planId = subResult.rows[0]?.plan_id;

    if (!planId) {
      return res.json({ success: true, classLimits: [] });
    }

    // Count only ACTIVE (non-deleted) websites for the dashboard display.
    // The creation cap in POST / separately counts all-time including deleted —
    // that's intentional to block delete-and-recreate abuse. Here we just want
    // "how many sites do you have right now" for the stat tile.
    const result = await pool.query(
      `SELECT
         pcl.class_id,
         wc.name  AS class_name,
         pcl.max_websites,
         (
           SELECT COUNT(*)::int
           FROM user_websites uw
           WHERE uw.user_id = $2
             AND uw.deleted_at IS NULL
             AND uw.catalog_id IN (
               SELECT id FROM website_catalog WHERE class_id = pcl.class_id
             )
         ) AS used_count
       FROM plan_class_limits pcl
       JOIN website_classes wc ON wc.id = pcl.class_id
       WHERE pcl.plan_id = $1
         AND (pcl.max_websites = -1 OR pcl.max_websites > 0)`,
      [planId, req.user.id]
    );

    res.json({ success: true, classLimits: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch class limits' });
  }
});

export default router;