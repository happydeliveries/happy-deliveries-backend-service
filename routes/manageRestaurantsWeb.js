'use strict';

const express = require('express');
const router = express.Router();
const db = require('../src/config/database');
const Restaurant = require('../src/models/Restaurant');
const EmailService = require('../src/utils/emailService');

function attachManageRestaurantRoutes(parentRouter, { isLoggedIn, isLoggedInApi, resolveManager }) {
  async function requirePlatformAdminPage(req, res) {
    const manager = await resolveManager(req);
    if (!manager || !Restaurant.isPlatformAdmin(manager)) {
      res.redirect('/manager/dashboard');
      return null;
    }
    return manager;
  }

  async function requirePlatformAdminApi(req, res) {
    const manager = await resolveManager(req);
    if (!manager) {
      res.status(403).json({ success: false, error: 'Manager profile not found' });
      return null;
    }
    if (!Restaurant.isPlatformAdmin(manager)) {
      res.status(403).json({ success: false, error: 'Platform administrator access required' });
      return null;
    }
    return manager;
  }

  // SSR Page: Manage Restaurants Portal (similar to /manager/drivers)
  router.get('/manage-restaurants', isLoggedIn, async (req, res) => {
    try {
      const admin = await requirePlatformAdminPage(req, res);
      if (!admin) return;

      res.render('manager/manage-restaurants', {
        title: 'Manage Restaurants',
        currentPage: 'manage-restaurants',
        manager: req.session.user,
      });
    } catch (err) {
      console.error('[GET /manager/manage-restaurants]', err);
      res.redirect('/manager/dashboard');
    }
  });

  // GET all restaurants & partner applications with stats
  router.get('/api/manage-restaurants', isLoggedInApi, async (req, res) => {
    try {
      const admin = await requirePlatformAdminApi(req, res);
      if (!admin) return;

      const { status, source, cuisine, search } = req.query;
      const [restaurants, stats] = await Promise.all([
        Restaurant.getAllForManager({ status, source, cuisine, search }),
        Restaurant.getManagerStats(),
      ]);

      res.json({ success: true, restaurants, stats });
    } catch (err) {
      console.error('[GET /manager/api/manage-restaurants]', err);
      res.status(500).json({ success: false, error: 'Failed to load restaurants list' });
    }
  });

  // GET single restaurant full dossier (with menus count & order breakdown)
  router.get('/api/manage-restaurants/:id', isLoggedInApi, async (req, res) => {
    try {
      const admin = await requirePlatformAdminApi(req, res);
      if (!admin) return;

      const restaurant = await Restaurant.findByIdWithOwner(req.params.id);
      if (!restaurant) {
        return res.status(404).json({ success: false, error: 'Restaurant application not found' });
      }

      const { rows: menus } = await db.query(
        `SELECT m.id, m.name, m.is_active,
                (SELECT COUNT(*)::int FROM menu_items mi WHERE mi.menu_id = m.id) AS item_count
         FROM menus m
         WHERE m.restaurant_id = $1
         ORDER BY m.display_order, m.created_at`,
        [restaurant.id]
      );

      res.json({ success: true, restaurant, menus });
    } catch (err) {
      console.error('[GET /manager/api/manage-restaurants/:id]', err);
      res.status(500).json({ success: false, error: 'Failed to load restaurant dossier' });
    }
  });

  // POST approve restaurant application
  router.post('/api/manage-restaurants/:id/approve', isLoggedInApi, async (req, res) => {
    try {
      const admin = await requirePlatformAdminApi(req, res);
      if (!admin) return;

      const existing = await Restaurant.findByIdWithOwner(req.params.id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Restaurant application not found' });
      }

      const notes = (req.body?.notes || '').trim();
      const approved = await Restaurant.approveApplication(req.params.id, req.session.user.id, notes);

      let emailResult = null;
      const recipientEmail = approved.owner_email || approved.email;
      if (recipientEmail) {
        try {
          emailResult = await EmailService.sendRestaurantApprovedEmail(
            {
              id: approved.owner_user_id || approved.owner_resolved_user_id,
              email: recipientEmail,
              first_name: approved.owner_first_name,
              last_name: approved.owner_last_name,
            },
            approved,
            notes
          );
        } catch (emailErr) {
          console.warn('[POST /api/manage-restaurants/:id/approve email]', emailErr.message);
        }
      }

      const io = req.app?.get('io');
      if (io) {
        io.to('restaurant_managers').emit('restaurant_application_updated', {
          restaurant_id: approved.id,
          approval_status: 'approved',
          restaurant: approved,
        });
      }

      res.json({
        success: true,
        message: `${approved.name} has been approved and is now live for partner login and customer discovery.`,
        restaurant: approved,
        emailResult,
      });
    } catch (err) {
      console.error('[POST /manager/api/manage-restaurants/:id/approve]', err);
      res.status(500).json({ success: false, error: err.message || 'Failed to approve restaurant' });
    }
  });

  // POST reject restaurant application with feedback email
  router.post('/api/manage-restaurants/:id/reject', isLoggedInApi, async (req, res) => {
    try {
      const admin = await requirePlatformAdminApi(req, res);
      if (!admin) return;

      const reason = (req.body?.reason || '').trim();
      if (!reason) {
        return res.status(400).json({
          success: false,
          error: 'Please enter a clear reason explaining what needs to be fixed before rejecting.',
        });
      }

      const existing = await Restaurant.findByIdWithOwner(req.params.id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Restaurant application not found' });
      }

      const rejected = await Restaurant.rejectApplication(req.params.id, req.session.user.id, reason);

      let emailResult = null;
      const recipientEmail = rejected.owner_email || rejected.email;
      if (recipientEmail) {
        try {
          emailResult = await EmailService.sendRestaurantRejectedEmail(
            {
              id: rejected.owner_user_id || rejected.owner_resolved_user_id,
              email: recipientEmail,
              first_name: rejected.owner_first_name,
              last_name: rejected.owner_last_name,
            },
            rejected,
            reason
          );
        } catch (emailErr) {
          console.warn('[POST /api/manage-restaurants/:id/reject email]', emailErr.message);
        }
      }

      const io = req.app?.get('io');
      if (io) {
        io.to('restaurant_managers').emit('restaurant_application_updated', {
          restaurant_id: rejected.id,
          approval_status: 'rejected',
          restaurant: rejected,
        });
      }

      res.json({
        success: true,
        message: `${rejected.name} was marked as rejected and feedback was sent to ${recipientEmail || 'the applicant'}.`,
        restaurant: rejected,
        emailResult,
      });
    } catch (err) {
      console.error('[POST /manager/api/manage-restaurants/:id/reject]', err);
      res.status(500).json({ success: false, error: err.message || 'Failed to reject restaurant' });
    }
  });

  parentRouter.use(router);
}

module.exports = { attachManageRestaurantRoutes };
