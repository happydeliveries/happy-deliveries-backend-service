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

  static async sendDriverApprovedEmail(driverUser, notes = '') {
    const fullName = `${driverUser.first_name || ''} ${driverUser.last_name || ''}`.trim() || 'Driver';
    const baseUrl = (
      process.env.BASE_URL ||
      process.env.APP_URL ||
      'https://happy-deliveries-api-tq5y.onrender.com'
    ).replace(/\/$/, '');
    const currentYear = new Date().getFullYear();

    const subject = '🎉 Congratulations! Your Happy Deliveries Driver Account is Approved';
    const text = [
      `Hi ${fullName},`,
      ``,
      `Congratulations! Your Happy Deliveries driver application has been APPROVED by management. We are thrilled to welcome you to the team!`,
      notes ? `\nManager Note: ${notes}\n` : '',
      `You can now log in to the Driver side of the Happy Deliveries mobile app using:`,
      `• Email: ${driverUser.email}`,
      `• Password: The password you created during registration`,
      ``,
      `Once logged in, toggle your status to "Online" on the Driver Dashboard to start receiving paid delivery orders.`,
      ``,
      `Welcome aboard!`,
      `Happy Deliveries Management Team`,
    ].filter(Boolean).join('\n');

    const notesRowHtml = notes
      ? `
                                                <tr>
                                                  <td style="padding:12px 0 4px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#166534;border-top:2px solid #BBF7D0;margin-top:10px;white-space:pre-line;">
                                                    <strong>Note from Management:</strong><br/>${notes}
                                                  </td>
                                                </tr>`
      : '';

    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
  <meta charset="UTF-8">
  <meta content="width=device-width, initial-scale=1" name="viewport">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta content="telephone=no" name="format-detection">
  <title>${subject}</title>

  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap">

  <style type="text/css">
    u + .body img ~ div div { display: none; }
    #outlook a { padding: 0; }
    span.MsoHyperlink,
    span.MsoHyperlinkFollowed { color: inherit; mso-style-priority: 99; }
    a.es-button { mso-style-priority: 100 !important; text-decoration: none !important; }
    a[x-apple-data-detectors],
    #MessageViewBody a {
      color: inherit !important;
      text-decoration: none !important;
      font-size: inherit !important;
      font-family: inherit !important;
      font-weight: inherit !important;
      line-height: inherit !important;
    }
    .es-desk-hidden {
      display: none;
      float: left;
      overflow: hidden;
      width: 0;
      max-height: 0;
      line-height: 0;
      mso-hide: all;
    }

    @media only screen and (max-width: 600px) {
      .es-m-p15b { padding-bottom: 15px !important; }
      .es-m-p0r { padding-right: 0px !important; }
      .es-m-p20r { padding-right: 20px !important; }
      .es-m-p20b { padding-bottom: 20px !important; }
      .es-m-p0l { padding-left: 0px !important; }
      .es-m-p20l { padding-left: 20px !important; }
      *[class="gmail-fix"] { display: none !important; }
      p, a { line-height: 150% !important; }
      h1, h1 a { line-height: 120% !important; font-size: 26px !important; text-align: center; }
      h2, h2 a { line-height: 120% !important; font-size: 22px !important; }
      .es-header-body p, .es-header-body a,
      .es-content-body p, .es-content-body a,
      .es-footer-body p, .es-footer-body a { font-size: 14px !important; }
      .es-m-txt-c, .es-m-txt-c h1, .es-m-txt-c h2, .es-m-txt-c h3 { text-align: center !important; }
      a.es-button, button.es-button {
        display: inline-block !important;
        font-size: 16px !important;
        padding: 15px 36px !important;
        line-height: 120% !important;
      }
      .es-button-border {
        display: inline-block !important;
        border-style: solid;
        border-color: rgb(44, 181, 67);
        border-width: 0px;
      }
      .es-adaptive table, .es-left, .es-right { width: 100% !important; border-collapse: separate !important; }
      .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header {
        width: 100% !important;
        max-width: 600px !important;
      }
      .adapt-img { width: 100% !important; height: auto !important; }
      .img-6429 { height: 70px !important; width: 70px !important; }
      .es-m-w0 { width: 0px !important; }
    }

    @media screen and (max-width: 384px) {
      .mail-message-content { width: 414px !important; }
    }
  </style>
</head>

