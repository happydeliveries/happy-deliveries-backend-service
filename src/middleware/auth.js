const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Please authenticate'
      });
    }
    
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({
        success: false,
        error: 'Please authenticate'
      });
    }

    let user;
    try {
      user = await User.findById(decoded.id);
    } catch (dbError) {
      console.error('Database error during authentication:', dbError.message);
      return res.status(503).json({
        success: false,
        message: 'Database waking up, please retry',
        error: 'Database waking up, please retry'
      });
    }
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Please authenticate'
      });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        error: 'Please verify your email address before using your account.'
      });
    }

    if (user.is_active === false) {
      return res.status(403).json({
        success: false,
        error: user.role === 'driver'
          ? 'Your driver account is pending approval or has not been activated yet.'
          : 'Your account is currently inactive.'
      });
    }
    
    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    res.status(401).json({ 
      success: false, 
      error: 'Please authenticate' 
    });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to perform this action'
      });
    }
    next();
  };
};

module.exports = { auth, authorize };