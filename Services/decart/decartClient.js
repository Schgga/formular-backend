import { createDecartClient } from '@decartai/sdk';
import { getDecryptedApiKey } from '../../Utils/encryption.js';

let cachedClient = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // re-fetch key from DB every 5 minutes, in case superadmin rotates it

export async function getDecartClient() {
  const now = Date.now();

  if (cachedClient && now - cachedAt < CACHE_TTL_MS) {
    return cachedClient;
  }

  const apiKey = await getDecryptedApiKey('decart_api_key');
  cachedClient = createDecartClient({ apiKey });
  cachedAt = now;

  return cachedClient;
}