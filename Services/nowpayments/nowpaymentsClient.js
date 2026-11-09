import { getDecryptedApiKey } from '../../Utils/encryption.js';

const NOWPAYMENTS_URL = 'https://api.nowpayments.io/v1';

export async function createNowPayment({ amountUsd, payCurrency, orderId, ipnCallbackUrl }) {
  const apiKey = await getDecryptedApiKey('nowpayments_api_key');

  const response = await fetch(`${NOWPAYMENTS_URL}/payment`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      price_amount: amountUsd,
      price_currency: 'usd',
      pay_currency: payCurrency,
      order_id: orderId,
      ipn_callback_url: ipnCallbackUrl
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`NOWPayments error: ${response.status} - ${errText}`);
  }

  return response.json();
}

export async function getAvailableCurrencies() {
  const apiKey = await getDecryptedApiKey('nowpayments_api_key');
  const response = await fetch(`${NOWPAYMENTS_URL}/currencies`, {
    headers: { 'x-api-key': apiKey }
  });
  return response.json();
}