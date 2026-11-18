const express = require('express');
const router = express.Router();
const {
  register,
  login,
  getCurrentUser,
  verifyEmail,
  verifyEmailLink,
  resendVerification,
} = require('../controllers/authController');
const { auth } = require('../middleware/auth');
const { handleAvatarUpload } = require('../utils/imageUpload');

router.post('/upload-avatar', handleAvatarUpload);
router.post('/register', register);
router.post('/verify-email', verifyEmail);
router.get('/verify-email', verifyEmailLink);
router.post('/resend-verification', resendVerification);
router.post('/login', login);
router.get('/me', auth, getCurrentUser);

module.exports = router;
