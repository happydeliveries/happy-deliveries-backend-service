const User = require('../models/User');
const Customer = require('../models/Customer');
const Driver = require('../models/Driver');
const RestaurantManager = require('../models/RestaurantManager');
const EmailService = require('../utils/emailService');

function resolveBaseUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

async function resolveRoleProfile(user) {
  switch (user.role) {
    case 'customer':
      return Customer.findByUserId(user.id);
    case 'driver':
      return Driver.findByUserId(user.id);
    case 'restaurant_manager':
      return RestaurantManager.findByUserId(user.id);
    default:
      return null;
  }
}

function renderEmailVerifiedHtml({ title, heading, message, subtext, badge, isError = false }) {
  const accent = isError ? '#dc2626' : '#16a34a';
  const badgeBg = isError ? '#fee2e2' : '#dcfce7';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} · Happy Deliveries</title>
</head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;">
  <div style="background:#fff;border:1px solid #e4e4e7;border-radius:16px;max-width:460px;width:100%;padding:32px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.06);">
    <div style="display:inline-block;padding:6px 14px;border-radius:999px;background:${badgeBg};color:${accent};font-size:12px;font-weight:800;letter-spacing:0.04em;margin-bottom:16px;">
      ${badge}
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;color:#18181b;">${heading}</h1>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#3f3f46;">${message}</p>
    ${subtext ? `<p style="margin:0;font-size:13px;color:#71717a;">${subtext}</p>` : ''}
  </div>
