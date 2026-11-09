import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';

const router = Router();

router.post('/simulator-catalog', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { name, slug, logoUrl, description } = req.body;
    if (!name || !slug) return res.status(400).json({ success: false, error: 'Name and slug are required' });

    const result = await pool.query(
      `INSERT INTO simulator_catalog (name, slug, logo_url, description) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, slug, logoUrl || null, description || null]
    );
    res.status(201).json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create item' });
  }
});

router.put('/simulator-catalog/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { name, slug, logoUrl, description } = req.body;
    const result = await pool.query(
      `UPDATE simulator_catalog SET name = $1, slug = $2, logo_url = $3, description = $4 WHERE id = $5 RETURNING *`,
      [name, slug, logoUrl || null, description || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update item' });
  }
});

router.delete('/simulator-catalog/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM simulator_catalog WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete item' });
  }
});

export default router;