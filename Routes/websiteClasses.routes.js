import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';

const router = Router();

// Public (logged-in users need this to browse)
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM website_classes ORDER BY name');

    const classesWithTags = await Promise.all(
      result.rows.map(async (cls) => {
        const tags = await pool.query(
          `SELECT ct.id, ct.name, ct.color FROM class_tag_map ctm
           JOIN catalog_tags ct ON ct.id = ctm.tag_id
           WHERE ctm.class_id = $1`,
          [cls.id]
        );
        return { ...cls, tags: tags.rows };
      })
    );

    res.json({ success: true, classes: classesWithTags });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not fetch classes' });
  }
});

// Superadmin only - create
router.post('/', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const { name, description, imageUrl, tagIds, requiresBankingFields, requiresDesignKey } = req.body;
if (!name) return res.status(400).json({ success: false, error: 'Name is required' });

const result = await pool.query(
  `INSERT INTO website_classes (name, description, image_url, created_by, requires_banking_fields, requires_design_key)
   VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
  [name, description || null, imageUrl || null, req.user.id, requiresBankingFields || false, requiresDesignKey || false]
);
    const cls = result.rows[0];

    for (const tagId of (tagIds || [])) {
      await pool.query('INSERT INTO class_tag_map (class_id, tag_id) VALUES ($1, $2)', [cls.id, tagId]);
    }

    res.status(201).json({ success: true, class: cls });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'A class with that name already exists' });
    res.status(500).json({ success: false, error: 'Could not create class' });
  }
});

router.put('/:id', requireAuth, requirePermission('website-classes'), async (req, res) => {
  try {
    const { name, description, imageUrl, tagIds, requiresBankingFields, requiresDesignKey } = req.body;
const result = await pool.query(
  'UPDATE website_classes SET name = COALESCE($1, name), description = COALESCE($2, description), image_url = COALESCE($3, image_url), requires_banking_fields = COALESCE($4, requires_banking_fields), requires_design_key = COALESCE($5, requires_design_key), updated_at = NOW() WHERE id = $6 RETURNING *',
  [name, description, imageUrl, requiresBankingFields, requiresDesignKey, req.params.id]
);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Class not found' });

    if (tagIds) {
      await pool.query('DELETE FROM class_tag_map WHERE class_id = $1', [req.params.id]);
      for (const tagId of tagIds) {
        await pool.query('INSERT INTO class_tag_map (class_id, tag_id) VALUES ($1, $2)', [req.params.id, tagId]);
      }
    }

    res.json({ success: true, class: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not update class' });
  }
});

router.delete('/:id', requireAuth, requirePermission('website-classes'), async (req, res) => {
  try {
    const inUse = await pool.query('SELECT id FROM website_catalog WHERE class_id = $1 LIMIT 1', [req.params.id]);
    if (inUse.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Cannot delete — this class has templates in it. Remove them first.' });
    }
    await pool.query('DELETE FROM website_classes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete class' });
  }
});

export default router;