import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { requireAuth } from '../Middleware/auth.middleware.js';
import { requirePermission } from '../Middleware/permission.middleware.js';

// Preset Studio backgrounds.
// Safety: only real JPG / PNG / WEBP pictures are kept, file names are cleaned so
// nobody can write or delete files outside public/backgrounds, max 5 MB.

const router = Router();
const DIR = path.resolve('public/backgrounds');
const OK_EXT = /\.(jpe?g|png|webp)$/i;

function safeName(original) {
  const base = path.basename(String(original || ''))
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 60) || 'background';
  return base;
}

// Look at the first bytes of the file: is it really a picture?
function detectImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

router.get('/', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(DIR).filter((f) => OK_EXT.test(f));
    const backgrounds = files.map((filename) => ({
      filename,
      url: `/public/backgrounds/${encodeURIComponent(filename)}`,
      label: filename
        .replace(/\.[^/.]+$/, '')
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
    }));
    res.json({ success: true, backgrounds });
  } catch {
    res.json({ success: true, backgrounds: [] }); // folder empty/missing is fine
  }
});

// Keep the upload in memory first, check it, then write it ourselves
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype))
});

router.post('/', requireAuth, requirePermission('backgrounds'), (req, res) => {
  upload.single('background')(req, res, (uploadErr) => {
    if (uploadErr) {
      const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ success: false, error: tooBig ? 'Picture is larger than 5 MB' : 'Upload failed' });
    }
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'Please choose a JPG, PNG or WEBP picture' });
      const kind = detectImage(req.file.buffer);
      if (!kind) return res.status(400).json({ success: false, error: 'That file is not a real JPG, PNG or WEBP picture' });

      fs.mkdirSync(DIR, { recursive: true });
      let name = `${safeName(req.file.originalname)}.${kind}`;
      let n = 2;
      while (fs.existsSync(path.join(DIR, name))) name = `${safeName(req.file.originalname)}-${n++}.${kind}`;
      fs.writeFileSync(path.join(DIR, name), req.file.buffer, { flag: 'wx' });
      res.json({ success: true, filename: name });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Could not save the picture' });
    }
  });
});

router.delete('/:filename', requireAuth, requirePermission('backgrounds'), (req, res) => {
  try {
    const name = path.basename(String(req.params.filename || ''));
    if (!OK_EXT.test(name) || name !== req.params.filename) {
      return res.status(400).json({ success: false, error: 'Invalid file name' });
    }
    const full = path.join(DIR, name);
    if (path.dirname(full) !== DIR) return res.status(400).json({ success: false, error: 'Invalid file name' });
    fs.unlinkSync(full);
    res.json({ success: true });
  } catch {
    res.status(404).json({ success: false, error: 'File not found' });
  }
});

export default router;