</body>
</html>`;
}

// Register user
exports.register = async (req, res) => {
  try {
    const {
      email,
      password,
      role,
      first_name,
      last_name,
      phone_number,
      profile_image_url,
      ...profileData
    } = req.body;

    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password || !role || !first_name || !last_name) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, role, first name, and last name are required.',
      });
    }

    if (role === 'driver' && (!profile_image_url || !String(profile_image_url).trim())) {
      return res.status(400).json({
        success: false,
        error: 'A clear profile photo of your face is required to register as a driver.',
      });
    }

    // 1. Check if email already exists
    const emailExists = await User.emailExists(cleanEmail);
    if (emailExists) {
      return res.status(400).json({ success: false, error: 'Email already registered' });
    }

    const userData = {
      email: cleanEmail,
      password,
      role,
      first_name: String(first_name).trim(),
      last_name: String(last_name).trim(),
      phone_number: phone_number ? String(phone_number).trim() : null,
      profile_image_url: profile_image_url ? String(profile_image_url).trim() : null,
      email_verified: false,
      is_active: false,
    };
    const user = await User.create(userData);

    // 2. Create the role-specific profile
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
      const db = require('../config/database');
      await db.query('DELETE FROM users WHERE id = $1', [user.id]).catch(() => {});
      console.error(`❌ Profile creation failed for ${role}:`, profileError.message);
      return res.status(500).json({
        success: false,
        error: `Profile setup failed for ${role}: ${profileError.message}`,
      });
    }

    // 3. Issue verification code & link and send email
    const { code, token } = await User.issueEmailVerification(user.id);
    const verifyUrl = `${resolveBaseUrl(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    try {
      await EmailService.sendEmailVerificationEmail(user, {
        code,
        verifyUrl,
        portalLabel: 'Happy Deliveries',
      });
    } catch (emailErr) {
      console.warn('[authController.register] Verification email warning:', emailErr.message);
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
          name: `${user.first_name} ${user.last_name}`,
          email: cleanEmail,
          vehicle_type: profile?.vehicle_type,
          profile_image_url: user.profile_image_url || null,
          created_at: new Date().toISOString(),
        });
      }
    }

    return res.status(201).json({
      success: true,
      requires_email_verification: true,
      pending_approval: role === 'driver',
      message:
        role === 'driver'
          ? 'Please verify your email using the code or link sent to your inbox. Management will also review your driver application.'
          : 'Account created! Please enter the 6-digit code or click the link sent to your email to activate your account.',
      data: {
        requires_email_verification: true,
        pending_approval: role === 'driver',
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          first_name: user.first_name,
          last_name: user.last_name,
          phone_number: user.phone_number,
          profile_image_url: user.profile_image_url || null,
          email_verified: false,
          is_active: false,
        },
        profile,
      },
    });
  } catch (error) {
    console.error('❌ Global Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Verify email using 6-digit code or link token (POST /api/auth/verify-email)
exports.verifyEmail = async (req, res) => {
  try {
    const email = req.body?.email || req.query?.email;
    const code = req.body?.code || req.query?.code;
    const token = req.body?.token || req.query?.token;

    const result = await User.verifyEmail({ email, code, token });
    const profile = await resolveRoleProfile(result.user);

    const canSignInNow = Boolean(result.user.email_verified && result.user.is_active !== false);
    const jwtToken = canSignInNow ? User.generateToken(result.user) : null;

    return res.json({
      success: true,
      verified: true,
      already_verified: result.alreadyVerified,
      pending_approval: result.pendingApproval,
      message: result.pendingApproval
        ? 'Your email has been verified! Your application is still awaiting management approval before you can sign in.'
        : 'Your email has been verified and your account is now active!',
      data: {
        verified: true,
        pending_approval: result.pendingApproval,
        user: {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role,
          first_name: result.user.first_name,
          last_name: result.user.last_name,
          phone_number: result.user.phone_number,
          profile_image_url: result.user.profile_image_url || null,
          email_verified: true,
          is_active: result.user.is_active,
        },
        profile,
        token: jwtToken,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      success: false,
      error: error.message || 'Could not verify email.',
    });
  }
};

// Clickable browser verification link (GET /api/auth/verify-email?token=...)
exports.verifyEmailLink = async (req, res) => {
  try {
    const token = req.query?.token;
    const email = req.query?.email;
    if (!token) {
      return res.status(400).send(
        renderEmailVerifiedHtml({
          title: 'Invalid Verification Link',
          badge: 'INVALID LINK',
          heading: 'Missing verification token',
          message: 'Please open the full verification link from your email or enter the 6-digit code in the app.',
          isError: true,
        })
      );
    }

    const result = await User.verifyEmail({ email, token });
    const message = result.pendingApproval
      ? 'Your email address is verified! Your application is currently awaiting management approval — we will email you as soon as it is approved.'
      : 'Your email address is verified and your account is now active. You can return to the Happy Deliveries app or portal and sign in.';

    return res.send(
      renderEmailVerifiedHtml({
        title: 'Email Verified',
        badge: 'EMAIL VERIFIED',
        heading: 'Email Verified!',
        message,
        subtext: 'You can safely close this browser tab.',
      })
    );
  } catch (error) {
    return res.status(error.statusCode || 400).send(
      renderEmailVerifiedHtml({
        title: 'Verification Failed',
        badge: 'VERIFICATION ERROR',
        heading: 'Could not verify email',
        message: error.message || 'This verification link may have expired or already been used.',
        subtext: 'Request a fresh verification email from the app or portal login screen.',
        isError: true,
      })
    );
  }
};

// Resend verification email (POST /api/auth/resend-verification)
exports.resendVerification = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email address is required.' });
    }

    const user = await User.findByEmail(email);
    if (!user) {
      return res.json({
        success: true,
        message: 'If an unverified account exists for that email, a fresh verification email has been sent.',
      });
    }

    if (user.email_verified) {
      return res.json({
        success: true,
        already_verified: true,
        message: 'This email address is already verified. You can sign in.',
      });
    }

    const { code, token } = await User.issueEmailVerification(user.id);
    const verifyUrl = `${resolveBaseUrl(req)}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    await EmailService.sendEmailVerificationEmail(user, {
      code,
      verifyUrl,
      portalLabel: 'Happy Deliveries',
    });

    return res.json({
      success: true,
      message: 'A new verification code and link have been sent to your email address.',
    });
  } catch (error) {
    console.error('[authController.resendVerification] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Unable to send verification email right now.',
    });
  }
};

// Login user
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findByEmail(email);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    const isPasswordValid = await User.verifyPassword(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        email: user.email,
        role: user.role,
        error: 'Please verify your email address before signing in. Check your inbox for your verification code or link.',
      });
    }

    const profile = await resolveRoleProfile(user);

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
    } else if (user.role === 'restaurant_manager' && profile?.account_type === 'restaurant_partner') {
      const appStatus = profile?.approval_status || (user.is_active === false ? 'pending' : 'approved');
      if (appStatus === 'rejected') {
        return res.status(403).json({
          success: false,
          code: 'RESTAURANT_REJECTED',
          error: 'Your restaurant application was not approved. Please visit the Restaurant Registration Portal to review feedback and resubmit.',
        });
      }
      if (appStatus === 'pending' || user.is_active === false) {
        return res.status(403).json({
          success: false,
          code: 'RESTAURANT_PENDING_APPROVAL',
          error: 'Your restaurant application is currently pending admin review. You will receive an email once approved.',
        });
      }
    } else if (user.is_active === false) {
      return res.status(403).json({
        success: false,
        error: 'Your account is currently inactive. Please contact support.',
      });
    }

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
          phone_number: user.phone_number,
          profile_image_url: user.profile_image_url || null,
          email_verified: true,
        },
        profile,
        token,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// Get current user
exports.getCurrentUser = async (req, res) => {
  try {
    const user = req.user;
    const profile = await resolveRoleProfile(user);

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
          profile_image_url: user.profile_image_url,
          email_verified: Boolean(user.email_verified),
        },
        profile,
      },
    });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};