<body class="body" style="width:100%;height:100%;font-family:Poppins, Arial, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
  <div dir="ltr" class="es-wrapper-color" lang="en" style="background-color:#F5F5F5">
    <table width="100%" cellspacing="0" cellpadding="0" class="es-wrapper" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%">
      <tbody>
        <tr>
          <td valign="top" style="padding:0;Margin:0">

            <!-- ================= HERO SECTION ================= -->
            <table cellspacing="0" cellpadding="0" align="center" class="es-content" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important">
              <tbody>
                <tr>
                  <td align="center" style="padding:0;Margin:0">
                    <table cellspacing="0" cellpadding="0" bgcolor="#FFCC00" align="center" class="es-content-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#ffffff;width:600px">
                      <tbody>
                        <tr>
                          <td align="left" class="es-m-p20b" style="Margin:0;padding:30px 20px 30px">
                            <table width="100%" cellspacing="0" cellpadding="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                              <tbody>
                                <tr>
                                  <td valign="top" align="center" class="es-m-p0r es-m-p20b" style="padding:0;Margin:0;width:560px">
                                    <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                                      <tbody>
                                        <!-- Logo, Badge & Heading -->
                                        <tr>
                                          <td align="center" class="es-m-p0l es-m-p0r" style="Margin:0;padding:10px 30px 20px">
                                            <a href="${baseUrl}/" target="_blank" style="background-color:#ffffff;border-radius:50%;padding:10px;display:inline-block;margin-bottom:14px;text-decoration:none;">
                                              <img src="https://res.cloudinary.com/dpdira4rd/image/upload/v1794689689/logo-square_gmpkuq.png" alt="Happy Deliveries" height="100" title="Happy Deliveries" class="img-6429" width="100" style="display:block;border:0;outline:none;text-decoration:none;">
                                            </a>
                                            
                                            <h1 class="es-m-txt-c" style="Margin:0;font-family:Poppins, Arial, sans-serif;mso-line-height-rule:exactly;letter-spacing:0;font-size:28px;font-style:normal;font-weight:700;line-height:38px;color:#18181B">
                                              Congratulations, ${fullName}!
                                            </h1>
                                          </td>
                                        </tr>

                                        <!-- Greeting & Congratulatory Intro Copy -->
                                        <tr>
                                          <td align="center" class="es-m-p0l es-m-p0r" style="padding:0 25px 20px;Margin:0">
                                            <p style="Margin:0;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#18181B;font-size:14px">
                                              Great news! Your driver application for <strong style="font-weight:700 !important">Happy Deliveries</strong> has been officially approved. We are thrilled to welcome you to our driver network!
                                            </p>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>

                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- ================= HOW TO START DRIVING & SUPPORT ================= -->
            <table cellpadding="0" align="center" cellspacing="0" class="es-content" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important">
              <tbody>
                <tr>
                  <td bgcolor="transparent" align="center" style="padding:0;Margin:0">
                    <table cellpadding="0" cellspacing="0" bgcolor="#18181B" align="center" class="es-content-body" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#18181B;width:600px" role="none">
                      <tbody>
                        <!-- How to Start Driving -->
                        <tr>
                          <td align="left" style="Margin:0;padding:40px 35px 10px">
                            <h2 style="Margin:0 0 16px;font-family:Poppins, Arial, sans-serif;font-size:20px;font-weight:700;color:#FFCC00;text-align:center;">
                              How to start driving:
                            </h2>
                            <p style="Margin:0 0 12px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#E4E4E7;">
                              <span style="color:#FFCC00;">1. Log In to the App:</span> Open the Happy Deliveries mobile app and sign in using your registered email (<strong style="color:#FFFFFF;">${driverUser.email}</strong>) and password.
                            </p>
                            <p style="Margin:0 0 12px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#E4E4E7;">
                              <span style="color:#FFCC00;">2. Go Online:</span> Once logged in, toggle your status to <strong style="color:#FFFFFF;">"Online"</strong> on the Driver Dashboard.
                            </p>
                            <p style="Margin:0 0 16px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#E4E4E7;">
                              <span style="color:#FFCC00;">3. Accept Orders:</span> Start receiving and completing paid delivery orders in your area. Welcome aboard!
                            </p>
                          </td>
                        </tr>

                        <!-- Support CTA Button -->
                        <tr>
                          <td align="center" style="Margin:0;padding:20px 20px 30px">
                            <span class="es-button-border msohide" style="border-style:solid;border-color:#2CB543;background:#FFCC00;border-width:0px;display:inline-block;border-radius:40px;width:auto;mso-hide:all;">
                              <a href="${baseUrl}/" target="_blank" class="es-button" style="mso-style-priority:100 !important;text-decoration:none !important;mso-line-height-rule:exactly;color:#18181B;font-size:16px;font-weight:600;padding:15px 40px;display:inline-block;background:#ffd900;border-radius:40px;font-family:Poppins, Arial, sans-serif;font-style:normal;line-height:22px;width:auto;text-align:center;letter-spacing:0;mso-padding-alt:0;mso-border-alt:10px solid #FFCC00;text-transform:none;">Contact Driver Support</a>
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- ================= FOOTER ================= -->
            <table cellspacing="0" cellpadding="0" align="center" class="es-footer" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
              <tbody>
                <tr>
                  <td align="center" style="padding:0;Margin:0">
                    <table cellspacing="0" cellpadding="0" bgcolor="#18181B" align="center" class="es-footer-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#18181B;width:600px">
                      <tbody>
                        <!-- App Store Badges -->
                        <tr>
                          <td align="left" style="padding:30px 20px 0;Margin:0">
                            <table cellpadding="0" cellspacing="0" class="esdev-mso-table" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:560px">
                              <tbody>
                                <tr>
                                  <!-- Google Play -->
                                  <td valign="top" class="esdev-mso-td" style="padding:0;Margin:0">
                                    <table cellpadding="0" cellspacing="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                                      <tbody>
                                        <tr>
                                          <td align="right" style="padding:0;Margin:0;width:270px;font-size:0">
                                            <a target="_blank" href="${baseUrl}/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#FFFFFF;font-size:14px">
                                              <img src="https://edilabd.stripocdn.email/content/guids/CABINET_e6a4e646c7343a3bc862dcbe5f5594340f36f9df3ab9fbf9aa59d0d388e0186b/images/group_4078300.png" alt="Google Play Store" height="35" title="Google Play Store" width="117" style="display:inline-block;border:0;outline:none;text-decoration:none;margin:0">
                                            </a>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>

                                  <td class="es-m-w0 es-m-p20r" style="padding:0;Margin:0;width:20px"></td>

                                  <!-- Apple App Store -->
                                  <td valign="top" class="esdev-mso-td" style="padding:0;Margin:0">
                                    <table cellpadding="0" cellspacing="0" align="right" class="es-right" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:right">
                                      <tbody>
                                        <tr>
                                          <td align="left" style="padding:0;Margin:0;width:270px;font-size:0">
                                            <a target="_blank" href="${baseUrl}/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#FFFFFF;font-size:14px">
                                              <img src="https://edilabd.stripocdn.email/content/guids/CABINET_e6a4e646c7343a3bc862dcbe5f5594340f36f9df3ab9fbf9aa59d0d388e0186b/images/group.png" alt="Apple App Store" height="35" title="Apple App Store" width="118" style="display:inline-block;border:0;outline:none;text-decoration:none;margin:0">
                                            </a>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>

                        <!-- Sign-off & Dynamic Copyright -->
                        <tr>
                          <td align="center" style="Margin:0;padding:25px 20px 35px">
                            <p style="Margin:0 0 8px;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:21px;color:#A1A1AA;font-size:13px">
                              — Happy Deliveries Management Team
                            </p>
                            <p style="Margin:0;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:21px;color:#FFFFFF;font-size:14px">
                              © ${currentYear} Happy Deliveries. All rights reserved.
                            </p>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

          </td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>`;

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

  static async sendDriverApplicationReceivedEmail(driverUser, applicationData = {}) {
    const fullName = `${driverUser.first_name || ''} ${driverUser.last_name || ''}`.trim() || 'Driver Applicant';
    const baseUrl = (
      process.env.BASE_URL ||
      process.env.APP_URL ||
      'https://happy-deliveries-api-tq5y.onrender.com'
    ).replace(/\/$/, '');
    const currentYear = new Date().getFullYear();

    const vehicleSummary = [
      applicationData.vehicle_color,
      applicationData.vehicle_model,
      applicationData.vehicle_type ? `(${applicationData.vehicle_type})` : '',
    ]
      .filter(Boolean)
      .join(' ') || 'Provided';

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
      `Check your status: ${baseUrl}/driver/register`,
      ``,
      `Best regards,`,
      `Happy Deliveries Management Team`,
    ].join('\n');

    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
  <meta charset="UTF-8">
  <meta content="width=device-width, initial-scale=1" name="viewport">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta content="telephone=no" name="format-detection">
  <title>${subject}</title>

  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap">

  <style type="text/css">
    u + .body img ~ div div { display: none; }
    #outlook a { padding: 0; }
    span.MsoHyperlink,
    span.MsoHyperlinkFollowed { color: inherit; mso-style-priority: 99; }
    a.es-button { mso-style-priority: 100 !important; text-decoration: none !important; }
    a[x-apple-data-detectors],
    #MessageViewBody a {
      color: inherit !important;
      text-decoration: none !important;
      font-size: inherit !important;
      font-family: inherit !important;
      font-weight: inherit !important;
      line-height: inherit !important;
    }
    .es-desk-hidden {
      display: none;
      float: left;
      overflow: hidden;
      width: 0;
      max-height: 0;
      line-height: 0;
      mso-hide: all;
    }

    @media only screen and (max-width: 600px) {
      .es-m-p15b { padding-bottom: 15px !important; }
      .es-m-p0r { padding-right: 0px !important; }
      .es-m-p20r { padding-right: 20px !important; }
      .es-m-p20b { padding-bottom: 20px !important; }
      .es-m-p0l { padding-left: 0px !important; }
      .es-m-p20l { padding-left: 20px !important; }
      *[class="gmail-fix"] { display: none !important; }
      p, a { line-height: 150% !important; }
      h1, h1 a { line-height: 120% !important; font-size: 28px !important; text-align: center; }
      h2, h2 a { line-height: 120% !important; font-size: 22px !important; }
      .es-header-body p, .es-header-body a,
      .es-content-body p, .es-content-body a,
      .es-footer-body p, .es-footer-body a { font-size: 14px !important; }
      .es-m-txt-c, .es-m-txt-c h1, .es-m-txt-c h2, .es-m-txt-c h3 { text-align: center !important; }
      a.es-button, button.es-button {
        display: inline-block !important;
        font-size: 16px !important;
        padding: 15px 36px !important;
        line-height: 120% !important;
      }
      .es-button-border {
        display: inline-block !important;
        border-style: solid;
        border-color: rgb(44, 181, 67);
        border-width: 0px;
      }
      .es-adaptive table, .es-left, .es-right { width: 100% !important; border-collapse: separate !important; }
      .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header {
        width: 100% !important;
        max-width: 600px !important;
      }
      .adapt-img { width: 100% !important; height: auto !important; }
      .img-6429 { height: 70px !important; width: 70px !important; }
      .es-m-w0 { width: 0px !important; }
    }

    @media screen and (max-width: 384px) {
      .mail-message-content { width: 414px !important; }
    }
  </style>
</head>

<body class="body" style="width:100%;height:100%;font-family:Poppins, Arial, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
  <div dir="ltr" class="es-wrapper-color" lang="en" style="background-color:#F5F5F5">
    <table width="100%" cellspacing="0" cellpadding="0" class="es-wrapper" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%">
      <tbody>
        <tr>
          <td valign="top" style="padding:0;Margin:0">

            <!-- ================= HERO SECTION ================= -->
            <table cellspacing="0" cellpadding="0" align="center" class="es-content" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important">
              <tbody>
                <tr>
                  <td align="center" style="padding:0;Margin:0">
                    <table cellspacing="0" cellpadding="0" bgcolor="#FFCC00" align="center" class="es-content-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFCC00;width:600px">
                      <tbody>
                        <tr>
                          <td align="left" class="es-m-p20b" style="Margin:0;padding:30px 20px 30px">
                            <table width="100%" cellspacing="0" cellpadding="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                              <tbody>
                                <tr>
                                  <td valign="top" align="center" class="es-m-p0r es-m-p20b" style="padding:0;Margin:0;width:560px">
                                    <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                                      <tbody>
                                        <!-- Logo & Heading -->
                                        <tr>
                                          <td align="center" class="es-m-p0l es-m-p0r" style="Margin:0;padding:10px 30px 20px">
                                            <a href="${baseUrl}/" target="_blank" style="background-color:#ffffff;border-radius:50%;padding:10px;display:inline-block;margin-bottom:16px;text-decoration:none;">
                                              <img src="https://res.cloudinary.com/dpdira4rd/image/upload/v1794689689/logo-square_gmpkuq.png" alt="Happy Deliveries" height="100" title="Happy Deliveries" class="img-6429" width="100" style="display:block;border:0;outline:none;text-decoration:none;">
                                            </a>
                                            <h1 class="es-m-txt-c" style="Margin:0;font-family:Poppins, Arial, sans-serif;mso-line-height-rule:exactly;letter-spacing:0;font-size:30px;font-style:normal;font-weight:700;line-height:40px;color:#18181B">
                                              Driver Application Received
                                            </h1>
                                          </td>
                                        </tr>

                                        <!-- Personal Greeting & Intro Copy -->
                                        <tr>
                                          <td align="center" class="es-m-p0l es-m-p0r" style="padding:0 25px 20px;Margin:0">
                                            <p style="Margin:0 0 12px;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#18181B;font-size:15px">
                                              Hi <strong style="font-weight:700 !important">${fullName}</strong>,
                                            </p>
                                            <p style="Margin:0;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#18181B;font-size:14px">
                                              Thank you for registering to drive with <strong style="font-weight:700 !important">Happy Deliveries</strong>! Your application has been submitted and is currently <strong style="font-weight:700 !important">Pending Review</strong>.
                                            </p>
                                          </td>
                                        </tr>

                                        <!-- Submitted Details Callout Card -->
                                        <tr>
                                          <td align="center" style="padding:0 25px 25px;Margin:0">
                                            <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="background-color:#FFFFFF;padding:18px 20px;text-align:left;mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                                              <tbody>
                                                <tr>
                                                  <td style="font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#18181B;font-weight:500;padding-bottom:8px;text-align:center;">
                                                    Application Details:
                                                  </td>
                                                </tr>
                                                <tr>
                                                  <td style="padding:4px 0;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#18181B;">
                                                    <strong>Email:</strong> ${driverUser.email}
                                                  </td>
                                                </tr>
                                                <tr>
                                                  <td style="padding:4px 0;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#18181B;">
                                                    <strong>License Number:</strong> ${applicationData.driver_license_number || 'Provided'}
                                                  </td>
                                                </tr>
                                                <tr>
                                                  <td style="padding:4px 0;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#18181B;">
                                                    <strong>Vehicle:</strong> ${vehicleSummary}
                                                  </td>
                                                </tr>
                                                <tr>
                                                  <td style="padding:4px 0;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#18181B;">
                                                    <strong>Registration:</strong> ${applicationData.vehicle_registration || 'Provided'}
                                                  </td>
                                                </tr>
                                              </tbody>
                                            </table>
                                          </td>
                                        </tr>

                                        <!-- Primary CTA Button -->
                                        <tr>
                                          <td align="center" style="padding:0;Margin:0">
                                            <span class="es-button-border msohide" style="border-style:solid;border-color:#18181B;background:#18181B;border-width:0px;display:inline-block;border-radius:40px;width:auto;mso-hide:all">
                                              <a target="_blank" href="${baseUrl}/driver/register" class="es-button" style="mso-style-priority:100 !important;text-decoration:none !important;mso-line-height-rule:exactly;color:#FFFFFF;font-size:16px;font-weight:600;padding:15px 40px;display:inline-block;background:#18181B;border-radius:40px;font-family:Poppins, Arial, sans-serif;font-style:normal;line-height:22px;width:auto;text-align:center;letter-spacing:0;mso-padding-alt:0;mso-border-alt:10px solid #18181B;text-transform:none">Check My Status</a>
                                            </span>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>

                        <!-- App Preview Image -->
                        <tr>
                          <td align="left" style="padding:0;Margin:0">
                            <table width="100%" cellpadding="0" cellspacing="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                              <tbody>
                                <tr>
                                  <td align="center" style="padding:0;Margin:0;width:600px;font-size:0">
                                    <img src="https://res.cloudinary.com/dpdira4rd/image/upload/v1795031568/edited-image-1795031413850_r1pmbx.png" alt="Happy Deliveries Driver App" width="600" title="Happy Deliveries Driver App" class="adapt-img" height="321" style="display:block;font-size:16px;border:0;outline:none;text-decoration:none;margin:0">
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- ================= WHAT HAPPENS NEXT & SUPPORT ================= -->
            <table cellpadding="0" align="center" cellspacing="0" class="es-content" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important">
              <tbody>
                <tr>
                  <td bgcolor="transparent" align="center" style="padding:0;Margin:0">
                    <table cellpadding="0" cellspacing="0" bgcolor="#18181B" align="center" class="es-content-body" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#18181B;width:600px" role="none">
                      <tbody>
                        <!-- What Happens Next -->
                        <tr>
                          <td align="left" style="Margin:0;padding:40px 35px 10px">
                            <h2 style="Margin:0 0 16px;font-family:Poppins, Arial, sans-serif;font-size:20px;font-weight:700;color:#FFCC00;text-align:center;">
                              What happens next:
                            </h2>
                            <p style="Margin:0 0 12px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#E4E4E7;">
                              <span style="color:#FFCC00;">1. Application Review:</span> Our management team will review your driver's license, vehicle details, and payout information.
                            </p>
                            <p style="Margin:0 0 12px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#E4E4E7;">
                              <span style="color:#FFCC00;">2. Approval Notification:</span> You will receive an email as soon as your account is approved (or if any corrections are needed).
                            </p>
                            <p style="Margin:0 0 16px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#E4E4E7;">
                              <span style="color:#FFCC00;">3. Start Driving:</span> Once approved, we will unlock your access to the Driver side of the Happy Deliveries mobile app using your email (<strong style="color:#FFFFFF;">${driverUser.email}</strong>) and password.
                            </p>
                          </td>
                        </tr>

                        <!-- Support CTA Button -->
                        <tr>
                          <td align="center" style="Margin:0;padding:20px 20px 30px">
                            <span class="es-button-border msohide" style="border-style:solid;border-color:#2CB543;background:#FFCC00;border-width:0px;display:inline-block;border-radius:40px;width:auto;mso-hide:all;">
                              <a href="${baseUrl}/" target="_blank" class="es-button" style="mso-style-priority:100 !important;text-decoration:none !important;mso-line-height-rule:exactly;color:#18181B;font-size:16px;font-weight:600;padding:15px 40px;display:inline-block;background:#ffd900;border-radius:40px;font-family:Poppins, Arial, sans-serif;font-style:normal;line-height:22px;width:auto;text-align:center;letter-spacing:0;mso-padding-alt:0;mso-border-alt:10px solid #FFCC00;text-transform:none;">Contact Driver Support</a>
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- ================= FOOTER ================= -->
            <table cellspacing="0" cellpadding="0" align="center" class="es-footer" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
              <tbody>
                <tr>
                  <td align="center" style="padding:0;Margin:0">
                    <table cellspacing="0" cellpadding="0" bgcolor="#18181B" align="center" class="es-footer-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#18181B;width:600px">
                      <tbody>
                        <!-- App Store Badges -->
                        <tr>
                          <td align="left" style="padding:30px 20px 0;Margin:0">
                            <table cellpadding="0" cellspacing="0" class="esdev-mso-table" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:560px">
                              <tbody>
                                <tr>
                                  <!-- Google Play -->
                                  <td valign="top" class="esdev-mso-td" style="padding:0;Margin:0">
                                    <table cellpadding="0" cellspacing="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                                      <tbody>
                                        <tr>
                                          <td align="right" style="padding:0;Margin:0;width:270px;font-size:0">
                                            <a target="_blank" href="${baseUrl}/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#FFFFFF;font-size:14px">
                                              <img src="https://edilabd.stripocdn.email/content/guids/CABINET_e6a4e646c7343a3bc862dcbe5f5594340f36f9df3ab9fbf9aa59d0d388e0186b/images/group_4078300.png" alt="Google Play Store" height="35" title="Google Play Store" width="117" style="display:inline-block;border:0;outline:none;text-decoration:none;margin:0">
                                            </a>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>

                                  <td class="es-m-w0 es-m-p20r" style="padding:0;Margin:0;width:20px"></td>

                                  <!-- Apple App Store -->
                                  <td valign="top" class="esdev-mso-td" style="padding:0;Margin:0">
                                    <table cellpadding="0" cellspacing="0" align="right" class="es-right" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:right">
                                      <tbody>
                                        <tr>
                                          <td align="left" style="padding:0;Margin:0;width:270px;font-size:0">
                                            <a target="_blank" href="${baseUrl}/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#FFFFFF;font-size:14px">
                                              <img src="https://edilabd.stripocdn.email/content/guids/CABINET_e6a4e646c7343a3bc862dcbe5f5594340f36f9df3ab9fbf9aa59d0d388e0186b/images/group.png" alt="Apple App Store" height="35" title="Apple App Store" width="118" style="display:inline-block;border:0;outline:none;text-decoration:none;margin:0">
                                            </a>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>

                        <!-- Sign-off & Dynamic Copyright -->
                        <tr>
                          <td align="center" style="Margin:0;padding:25px 20px 35px">
                            <p style="Margin:0 0 8px;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:21px;color:#A1A1AA;font-size:13px">
                              — Happy Deliveries Management Team
                            </p>
                            <p style="Margin:0;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:21px;color:#FFFFFF;font-size:14px">
                              © ${currentYear} Happy Deliveries. All rights reserved.
                            </p>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

          </td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>`;

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

  static async sendDriverRejectedEmail(driverUser, reason, portalUrl = '/driver/register') {
    const fullName = `${driverUser.first_name || ''} ${driverUser.last_name || ''}`.trim() || 'Driver Applicant';
    const baseUrl = (
      process.env.BASE_URL ||
      process.env.APP_URL ||
      'https://happy-deliveries-api-tq5y.onrender.com'
    ).replace(/\/$/, '');
    const currentYear = new Date().getFullYear();

    const resolvedPortalUrl = /^https?:\/\//i.test(portalUrl)
      ? portalUrl
      : `${baseUrl}${portalUrl.startsWith('/') ? '' : '/'}${portalUrl}`;

    const safeReason = reason || 'Please review your submitted driver details and documents.';
    const subject = 'Update on Your Happy Deliveries Driver Application';

    const text = [
      `Hi ${fullName},`,
      ``,
      `Thank you for applying to become a driver with Happy Deliveries.`,
      `After reviewing your application, we were unable to approve your driver account at this time.`,
      ``,
      `What was wrong / Reason for rejection:`,
      `"${safeReason}"`,
      ``,
      `How to fix this:`,
      `You can visit the Driver Registration Portal (${resolvedPortalUrl} or Check Application Status) using your email (${driverUser.email}) to update the information above and resubmit your application for review.`,
      ``,
      `Best regards,`,
      `Happy Deliveries Management Team`,
    ].join('\n');

    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
<head>
  <meta charset="UTF-8">
  <meta content="width=device-width, initial-scale=1" name="viewport">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta content="telephone=no" name="format-detection">
  <title>${subject}</title>

  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap">

  <style type="text/css">
    u + .body img ~ div div { display: none; }
    #outlook a { padding: 0; }
    span.MsoHyperlink,
    span.MsoHyperlinkFollowed { color: inherit; mso-style-priority: 99; }
    a.es-button { mso-style-priority: 100 !important; text-decoration: none !important; }
    a[x-apple-data-detectors],
    #MessageViewBody a {
      color: inherit !important;
      text-decoration: none !important;
      font-size: inherit !important;
      font-family: inherit !important;
      font-weight: inherit !important;
      line-height: inherit !important;
    }
    .es-desk-hidden {
      display: none;
      float: left;
      overflow: hidden;
      width: 0;
      max-height: 0;
      line-height: 0;
      mso-hide: all;
    }

    @media only screen and (max-width: 600px) {
      .es-m-p15b { padding-bottom: 15px !important; }
      .es-m-p0r { padding-right: 0px !important; }
      .es-m-p20r { padding-right: 20px !important; }
      .es-m-p20b { padding-bottom: 20px !important; }
      .es-m-p0l { padding-left: 0px !important; }
      .es-m-p20l { padding-left: 20px !important; }
      *[class="gmail-fix"] { display: none !important; }
      p, a { line-height: 150% !important; }
      h1, h1 a { line-height: 120% !important; font-size: 28px !important; text-align: center; }
      h2, h2 a { line-height: 120% !important; font-size: 22px !important; }
      .es-header-body p, .es-header-body a,
      .es-content-body p, .es-content-body a,
      .es-footer-body p, .es-footer-body a { font-size: 14px !important; }
      .es-m-txt-c, .es-m-txt-c h1, .es-m-txt-c h2, .es-m-txt-c h3 { text-align: center !important; }
      a.es-button, button.es-button {
        display: inline-block !important;
        font-size: 16px !important;
        padding: 15px 36px !important;
        line-height: 120% !important;
      }
      .es-button-border {
        display: inline-block !important;
        border-style: solid;
        border-color: rgb(44, 181, 67);
        border-width: 0px;
      }
      .es-adaptive table, .es-left, .es-right { width: 100% !important; border-collapse: separate !important; }
      .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header {
        width: 100% !important;
        max-width: 600px !important;
      }
      .adapt-img { width: 100% !important; height: auto !important; }
      .img-6429 { height: 70px !important; width: 70px !important; }
      .es-m-w0 { width: 0px !important; }
    }

    @media screen and (max-width: 384px) {
      .mail-message-content { width: 414px !important; }
    }
  </style>
