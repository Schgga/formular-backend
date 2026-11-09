import crypto from 'crypto';
import { getDecryptedApiKey } from '../../Utils/encryption.js';

// Sorts keys alphabetically and re-stringifies, per NOWPayments' exact spec
function sortedStringify(obj) {
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj = {};
  sortedKeys.forEach((key) => { sortedObj[key] = obj[key]; });
  return JSON.stringify(sortedObj);
}

export async function verifyNowPaymentsSignature(body, signatureHeader) {
  if (!signatureHeader) return false;

  const ipnSecret = await getDecryptedApiKey('nowpayments_ipn_secret');
  const sortedBody = sortedStringify(body);

  const expectedSignature = crypto
    .createHmac('sha512', ipnSecret)
    .update(sortedBody)
    .digest('hex');

  return expectedSignature === signatureHeader;
}