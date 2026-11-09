import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

const router = Router();

// Get current user's own profile
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, full_name, role, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch profile' });
  }
});

// Update full name (email changes are more sensitive - skip for now)
router.put('/', requireAuth, async (req, res) => {
  try {
    const { fullName } = req.body;

    const result = await pool.query(
      `UPDATE users SET full_name = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, full_name, role`,
      [fullName, req.user.id]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update profile' });
  }
});

export default router;