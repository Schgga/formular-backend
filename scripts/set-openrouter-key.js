// Puts ONE OpenRouter API key on all your OpenRouter AI writers at once.
// The key is typed here in your terminal (hidden), encrypted the same way as the
// admin page does it, and saved. It is never written to a file or shown.
//
// Run from the backend folder:
//   node scripts/set-openrouter-key.js            → only writers that have no key yet
//   node scripts/set-openrouter-key.js --all      → replace the key on every OpenRouter writer
import readline from 'node:readline';
import dotenv from 'dotenv';

dotenv.config();
const { pool } = await import('../db.js');
const { sealKey } = await import('../Services/ai/writers.js');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted || s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

const all = process.argv.includes('--all');
const writers = (await pool.query(
  `SELECT id, display_name, model_name FROM ai_writers WHERE provider = 'openrouter' ${all ? '' : 'AND encrypted_key IS NULL'} ORDER BY sort_order, id`)).rows;
if (!writers.length) {
  const any = (await pool.query(`SELECT COUNT(*)::int AS n FROM ai_writers WHERE provider = 'openrouter'`)).rows[0].n;
  console.log(!any
    ? 'You have no OpenRouter writers yet. Run the writers SQL in pgAdmin first (or add one in the admin app), then run this again.'
    : 'Every OpenRouter writer already has a key. To replace it on all of them:  node scripts/set-openrouter-key.js --all');
  await pool.end();
  process.exit(0);
}
console.log(`This will set the key on ${writers.length} writer(s):`);
for (const w of writers) console.log(`  - ${w.display_name}  (${w.model_name})`);

const key = await askHidden('Paste your OpenRouter API key and press Enter: ');
if (!/^sk-or-[A-Za-z0-9_-]{20,}$/.test(key)) {
  console.log('That does not look like an OpenRouter key (it should start with "sk-or-"). Nothing was changed.');
  process.exit(1);
}
const sealed = sealKey(key);
await pool.query(
  `UPDATE ai_writers SET encrypted_key = $1, key_iv = $2, key_last4 = $3, last_test_ok = NULL, updated_at = NOW() WHERE id = ANY($4::int[])`,
  [sealed.encryptedValue, sealed.iv, sealed.last4, writers.map((w) => w.id)]);
console.log(`Done. Key ending in ${sealed.last4} saved on ${writers.length} writer(s).`);
console.log('Next: admin app → AI Writers → press "Test connection" on each one.');
await pool.end();