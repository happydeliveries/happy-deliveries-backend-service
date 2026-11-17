const User = require('../models/User');
const Customer = require('../models/Customer');
const Driver = require('../models/Driver');
const RestaurantManager = require('../models/RestaurantManager');
const { resolveAddressCoordinates, toValidLatLng } = require('../utils/deliveryPricing');

// Update user profile
exports.updateProfile = async (req, res) => {
  try {
    const { first_name, last_name, phone_number, profile_image_url } = req.body || {};

    const updateData = {};
    if (first_name !== undefined && String(first_name).trim()) {
      updateData.first_name = String(first_name).trim();
    }
    if (last_name !== undefined && String(last_name).trim()) {
      updateData.last_name = String(last_name).trim();
    }
    if (phone_number !== undefined && String(phone_number).trim()) {
      updateData.phone_number = String(phone_number).trim();
    }
    if (profile_image_url !== undefined) {
      updateData.profile_image_url = profile_image_url;
    }

    const updatedUser = await User.update(req.user.id, updateData);

    res.json({
      success: true,
      data: updatedUser
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Update role-specific profile
exports.updateRoleProfile = async (req, res) => {
  try {
    const user = req.user;
    let updatedProfile;

    switch (user.role) {
      case 'customer': {
        const customer = await Customer.getOrCreateByUserId(user.id);
        updatedProfile = await Customer.updatePreferences(customer.id, req.body);
        break;
      }

      case 'driver': {
        const driver = await Driver.findByUserId(user.id);
        updatedProfile = driver;
        break;
      }

      case 'restaurant_manager': {
        const manager = await RestaurantManager.findByUserId(user.id);
        updatedProfile = manager;
        break;
      }
    }

    res.json({
      success: true,
      data: updatedProfile
    });
  } catch (error) {
    console.error('Update role profile error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get saved customer addresses (backfilling coordinates for legacy entries)
exports.getAddresses = async (req, res) => {
  try {
    const customer = await Customer.getOrCreateByUserId(req.user.id);
    const rawList = Array.isArray(customer?.delivery_addresses) ? customer.delivery_addresses : [];
    let changed = false;

    const hydratedList = await Promise.all(
      rawList.map(async (entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        const existing = toValidLatLng(entry.latitude, entry.longitude);
        if (existing) return entry;
        const resolved = await resolveAddressCoordinates(entry).catch(() => null);
        if (resolved) {
          changed = true;
          return {
            ...entry,
            latitude: resolved.latitude,
            longitude: resolved.longitude,
          };
        }
        return entry;
      })
    );

    if (changed) {
      await Customer.updateDeliveryAddresses(customer.id, hydratedList).catch(() => {});
    }

    res.json({ success: true, data: hydratedList });
  } catch (error) {
    console.error('Get addresses error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Add a saved customer address
exports.addAddress = async (req, res) => {
  try {
    const { street, address, label, city, postal_code, instructions, latitude, longitude, is_default } = req.body || {};
    const streetValue = String(street || address || '').trim();
    if (!streetValue) {
      return res.status(400).json({ success: false, error: 'Delivery street address is required' });
    }

    const cleanCity = city ? String(city).trim() : '';
    const cleanPostal = postal_code ? String(postal_code).trim() : '';
    let resolvedCoords = toValidLatLng(latitude, longitude);
    if (!resolvedCoords) {
      resolvedCoords = await resolveAddressCoordinates({
        street: streetValue,
        city: cleanCity,
        postal_code: cleanPostal,
      }).catch(() => null);
    }

    const customer = await Customer.getOrCreateByUserId(req.user.id);
    const result = await Customer.addDeliveryAddress(customer.id, {
      street: streetValue,
      label: label ? String(label).trim() : 'Home',
      city: cleanCity,
      postal_code: cleanPostal,
      instructions: instructions ? String(instructions).trim() : '',
      latitude: resolvedCoords?.latitude,
      longitude: resolvedCoords?.longitude,
      is_default
    });

    res.status(201).json({
      success: true,
      data: result?.delivery_addresses || []
    });
  } catch (error) {
    console.error('Add address error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Mark a saved customer address as default
exports.setDefaultAddress = async (req, res) => {
  try {
    const customer = await Customer.getOrCreateByUserId(req.user.id);
    const result = await Customer.setDefaultDeliveryAddress(customer.id, req.params.addressId);
    res.json({
      success: true,
      data: result?.delivery_addresses || []
    });
  } catch (error) {
    console.error('Set default address error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete a saved customer address by id or index
exports.removeAddress = async (req, res) => {
  try {
    const customer = await Customer.getOrCreateByUserId(req.user.id);
    const result = await Customer.removeDeliveryAddress(customer.id, req.params.addressId);
    res.json({
      success: true,
      data: result?.delivery_addresses || []
    });
  } catch (error) {
    console.error('Remove address error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};