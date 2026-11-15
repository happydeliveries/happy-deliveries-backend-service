const net = require('net');
const tls = require('tls');
const db = require('../config/database');

/**
 * Zero-dependency SMTP + Notification Email Service
 * Supports Nodemailer (if installed), native Node TLS/STARTTLS SMTP using .env credentials,
 * and automatic persistence to the notifications table + console preview.
 */
class EmailService {
  static async sendEmail({ to, subject, text, html, userId = null, userType = 'driver', metadata = {} }) {
    const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@happydeliveries.co.za';
    const fromName = process.env.EMAIL_FROM_NAME || 'Happy Deliveries Management';
    let sentViaSmtp = false;
    let smtpError = null;

    // 1. Try nodemailer if available in node_modules
    try {
      const nodemailer = require('nodemailer');
      if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        const port = parseInt(process.env.EMAIL_PORT || '587', 10);
        const transporter = nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port,
          secure: port === 465,
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
          },
        });
        await transporter.sendMail({
          from: `"${fromName}" <${fromEmail}>`,
          to,
          subject,
          text,
          html: html || text,
        });
        sentViaSmtp = true;
      }
    } catch (err) {
      // Nodemailer not installed or failed; try native SMTP if credentials exist
      if (err.code !== 'MODULE_NOT_FOUND') {
        smtpError = err.message;
      }
    }

    // 2. Native TLS SMTP sender when EMAIL_HOST / EMAIL_USER / EMAIL_PASS are configured
    if (!sentViaSmtp && process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      try {
        await this.sendRawSmtp({
          host: process.env.EMAIL_HOST,
          port: parseInt(process.env.EMAIL_PORT || '465', 10),
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
          from: fromEmail,
          fromName,
          to,
          subject,
          text,
          html: html || text,
        });
        sentViaSmtp = true;
      } catch (rawErr) {
        smtpError = rawErr.message;
        console.warn('[EmailService] SMTP send warning:', rawErr.message);
      }
    }

    // 3. Log formatted email in server console for visibility and debugging
    console.log('\n============================================================');
    console.log(`📧 EMAIL ${sentViaSmtp ? 'SENT VIA SMTP' : 'QUEUED / LOGGED'}`);
    console.log(`To:      ${to}`);
    console.log(`From:    ${fromName} <${fromEmail}>`);
    console.log(`Subject: ${subject}`);
    console.log('------------------------------------------------------------');
    console.log(text);
    console.log('============================================================\n');

    // 4. Record notification in database if userId is provided
    if (userId) {
      try {
        await db.query(
          `INSERT INTO notifications (user_id, user_type, title, body, type, data, is_sent, sent_via, sent_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
          [
            userId,
            userType,
            subject,
            text,
            metadata.type || 'driver_application_email',
            JSON.stringify({ to, subject, ...metadata }),
            true,
            ['email'],
          ]
        );
      } catch (dbErr) {
        console.warn('[EmailService] Could not record email notification in DB:', dbErr.message);
      }
    }

    const mailtoUrl = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;

    return {
      success: true,
      sentViaSmtp,
      smtpError,
      to,
      subject,
      mailtoUrl,
    };
  }

  static sendRawSmtp({ host, port, user, pass, from, fromName, to, subject, text, html }) {
    return new Promise((resolve, reject) => {
      const isImplicitTls = port === 465;
      const socket = isImplicitTls
        ? tls.connect({ host, port, rejectUnauthorized: false })
        : net.createConnection({ host, port });

      let step = 0;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('SMTP connection timed out'));
      }, 10000);

      const sendLine = (sock, line) => sock.write(line + '\r\n');

      const buildMimeMessage = () => {
        const boundary = `----=_Part_${Date.now()}`;
        return [
          `From: "${fromName}" <${from}>`,
          `To: <${to}>`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          ``,
          `--${boundary}`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          text,
          ``,
          `--${boundary}`,
          `Content-Type: text/html; charset=utf-8`,
          ``,
          html || `<pre>${text}</pre>`,
          ``,
          `--${boundary}--`,
          `.`,
        ].join('\r\n');
      };

      const attachHandlers = (sock) => {
        sock.on('data', (chunk) => {
          const msg = chunk.toString();
          const code = parseInt(msg.slice(0, 3), 10);
          if (code >= 400) {
            clearTimeout(timeout);
            sock.end();
            return reject(new Error(`SMTP Error ${code}: ${msg.trim()}`));
          }

          if (step === 0 && code === 220) {
            step = 1;
            sendLine(sock, `EHLO localhost`);
          } else if (step === 1 && code === 250) {
            if (!isImplicitTls && msg.includes('STARTTLS')) {
              step = 1.5;
              sendLine(sock, 'STARTTLS');
            } else {
              step = 2;
              sendLine(sock, 'AUTH LOGIN');
            }
          } else if (step === 1.5 && code === 220) {
            const tlsSock = tls.connect({ socket: sock, host, rejectUnauthorized: false }, () => {
              step = 2;
              attachHandlers(tlsSock);
              sendLine(tlsSock, 'AUTH LOGIN');
            });
          } else if (step === 2 && code === 334) {
            step = 3;
            sendLine(sock, Buffer.from(user).toString('base64'));
          } else if (step === 3 && code === 334) {
            step = 4;
            sendLine(sock, Buffer.from(pass).toString('base64'));
          } else if (step === 4 && code === 235) {
            step = 5;
            sendLine(sock, `MAIL FROM:<${from}>`);
          } else if (step === 5 && code === 250) {
            step = 6;
            sendLine(sock, `RCPT TO:<${to}>`);
          } else if (step === 6 && code === 250) {
            step = 7;
            sendLine(sock, 'DATA');
          } else if (step === 7 && code === 354) {
            step = 8;
            sendLine(sock, buildMimeMessage());
          } else if (step === 8 && code === 250) {
            step = 9;
            sendLine(sock, 'QUIT');
            clearTimeout(timeout);
            sock.end();
            resolve(true);
          }
        });

        sock.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      };

      attachHandlers(socket);
    });
  }

  static async sendDriverApplicationReceivedEmail(driverUser, applicationData = {}) {
    const fullName = `${driverUser.first_name || ''} ${driverUser.last_name || ''}`.trim() || 'Driver Applicant';
    const subject = 'Happy Deliveries — Driver Application Received';
    const text = [
      `Hi ${fullName},`,
      ``,
      `Thank you for applying to become a driver with Happy Deliveries!`,
      `We have received your driver registration and vehicle details (${applicationData.vehicle_type || 'Vehicle'} - ${applicationData.vehicle_registration || 'N/A'}).`,
      ``,
      `What happens next:`,
      `1. Our management team will review your driver's license, vehicle details, and payout information.`,
      `2. You will receive an email as soon as your account is approved (or if any corrections are needed).`,
      `3. Once approved, you can log directly into the Happy Deliveries Driver App using your email (${driverUser.email}) and password.`,
      ``,
      `Best regards,`,
      `Happy Deliveries Management Team`,
    ].join('\n');

    const html = `
      <div style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; color: #111827;">
        <h2 style="color: #2563eb; margin-top: 0;">Driver Application Received</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Thank you for registering to drive with <strong>Happy Deliveries</strong>! Your application has been submitted and is currently <strong>Pending Review</strong>.</p>
        <div style="background: #f9fafb; padding: 16px; border-radius: 8px; margin: 16px 0; font-size: 14px;">
          <div><strong>Email:</strong> ${driverUser.email}</div>
          <div><strong>License Number:</strong> ${applicationData.driver_license_number || 'Provided'}</div>
          <div><strong>Vehicle:</strong> ${applicationData.vehicle_color || ''} ${applicationData.vehicle_model || ''} (${applicationData.vehicle_type || ''})</div>
          <div><strong>Registration:</strong> ${applicationData.vehicle_registration || 'Provided'}</div>
        </div>
        <p>Once an administrator approves your application, we will notify you via email and unlock your access to the Driver side of the Happy Deliveries mobile app.</p>
        <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">— Happy Deliveries Management Team</p>
      </div>
    `;

    return this.sendEmail({
      to: driverUser.email,
      subject,
      text,
      html,
      userId: driverUser.id,
      userType: 'driver',
      metadata: { type: 'driver_application_submitted' },
    });
  }

  static async sendDriverApprovedEmail(driverUser, notes = '') {
    const fullName = `${driverUser.first_name || ''} ${driverUser.last_name || ''}`.trim() || 'Driver';
    const subject = '🎉 Your Happy Deliveries Driver Account is Approved!';
    const text = [
      `Hi ${fullName},`,
      ``,
      `Great news! Your Happy Deliveries driver application has been APPROVED by management.`,
      notes ? `\nManager Note: ${notes}\n` : '',
      `You can now log in to the Driver side of the Happy Deliveries mobile app using:`,
      `• Email: ${driverUser.email}`,
      `• Password: The password you created during registration`,
      ``,
      `Once logged in, toggle your status to "Online" on the Driver Dashboard to start receiving paid delivery orders.`,
      ``,
      `Welcome to the team!`,
      `Happy Deliveries Management Team`,
    ].filter(Boolean).join('\n');

    const html = `
      <div style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #bbf7d0; border-radius: 12px; color: #111827;">
        <div style="display:inline-block; background:#dcfce7; color:#166534; padding:6px 12px; border-radius:999px; font-weight:600; font-size:13px; margin-bottom:12px;">
          APPLICATION APPROVED
        </div>
        <h2 style="color: #166534; margin-top: 0;">Welcome to Happy Deliveries, ${fullName}!</h2>
        <p>Your driver account has been reviewed and <strong>approved</strong>.</p>
        ${notes ? `<div style="background:#f0fdf4; border-left:4px solid #16a34a; padding:12px 16px; margin:16px 0;"><strong>Note from Management:</strong><br/>${notes}</div>` : ''}
        <p>You can now sign in to the <strong>Happy Deliveries Mobile App</strong> with your registered email (<strong>${driverUser.email}</strong>) and password to access the Driver Dashboard and start accepting deliveries.</p>
        <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">— Happy Deliveries Management Team</p>
      </div>
    `;

    return this.sendEmail({
      to: driverUser.email,
      subject,
      text,
      html,
      userId: driverUser.id,
      userType: 'driver',
      metadata: { type: 'driver_application_approved', notes },
    });
  }

  static async sendDriverRejectedEmail(driverUser, reason, portalUrl = '/driver/register') {
    const fullName = `${driverUser.first_name || ''} ${driverUser.last_name || ''}`.trim() || 'Driver Applicant';
    const subject = 'Update on Your Happy Deliveries Driver Application';
    const text = [
      `Hi ${fullName},`,
      ``,
      `Thank you for applying to become a driver with Happy Deliveries.`,
      `After reviewing your application, we were unable to approve your driver account at this time.`,
      ``,
      `What was wrong / Reason for rejection:`,
      `"${reason}"`,
      ``,
      `How to fix this:`,
      `You can visit the Driver Registration Portal (${portalUrl} or Check Application Status) using your email (${driverUser.email}) to update the information above and resubmit your application for review.`,
      ``,
      `Best regards,`,
      `Happy Deliveries Management Team`,
    ].join('\n');

    const html = `
      <div style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #fecaca; border-radius: 12px; color: #111827;">
        <div style="display:inline-block; background:#fee2e2; color:#991b1b; padding:6px 12px; border-radius:999px; font-weight:600; font-size:13px; margin-bottom:12px;">
          ACTION REQUIRED — APPLICATION NOT APPROVED
        </div>
        <h2 style="color: #991b1b; margin-top: 0;">Driver Application Update</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>We reviewed your driver registration for <strong>Happy Deliveries</strong>, and unfortunately we cannot approve your account yet due to the following issue(s):</p>
        <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 14px 16px; border-radius: 6px; margin: 16px 0; color: #7f1d1d;">
          <strong>What needs attention:</strong><br/>
          <p style="margin: 6px 0 0; white-space: pre-line;">${reason}</p>
        </div>
        <p>Please update your application details on the <strong>Driver Registration Web Portal</strong> and resubmit so our team can review your account again.</p>
        <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">— Happy Deliveries Management Team</p>
      </div>
    `;

    return this.sendEmail({
      to: driverUser.email,
      subject,
      text,
      html,
      userId: driverUser.id,
      userType: 'driver',
      metadata: { type: 'driver_application_rejected', reason },
    });
  }
}

module.exports = EmailService;
