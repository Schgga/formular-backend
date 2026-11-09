import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';

// =====================================================================
// NEAR ME DIRECTORY
//   Owner (logged in):  GET  /api/directory/mine
//                       PUT  /api/directory/listing/:websiteId
//   Public (no login):  GET  /api/directory/search?q=&lat=&lng=&radiusKm=&category=
//                       GET  /api/directory/categories
//                       GET  /api/directory/geocode?q=
//                       POST /api/directory/track/:listingId   { type }
// =====================================================================

const router = Router();

export const DIRECTORY_CATEGORIES = [
  'Hotel & Lodging', 'Restaurant & Food', 'Salon & Beauty', 'Shop & Retail', 'Fashion',
  'Real Estate', 'Health & Clinic', 'Education & Training', 'Engineering & Construction',
  'Consulting & Legal', 'Technology', 'Logistics & Transport', 'Events & Entertainment',
  'Auto & Mechanic', 'Home Services', 'Church & Community', 'NGO & Charity', 'Other'
];

const TRACK_TYPES = {
  call: 'call_clicks',
  whatsapp: 'whatsapp_clicks',
  directions: 'direction_clicks',
  website: 'website_clicks'
};

const clean = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
};

// ---------------------------------------------------------------------
// Geocoding (address → map point) with OpenStreetMap Nominatim.
// Free, no key. Their rules: max 1 request per second and a real User-Agent,
// so requests are queued and results cached in memory.
// ---------------------------------------------------------------------
const geoCache = new Map();
let geoChain = Promise.resolve();
const GEO_UA = process.env.GEOCODER_USER_AGENT || 'Formular-NearMe/1.0 (support@formular.app)';

function geocode(query) {
  const key = query.trim().toLowerCase();
  if (!key) return Promise.resolve(null);
  if (geoCache.has(key)) return Promise.resolve(geoCache.get(key));
  const job = geoChain.then(async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { 'User-Agent': GEO_UA, 'Accept-Language': 'en' } });
      if (!res.ok) return null;
      const rows = await res.json();
      const r = rows[0];
      const out = r ? {
        lat: Number(r.lat),
        lng: Number(r.lon),
        label: r.display_name,
        city: r.address?.city || r.address?.town || r.address?.village || r.address?.county || null,
        region: r.address?.state || null,
        country: r.address?.country || null
      } : null;
      geoCache.set(key, out);
      if (geoCache.size > 2000) geoCache.delete(geoCache.keys().next().value);
      return out;
    } catch (err) {
      console.error('Geocode failed:', err.message);
      return null;
    } finally {
      await new Promise((r) => setTimeout(r, 1100)); // stay under 1 request per second
    }
  });
  geoChain = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------------
// Owner: my websites + their listing
// ---------------------------------------------------------------------
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT uw.id AS website_id, uw.business_name, uw.description, uw.logo_url, uw.site_url, uw.status,
              uw.support_phone, uw.support_whatsapp, uw.support_email, wcl.name AS class_name,
              dl.id AS listing_id, dl.is_listed, dl.category, dl.short_description, dl.address, dl.city, dl.region,
              dl.country, dl.lat, dl.lng, dl.phone, dl.whatsapp, dl.email, dl.opening_hours,
              dl.impressions, dl.call_clicks, dl.whatsapp_clicks, dl.direction_clicks, dl.website_clicks
       FROM user_websites uw
       JOIN website_catalog wc ON wc.id = uw.catalog_id
       JOIN website_classes wcl ON wcl.id = wc.class_id
       LEFT JOIN directory_listings dl ON dl.website_id = uw.id
       WHERE uw.user_id = $1 AND uw.deleted_at IS NULL
       ORDER BY uw.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, websites: result.rows, categories: DIRECTORY_CATEGORIES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load your listings' });
  }
});

