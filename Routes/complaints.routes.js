import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

const router = Router();

// Submit a complaint
router.post('/', requireAuth, async (req, res) => {
  try {
    const { issueType, subject, description } = req.body;

    if (!issueType || !subject || !description) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    const result = await pool.query(
      `INSERT INTO complaints (user_id, issue_type, subject, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.id, issueType, subject, description]
    );

    res.status(201).json({ success: true, complaint: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not submit complaint' });
  }
});

// Get current user's own complaints
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM complaints WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ success: true, complaints: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch complaints' });
  }
});

export default router;