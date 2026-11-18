'use strict';

let uploadSingleImageMiddleware = null;
let uploadAvatarImageMiddleware = null;

try {
  const multer = require('multer');
  const { storage, avatarStorage } = require('../config/cloudinary');
  const fileFilter = (_req, file, cb) => {
    if (!file?.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Please select a valid image file (JPG, PNG, or WEBP).'));
    }
    cb(null, true);
  };

  uploadSingleImageMiddleware = multer({
    storage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter,
  }).single('image');

  uploadAvatarImageMiddleware = multer({
    storage: avatarStorage || storage,
    limits: { fileSize: 6 * 1024 * 1024 },
    fileFilter,
  }).single('image');
} catch (err) {
  console.warn('[imageUpload] Cloudinary upload unavailable, URL inputs remain active:', err.message);
}

function createUploadHandler(middleware) {
  return (req, res) => {
    if (!middleware) {
      return res.status(503).json({
        success: false,
        error: 'Image upload service unavailable; please try again later.',
      });
    }
    middleware(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, error: err.message || 'Image upload failed' });
      }
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No image file provided' });
      }
      res.json({ success: true, url: req.file.path });
    });
  };
}

const handleSingleImageUpload = createUploadHandler(uploadSingleImageMiddleware);
const handleAvatarUpload = createUploadHandler(uploadAvatarImageMiddleware);

module.exports = { handleSingleImageUpload, handleAvatarUpload };
