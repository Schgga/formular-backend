import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db.js';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requireRole } from '../Middleware/role.middleware.js';
import { uploadImageBuffer } from '../Services/cloudinary/cloudinaryService.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/tutorials/upload-thumbnail', requireAuth, requireRole('admin', 'superadmin'), upload.single('thumbnail'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const result = await uploadImageBuffer(req.file.buffer, 'tutorials');
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not upload thumbnail' });
  }
});

router.post('/tutorials', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { title, category, duration, videoUrl, pageKey, thumbnailUrl } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, error: 'Title is required' });
    const result = await pool.query(
      `INSERT INTO tutorials (id, title, category, duration, video_url, page_key, thumbnail_url)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING *`,
      [title.trim(), category || null, duration || null, videoUrl || null, pageKey || null, thumbnailUrl || null]
    );
    res.status(201).json({ success: true, tutorial: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'That page already has a tutorial assigned' });
    res.status(500).json({ success: false, error: 'Could not create tutorial' });
  }
});

router.put('/tutorials/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { title, category, duration, videoUrl, pageKey, thumbnailUrl } = req.body;
    const result = await pool.query(
      `UPDATE tutorials SET title = $1, category = $2, duration = $3, video_url = $4, page_key = $5, thumbnail_url = $6 WHERE id = $7 RETURNING *`,
      [title, category || null, duration || null, videoUrl || null, pageKey || null, thumbnailUrl || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Tutorial not found' });
    res.json({ success: true, tutorial: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'That page already has a tutorial assigned' });
    res.status(500).json({ success: false, error: 'Could not update tutorial' });
  }
});

router.delete('/tutorials/:id', requireAuth, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM tutorials WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not delete tutorial' });
  }
});

export default router;