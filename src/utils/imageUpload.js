'use strict';

let uploadSingleImageMiddleware = null;

try {
  const multer = require('multer');
  const { storage } = require('../config/cloudinary');
  uploadSingleImageMiddleware = multer({ storage }).single('image');
} catch (err) {
  console.warn('[imageUpload] Cloudinary upload unavailable, URL inputs remain active:', err.message);
}

function handleSingleImageUpload(req, res) {
  if (!uploadSingleImageMiddleware) {
    return res.status(503).json({
      success: false,
      error: 'Image upload service unavailable; please paste an image URL.',
    });
  }
  uploadSingleImageMiddleware(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message || 'Image upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file provided' });
    }
    res.json({ success: true, url: req.file.path });
  });
}

module.exports = { handleSingleImageUpload };
