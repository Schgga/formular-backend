import { pool } from '../../db.js';

const CURRENCY_API_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';

export async function refreshCurrencyRates() {
  const response = await fetch(CURRENCY_API_URL);
  if (!response.ok) {
    throw new Error(`Currency API failed: ${response.status}`);
  }

  const data = await response.json();
  const rates = data.usd; // { eur: 0.86, ngn: 1530.5, gbp: 0.73, ... } - lowercase keys

  let count = 0;
  for (const [code, rate] of Object.entries(rates)) {
    // Skip malformed/non-standard codes (this dataset includes some crypto & odd entries)
    if (!/^[a-z]{3}$/.test(code)) continue;

    await pool.query(
      `INSERT INTO currency_rates (currency_code, rate_to_usd, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (currency_code)
       DO UPDATE SET rate_to_usd = $2, updated_at = NOW()`,
      [code.toUpperCase(), rate]
    );
    count++;
  }

  return count;
}

export async function getAllRates() {
  const result = await pool.query('SELECT currency_code, rate_to_usd FROM currency_rates ORDER BY currency_code');
  return result.rows;
}