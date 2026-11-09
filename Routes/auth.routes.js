import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../Middleware/auth.middleware.js';

const router = Router();

router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    // Check if user already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Email already registered' });
    }

    // Hash the password (never store the real one)
    const passwordHash = await bcrypt.hash(password, 12);

   const result = await pool.query(
  `INSERT INTO users (email, password_hash, full_name)
   VALUES ($1, $2, $3)
   RETURNING id, email, full_name, role`,
  [email, passwordHash, fullName]
);

const newUser = result.rows[0];

// Every new user automatically gets a wallet, starting at $0
await pool.query(
  'INSERT INTO wallets (user_id, balance_usd_cents) VALUES ($1, 0)',
  [newUser.id]
);

res.status(201).json({ success: true, user: newUser });
    
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});



router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});



router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, message: 'You are authenticated!', user: req.user });
});

export default router;