// ---------------------------------------------------------------------
// Owner: create or update a website's listing
// ---------------------------------------------------------------------
router.put('/listing/:websiteId', requireAuth, async (req, res) => {
  try {
    const own = await pool.query(
      'SELECT id, status FROM user_websites WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [req.params.websiteId, req.user.id]
    );
    if (own.rows.length === 0) return res.status(404).json({ success: false, error: 'Website not found' });

    const b = req.body || {};
    const isListed = !!b.isListed;
    const category = DIRECTORY_CATEGORIES.includes(b.category) ? b.category : 'Other';
    const address = clean(b.address, 300);
    let city = clean(b.city, 120);
    let region = clean(b.region, 120);
    let country = clean(b.country, 80);
    let lat = b.lat === '' || b.lat === null || b.lat === undefined ? null : Number(b.lat);
    let lng = b.lng === '' || b.lng === null || b.lng === undefined ? null : Number(b.lng);
    const email = clean(b.email, 190);

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: 'Please check the email address' });
    }
    if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
      return res.status(400).json({ success: false, error: 'The map location is not valid' });
    }

    // No map point given (or "find it for me" was asked): look the address up.
    if ((lat === null || lng === null || b.regeocode) && (address || city)) {
      const found = await geocode([address, city, region, country].filter(Boolean).join(', '));
      if (found) {
        lat = found.lat; lng = found.lng;
        city = city || found.city; region = region || found.region; country = country || found.country;
      }
    }

    if (isListed && (lat === null || lng === null)) {
      return res.status(400).json({
        success: false,
        error: 'We could not find that address on the map. Check the address and city, or tap "Use my current location" while at the business.'
      });
    }
    if (isListed && own.rows[0].status !== 'active') {
      return res.status(400).json({ success: false, error: 'Only active websites can be shown on the map. Activate the website first.' });
    }

    const result = await pool.query(
      `INSERT INTO directory_listings
         (website_id, is_listed, category, short_description, address, city, region, country, lat, lng, phone, whatsapp, email, opening_hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (website_id) DO UPDATE SET
         is_listed = EXCLUDED.is_listed, category = EXCLUDED.category, short_description = EXCLUDED.short_description,
         address = EXCLUDED.address, city = EXCLUDED.city, region = EXCLUDED.region, country = EXCLUDED.country,
         lat = EXCLUDED.lat, lng = EXCLUDED.lng, phone = EXCLUDED.phone, whatsapp = EXCLUDED.whatsapp,
         email = EXCLUDED.email, opening_hours = EXCLUDED.opening_hours, updated_at = NOW()
       RETURNING *`,
      [req.params.websiteId, isListed, category, clean(b.shortDescription, 300), address, city, region, country,
       lat, lng, clean(b.phone, 40), clean(b.whatsapp, 40), email, clean(b.openingHours, 160)]
    );
    res.json({ success: true, listing: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not save your listing' });
  }
});

