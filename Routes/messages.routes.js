import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

const router = Router();

router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    const result = await pool.query(
      `INSERT INTO messages (user_id, name, email, message)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.id, name, email, message]
    );

    res.status(201).json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not send message' });
  }
});

export default router;