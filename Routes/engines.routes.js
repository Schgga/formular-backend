import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';

const router = Router();

// PUBLIC — anyone logged in can see available engines to choose from
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT engine_key, display_name, description, recommendation_note, badge_label FROM engines WHERE is_active = true ORDER BY display_name'
    );
    res.json({ success: true, engines: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load engines' });
  }
});

// SUPERADMIN ONLY — full details including model_version, provider
router.get('/admin', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM engines ORDER BY display_name');
    res.json({ success: true, engines: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load engines' });
  }
});

// SUPERADMIN ONLY — update an engine's config
//router.put('/:engineKey', requireAuth, requireRole('superadmin'), async (req, res) => {
  router.put('/:engineKey', requireAuth, requirePermission('engines'), async (req, res) => {
  try {
    const { engineKey } = req.params;
    const { display_name, model_version, description, recommendation_note, badge_label, is_active } = req.body;

    const result = await pool.query(
      `UPDATE engines
       SET display_name = COALESCE($1, display_name),
           model_version = COALESCE($2, model_version),
           description = COALESCE($3, description),
           recommendation_note = COALESCE($4, recommendation_note),
           badge_label = COALESCE($5, badge_label),
           is_active = COALESCE($6, is_active),
           updated_by = $7,
           updated_at = NOW()
       WHERE engine_key = $8
       RETURNING *`,
      [display_name, model_version, description, recommendation_note, badge_label, is_active, req.user.id, engineKey]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Engine not found' });
    }

    res.json({ success: true, engine: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update engine' });
  }
});

export default router;