// ---------------------------------------------------------------------
// Public: categories (with how many businesses are listed in each)
// ---------------------------------------------------------------------
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dl.category, COUNT(*)::int AS count
       FROM directory_listings dl JOIN user_websites uw ON uw.id = dl.website_id
       WHERE dl.is_listed AND uw.deleted_at IS NULL AND uw.status = 'active'
       GROUP BY dl.category`
    );
    const counts = Object.fromEntries(result.rows.map((r) => [r.category, r.count]));
    res.json({ success: true, categories: DIRECTORY_CATEGORIES.map((c) => ({ name: c, count: counts[c] || 0 })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not load categories' });
  }
});

// ---------------------------------------------------------------------
// Public: turn a typed place ("Ikeja, Lagos", "Manchester") into a map point
// ---------------------------------------------------------------------
router.get('/geocode', async (req, res) => {
  const q = clean(req.query.q, 200);
  if (!q) return res.status(400).json({ success: false, error: 'Type a city or area' });
  const found = await geocode(q);
  if (!found) return res.status(404).json({ success: false, error: 'We could not find that place. Try a nearby city name.' });
  res.json({ success: true, place: found });
});

// ---------------------------------------------------------------------
// Public: search businesses near a point
// ---------------------------------------------------------------------
router.get('/search', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ success: false, error: 'Choose your location first' });
    }
    const radiusKm = Math.min(Math.max(Number(req.query.radiusKm) || 10, 1), 200);
    const q = clean(req.query.q, 80);
    const category = DIRECTORY_CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 60);

    // Quick box around the point first (fast), then exact distance.
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));

    const params = [lat, lng, lat - dLat, lat + dLat, lng - dLng, lng + dLng, radiusKm, limit];
    let extra = '';
    if (category) { params.push(category); extra += ` AND dl.category = $${params.length}`; }
    if (q) {
      params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
      const p = `$${params.length}`;
      extra += ` AND (uw.business_name ILIKE ${p} OR dl.category ILIKE ${p} OR dl.short_description ILIKE ${p} OR uw.description ILIKE ${p} OR dl.city ILIKE ${p})`;
    }

    const result = await pool.query(
      `SELECT * FROM (
         SELECT dl.id AS listing_id, dl.website_id, uw.business_name, uw.logo_url, uw.site_url,
                COALESCE(dl.short_description, uw.description) AS description,
                dl.category, dl.address, dl.city, dl.region, dl.country, dl.lat, dl.lng,
                dl.phone, dl.whatsapp, dl.email, dl.opening_hours,
                6371 * 2 * ASIN(SQRT(
                  POWER(SIN(RADIANS(dl.lat - $1) / 2), 2) +
                  COS(RADIANS($1)) * COS(RADIANS(dl.lat)) * POWER(SIN(RADIANS(dl.lng - $2) / 2), 2)
                )) AS distance_km
         FROM directory_listings dl
         JOIN user_websites uw ON uw.id = dl.website_id
         WHERE dl.is_listed AND uw.deleted_at IS NULL AND uw.status = 'active'
           AND dl.lat BETWEEN $3 AND $4 AND dl.lng BETWEEN $5 AND $6 ${extra}
       ) x
       WHERE distance_km <= $7
       ORDER BY distance_km
       LIMIT $8`,
      params
    );

    if (result.rows.length) {
      await pool.query('UPDATE directory_listings SET impressions = impressions + 1 WHERE id = ANY($1)', [result.rows.map((r) => r.listing_id)]);
    }
    // Star ratings + review link (from Reviews Booster). Skipped quietly if it is not installed.
    const ratings = new Map();
    if (result.rows.length) {
      try {
        const rv = await pool.query(
          `SELECT rp.website_id, CASE WHEN rp.is_enabled THEN rp.code END AS review_code,
                  (SELECT COUNT(*)::int FROM reviews r WHERE r.website_id = rp.website_id AND NOT r.is_hidden) AS rating_count,
                  (SELECT ROUND(AVG(r.rating)::numeric, 1)::float FROM reviews r WHERE r.website_id = rp.website_id AND NOT r.is_hidden) AS rating
           FROM review_pages rp WHERE rp.website_id = ANY($1)`,
          [result.rows.map((r) => r.website_id)]
        );
        rv.rows.forEach((r) => ratings.set(String(r.website_id), r));
      } catch { /* Reviews Booster not installed */ }
    }

    res.json({
      success: true,
      results: result.rows.map(({ website_id, ...r }) => {
        const rv = ratings.get(String(website_id));
        return {
          ...r,
          distance_km: Math.round(r.distance_km * 10) / 10,
          rating: rv?.rating ?? null,
          rating_count: rv?.rating_count ?? 0,
          review_code: rv?.review_code ?? null
        };
      })
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Search failed. Please try again.' });
  }
});

// ---------------------------------------------------------------------
// Public: count a button tap (Call / WhatsApp / Directions / Website)
// ---------------------------------------------------------------------
router.post('/track/:listingId', async (req, res) => {
  const col = TRACK_TYPES[req.body?.type];
  if (!col) return res.status(400).json({ success: false });
  try {
    await pool.query(`UPDATE directory_listings SET ${col} = ${col} + 1 WHERE id = $1 AND is_listed`, [req.params.listingId]);
    res.json({ success: true });
  } catch {
    res.json({ success: false });
  }
});

export default router;