</head>

<body class="body" style="width:100%;height:100%;font-family:Poppins, Arial, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
  <div dir="ltr" class="es-wrapper-color" lang="en" style="background-color:#F5F5F5">
    <table width="100%" cellspacing="0" cellpadding="0" class="es-wrapper" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%">
      <tbody>
        <tr>
          <td valign="top" style="padding:0;Margin:0">

            <!-- ================= HERO SECTION ================= -->
            <table cellspacing="0" cellpadding="0" align="center" class="es-content" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important">
              <tbody>
                <tr>
                  <td align="center" style="padding:0;Margin:0">
                    <table cellspacing="0" cellpadding="0" bgcolor="#FFCC00" align="center" class="es-content-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFCC00;width:600px">
                      <tbody>
                        <tr>
                          <td align="left" class="es-m-p20b" style="Margin:0;padding:30px 20px 30px">
                            <table width="100%" cellspacing="0" cellpadding="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                              <tbody>
                                <tr>
                                  <td valign="top" align="center" class="es-m-p0r es-m-p20b" style="padding:0;Margin:0;width:560px">
                                    <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                                      <tbody>
                                        <!-- Logo & Heading -->
                                        <tr>
                                          <td align="center" class="es-m-p0l es-m-p0r" style="Margin:0;padding:10px 30px 20px">
                                            <a href="${baseUrl}/" target="_blank" style="background-color:#ffffff;border-radius:50%;padding:10px;display:inline-block;margin-bottom:16px;text-decoration:none;">
                                              <img src="https://res.cloudinary.com/dpdira4rd/image/upload/v1794689689/logo-square_gmpkuq.png" alt="Happy Deliveries" height="100" title="Happy Deliveries" class="img-6429" width="100" style="display:block;border:0;outline:none;text-decoration:none;">
                                            </a>
                                            <h1 class="es-m-txt-c" style="Margin:0;font-family:Poppins, Arial, sans-serif;mso-line-height-rule:exactly;letter-spacing:0;font-size:30px;font-style:normal;font-weight:700;line-height:40px;color:#18181B">
                                              Driver Application Update
                                            </h1>
                                          </td>
                                        </tr>

                                        <!-- Personal Greeting & Intro Copy -->
                                        <tr>
                                          <td align="center" class="es-m-p0l es-m-p0r" style="padding:0 25px 20px;Margin:0">
                                            <p style="Margin:0 0 12px;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#18181B;font-size:15px">
                                              Hi <strong style="font-weight:700 !important">${fullName}</strong>,
                                            </p>
                                            <p style="Margin:0;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#18181B;font-size:14px">
                                              We reviewed your driver registration for <strong style="font-weight:700 !important">Happy Deliveries</strong>, and unfortunately we cannot approve your account yet due to the following issue(s):
                                            </p>
                                          </td>
                                        </tr>

                                        <!-- Rejection Reason Callout Card -->
                                        <tr>
                                          <td align="center" style="padding:0 25px 25px;Margin:0">
                                            <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="background-color:#FEF2F2;padding:18px 20px;text-align:left;mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                                              <tbody>
                                                <tr>
                                                  <td style="font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#991B1B;font-weight:500;padding-bottom:6px;text-align:center;">
                                                    What needs attention:
                                                  </td>
                                                </tr>
                                                <tr>
                                                  <td style="font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#7F1D1D;white-space:pre-line;">
                                                    ${safeReason}
                                                  </td>
                                                </tr>
                                              </tbody>
                                            </table>
                                          </td>
                                        </tr>

                                        <!-- Primary CTA Button -->
                                        <tr>
                                          <td align="center" style="padding:0;Margin:0">
                                            <span class="es-button-border msohide" style="border-style:solid;border-color:#18181B;background:#18181B;border-width:0px;display:inline-block;border-radius:40px;width:auto;mso-hide:all">
                                              <a target="_blank" href="${resolvedPortalUrl}" class="es-button" style="mso-style-priority:100 !important;text-decoration:none !important;mso-line-height-rule:exactly;color:#FFFFFF;font-size:16px;font-weight:600;padding:15px 40px;display:inline-block;background:#18181B;border-radius:40px;font-family:Poppins, Arial, sans-serif;font-style:normal;line-height:22px;width:auto;text-align:center;letter-spacing:0;mso-padding-alt:0;mso-border-alt:10px solid #18181B;text-transform:none">Resubmit Application</a>
                                            </span>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>

                        <!-- App Preview Image -->
                        <tr>
                          <td align="left" style="padding:0;Margin:0">
                            <table width="100%" cellpadding="0" cellspacing="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                              <tbody>
                                <tr>
                                  <td align="center" style="padding:0;Margin:0;width:600px;font-size:0">
                                    <img src="https://res.cloudinary.com/dpdira4rd/image/upload/v1795031568/edited-image-1795031413850_r1pmbx.png" alt="Happy Deliveries Driver App" width="600" title="Happy Deliveries Driver App" class="adapt-img" height="321" style="display:block;font-size:16px;border:0;outline:none;text-decoration:none;margin:0">
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- ================= HOW TO FIX THIS & SUPPORT ================= -->
            <table cellpadding="0" align="center" cellspacing="0" class="es-content" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important">
              <tbody>
                <tr>
                  <td bgcolor="transparent" align="center" style="padding:0;Margin:0">
                    <table cellpadding="0" cellspacing="0" bgcolor="#18181B" align="center" class="es-content-body" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#18181B;width:600px" role="none">
                      <tbody>
                        <!-- How to Fix This -->
                        <tr>
                          <td align="left" style="Margin:0;padding:40px 35px 10px">
                            <h2 style="Margin:0 0 16px;font-family:Poppins, Arial, sans-serif;font-size:20px;font-weight:700;color:#FFCC00;text-align:center;">
                              How to fix this:
                            </h2>
                            <p style="Margin:0 0 12px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#E4E4E7;">
                              <span style="color:#FFCC00;">1. Open the Driver Portal:</span> Visit the <a href="${resolvedPortalUrl}" target="_blank" style="color:#FFCC00;text-decoration:underline;">Driver Registration Web Portal</a> and check your application status using your email (<strong style="color:#FFFFFF;">${driverUser.email}</strong>).
                            </p>
                            <p style="Margin:0 0 12px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#E4E4E7;">
                              <span style="color:#FFCC00;">2. Update Your Details:</span> Correct the issue(s) highlighted above and ensure all required documents and vehicle details are clear and accurate.
                            </p>
                            <p style="Margin:0 0 16px;font-family:Poppins, Arial, sans-serif;font-size:14px;line-height:22px;color:#E4E4E7;">
                              <span style="color:#FFCC00;">3. Resubmit for Review:</span> Submit your updated application so our management team can review your account again.
                            </p>
                          </td>
                        </tr>

                        <!-- Support CTA Button -->
                        <tr>
                          <td align="center" style="Margin:0;padding:20px 20px 30px">
                            <span class="es-button-border msohide" style="border-style:solid;border-color:#2CB543;background:#FFCC00;border-width:0px;display:inline-block;border-radius:40px;width:auto;mso-hide:all;">
                              <a href="${baseUrl}/" target="_blank" class="es-button" style="mso-style-priority:100 !important;text-decoration:none !important;mso-line-height-rule:exactly;color:#18181B;font-size:16px;font-weight:600;padding:15px 40px;display:inline-block;background:#ffd900;border-radius:40px;font-family:Poppins, Arial, sans-serif;font-style:normal;line-height:22px;width:auto;text-align:center;letter-spacing:0;mso-padding-alt:0;mso-border-alt:10px solid #FFCC00;text-transform:none;">Contact Driver Support</a>
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- ================= FOOTER ================= -->
            <table cellspacing="0" cellpadding="0" align="center" class="es-footer" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
              <tbody>
                <tr>
                  <td align="center" style="padding:0;Margin:0">
                    <table cellspacing="0" cellpadding="0" bgcolor="#18181B" align="center" class="es-footer-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#18181B;width:600px">
                      <tbody>
                        <!-- App Store Badges -->
                        <tr>
                          <td align="left" style="padding:30px 20px 0;Margin:0">
                            <table cellpadding="0" cellspacing="0" class="esdev-mso-table" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:560px">
                              <tbody>
                                <tr>
                                  <!-- Google Play -->
                                  <td valign="top" class="esdev-mso-td" style="padding:0;Margin:0">
                                    <table cellpadding="0" cellspacing="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                                      <tbody>
                                        <tr>
                                          <td align="right" style="padding:0;Margin:0;width:270px;font-size:0">
                                            <a target="_blank" href="${baseUrl}/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#FFFFFF;font-size:14px">
                                              <img src="https://edilabd.stripocdn.email/content/guids/CABINET_e6a4e646c7343a3bc862dcbe5f5594340f36f9df3ab9fbf9aa59d0d388e0186b/images/group_4078300.png" alt="Google Play Store" height="35" title="Google Play Store" width="117" style="display:inline-block;border:0;outline:none;text-decoration:none;margin:0">
                                            </a>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>

                                  <td class="es-m-w0 es-m-p20r" style="padding:0;Margin:0;width:20px"></td>

                                  <!-- Apple App Store -->
                                  <td valign="top" class="esdev-mso-td" style="padding:0;Margin:0">
                                    <table cellpadding="0" cellspacing="0" align="right" class="es-right" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:right">
                                      <tbody>
                                        <tr>
                                          <td align="left" style="padding:0;Margin:0;width:270px;font-size:0">
                                            <a target="_blank" href="${baseUrl}/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#FFFFFF;font-size:14px">
                                              <img src="https://edilabd.stripocdn.email/content/guids/CABINET_e6a4e646c7343a3bc862dcbe5f5594340f36f9df3ab9fbf9aa59d0d388e0186b/images/group.png" alt="Apple App Store" height="35" title="Apple App Store" width="118" style="display:inline-block;border:0;outline:none;text-decoration:none;margin:0">
                                            </a>
                                          </td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>

                        <!-- Sign-off & Dynamic Copyright -->
                        <tr>
                          <td align="center" style="Margin:0;padding:25px 20px 35px">
                            <p style="Margin:0 0 8px;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:21px;color:#A1A1AA;font-size:13px">
                              — Happy Deliveries Management Team
                            </p>
                            <p style="Margin:0;mso-line-height-rule:exactly;font-family:Poppins, Arial, sans-serif;line-height:21px;color:#FFFFFF;font-size:14px">
                              © ${currentYear} Happy Deliveries. All rights reserved.
                            </p>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

          </td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>`;

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

  static async sendRestaurantApplicationReceivedEmail(ownerUser, restaurantData = {}) {
    const fullName = `${ownerUser.first_name || ''} ${ownerUser.last_name || ''}`.trim() || 'Restaurant Partner';
    const restaurantName = restaurantData.name || 'Your Restaurant';
    const baseUrl = (
      process.env.BASE_URL ||
      process.env.APP_URL ||
      'https://happy-deliveries-api-tq5y.onrender.com'
    ).replace(/\/$/, '');
    const statusUrl = `${baseUrl}/restaurant/register?tab=status`;
    const currentYear = new Date().getFullYear();

    const subject = `Happy Deliveries — Restaurant Application Received (${restaurantName})`;
    const text = [
      `Hi ${fullName},`,
      ``,
      `Thank you for applying to partner with Happy Deliveries for "${restaurantName}"!`,
      `Your restaurant registration is currently Pending Review by our management team.`,
      ``,
      `Submitted Summary:`,
      `• Restaurant Name: ${restaurantName}`,
      `• Cuisine: ${restaurantData.cuisine_type || 'General'}`,
      `• Address: ${restaurantData.address || 'Provided'}`,
      `• Portal Login Email: ${ownerUser.email}`,
      ``,
      `What happens next:`,
      `1. Happy Deliveries management will review your restaurant profile, address, contact, and payout details.`,
      `2. You will receive an email as soon as your restaurant is approved (or if any corrections are requested).`,
      `3. Once approved, log in to the Restaurant Partner Portal to add menus & menu items, update store info, and manage live orders.`,
      ``,
      `Check status: ${statusUrl}`,
      ``,
      `Best regards,`,
      `Happy Deliveries Management Team`,
    ].join('\n');

    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
 <head>
  <meta charset="UTF-8">
  <meta content="width=device-width, initial-scale=1" name="viewport">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta content="telephone=no" name="format-detection">
  <title>${subject}</title>
  <!--[if (mso 16)]>
    <style type="text/css">
    a {text-decoration: none;}
    </style>
    <![endif]-->
  <!--[if gte mso 9]><style>sup { font-size: 100% !important; }</style><![endif]-->
  <!--[if gte mso 9]>
<noscript>
         <xml>
           <o:OfficeDocumentSettings>
           <o:AllowPNG></o:AllowPNG>
           <o:PixelsPerInch>96</o:PixelsPerInch>
           </o:OfficeDocumentSettings>
         </xml>
      </noscript>
<![endif]-->
  <!--[if mso]><xml>
    <w:WordDocument xmlns:w="urn:schemas-microsoft-com:office:word">
      <w:DontUseAdvancedTypographyReadingMail/>
    </w:WordDocument>
    </xml><![endif]-->
  <!--[if !mso]><!-- -->
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&display=swap">
  <!--<![endif]-->
  <style type="text/css">
    u + .body img ~ div div { display:none; }
    #outlook a { padding:0; }
    span.MsoHyperlink, span.MsoHyperlinkFollowed { color:inherit; mso-style-priority:99; }
    a.es-button { mso-style-priority:100!important; text-decoration:none!important; }
    a[x-apple-data-detectors], #MessageViewBody a {
      color:inherit!important; text-decoration:none!important; font-size:inherit!important; font-family:inherit!important; font-weight:inherit!important; line-height:inherit!important;
    }
    .es-desk-hidden { display:none; float:left; overflow:hidden; width:0; max-height:0; line-height:0; mso-hide:all; }
    @media only screen and (max-width:600px) {
      .es-m-p30r { padding-right:30px!important } .es-m-p30l { padding-left:30px!important } .es-m-p20r { padding-right:20px!important } .es-m-p20b { padding-bottom:20px!important } .es-p-default { padding-right:30px!important; padding-left:30px!important }
      *[class="gmail-fix"] { display:none!important }
      p, a { line-height:150%!important } h1, h1 a { line-height:120%!important } h2, h2 a { line-height:120%!important } h3, h3 a { line-height:120%!important }
      h1 { font-size:32px!important; text-align:left } h2 { font-size:26px!important; text-align:left } h3 { font-size:20px!important; text-align:left }
      .es-header-body p, .es-header-body a, .es-content-body p, .es-content-body a, .es-footer-body p, .es-footer-body a { font-size:14px!important }
      .es-m-txt-c { text-align:center!important }
      a.es-button, button.es-button { display:inline-block!important; font-size:16px!important; padding:15px 30px!important; line-height:120%!important }
      .es-adaptive table, .es-left, .es-right { width:100%!important; border-collapse:separate!important }
      .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header { width:100%!important; max-width:600px!important }
      .adapt-img { width:100%!important; height:auto!important }
      .es-m-w0 { width:0px!important }
    }
    @media screen and (max-width:384px) { .mail-message-content { width:414px!important } }
  </style>
 </head>
 <body class="body" style="width:100%;height:100%;font-family:Figtree, Arial, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
  <div dir="ltr" class="es-wrapper-color" lang="en" style="background-color:#F6F6F6">
   <table width="100%" cellspacing="0" cellpadding="0" class="es-wrapper" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%">
    <tbody>
     <tr>
      <td valign="top" style="padding:0;Margin:0">
       <!-- Header -->
       <table cellspacing="0" cellpadding="0" align="center" class="es-header" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
        <tbody>
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="es-header-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFFFFF;width:600px">
            <tbody>
             <tr>
              <td align="left" class="es-m-p30l es-m-p30r" style="Margin:0;padding:30px 35px">
               <table cellspacing="0" cellpadding="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                <tbody>
                 <tr>
                  <td valign="top" align="center" style="padding:0;Margin:0;width:530px">
                   <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                    <tbody>
                     <tr>
                      <td align="left" style="padding:0;Margin:0;font-size:0">
                       <a target="_blank" href="${baseUrl}/" style="mso-line-height-rule:exactly;text-decoration:none;color:#22372D;font-size:14px;font-weight:bold">
                         <img src="https://res.cloudinary.com/dpdira4rd/image/upload/v1794689689/logo-square_gmpkuq.png" alt="Happy Deliveries" height="40" title="Happy Deliveries" style="display:inline-block;vertical-align:middle;border:0;outline:none;text-decoration:none;margin-right:10px;">
                         <span style="vertical-align:middle;color:#22372D;font-family:Figtree, Arial, sans-serif;font-size:16px;">Happy Deliveries</span>
                       </a>
                      </td>
                     </tr>
                    </tbody>
                   </table>
                  </td>
                 </tr>
                </tbody>
               </table>
              </td>
             </tr>
            </tbody>
           </table>
          </td>
         </tr>
        </tbody>
       </table>

       <!-- Content Body -->
       <table cellspacing="0" cellpadding="0" align="center" class="es-content" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important">
        <tbody>
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="es-content-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFFFFF;width:600px">
            <tbody>
             <tr>
              <td align="left" class="es-m-p30l es-m-p30r" style="padding:10px 35px 30px;Margin:0">
               <table width="100%" cellspacing="0" cellpadding="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                <tbody>
                 <tr>
                  <td valign="top" align="center" style="padding:0;Margin:0;width:530px">
                   <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                    <tbody>
                     <tr>
                      <td align="left" style="padding:0 0 15px;Margin:0">
                       <h1 class="es-m-txt-c" style="Margin:0;font-family:Figtree, Arial, sans-serif;mso-line-height-rule:exactly;letter-spacing:0;font-size:32px;font-style:normal;font-weight:700;line-height:40px;color:#333333">Restaurant Application Received</h1>
                      </td>
                     </tr>
                     <tr>
                      <td align="left" style="padding:0 0 20px;Margin:0">
                       <p style="Margin:0 0 10px;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#22372D;font-size:16px">Hi <strong>${fullName}</strong>,</p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#22372D;font-size:16px">Thank you for registering <strong>${restaurantName}</strong> with <strong>Happy Deliveries</strong>! Your application has been submitted and is currently <strong style="color:#D97706;">Pending Review</strong>.</p>
                      </td>
                     </tr>

                     <!-- Submitted Details Summary Card Box -->
                     <tr>
                      <td align="left" style="padding:0 0 25px;Margin:0">
                       <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="background-color:#F9FAFB;border:1px solid #E5E7EB;border-radius:12px;padding:18px 20px;">
                        <tbody>
                         <tr>
                          <td style="padding:5px 0;font-family:Figtree, Arial, sans-serif;font-size:14px;color:#22372D;"><strong>Restaurant Name:</strong> ${restaurantName}</td>
                         </tr>
                         <tr>
                          <td style="padding:5px 0;font-family:Figtree, Arial, sans-serif;font-size:14px;color:#22372D;"><strong>Cuisine:</strong> ${restaurantData.cuisine_type || 'General'}</td>
                         </tr>
                         <tr>
                          <td style="padding:5px 0;font-family:Figtree, Arial, sans-serif;font-size:14px;color:#22372D;"><strong>Address:</strong> ${restaurantData.address || 'Provided'}</td>
                         </tr>
                         <tr>
                          <td style="padding:5px 0;font-family:Figtree, Arial, sans-serif;font-size:14px;color:#22372D;"><strong>Portal Login Email:</strong> ${ownerUser.email}</td>
                         </tr>
                        </tbody>
                       </table>
                      </td>
                     </tr>

                     <!-- What Happens Next Section -->
                     <tr>
                      <td align="left" style="padding:0 0 25px;Margin:0">
                       <h3 style="Margin:0 0 10px;font-family:Figtree, Arial, sans-serif;font-size:20px;font-weight:700;color:#333333;">What happens next:</h3>
                       <p style="Margin:0 0 8px;font-family:Figtree, Arial, sans-serif;font-size:15px;line-height:22px;color:#22372D;"><strong>1. Profile Review:</strong> Happy Deliveries management will review your restaurant profile, address, contact, and payout details.</p>
                       <p style="Margin:0 0 8px;font-family:Figtree, Arial, sans-serif;font-size:15px;line-height:22px;color:#22372D;"><strong>2. Approval Notification:</strong> You will receive an email as soon as your restaurant is approved (or if any corrections are requested).</p>
                       <p style="Margin:0;font-family:Figtree, Arial, sans-serif;font-size:15px;line-height:22px;color:#22372D;"><strong>3. Launch Menus:</strong> Once approved, log in to the Restaurant Partner Portal to add menus & menu items, update store info, and manage live orders.</p>
                      </td>
                     </tr>

                     <!-- CTA Button -->
                     <tr>
                      <td align="center" style="padding:10px 0 10px;Margin:0">
                       <span class="es-button-border" style="border-style:solid;border-color:#22372D;background:#F6C46B;border-width:0px;display:inline-block;border-radius:30px;width:auto;">
                        <a target="_blank" href="${statusUrl}" class="es-button" style="mso-style-priority:100 !important;text-decoration:none !important;mso-line-height-rule:exactly;color:#22372D;font-size:16px;font-weight:bold;padding:12px 30px;display:inline-block;background:#F6C46B;border-radius:30px;font-family:Figtree, Arial, sans-serif;font-style:normal;line-height:20px;width:auto;text-align:center;">Check Application Status</a>
                       </span>
                      </td>
                     </tr>

                    </tbody>
                   </table>
                  </td>
                 </tr>
                </tbody>
               </table>
              </td>
             </tr>
            </tbody>
           </table>
          </td>
         </tr>
        </tbody>
       </table>

       <!-- Footer -->
       <table cellspacing="0" cellpadding="0" align="center" class="es-footer" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
        <tbody>
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#22372D" align="center" class="es-footer-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#22372D;width:600px">
            <tbody>
             <tr>
              <td align="left" style="padding:35px;Margin:0">
               <table cellspacing="0" cellpadding="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                <tbody>
                 <tr>
                  <td align="left" class="es-m-p20b" style="padding:0;Margin:0;width:530px">
                   <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                    <tbody>
                     <tr>
                      <td align="center" style="padding:0 0 15px;Margin:0;font-size:0">
                       <img height="30" src="https://edilabd.stripocdn.email/content/guids/CABINET_ad6e46f1c6584c913ff80985bc5248a8dadc669c45f024533ac8cbb33e2ed7d5/images/group_4078363.png" alt="Happy Deliveries" title="Happy Deliveries" style="display:block;font-size:18px;border:0;outline:none;text-decoration:none;margin:0">
                      </td>
                     </tr>
                     <tr>
                      <td align="center" style="padding:0;Margin:0">
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px">Need help? Contact us anytime at <a target="_blank" href="mailto:support@happydeliveries.co.za" style="mso-line-height-rule:exactly;text-decoration:underline;color:#FFFFFF;font-size:14px;font-weight:inherit">support@happydeliveries.co.za</a></p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px"><br></p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px">Happy Deliveries — Nelspruit, South Africa</p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px"><br></p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px">© ${currentYear} Happy Deliveries. All rights reserved.</p>
                      </td>
                     </tr>
                    </tbody>
                   </table>
                  </td>
                 </tr>
                </tbody>
               </table>
              </td>
             </tr>
            </tbody>
           </table>
          </td>
         </tr>
        </tbody>
       </table>
      </td>
     </tr>
    </tbody>
   </table>
  </div>
 </body>
</html>`;

    return this.sendEmail({
      to: ownerUser.email,
      subject,
      text,
      html,
      userId: ownerUser.id,
      userType: 'restaurant_manager',
      metadata: { type: 'restaurant_application_submitted', restaurant_name: restaurantName },
    });
  }

  static async sendRestaurantApprovedEmail(ownerUser, restaurant = {}, notes = '', portalUrl = '/restaurant/login') {
    const fullName = `${ownerUser.first_name || ''} ${ownerUser.last_name || ''}`.trim() || 'Restaurant Partner';
    const restaurantName = restaurant.name || 'Your Restaurant';
    const baseUrl = (
      process.env.BASE_URL ||
      process.env.APP_URL ||
      'https://happy-deliveries-api-tq5y.onrender.com'
    ).replace(/\/$/, '');
    const currentYear = new Date().getFullYear();

    const resolvedPortalUrl = /^https?:\/\//i.test(portalUrl)
      ? portalUrl
      : `${baseUrl}${portalUrl.startsWith('/') ? '' : '/'}${portalUrl}`;

    const subject = `🎉 Congratulations! ${restaurantName} is Approved on Happy Deliveries`;
    const text = [
      `Hi ${fullName},`,
      ``,
      `Congratulations! Your restaurant partner application for "${restaurantName}" has been APPROVED by Happy Deliveries management. We are thrilled to welcome you to the team!`,
      notes ? `\nManager Note: ${notes}\n` : '',
      `You can now log in to your Restaurant Partner Portal (${resolvedPortalUrl}) using:`,
      `• Email: ${ownerUser.email}`,
      `• Password: The password you created during registration`,
      ``,
      `Inside your portal, you can add your menus and menu items, update store hours & details, accept or reject incoming orders, and track assigned drivers live.`,
      ``,
      `Welcome aboard!`,
      `Happy Deliveries Management Team`,
    ].filter(Boolean).join('\n');

    const notesRowHtml = notes
      ? `
                         <tr>
                          <td style="padding:10px 0 4px;font-family:Figtree, Arial, sans-serif;font-size:14px;line-height:22px;color:#166534;border-top:1px solid #BBF7D0;white-space:pre-line;">
                            <strong>Note from Management:</strong><br/>${notes}
                          </td>
                         </tr>`
      : '';

    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
 <head>
  <meta charset="UTF-8">
  <meta content="width=device-width, initial-scale=1" name="viewport">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta content="telephone=no" name="format-detection">
  <title>${subject}</title>
  <!--[if (mso 16)]>
    <style type="text/css">
    a {text-decoration: none;}
    </style>
    <![endif]-->
  <!--[if gte mso 9]><style>sup { font-size: 100% !important; }</style><![endif]-->
  <!--[if gte mso 9]>
<noscript>
         <xml>
           <o:OfficeDocumentSettings>
           <o:AllowPNG></o:AllowPNG>
           <o:PixelsPerInch>96</o:PixelsPerInch>
           </o:OfficeDocumentSettings>
         </xml>
      </noscript>
<![endif]-->
  <!--[if mso]><xml>
    <w:WordDocument xmlns:w="urn:schemas-microsoft-com:office:word">
      <w:DontUseAdvancedTypographyReadingMail/>
    </w:WordDocument>
    </xml><![endif]-->
  <!--[if !mso]><!-- -->
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&display=swap">
  <!--<![endif]-->
  <style type="text/css">
    u + .body img ~ div div { display:none; }
    #outlook a { padding:0; }
    span.MsoHyperlink, span.MsoHyperlinkFollowed { color:inherit; mso-style-priority:99; }
    a.es-button { mso-style-priority:100!important; text-decoration:none!important; }
    a[x-apple-data-detectors], #MessageViewBody a {
      color:inherit!important; text-decoration:none!important; font-size:inherit!important; font-family:inherit!important; font-weight:inherit!important; line-height:inherit!important;
    }
    .es-desk-hidden { display:none; float:left; overflow:hidden; width:0; max-height:0; line-height:0; mso-hide:all; }
    @media only screen and (max-width:600px) {
      .es-m-p30r { padding-right:30px!important } .es-m-p30l { padding-left:30px!important } .es-m-p20r { padding-right:20px!important } .es-m-p20b { padding-bottom:20px!important } .es-p-default { padding-right:30px!important; padding-left:30px!important }
      *[class="gmail-fix"] { display:none!important }
      p, a { line-height:150%!important } h1, h1 a { line-height:120%!important } h2, h2 a { line-height:120%!important } h3, h3 a { line-height:120%!important }
      h1 { font-size:30px!important; text-align:left } h2 { font-size:26px!important; text-align:left } h3 { font-size:20px!important; text-align:left }
      .es-header-body p, .es-header-body a, .es-content-body p, .es-content-body a, .es-footer-body p, .es-footer-body a { font-size:14px!important }
      .es-m-txt-c { text-align:center!important }
      a.es-button, button.es-button { display:inline-block!important; font-size:16px!important; padding:15px 30px!important; line-height:120%!important }
      .es-adaptive table, .es-left, .es-right { width:100%!important; border-collapse:separate!important }
      .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header { width:100%!important; max-width:600px!important }
      .adapt-img { width:100%!important; height:auto!important }
      .es-m-w0 { width:0px!important }
    }
    @media screen and (max-width:384px) { .mail-message-content { width:414px!important } }
  </style>
 </head>
 <body class="body" style="width:100%;height:100%;font-family:Figtree, Arial, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
  <div dir="ltr" class="es-wrapper-color" lang="en" style="background-color:#F6F6F6">
   <table width="100%" cellspacing="0" cellpadding="0" class="es-wrapper" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%">
    <tbody>
     <tr>
      <td valign="top" style="padding:0;Margin:0">
       <!-- Header -->
       <table cellspacing="0" cellpadding="0" align="center" class="es-header" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
        <tbody>
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="es-header-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFFFFF;width:600px">
            <tbody>
             <tr>
              <td align="left" class="es-m-p30l es-m-p30r" style="Margin:0;padding:30px 35px">
               <table cellspacing="0" cellpadding="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                <tbody>
                 <tr>
                  <td valign="top" align="center" style="padding:0;Margin:0;width:530px">
                   <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                    <tbody>
                     <tr>
                      <td align="left" style="padding:0;Margin:0;font-size:0">
                       <a target="_blank" href="${baseUrl}/" style="mso-line-height-rule:exactly;text-decoration:none;color:#22372D;font-size:14px;font-weight:bold">
                         <img src="https://res.cloudinary.com/dpdira4rd/image/upload/v1794689689/logo-square_gmpkuq.png" alt="Happy Deliveries" height="40" title="Happy Deliveries" style="display:inline-block;vertical-align:middle;border:0;outline:none;text-decoration:none;margin-right:10px;">
                         <span style="vertical-align:middle;color:#22372D;font-family:Figtree, Arial, sans-serif;font-size:16px;">Happy Deliveries</span>
                       </a>
                      </td>
                     </tr>
                    </tbody>
                   </table>
                  </td>
                 </tr>
                </tbody>
               </table>
              </td>
             </tr>
            </tbody>
           </table>
          </td>
         </tr>
        </tbody>
       </table>

       <!-- Content Body -->
       <table cellspacing="0" cellpadding="0" align="center" class="es-content" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important">
        <tbody>
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="es-content-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFFFFF;width:600px">
            <tbody>
             <tr>
              <td align="left" class="es-m-p30l es-m-p30r" style="padding:10px 35px 30px;Margin:0">
               <table width="100%" cellspacing="0" cellpadding="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                <tbody>
                 <tr>
                  <td valign="top" align="center" style="padding:0;Margin:0;width:530px">
                   <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                    <tbody>
                     <!-- Approval Badge & Heading -->
                     <tr>
                      
                     </tr>
                     <tr>
                      <td align="left" style="padding:0 0 15px;Margin:0">
                       <h1 class="es-m-txt-c" style="Margin:0;font-family:Figtree, Arial, sans-serif;mso-line-height-rule:exactly;letter-spacing:0;font-size:32px;font-style:normal;font-weight:700;line-height:40px;color:#333333">Congratulations! ${restaurantName} is Live</h1>
                      </td>
                     </tr>
                     <tr>
                      <td align="left" style="padding:0 0 20px;Margin:0">
                       <p style="Margin:0 0 10px;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#22372D;font-size:16px">Hi <strong>${fullName}</strong>,</p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#22372D;font-size:16px">Great news! Your restaurant partner application for <strong>${restaurantName}</strong> has been officially <strong style="color:#166534;">approved</strong> by Happy Deliveries management. We are thrilled to welcome you to our partner network!</p>
                      </td>
                     </tr>

                     <!-- Portal Credentials & Optional Manager Note Card -->
                     <tr>
                      <td align="left" style="padding:0 0 25px;Margin:0">
                       <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="background-color:#F0FDF4;padding:18px 20px;">
                        <tbody>
                         <tr>
                          <td style="padding:0 0 8px;font-family:Figtree, Arial, sans-serif;font-size:15px;font-weight:700;color:#166534;">Your Restaurant Partner Portal Credentials:</td>
                         </tr>
                         <tr>
                          <td style="padding:4px 0;font-family:Figtree, Arial, sans-serif;font-size:14px;color:#14532D;"><strong>Email:</strong> ${ownerUser.email}</td>
                         </tr>
                         <tr>
                          <td style="padding:4px 0;font-family:Figtree, Arial, sans-serif;font-size:14px;color:#14532D;"><strong>Password:</strong> The password you created during registration</td>
                         </tr>${notesRowHtml}
                        </tbody>
                       </table>
                      </td>
                     </tr>

                     <!-- Getting Started Section -->
                     <tr>
                      <td align="left" style="padding:0 0 25px;Margin:0">
                       <h3 style="Margin:0 0 10px;font-family:Figtree, Arial, sans-serif;font-size:20px;font-weight:700;color:#333333;">What you can do inside your portal:</h3>
                       <p style="Margin:0 0 8px;font-family:Figtree, Arial, sans-serif;font-size:15px;line-height:22px;color:#22372D;"><strong>1. Build Your Menu:</strong> Add categories, dishes, pricing, and photos so customers can start ordering.</p>
                       <p style="Margin:0 0 8px;font-family:Figtree, Arial, sans-serif;font-size:15px;line-height:22px;color:#22372D;"><strong>2. Manage Store Details:</strong> Update your operating hours, preparation times, and availability anytime.</p>
                       <p style="Margin:0;font-family:Figtree, Arial, sans-serif;font-size:15px;line-height:22px;color:#22372D;"><strong>3. Fulfill Live Orders:</strong> Accept incoming customer orders and track assigned delivery drivers in real time.</p>
                      </td>
                     </tr>

                     <!-- CTA Button -->
                     <tr>
                      <td align="center" style="padding:10px 0 10px;Margin:0">
                       <span class="es-button-border" style="border-style:solid;border-color:#22372D;background:#F6C46B;border-width:0px;display:inline-block;border-radius:30px;width:auto;">
                        <a target="_blank" href="${resolvedPortalUrl}" class="es-button" style="mso-style-priority:100 !important;text-decoration:none !important;mso-line-height-rule:exactly;color:#22372D;font-size:16px;font-weight:bold;padding:12px 32px;display:inline-block;background:#F6C46B;border-radius:30px;font-family:Figtree, Arial, sans-serif;font-style:normal;line-height:20px;width:auto;text-align:center;">Sign In to Partner Portal</a>
                       </span>
                      </td>
                     </tr>

                    </tbody>
                   </table>
                  </td>
                 </tr>
                </tbody>
               </table>
              </td>
             </tr>
            </tbody>
           </table>
          </td>
         </tr>
        </tbody>
       </table>

       <!-- Footer -->
       <table cellspacing="0" cellpadding="0" align="center" class="es-footer" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
        <tbody>
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#22372D" align="center" class="es-footer-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#22372D;width:600px">
            <tbody>
             <tr>
              <td align="left" style="padding:35px;Margin:0">
               <table cellspacing="0" cellpadding="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                <tbody>
                 <tr>
                  <td align="left" class="es-m-p20b" style="padding:0;Margin:0;width:530px">
                   <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                    <tbody>
                     <tr>
                      <td align="center" style="padding:0 0 15px;Margin:0;font-size:0">
                       <img height="30" src="https://edilabd.stripocdn.email/content/guids/CABINET_ad6e46f1c6584c913ff80985bc5248a8dadc669c45f024533ac8cbb33e2ed7d5/images/group_4078363.png" alt="Happy Deliveries" title="Happy Deliveries" style="display:block;font-size:18px;border:0;outline:none;text-decoration:none;margin:0">
                      </td>
                     </tr>
                     <tr>
                      <td align="center" style="padding:0;Margin:0">
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px">Need help? Contact us anytime at <a target="_blank" href="mailto:support@happydeliveries.co.za" style="mso-line-height-rule:exactly;text-decoration:underline;color:#FFFFFF;font-size:14px;font-weight:inherit">support@happydeliveries.co.za</a></p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px"><br></p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px">Happy Deliveries — Nelspruit, South Africa</p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px"><br></p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px">© ${currentYear} Happy Deliveries. All rights reserved.</p>
                      </td>
                     </tr>
                    </tbody>
                   </table>
                  </td>
                 </tr>
                </tbody>
               </table>
              </td>
             </tr>
            </tbody>
           </table>
          </td>
         </tr>
        </tbody>
       </table>
      </td>
     </tr>
    </tbody>
   </table>
  </div>
 </body>
