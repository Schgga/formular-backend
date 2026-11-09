// Routes/analyticsTrack.routes.js
import { Router } from 'express';
import { pool } from '../db.js';
import crypto from 'crypto';

const router = Router();

// Served as a static JS snippet — sites embed <script src=".../analytics.js?id=WEBSITE_ID"></script>
router.get('/analytics.js', (req, res) => {
  res.type('application/javascript');
  res.send(`
(function() {
  var websiteId = document.currentScript.src.split('id=')[1];
  if (!websiteId) return;
  fetch('${process.env.PUBLIC_API_URL || ''}/api/analytics/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      websiteId: websiteId,
      pageUrl: window.location.pathname,
      referrer: document.referrer || null
    }),
    keepalive: true
  }).catch(function(){});
})();
  `.trim());
});

router.post('/track', async (req, res) => {
  try {
    const { websiteId, pageUrl, referrer } = req.body;
    if (!websiteId) return res.status(400).json({ success: false });

    const userAgent = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
    const visitorHash = crypto.createHash('sha256').update(ip + userAgent).digest('hex').slice(0, 16);

    await pool.query(
      `INSERT INTO site_page_views (website_id, page_url, referrer, user_agent, visitor_hash) VALUES ($1,$2,$3,$4,$5)`,
      [websiteId, pageUrl || '/', referrer || null, userAgent.slice(0, 500), visitorHash]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

export default router;