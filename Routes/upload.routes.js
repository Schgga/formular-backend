import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { uploadImageBuffer } from '../Services/cloudinary/cloudinaryService.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const ok = allowed.test(file.mimetype.split('/')[1]);
    cb(ok ? null : new Error('Only JPG, PNG, and WebP images are allowed'), ok);
  }
});

// Website logos
router.post('/logo', requireAuth, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const result = await uploadImageBuffer(req.file.buffer, 'websites/logos');
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload failed:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// Studio backgrounds (user-uploaded, not the admin preset ones)
router.post('/studio-background', requireAuth, upload.single('background'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const result = await uploadImageBuffer(req.file.buffer, 'studio/backgrounds');
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload failed:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// Studio character/avatar reference images
router.post('/studio-character', requireAuth, upload.single('character'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const result = await uploadImageBuffer(req.file.buffer, 'studio/characters');
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload failed:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// Site-wide branding (superadmin only, since this affects the whole platform)
router.post('/site-logo', requireAuth, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const result = await uploadImageBuffer(req.file.buffer, 'settings/site-logo');
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload failed:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});


// Site favicon (superadmin only)
router.post('/favicon', requireAuth, upload.single('favicon'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const result = await uploadImageBuffer(req.file.buffer, 'settings/favicon');
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload failed:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// Site footer logo (superadmin only)
router.post('/footer-logo', requireAuth, upload.single('footerLogo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const result = await uploadImageBuffer(req.file.buffer, 'settings/footer-logo');
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload failed:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});


router.post('/catalog-image', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const result = await uploadImageBuffer(req.file.buffer, 'websites/catalog');
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary upload failed:', err);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

export default router;