</html>`;

    return this.sendEmail({
      to: ownerUser.email,
      subject,
      text,
      html,
      userId: ownerUser.id,
      userType: 'restaurant_manager',
      metadata: { type: 'restaurant_application_approved', restaurant_id: restaurant.id, notes },
    });
  }

  static async sendRestaurantRejectedEmail(ownerUser, restaurant = {}, reason = '', portalUrl = '/restaurant/register') {
    const fullName = `${ownerUser.first_name || ''} ${ownerUser.last_name || ''}`.trim() || 'Restaurant Partner';
    const restaurantName = restaurant.name || 'Your Restaurant';
    const baseUrl = (
      process.env.BASE_URL ||
      process.env.APP_URL ||
      'https://happy-deliveries-api-tq5y.onrender.com'
    ).replace(/\/$/, '');
    const currentYear = new Date().getFullYear();

    const resolvedPortalUrl = /^https?:\/\//i.test(portalUrl)
      ? portalUrl
      : `${baseUrl}${portalUrl.startsWith('/') ? '' : '/'}${portalUrl}`;

    const safeReason = reason || 'Please review your submitted restaurant details and required documents.';
    const subject = `Update on Your Happy Deliveries Restaurant Application (${restaurantName})`;

    const text = [
      `Hi ${fullName},`,
      ``,
      `Thank you for applying to list "${restaurantName}" on Happy Deliveries.`,
      `After reviewing your submission, we could not approve the restaurant yet.`,
      ``,
      `Reason / What needs attention:`,
      `"${safeReason}"`,
      ``,
      `How to fix & resubmit:`,
      `Visit the Restaurant Registration Portal (${resolvedPortalUrl}) and open "Check Application Status" with your email (${ownerUser.email}) to edit your details and resubmit for review.`,
      ``,
      `Best regards,`,
      `Happy Deliveries Management Team`,
    ].join('\n');

    const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
 <head>
  <meta charset="UTF-8">
  <meta content="width=device-width, initial-scale=1" name="viewport">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta content="telephone=no" name="format-detection">
  <title>${subject}</title>
  <!--[if (mso 16)]>
    <style type="text/css">
    a {text-decoration: none;}
    </style>
    <![endif]-->
  <!--[if gte mso 9]><style>sup { font-size: 100% !important; }</style><![endif]-->
  <!--[if gte mso 9]>
<noscript>
         <xml>
           <o:OfficeDocumentSettings>
           <o:AllowPNG></o:AllowPNG>
           <o:PixelsPerInch>96</o:PixelsPerInch>
           </o:OfficeDocumentSettings>
         </xml>
      </noscript>
<![endif]-->
  <!--[if mso]><xml>
    <w:WordDocument xmlns:w="urn:schemas-microsoft-com:office:word">
      <w:DontUseAdvancedTypographyReadingMail/>
    </w:WordDocument>
    </xml><![endif]-->
  <!--[if !mso]><!-- -->
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&display=swap">
  <!--<![endif]-->
  <style type="text/css">
    u + .body img ~ div div { display:none; }
    #outlook a { padding:0; }
    span.MsoHyperlink, span.MsoHyperlinkFollowed { color:inherit; mso-style-priority:99; }
    a.es-button { mso-style-priority:100!important; text-decoration:none!important; }
    a[x-apple-data-detectors], #MessageViewBody a {
      color:inherit!important; text-decoration:none!important; font-size:inherit!important; font-family:inherit!important; font-weight:inherit!important; line-height:inherit!important;
    }
    .es-desk-hidden { display:none; float:left; overflow:hidden; width:0; max-height:0; line-height:0; mso-hide:all; }
    @media only screen and (max-width:600px) {
      .es-m-p30r { padding-right:30px!important } .es-m-p30l { padding-left:30px!important } .es-m-p20r { padding-right:20px!important } .es-m-p20b { padding-bottom:20px!important } .es-p-default { padding-right:30px!important; padding-left:30px!important }
      *[class="gmail-fix"] { display:none!important }
      p, a { line-height:150%!important } h1, h1 a { line-height:120%!important } h2, h2 a { line-height:120%!important } h3, h3 a { line-height:120%!important }
      h1 { font-size:30px!important; text-align:left } h2 { font-size:26px!important; text-align:left } h3 { font-size:20px!important; text-align:left }
      .es-header-body p, .es-header-body a, .es-content-body p, .es-content-body a, .es-footer-body p, .es-footer-body a { font-size:14px!important }
      .es-m-txt-c { text-align:center!important }
      a.es-button, button.es-button { display:inline-block!important; font-size:16px!important; padding:15px 30px!important; line-height:120%!important }
      .es-adaptive table, .es-left, .es-right { width:100%!important; border-collapse:separate!important }
      .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header { width:100%!important; max-width:600px!important }
      .adapt-img { width:100%!important; height:auto!important }
      .es-m-w0 { width:0px!important }
    }
    @media screen and (max-width:384px) { .mail-message-content { width:414px!important } }
  </style>
 </head>
 <body class="body" style="width:100%;height:100%;font-family:Figtree, Arial, sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;padding:0;Margin:0">
  <div dir="ltr" class="es-wrapper-color" lang="en" style="background-color:#F6F6F6">
   <table width="100%" cellspacing="0" cellpadding="0" class="es-wrapper" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;padding:0;Margin:0;width:100%;height:100%">
    <tbody>
     <tr>
      <td valign="top" style="padding:0;Margin:0">
       <!-- Header -->
       <table cellspacing="0" cellpadding="0" align="center" class="es-header" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
        <tbody>
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="es-header-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFFFFF;width:600px">
            <tbody>
             <tr>
              <td align="left" class="es-m-p30l es-m-p30r" style="Margin:0;padding:30px 35px">
               <table cellspacing="0" cellpadding="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                <tbody>
                 <tr>
                  <td valign="top" align="center" style="padding:0;Margin:0;width:530px">
                   <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                    <tbody>
                     <tr>
                      <td align="left" style="padding:0;Margin:0;font-size:0">
                       <a target="_blank" href="${baseUrl}/" style="mso-line-height-rule:exactly;text-decoration:none;color:#22372D;font-size:14px;font-weight:bold">
                         <img src="https://res.cloudinary.com/dpdira4rd/image/upload/v1794689689/logo-square_gmpkuq.png" alt="Happy Deliveries" height="40" title="Happy Deliveries" style="display:inline-block;vertical-align:middle;border:0;outline:none;text-decoration:none;margin-right:10px;">
                         <span style="vertical-align:middle;color:#22372D;font-family:Figtree, Arial, sans-serif;font-size:16px;">Happy Deliveries</span>
                       </a>
                      </td>
                     </tr>
                    </tbody>
                   </table>
                  </td>
                 </tr>
                </tbody>
               </table>
              </td>
             </tr>
            </tbody>
           </table>
          </td>
         </tr>
        </tbody>
       </table>

       <!-- Content Body -->
       <table cellspacing="0" cellpadding="0" align="center" class="es-content" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important">
        <tbody>
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="es-content-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFFFFF;width:600px">
            <tbody>
             <tr>
              <td align="left" class="es-m-p30l es-m-p30r" style="padding:10px 35px 30px;Margin:0">
               <table width="100%" cellspacing="0" cellpadding="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                <tbody>
                 <tr>
                  <td valign="top" align="center" style="padding:0;Margin:0;width:530px">
                   <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                    <tbody>
                     <!-- Action Required Badge & Heading -->
                     <tr>
                      
                     </tr>
                     <tr>
                      <td align="left" style="padding:0 0 15px;Margin:0">
                       <h1 class="es-m-txt-c" style="Margin:0;font-family:Figtree, Arial, sans-serif;mso-line-height-rule:exactly;letter-spacing:0;font-size:32px;font-style:normal;font-weight:700;line-height:40px;color:#333333">Application Update for ${restaurantName}</h1>
                      </td>
                     </tr>
                     <tr>
                      <td align="left" style="padding:0 0 20px;Margin:0">
                       <p style="Margin:0 0 10px;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#22372D;font-size:16px">Hi <strong>${fullName}</strong>,</p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:24px;letter-spacing:0;font-weight:normal;color:#22372D;font-size:16px">We reviewed your restaurant application for <strong>Happy Deliveries</strong>, and unfortunately it cannot be approved yet due to the following:</p>
                      </td>
                     </tr>

                     <!-- Rejection Reason Callout Card -->
                     <tr>
                      <td align="left" style="padding:0 0 25px;Margin:0">
                       <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="background-color:#FEF2F2;padding:18px 20px;">
                        <tbody>
                         <tr>
                          <td style="padding:0 0 6px;font-family:Figtree, Arial, sans-serif;font-size:14px;font-weight:700;color:#991B1B;">What needs attention:</td>
                         </tr>
                         <tr>
                          <td style="font-family:Figtree, Arial, sans-serif;font-size:14px;line-height:22px;color:#7F1D1D;white-space:pre-line;">${safeReason}</td>
                         </tr>
                        </tbody>
                       </table>
                      </td>
                     </tr>

                     <!-- How to Fix & Resubmit Section -->
                     <tr>
                      <td align="left" style="padding:0 0 25px;Margin:0">
                       <h3 style="Margin:0 0 10px;font-family:Figtree, Arial, sans-serif;font-size:20px;font-weight:700;color:#333333;">How to fix & resubmit:</h3>
                       <p style="Margin:0 0 8px;font-family:Figtree, Arial, sans-serif;font-size:15px;line-height:22px;color:#22372D;"><strong>1. Open Status Checker:</strong> Visit the <a href="${resolvedPortalUrl}" target="_blank" style="color:#22372D;text-decoration:underline;font-weight:600;">Restaurant Registration Portal</a> and click <strong>Check Application Status</strong> using <strong>${ownerUser.email}</strong>.</p>
                       <p style="Margin:0 0 8px;font-family:Figtree, Arial, sans-serif;font-size:15px;line-height:22px;color:#22372D;"><strong>2. Update Details:</strong> Correct the items highlighted above and ensure all store and payout details are accurate.</p>
                       <p style="Margin:0;font-family:Figtree, Arial, sans-serif;font-size:15px;line-height:22px;color:#22372D;"><strong>3. Resubmit:</strong> Save and resubmit your application so our management team can review it again.</p>
                      </td>
                     </tr>

                     <!-- CTA Button -->
                     <tr>
                      <td align="center" style="padding:10px 0 10px;Margin:0">
                       <span class="es-button-border" style="border-style:solid;border-color:#22372D;background:#F6C46B;border-width:0px;display:inline-block;border-radius:30px;width:auto;">
                        <a target="_blank" href="${resolvedPortalUrl}" class="es-button" style="mso-style-priority:100 !important;text-decoration:none !important;mso-line-height-rule:exactly;color:#22372D;font-size:16px;font-weight:bold;padding:12px 32px;display:inline-block;background:#F6C46B;border-radius:30px;font-family:Figtree, Arial, sans-serif;font-style:normal;line-height:20px;width:auto;text-align:center;">Update & Resubmit Application</a>
                       </span>
                      </td>
                     </tr>

                    </tbody>
                   </table>
                  </td>
                 </tr>
                </tbody>
               </table>
              </td>
             </tr>
            </tbody>
           </table>
          </td>
         </tr>
        </tbody>
       </table>

       <!-- Footer -->
       <table cellspacing="0" cellpadding="0" align="center" class="es-footer" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
        <tbody>
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#22372D" align="center" class="es-footer-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#22372D;width:600px">
            <tbody>
             <tr>
              <td align="left" style="padding:35px;Margin:0">
               <table cellspacing="0" cellpadding="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                <tbody>
                 <tr>
                  <td align="left" class="es-m-p20b" style="padding:0;Margin:0;width:530px">
                   <table width="100%" cellspacing="0" cellpadding="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                    <tbody>
                     <tr>
                      <td align="center" style="padding:0 0 15px;Margin:0;font-size:0">
                       <img height="30" src="https://edilabd.stripocdn.email/content/guids/CABINET_ad6e46f1c6584c913ff80985bc5248a8dadc669c45f024533ac8cbb33e2ed7d5/images/group_4078363.png" alt="Happy Deliveries" title="Happy Deliveries" style="display:block;font-size:18px;border:0;outline:none;text-decoration:none;margin:0">
                      </td>
                     </tr>
                     <tr>
                      <td align="center" style="padding:0;Margin:0">
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px">Need help? Contact us anytime at <a target="_blank" href="mailto:support@happydeliveries.co.za" style="mso-line-height-rule:exactly;text-decoration:underline;color:#FFFFFF;font-size:14px;font-weight:inherit">support@happydeliveries.co.za</a></p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px"><br></p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px">Happy Deliveries — Nelspruit, South Africa</p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px"><br></p>
                       <p style="Margin:0;mso-line-height-rule:exactly;font-family:Figtree, Arial, sans-serif;line-height:21px;letter-spacing:0;font-weight:normal;color:#FFFFFF;font-size:14px">© ${currentYear} Happy Deliveries. All rights reserved.</p>
                      </td>
                     </tr>
                    </tbody>
                   </table>
                  </td>
                 </tr>
                </tbody>
               </table>
              </td>
             </tr>
            </tbody>
           </table>
          </td>
         </tr>
        </tbody>
       </table>
      </td>
     </tr>
    </tbody>
   </table>
  </div>
 </body>
</html>`;

    return this.sendEmail({
      to: ownerUser.email,
      subject,
      text,
      html,
      userId: ownerUser.id,
      userType: 'restaurant_manager',
      metadata: { type: 'restaurant_application_rejected', restaurant_id: restaurant.id, reason },
    });
  }

  static async sendEmailVerificationEmail(user, { code, verifyUrl, portalLabel = 'Happy Deliveries' } = {}) {
    const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'There';
    const subject = 'Verify Your Email Address — Happy Deliveries';
    const text = [
      `Hi ${fullName},`,
      ``,
      `Welcome to ${portalLabel}! Before your account can become active, please verify your email address.`,
      ``,
      code ? `Your 6-digit verification code: ${code}` : '',
      verifyUrl ? `Or click this link to verify immediately: ${verifyUrl}` : '',
      ``,
      `This verification code and link expire in 24 hours.`,
      `If you did not create this account, you can safely ignore this email.`,
      ``,
      `— Happy Deliveries Team`,
    ]
      .filter(Boolean)
      .join('\n');

    const html = `
      <div style="font-family: Inter, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; color: #111827;">
        <div style="display:inline-block; background:#fef3c7; color:#92400e; padding:6px 12px; border-radius:999px; font-weight:700; font-size:12px; margin-bottom:12px;">
          EMAIL VERIFICATION REQUIRED
        </div>
        <h2 style="color: #18181b; margin-top: 0;">Verify your email for Happy Deliveries</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Please verify your email address (<strong>${user.email}</strong>) before your account can be activated.</p>
        ${code ? `
          <div style="background: #f9fafb; border: 1px dashed #d4d4d8; padding: 16px; border-radius: 10px; text-align: center; margin: 18px 0;">
            <div style="font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700;">Verification Code</div>
            <div style="font-size: 30px; font-weight: 900; letter-spacing: 8px; color: #18181b; margin-top: 6px;">${code}</div>
          </div>
        ` : ''}
        ${verifyUrl ? `
          <div style="text-align: center; margin: 22px 0;">
            <a href="${verifyUrl}" style="display: inline-block; background: #FFCC00; color: #18181b; font-weight: 800; text-decoration: none; padding: 13px 26px; border-radius: 10px; font-size: 15px;">
              Verify My Email Address
            </a>
          </div>
          <p style="font-size: 12px; color: #6b7280; word-break: break-all;">Or open: ${verifyUrl}</p>
        ` : ''}
        <p style="color: #6b7280; font-size: 12.5px; margin-top: 24px;">Expires in 24 hours · — Happy Deliveries Team</p>
      </div>
    `;

    return this.sendEmail({
      to: user.email,
      subject,
      text,
      html,
      userId: user.id,
      userType: user.role || 'customer',
      metadata: { type: 'email_verification', role: user.role || 'customer' },
    });
  }
}

module.exports = EmailService;
