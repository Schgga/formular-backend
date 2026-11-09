import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tutorials ORDER BY created_at DESC');
    res.json({ success: true, tutorials: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load tutorials' });
  }
});

/**router.get('/page/:pageKey', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tutorials WHERE page_key = $1', [req.params.pageKey]);
    if (result.rows.length === 0) return res.json({ success: true, tutorial: null });
    res.json({ success: true, tutorial: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load tutorial' });
  }
}); **/

router.get('/page', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.json({ success: true, tutorial: null });
    const result = await pool.query('SELECT * FROM tutorials WHERE page_key = $1', [key]);
    if (result.rows.length === 0) return res.json({ success: true, tutorial: null });
    res.json({ success: true, tutorial: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load tutorial' });
  }
});


export default router;