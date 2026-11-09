import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { encrypt } from '../Utils/encryption.js';
import { decrypt } from '../Utils/encryption.js';
import { requirePermission } from '../Middleware/permission.middleware.js';

const router = Router();

// List all API key entries (superadmin only) — values are NEVER sent back, only metadata
router.get('/', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, key_name, updated_at FROM api_keys ORDER BY key_name'
    );
    res.json({ success: true, apiKeys: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch API keys' });
  }
});

// Create or update a key (superadmin only)
//router.put('/:keyName', requireAuth, requireRole('superadmin'), async (req, res) => {
  router.put('/:keyName', requireAuth, requirePermission('api-keys'), async (req, res) => {
  try {
    const { keyName } = req.params;
    const { value } = req.body;

    if (!value) {
      return res.status(400).json({ success: false, error: 'Value is required' });
    }

    const { encryptedValue, iv } = encrypt(value);

    const result = await pool.query(
      `INSERT INTO api_keys (key_name, encrypted_value, iv, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (key_name)
       DO UPDATE SET encrypted_value = $2, iv = $3, updated_by = $4, updated_at = NOW()
       RETURNING id, key_name, updated_at`,
      [keyName, encryptedValue, iv, req.user.id]
    );

    res.json({ success: true, apiKey: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save API key' });
  }
});





router.get('/:keyName/reveal', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT encrypted_value, iv FROM api_keys WHERE key_name = $1',
      [req.params.keyName]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Key not found' });
    }
    const { encrypted_value, iv } = result.rows[0];
    const value = decrypt(encrypted_value, iv);
    res.json({ success: true, value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not reveal key' });
  }
});

//router.delete('/:keyName', requireAuth, requireRole('superadmin'), async (req, res) => {
  router.delete('/:keyName', requireAuth, requirePermission('api-keys'), async (req, res) => {
  try {
    await pool.query('DELETE FROM api_keys WHERE key_name = $1', [req.params.keyName]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete key' });
  }
});
export default router;