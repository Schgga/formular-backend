// =====================================================================
// Wallet helpers shared by Studio sessions, the Video Planner and billing.
// Every amount here is worked out on the SERVER. Nothing the browser sends
// is ever used as a price, a number of seconds or an amount.
// =====================================================================

export class OutOfFundsError extends Error {
  constructor(balance = 0) {
    super('Insufficient balance');
    this.outOfFunds = true;
    this.balance = balance;
  }
}

// Paid plan or not. No subscription row = free plan (old code treated it as premium).
export async function isPremiumUser(db, userId) {
  try {
    const r = await db.query(
      `SELECT sp.plan_key FROM user_subscriptions us
       JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.user_id = $1 LIMIT 1`,
      [userId]
    );
    const key = r.rows[0]?.plan_key;
    return Boolean(key) && key !== 'free';
  } catch {
    return false;
  }
}

// Per-second (or per-item) price from the pricing table, or null if not set up
export async function getPrice(db, serviceKey, premium) {
  const r = await db.query(
    `SELECT service_key, free_price_usd_cents, premium_price_usd_cents
     FROM pricing WHERE service_key = $1 AND is_active = true LIMIT 1`,
    [serviceKey]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const value = Number(premium ? row.premium_price_usd_cents : row.free_price_usd_cents);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export async function getBalance(db, userId) {
  const r = await db.query('SELECT balance_usd_cents FROM wallets WHERE user_id = $1', [userId]);
  return r.rows.length ? Number(r.rows[0].balance_usd_cents) : null;
}

// Take money out. Must be called inside a transaction (BEGIN ... COMMIT) on `client`.
export async function debit(client, userId, cents, serviceKey, description) {
  const amount = Math.ceil(Number(cents));
  if (!Number.isInteger(amount) || amount < 0) throw new Error('Bad debit amount');
  const w = await client.query('SELECT id, balance_usd_cents FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  if (!w.rows.length) throw new OutOfFundsError(0);
  const balance = Number(w.rows[0].balance_usd_cents);
  if (balance < amount) throw new OutOfFundsError(balance);
  if (amount > 0) {
    await client.query('UPDATE wallets SET balance_usd_cents = balance_usd_cents - $1, updated_at = NOW() WHERE id = $2', [amount, w.rows[0].id]);
    await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_usd_cents, service_key, description)
       VALUES ($1, 'debit', $2, $3, $4)`,
      [w.rows[0].id, amount, serviceKey, String(description).slice(0, 250)]
    );
  }
  return { charged: amount, balance: balance - amount };
}

// Give money back (unused Studio time, a failed AI script). Inside a transaction.
export async function credit(client, userId, cents, serviceKey, description) {
  const amount = Math.floor(Number(cents));
  if (!Number.isInteger(amount) || amount <= 0) return { credited: 0 };
  const w = await client.query('SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  if (!w.rows.length) return { credited: 0 };
  await client.query('UPDATE wallets SET balance_usd_cents = balance_usd_cents + $1, updated_at = NOW() WHERE id = $2', [amount, w.rows[0].id]);
  await client.query(
    `INSERT INTO wallet_transactions (wallet_id, type, amount_usd_cents, service_key, description)
     VALUES ($1, 'credit', $2, $3, $4)`,
    [w.rows[0].id, amount, serviceKey, String(description).slice(0, 250)]
  );
  return { credited: amount };
}

// Run fn(client) in one transaction
export async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// Tiny in-memory limiter: max `limit` hits per `windowMs` for a key.
// (Resets when the server restarts — fine for stopping hammering.)
export function makeLimiter(limit, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const cut = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => t > cut);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }, Math.min(windowMs, 60_000)).unref?.();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => t > now - windowMs);
    if (arr.length >= limit) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}