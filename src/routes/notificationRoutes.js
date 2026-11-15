const express = require('express');
const router = express.Router();
const {
  getNotifications,
  markAsRead,
  markAllAsRead
} = require('../controllers/notificationController');
const { auth } = require('../middleware/auth');

// All notification routes require authentication
router.use(auth);

// Get user notifications
router.get('/', getNotifications);

// Mark specific notification as read
router.patch('/:notification_id/read', markAsRead);

// Mark all notifications as read
router.patch('/mark-all/read', markAllAsRead);

module.exports = router;
