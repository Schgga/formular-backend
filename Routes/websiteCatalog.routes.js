import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';


const router = Router();

// Public - browse catalog by class
router.get('/', requireAuth, async (req, res) => {
  try {
    const { classId } = req.query;
    const query = classId
      ? 'SELECT * FROM website_catalog WHERE class_id = $1 AND is_active = true ORDER BY name'
      : 'SELECT * FROM website_catalog WHERE is_active = true ORDER BY name';
    const params = classId ? [classId] : [];

    const result = await pool.query(query, params);

    const catalogFull = await Promise.all(
      result.rows.map(async (entry) => {
        const domains = await pool.query(
          `SELECT md.id, md.domain FROM catalog_domains cd
           JOIN managed_domains md ON md.id = cd.managed_domain_id
           WHERE cd.catalog_id = $1 AND md.is_active = true`,
          [entry.id]
        );
        const tags = await pool.query(
          `SELECT ct.id, ct.name, ct.color FROM catalog_tag_map ctm
           JOIN catalog_tags ct ON ct.id = ctm.tag_id
           WHERE ctm.catalog_id = $1`,
          [entry.id]
        );
        return { ...entry, domains: domains.rows, tags: tags.rows };
      })
    );

    res.json({ success: true, catalog: catalogFull });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch catalog' });
  }
});

// Admin/Superadmin - add a catalog entry
router.post('/', requireAuth, requirePermission('website-catalog'), async (req, res) => {
  try {
    const { classId, name, description, provisionEndpoint, provisionApiKeyName, requiresBackend, domainIds, sampleImageUrl, sampleUrl, tagIds, hasSupportPage, designKey } = req.body;

if (!classId || !name || !provisionEndpoint || !provisionApiKeyName || !domainIds?.length) {
  return res.status(400).json({ success: false, error: 'Missing required fields, including at least one domain' });
}

const result = await pool.query(
  `INSERT INTO website_catalog
   (class_id, name, description, provision_endpoint, provision_api_key_name, base_domain, requires_backend, sample_image_url, sample_url, created_by, has_support_page, design_key)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
   RETURNING *`,
  [classId, name, description || null, provisionEndpoint, provisionApiKeyName, 'multiple', requiresBackend !== false, sampleImageUrl || null, sampleUrl || null, req.user.id, hasSupportPage || false, designKey || null]
);
    const catalogEntry = result.rows[0];

    for (const domainId of domainIds) {
      await pool.query('INSERT INTO catalog_domains (catalog_id, managed_domain_id) VALUES ($1, $2)', [catalogEntry.id, domainId]);
    }
    for (const tagId of (tagIds || [])) {
      await pool.query('INSERT INTO catalog_tag_map (catalog_id, tag_id) VALUES ($1, $2)', [catalogEntry.id, tagId]);
    }

    res.status(201).json({ success: true, catalogEntry });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create catalog entry' });
  }
});



router.put('/:id', requireAuth, requirePermission('website-catalog'), async (req, res) => {
  try {
    const { name, description, provisionEndpoint, provisionApiKeyName, isActive, domainIds, sampleImageUrl, sampleUrl, tagIds, hasSupportPage, designKey } = req.body;

const result = await pool.query(
  `UPDATE website_catalog SET
     name = COALESCE($1, name), description = COALESCE($2, description),
     provision_endpoint = COALESCE($3, provision_endpoint),
     provision_api_key_name = COALESCE($4, provision_api_key_name),
     is_active = COALESCE($5, is_active),
     sample_image_url = COALESCE($6, sample_image_url),
     sample_url = COALESCE($7, sample_url),
     has_support_page = COALESCE($8, has_support_page),
     design_key = COALESCE($9, design_key),
     updated_at = NOW()
   WHERE id = $10 RETURNING *`,
  [name, description, provisionEndpoint, provisionApiKeyName, isActive, sampleImageUrl, sampleUrl, hasSupportPage, designKey, req.params.id]
);

    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Template not found' });

    if (domainIds) {
      await pool.query('DELETE FROM catalog_domains WHERE catalog_id = $1', [req.params.id]);
      for (const domainId of domainIds) {
        await pool.query('INSERT INTO catalog_domains (catalog_id, managed_domain_id) VALUES ($1, $2)', [req.params.id, domainId]);
      }
    }

    if (tagIds) {
      await pool.query('DELETE FROM catalog_tag_map WHERE catalog_id = $1', [req.params.id]);
      for (const tagId of tagIds) {
        await pool.query('INSERT INTO catalog_tag_map (catalog_id, tag_id) VALUES ($1, $2)', [req.params.id, tagId]);
      }
    }

    res.json({ success: true, catalogEntry: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update template' });
  }
});

router.delete('/:id', requireAuth, requirePermission('website-catalog'), async (req, res) => {
  try {
    await pool.query('UPDATE website_catalog SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete template' });
  }
});


// List all available tags
router.get('/tags', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM catalog_tags ORDER BY name');
  res.json({ success: true, tags: result.rows });
});

// Create a new tag (admin/superadmin)
router.post('/tags', requireAuth, requirePermission('website-catalog'), async (req, res) => {
  try {
    const { name, color } = req.body;
    const result = await pool.query(
      'INSERT INTO catalog_tags (name, color) VALUES ($1, $2) RETURNING *',
      [name, color || '#a1854a']
    );
    res.status(201).json({ success: true, tag: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'That tag already exists' });
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create tag' });
  }
});


router.put('/tags/:id', requireAuth, requirePermission('website-catalog'), async (req, res) => {
  try {
    const { name, color } = req.body;
    const result = await pool.query(
      'UPDATE catalog_tags SET name = COALESCE($1, name), color = COALESCE($2, color) WHERE id = $3 RETURNING *',
      [name, color, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Tag not found' });
    res.json({ success: true, tag: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'A tag with that name already exists' });
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update tag' });
  }
});

router.delete('/tags/:id', requireAuth, requirePermission('website-catalog'), async (req, res) => {
  try {
    await pool.query('DELETE FROM catalog_tags WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete tag' });
  }
});



export default router;