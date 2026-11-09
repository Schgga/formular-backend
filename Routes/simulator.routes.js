import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM simulator_catalog ORDER BY sort_order, id');
    res.json({ success: true, items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load simulators' });
  }
});

router.get('/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM simulator_catalog WHERE slug = $1', [req.params.slug]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load simulator' });
  }
});

export default router;