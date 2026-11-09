import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT site_name, logo_url_dark, logo_url_light,
             footer_logo_url_dark, footer_logo_url_light, favicon_url,
             site_email_1, site_email_2, whatsapp_1, whatsapp_2,
             live_chat_url, hero_description, telegram_url
      FROM site_settings LIMIT 1
    `);
    res.json({ success: true, settings: result.rows[0] || {} });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load settings' });
  }
});

//router.put('/', requireAuth, requireRole('superadmin'), async (req, res) => {
  router.put('/', requireAuth, requirePermission('site-settings'), async (req, res) => {
  try {
    const {
      site_name, logo_url_dark, logo_url_light,
      footer_logo_url_dark, footer_logo_url_light, favicon_url,
      site_email_1, site_email_2, whatsapp_1, whatsapp_2,
      live_chat_url, hero_description, telegram_url
    } = req.body;

    const result = await pool.query(
      `UPDATE site_settings
       SET site_name = COALESCE($1, site_name),
           logo_url_dark = COALESCE($2, logo_url_dark),
           logo_url_light = COALESCE($3, logo_url_light),
           footer_logo_url_dark = COALESCE($4, footer_logo_url_dark),
           footer_logo_url_light = COALESCE($5, footer_logo_url_light),
           favicon_url = COALESCE($6, favicon_url),
           site_email_1 = COALESCE($7, site_email_1),
           site_email_2 = COALESCE($8, site_email_2),
           whatsapp_1 = COALESCE($9, whatsapp_1),
           whatsapp_2 = COALESCE($10, whatsapp_2),
           live_chat_url = COALESCE($11, live_chat_url),
           hero_description = COALESCE($12, hero_description),
           telegram_url = COALESCE($13, telegram_url),
           updated_at = NOW()
       RETURNING *`,
      [site_name, logo_url_dark, logo_url_light,
       footer_logo_url_dark, footer_logo_url_light, favicon_url,
       site_email_1, site_email_2, whatsapp_1, whatsapp_2,
       live_chat_url, hero_description, telegram_url]
    );

    res.json({ success: true, settings: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update settings' });
  }
});

export default router;