import { pool } from '../../db.js';
import { encrypt, decrypt } from '../../Utils/encryption.js';

// AI writers set up by the super admin. Keys are stored encrypted (same
// encryption as your API Keys page) and are only decrypted at the moment of use.

export function sealKey(plain) {
  const value = String(plain || '').trim();
  const { encryptedValue, iv } = encrypt(value);
  return { encryptedValue, iv, last4: value.slice(-4) };
}

export function openKey(row) {
  if (!row?.encrypted_key || !row?.key_iv) return '';
  try { return decrypt(row.encrypted_key, row.key_iv); } catch { return ''; }
}

// What a normal user is allowed to see (no provider, no model, no key)
export async function listWritersForUser(premium) {
  const r = await pool.query(
    `SELECT id, display_name, description, price_usd_cents, premium_price_usd_cents, is_default
     FROM ai_writers WHERE is_active = true AND encrypted_key IS NOT NULL
     ORDER BY is_default DESC, sort_order, id`
  );
  return r.rows.map((w) => ({
    id: w.id,
    name: w.display_name,
    description: w.description || '',
    priceCents: Number(premium ? w.premium_price_usd_cents : w.price_usd_cents),
    isDefault: w.is_default
  }));
}

export async function getActiveWriter(id) {
  const r = await pool.query('SELECT * FROM ai_writers WHERE id = $1 AND is_active = true AND encrypted_key IS NOT NULL', [id]);
  return r.rows[0] || null;
}