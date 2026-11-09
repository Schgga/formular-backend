import { pool } from '../db.js';

// Superadmin always passes. Admin passes only if this page isn't locked for them.
export function requirePermission(pageKey) {
  return async (req, res, next) => {
    if (req.user.role === 'superadmin') return next();

    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    try {
      const result = await pool.query(
        'SELECT locked_for_admin FROM admin_permissions WHERE page_key = $1',
        [pageKey]
      );

      const locked = result.rows[0]?.locked_for_admin;
      if (locked) {
        return res.status(403).json({ success: false, error: 'This page is read-only for your role' });
      }

      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Permission check failed' });
    }
  };
}