const User = require('../models/User');
const Customer = require('../models/Customer');
const Driver = require('../models/Driver');
const RestaurantManager = require('../models/RestaurantManager');
const EmailService = require('../utils/emailService');

// Register user
exports.register = async (req, res) => {
  try {
    const { email, password, role, first_name, last_name, phone_number, ...profileData } = req.body;
    
    // 1. Check if email already exists
    const emailExists = await User.emailExists(email);
    if (emailExists) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }
    
    const userData = {
      email,
      password,
      role,
      first_name,
      last_name,
      phone_number,
      is_active: role === 'driver' ? false : true,
    };
    const user = await User.create(userData);
    
    // 3. Create the role-specific profile (wrapped in a try-catch to prevent core crash).
    let profile;
    try {
      switch (role) {
        case 'customer':
          profile = await Customer.create(user.id, profileData);
          break;
        case 'driver':
          profile = await Driver.create(user.id, profileData);
          break;
        case 'restaurant_manager':
          profile = await RestaurantManager.create(user.id, profileData);
          break;
      }
    } catch (profileError) {
      console.error(`❌ Profile creation failed for ${role}:`, profileError.message);
      return res.status(500).json({
        success: false,
        error: `Account created, but ${role} profile failed: ${profileError.message}`
      });
    }

    if (role === 'driver') {
      try {
        await EmailService.sendDriverApplicationReceivedEmail(user, profile);
      } catch (emailErr) {
        console.warn('[authController.register] Driver application email warning:', emailErr.message);
      }

      const io = req.app?.get('io');
      if (io) {
        io.to('restaurant_managers').emit('new_driver_application', {
          driver_id: profile?.id,
          name: `${first_name} ${last_name}`,
          email,
          vehicle_type: profile?.vehicle_type,
          created_at: new Date().toISOString(),
        });
      }

      return res.status(201).json({
        success: true,
        pending_approval: true,
        message: 'Your driver application has been submitted and is pending admin approval. You will receive an email once your account is reviewed.',
        data: {
          pending_approval: true,
          user: { id: user.id, email: user.email, role: user.role, first_name, last_name, phone_number, is_active: false },
          profile,
        }
      });
    }
    
    const token = User.generateToken(user);
    
    res.status(201).json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, role: user.role, first_name, last_name, phone_number },
        profile,
        token
      }
    });
  } catch (error) {
    console.error('❌ Global Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Login user
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Find user by email
    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }
    
    // Check password
    const isPasswordValid = await User.verifyPassword(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }
    
    // Get role-specific profile
    let profile;
    switch (user.role) {
      case 'customer':
        profile = await Customer.findByUserId(user.id);
        break;
      case 'driver':
        profile = await Driver.findByUserId(user.id);
        break;
      case 'restaurant_manager':
        profile = await RestaurantManager.findByUserId(user.id);
        break;
    }

    // Enforce Driver Application Approval Gate before allowing login to the driver app
    if (user.role === 'driver') {
      const approvalStatus = profile?.approval_status || (user.is_active === false ? 'pending' : 'approved');

      if (approvalStatus === 'rejected') {
        return res.status(403).json({
          success: false,
          code: 'DRIVER_REJECTED',
          error: `Your driver application was not approved. Reason: ${profile?.rejection_reason || 'Please check your email or visit the Driver Registration Portal to update your application.'}`,
          rejection_reason: profile?.rejection_reason || null,
        });
      }

      if (approvalStatus === 'pending' || user.is_active === false) {
        return res.status(403).json({
          success: false,
          code: 'DRIVER_PENDING_APPROVAL',
          error: 'Your driver application is currently pending review by management. You will receive an email once your account is approved and ready to log in.',
        });
      }
    } else if (user.is_active === false) {
      return res.status(403).json({
        success: false,
        error: 'Your account is currently inactive. Please contact support.',
      });
    }
    
    // Generate token
    const token = User.generateToken(user);
    
    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          first_name: user.first_name,
          last_name: user.last_name,
          phone_number: user.phone_number
        },
        profile,
        token
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get current user
exports.getCurrentUser = async (req, res) => {
  try {
    const user = req.user;
    
    // Get role-specific profile
    let profile;
    switch (user.role) {
      case 'customer':
        profile = await Customer.findByUserId(user.id);
        break;
      case 'driver':
        profile = await Driver.findByUserId(user.id);
        break;
      case 'restaurant_manager':
        profile = await RestaurantManager.findByUserId(user.id);
        break;
    }
    
    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          first_name: user.first_name,
          last_name: user.last_name,
          phone_number: user.phone_number,
          profile_image_url: user.profile_image_url
        },
        profile
      }
    });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};