import crypto from 'crypto';
import { pool } from '../db.js';

const ALGORITHM = 'aes-256-cbc';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

export function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { encryptedValue: encrypted, iv: iv.toString('hex') };
}

export function decrypt(encryptedValue, ivHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  let decrypted = decipher.update(encryptedValue, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export async function getDecryptedApiKey(keyName) {
  const result = await pool.query(
    'SELECT encrypted_value, iv FROM api_keys WHERE key_name = $1',
    [keyName]
  );

  if (result.rows.length === 0) {
    throw new Error(`API key "${keyName}" is not configured`);
  }

  const { encrypted_value, iv } = result.rows[0];
  return decrypt(encrypted_value, iv);
}