import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

const router = Router();

// Confirms the requesting user actually owns this website before returning any data
async function verifyOwnership(websiteId, userId) {
  const result = await pool.query('SELECT id FROM user_websites WHERE id = $1 AND user_id = $2', [websiteId, userId]);
  return result.rows.length > 0;
}

router.get('/:websiteId/summary', requireAuth, async (req, res) => {
  try {
    const { websiteId } = req.params;
    if (!(await verifyOwnership(websiteId, req.user.id))) return res.status(403).json({ success: false, error: 'Not your site' });

    const totalsResult = await pool.query(
      `SELECT COUNT(*) AS total_views, COUNT(DISTINCT visitor_hash) AS unique_visitors
       FROM site_page_views WHERE website_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
      [websiteId]
    );
    const uptimeResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'up') AS up_count,
         COUNT(*) AS total_count,
         AVG(response_time_ms) FILTER (WHERE status = 'up') AS avg_response_ms
       FROM site_uptime_checks WHERE website_id = $1 AND checked_at > NOW() - INTERVAL '7 days'`,
      [websiteId]
    );

    const totals = totalsResult.rows[0];
    const uptime = uptimeResult.rows[0];
    const uptimePercent = uptime.total_count > 0 ? ((uptime.up_count / uptime.total_count) * 100).toFixed(2) : null;

    res.json({
      success: true,
      totalViews: Number(totals.total_views),
      uniqueVisitors: Number(totals.unique_visitors),
      uptimePercent: uptimePercent,
      avgResponseMs: uptime.avg_response_ms ? Math.round(uptime.avg_response_ms) : null,
      hasUptimeData: Number(uptime.total_count) > 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load summary' });
  }
});

router.get('/:websiteId/timeseries', requireAuth, async (req, res) => {
  try {
    const { websiteId } = req.params;
    if (!(await verifyOwnership(websiteId, req.user.id))) return res.status(403).json({ success: false, error: 'Not your site' });

    const result = await pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors
       FROM site_page_views WHERE website_id = $1 AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at) ORDER BY day ASC`,
      [websiteId]
    );
    res.json({ success: true, days: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load traffic trend' });
  }
});

router.get('/:websiteId/top-pages', requireAuth, async (req, res) => {
  try {
    const { websiteId } = req.params;
    if (!(await verifyOwnership(websiteId, req.user.id))) return res.status(403).json({ success: false, error: 'Not your site' });

    const result = await pool.query(
      `SELECT page_url, COUNT(*) AS views FROM site_page_views
       WHERE website_id = $1 AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY page_url ORDER BY views DESC LIMIT 10`,
      [websiteId]
    );
    res.json({ success: true, pages: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load top pages' });
  }
});

router.get('/:websiteId/referrers', requireAuth, async (req, res) => {
  try {
    const { websiteId } = req.params;
    if (!(await verifyOwnership(websiteId, req.user.id))) return res.status(403).json({ success: false, error: 'Not your site' });

    const result = await pool.query(
      `SELECT COALESCE(NULLIF(referrer, ''), 'Direct') AS source, COUNT(*) AS views
       FROM site_page_views WHERE website_id = $1 AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY source ORDER BY views DESC LIMIT 8`,
      [websiteId]
    );
    res.json({ success: true, referrers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load referrers' });
  }
});

export default router;