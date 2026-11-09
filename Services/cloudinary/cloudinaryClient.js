import { v2 as cloudinary } from 'cloudinary';
import { getDecryptedApiKey } from '../../Utils/encryption.js';

let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getCloudinaryClient() {
  const now = Date.now();

  if (now - cachedAt < CACHE_TTL_MS) {
    return cloudinary;
  }

  const [cloudName, apiKey, apiSecret] = await Promise.all([
    getDecryptedApiKey('cloudinary_cloud_name'),
    getDecryptedApiKey('cloudinary_api_key'),
    getDecryptedApiKey('cloudinary_api_secret')
  ]);

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true
  });

  cachedAt = now;
  return cloudinary;
}