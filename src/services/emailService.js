/**
 * Transactional Email Service & Reliable Outbox for HireLoop
 * Supports Resend, custom SMTP configuration, and safe local outbox simulation.
 */

import { config } from "../config.js";
import { getDb } from "../db.js";
import {
  shouldDeliverEmail,
  generateUnsubscribeToken,
  ESSENTIAL_TEMPLATES,
} from "./preferenceService.js";

/**
 * Base email layout wrapper with HireLoop modern dark/indigo aesthetic.
 */
function renderBaseTemplate({ title, preheader, bodyHtml, ctaText, ctaUrl }) {
  const clientUrl = config.clientOrigin || "http://localhost:3000";
  const fullCtaUrl = ctaUrl.startsWith("http") ? ctaUrl : `${clientUrl}${ctaUrl}`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #09090b;
      color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 580px;
      margin: 30px auto;
      background-color: #121215;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      overflow: hidden;
    }
    .header {
      padding: 28px 32px;
      background-color: #09090b;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      font-size: 20px;
      font-weight: 700;
      color: #ffffff;
      text-decoration: none;
      letter-spacing: -0.5px;
    }
    .brand-accent {
      color: #6366f1;
    }
    .content {
      padding: 32px;
      line-height: 1.6;
      font-size: 15px;
      color: #d4d4d8;
    }
    .title {
      font-size: 22px;
      font-weight: 600;
      color: #ffffff;
      margin-top: 0;
      margin-bottom: 16px;
      letter-spacing: -0.3px;
    }
    .cta-container {
      margin: 28px 0 12px;
    }
    .cta-button {
      display: inline-block;
      background-color: #6366f1;
      color: #ffffff !important;
      font-weight: 600;
      font-size: 14px;
      padding: 12px 24px;
      border-radius: 10px;
      text-decoration: none;
      transition: background-color 0.2s ease;
    }
    .cta-button:hover {
      background-color: #4f46e5;
    }
    .meta-box {
      background-color: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 16px 20px;
      margin: 20px 0;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .meta-row:last-child {
      margin-bottom: 0;
    }
    .meta-label {
      color: #a1a1aa;
    }
    .meta-value {
      color: #ffffff;
      font-weight: 500;
    }
    .footer {
      padding: 24px 32px;
      background-color: #09090b;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 12px;
      color: #71717a;
      line-height: 1.5;
    }
    .footer a {
      color: #a1a1aa;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div style="display:none;font-size:1px;color:#333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${preheader || title}
  </div>
  <div class="container">
    <div class="header">
      <a href="${clientUrl}" class="brand">Hire<span class="brand-accent">Loop</span></a>
    </div>
    <div class="content">
      <h1 class="title">${title}</h1>
      ${bodyHtml}
      ${ctaText ? `
        <div class="cta-container">
          <a href="${fullCtaUrl}" class="cta-button">${ctaText}</a>
        </div>
      ` : ""}
    </div>
    <div class="footer">
      This is an automated transactional message regarding your HireLoop account.
      <!-- UNSUBSCRIBE_SLOT -->
      <br>
      © ${new Date().getFullYear()} HireLoop Platform. All rights reserved.
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Built-in email templates for recruitment and subscription lifecycle.
 */
export const emailTemplates = {
  applicationReceived({ seekerName, jobTitle, companyName, reviewUrl }) {
    return {
      subject: `New Application Received: ${jobTitle}`,
      html: renderBaseTemplate({
        title: "New Candidate Application",
        preheader: `${seekerName} applied for ${jobTitle}`,
        bodyHtml: `
          <p>Hello,</p>
          <p><strong style="color: #ffffff;">${seekerName}</strong> has submitted an application for your active listing:</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Position:</span><span class="meta-value">${jobTitle}</span></div>
            <div class="meta-row"><span class="meta-label">Company:</span><span class="meta-value">${companyName}</span></div>
            <div class="meta-row"><span class="meta-label">Candidate:</span><span class="meta-value">${seekerName}</span></div>
          </div>
          <p>You can review their application, resume, and cover letter directly in your recruiter dashboard.</p>
        `,
        ctaText: "Review Candidate",
        ctaUrl: reviewUrl || "/dashboard/recruiter/jobs",
      }),
    };
  },

  applicationStatusChanged({ jobTitle, companyName, newStatus, viewUrl }) {
    return {
      subject: `Application Status Updated: ${newStatus} (${jobTitle})`,
      html: renderBaseTemplate({
        title: `Status: ${newStatus}`,
        preheader: `Your application for ${jobTitle} is now ${newStatus}`,
        bodyHtml: `
          <p>Hello,</p>
          <p>The recruitment team for <strong style="color: #ffffff;">${jobTitle}</strong> at <strong style="color: #ffffff;">${companyName}</strong> has updated the status of your application:</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Job Role:</span><span class="meta-value">${jobTitle}</span></div>
            <div class="meta-row"><span class="meta-label">Company:</span><span class="meta-value">${companyName}</span></div>
            <div class="meta-row"><span class="meta-label">Current Stage:</span><span class="meta-value" style="color: #818cf8;">${newStatus}</span></div>
          </div>
          <p>Visit your applications dashboard to track progress, interview updates, or explore further opportunities.</p>
        `,
        ctaText: "View Application Status",
        ctaUrl: viewUrl || "/dashboard/seeker/applications",
      }),
    };
  },

  companyTeamInvitation({ companyName, inviterName, roleName, inviteUrl, expiresInDays = 7 }) {
    return {
      subject: `Invitation to join ${companyName} on HireLoop`,
      html: renderBaseTemplate({
        title: `Team Invitation: ${companyName}`,
        preheader: `${inviterName} has invited you to join ${companyName} as a ${roleName}`,
        bodyHtml: `
          <p>Hello,</p>
          <p><strong style="color: #ffffff;">${inviterName}</strong> has invited you to join the <strong style="color: #ffffff;">${companyName}</strong> recruitment workspace on HireLoop as <strong style="color: #818cf8;">${roleName}</strong>.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Company:</span><span class="meta-value">${companyName}</span></div>
            <div class="meta-row"><span class="meta-label">Assigned Role:</span><span class="meta-value" style="color: #818cf8;">${roleName}</span></div>
            <div class="meta-row"><span class="meta-label">Invited By:</span><span class="meta-value">${inviterName}</span></div>
            <div class="meta-row"><span class="meta-label">Expires In:</span><span class="meta-value">${expiresInDays} days</span></div>
          </div>
          <p>As a team member, you can collaborate on vacancies, review applications, and coordinate interview workflows within the scope granted to your role.</p>
        `,
        ctaText: "Accept Invitation",
        ctaUrl: inviteUrl || "/dashboard/recruiter/team",
      }),
    };
  },

  subscriptionActivated({ planName, role, billingUrl }) {
    return {
      subject: `HireLoop ${planName} Subscription Activated`,
      html: renderBaseTemplate({
        title: "Subscription Activated",
        preheader: `Welcome to the HireLoop ${planName} plan`,
        bodyHtml: `
          <p>Thank you for subscribing to HireLoop!</p>
          <p>Your account has been upgraded to the <strong style="color: #818cf8;">${planName}</strong> plan for ${role === "recruiter" ? "Recruiters" : "Job Seekers"}. Your new listing capacity and platform perks are immediately available.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Plan Tier:</span><span class="meta-value">${planName}</span></div>
            <div class="meta-row"><span class="meta-label">Account Role:</span><span class="meta-value" style="text-transform: capitalize;">${role}</span></div>
            <div class="meta-row"><span class="meta-label">Billing Status:</span><span class="meta-value" style="color: #34d399;">Active</span></div>
          </div>
          <p>You can manage your subscription, download receipts, or update your payment card at any time through your billing dashboard.</p>
        `,
        ctaText: "Go to Billing Dashboard",
        ctaUrl: billingUrl || `/dashboard/${role === "recruiter" ? "recruiter" : "seeker"}/billing`,
      }),
    };
  },

  paymentSucceeded({ planName, amount, billingUrl }) {
    return {
      subject: `Receipt for your HireLoop ${planName} payment`,
      html: renderBaseTemplate({
        title: "Payment Confirmed",
        preheader: `Payment of ${amount} confirmed for ${planName}`,
        bodyHtml: `
          <p>Hello,</p>
          <p>Your payment of <strong style="color: #ffffff;">${amount}</strong> for the HireLoop <strong style="color: #818cf8;">${planName}</strong> plan has succeeded.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Plan:</span><span class="meta-value">${planName}</span></div>
            <div class="meta-row"><span class="meta-label">Amount:</span><span class="meta-value">${amount}</span></div>
            <div class="meta-row"><span class="meta-label">Status:</span><span class="meta-value" style="color: #34d399;">Paid</span></div>
          </div>
          <p>Your billing records have been updated in your dashboard.</p>
        `,
        ctaText: "View Billing History",
        ctaUrl: billingUrl || "/dashboard",
      }),
    };
  },

  paymentFailed({ planName, billingUrl }) {
    return {
      subject: `Action Required: Payment failed for HireLoop ${planName}`,
      html: renderBaseTemplate({
        title: "Payment Processing Failed",
        preheader: `Unable to process renewal payment for ${planName}`,
        bodyHtml: `
          <p>Hello,</p>
          <p>We were unable to process the scheduled renewal payment for your HireLoop <strong style="color: #f87171;">${planName}</strong> plan.</p>
          <p>To avoid service disruption or automatic account downgrading to the Free tier, please update your payment method promptly.</p>
        `,
        ctaText: "Update Payment Method",
        ctaUrl: billingUrl || "/dashboard",
      }),
    };
  },

  subscriptionCanceled({ planName, expirationDate, billingUrl }) {
    return {
      subject: `HireLoop ${planName} Subscription Canceled`,
      html: renderBaseTemplate({
        title: "Subscription Scheduled to End",
        preheader: `Your ${planName} plan access will end on ${expirationDate}`,
        bodyHtml: `
          <p>Hello,</p>
          <p>Your subscription to the HireLoop <strong style="color: #ffffff;">${planName}</strong> plan has been canceled.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Current Plan:</span><span class="meta-value">${planName}</span></div>
            <div class="meta-row"><span class="meta-label">Access Expires:</span><span class="meta-value">${expirationDate || "End of billing period"}</span></div>
            <div class="meta-row"><span class="meta-label">Next Tier:</span><span class="meta-value">Free</span></div>
          </div>
          <p>You will retain your full plan entitlements until the date above. You can re-subscribe at any time to restore higher quotas.</p>
        `,
        ctaText: "Manage Account",
        ctaUrl: billingUrl || "/dashboard",
      }),
    };
  },

  interviewInvitation({ jobTitle, companyName, scheduledAt, durationMinutes, timezone, format, location, agenda, calendarUrl, viewUrl }) {
    return {
      subject: `Interview Invitation: ${jobTitle} at ${companyName}`,
      html: renderBaseTemplate({
        title: "Interview Invitation",
        preheader: `You have been invited to an interview for ${jobTitle}`,
        bodyHtml: `
          <p>Hello,</p>
          <p>You have been invited to an interview for the <strong style="color: #ffffff;">${jobTitle}</strong> position at <strong style="color: #ffffff;">${companyName}</strong>.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Position:</span><span class="meta-value">${jobTitle}</span></div>
            <div class="meta-row"><span class="meta-label">Company:</span><span class="meta-value">${companyName}</span></div>
            <div class="meta-row"><span class="meta-label">Date & Time:</span><span class="meta-value" style="color: #818cf8;">${scheduledAt} (${timezone || "UTC"})</span></div>
            <div class="meta-row"><span class="meta-label">Duration:</span><span class="meta-value">${durationMinutes || 45} minutes</span></div>
            <div class="meta-row"><span class="meta-label">Format:</span><span class="meta-value" style="text-transform: capitalize;">${format || "Video Call"}</span></div>
            ${location ? `<div class="meta-row"><span class="meta-label">Location / Link:</span><span class="meta-value">${location}</span></div>` : ""}
            ${agenda ? `<div class="meta-row"><span class="meta-label">Agenda:</span><span class="meta-value">${agenda}</span></div>` : ""}
          </div>
          <p>Please review the details in your HireLoop dashboard. You can confirm your attendance or download the calendar invite directly.</p>
          ${calendarUrl ? `<p><a href="${calendarUrl}" style="color: #818cf8; text-decoration: underline; font-size: 13px;">Add to Google Calendar</a></p>` : ""}
        `,
        ctaText: "View & Confirm Interview",
        ctaUrl: viewUrl || "/dashboard/seeker/applications",
      }),
    };
  },

  interviewRescheduled({ jobTitle, companyName, previousTime, newTime, timezone, format, location, reason, calendarUrl, viewUrl }) {
    return {
      subject: `Interview Rescheduled: ${jobTitle} (${newTime})`,
      html: renderBaseTemplate({
        title: "Interview Rescheduled",
        preheader: `New interview time scheduled for ${jobTitle}`,
        bodyHtml: `
          <p>Hello,</p>
          <p>The interview appointment for <strong style="color: #ffffff;">${jobTitle}</strong> at <strong style="color: #ffffff;">${companyName}</strong> has been rescheduled.</p>
          <div class="meta-box">
            ${previousTime ? `<div class="meta-row"><span class="meta-label">Previous Time:</span><span class="meta-value" style="text-decoration: line-through; color: #a1a1aa;">${previousTime}</span></div>` : ""}
            <div class="meta-row"><span class="meta-label">New Date & Time:</span><span class="meta-value" style="color: #34d399; font-weight: 600;">${newTime} (${timezone || "UTC"})</span></div>
            <div class="meta-row"><span class="meta-label">Format:</span><span class="meta-value" style="text-transform: capitalize;">${format || "Video Call"}</span></div>
            ${location ? `<div class="meta-row"><span class="meta-label">Location / Link:</span><span class="meta-value">${location}</span></div>` : ""}
            ${reason ? `<div class="meta-row"><span class="meta-label">Reason / Notes:</span><span class="meta-value">${reason}</span></div>` : ""}
          </div>
          <p>Your calendar and appointment details have been updated accordingly.</p>
          ${calendarUrl ? `<p><a href="${calendarUrl}" style="color: #818cf8; text-decoration: underline; font-size: 13px;">Update Google Calendar</a></p>` : ""}
        `,
        ctaText: "View Updated Appointment",
        ctaUrl: viewUrl || "/dashboard/seeker/applications",
      }),
    };
  },

  interviewCanceled({ jobTitle, companyName, scheduledAt, canceledBy, reason, viewUrl }) {
    return {
      subject: `Interview Canceled: ${jobTitle}`,
      html: renderBaseTemplate({
        title: "Interview Canceled",
        preheader: `The interview scheduled for ${jobTitle} has been canceled`,
        bodyHtml: `
          <p>Hello,</p>
          <p>The interview appointment for <strong style="color: #ffffff;">${jobTitle}</strong> at <strong style="color: #ffffff;">${companyName}</strong> originally set for <strong style="color: #ffffff;">${scheduledAt}</strong> has been canceled by ${canceledBy || "the hiring team"}.</p>
          ${reason ? `<div class="meta-box"><div class="meta-row"><span class="meta-label">Note:</span><span class="meta-value">${reason}</span></div></div>` : ""}
          <p>If you have any questions or wish to explore next steps, please check your application status in HireLoop.</p>
        `,
        ctaText: "View Application Status",
        ctaUrl: viewUrl || "/dashboard/seeker/applications",
      }),
    };
  },

  interviewStatusUpdated({ jobTitle, companyName, newStatus, scheduledAt, viewUrl }) {
    return {
      subject: `Interview Update: ${newStatus} (${jobTitle})`,
      html: renderBaseTemplate({
        title: `Interview ${newStatus}`,
        preheader: `Interview status has been updated to ${newStatus}`,
        bodyHtml: `
          <p>Hello,</p>
          <p>The status of your interview for <strong style="color: #ffffff;">${jobTitle}</strong> at <strong style="color: #ffffff;">${companyName}</strong> has been updated to <strong style="color: #818cf8;">${newStatus}</strong>.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Position:</span><span class="meta-value">${jobTitle}</span></div>
            <div class="meta-row"><span class="meta-label">Appointment Time:</span><span class="meta-value">${scheduledAt}</span></div>
            <div class="meta-row"><span class="meta-label">Updated Status:</span><span class="meta-value" style="color: #34d399;">${newStatus}</span></div>
          </div>
          <p>Visit your dashboard to view complete details.</p>
        `,
        ctaText: "View Interview Details",
        ctaUrl: viewUrl || "/dashboard",
      }),
    };
  },

  newMessageReceived({ recipientName, senderName, jobTitle, companyName, previewText, messagePreview, viewUrl, conversationUrl }) {
    const preview = previewText || messagePreview;
    const targetUrl = viewUrl || conversationUrl || "/dashboard";
    return {
      subject: `New message from ${senderName} regarding ${jobTitle}`,
      html: renderBaseTemplate({
        title: "New Message Received",
        preheader: `${senderName} sent you a message on HireLoop`,
        bodyHtml: `
          <p>Hello${recipientName ? ` ${recipientName}` : ""},</p>
          <p><strong style="color: #ffffff;">${senderName}</strong> sent you a message regarding the <strong style="color: #818cf8;">${jobTitle}</strong> position${companyName ? ` at <strong style="color: #ffffff;">${companyName}</strong>` : ""}.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">From:</span><span class="meta-value">${senderName}</span></div>
            <div class="meta-row"><span class="meta-label">Position:</span><span class="meta-value">${jobTitle}</span></div>
            ${preview ? `<div class="meta-row"><span class="meta-label">Message Preview:</span><span class="meta-value" style="color: #d4d4d8; font-style: italic;">&quot;${preview}&quot;</span></div>` : ""}
          </div>
          <p>To reply and review the full conversation, open your HireLoop messages inbox.</p>
        `,
        ctaText: "Reply to Message",
        ctaUrl: targetUrl,
      }),
    };
  },

  interviewReminder24h({ recipientName, recipientRole, otherPartyName, jobTitle, companyName, scheduledAt, timezone, format, location, calendarUrl, viewUrl }) {
    const isRecruiter = recipientRole === "recruiter";
    const subject = isRecruiter
      ? `Reminder: Candidate Interview with ${otherPartyName || "Candidate"} tomorrow`
      : `Reminder: Interview for ${jobTitle} at ${companyName} tomorrow`;

    return {
      subject,
      html: renderBaseTemplate({
        title: "Interview Reminder (24 Hours)",
        preheader: `Your interview for ${jobTitle} is scheduled for tomorrow at ${scheduledAt}`,
        bodyHtml: `
          <p>Hello${recipientName ? ` ${recipientName}` : ""},</p>
          <p>This is a scheduled reminder that your interview for <strong style="color: #ffffff;">${jobTitle}</strong>${companyName ? ` with <strong style="color: #ffffff;">${companyName}</strong>` : ""} is scheduled in approximately 24 hours.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Position:</span><span class="meta-value">${jobTitle}</span></div>
            ${companyName ? `<div class="meta-row"><span class="meta-label">Company:</span><span class="meta-value">${companyName}</span></div>` : ""}
            ${otherPartyName ? `<div class="meta-row"><span class="meta-label">${isRecruiter ? "Candidate" : "Interviewer"}:</span><span class="meta-value">${otherPartyName}</span></div>` : ""}
            <div class="meta-row"><span class="meta-label">Date & Time:</span><span class="meta-value" style="color: #818cf8;">${scheduledAt} (${timezone || "UTC"})</span></div>
            <div class="meta-row"><span class="meta-label">Format:</span><span class="meta-value" style="text-transform: capitalize;">${format || "Video"}</span></div>
            ${location ? `<div class="meta-row"><span class="meta-label">Location / Link:</span><span class="meta-value">${location}</span></div>` : ""}
          </div>
          <p>Please ensure your setup is ready ahead of time. You can view all appointment instructions directly in HireLoop.</p>
          ${calendarUrl ? `<p><a href="${calendarUrl}" style="color: #818cf8; text-decoration: underline; font-size: 13px;">Add to Google Calendar</a></p>` : ""}
        `,
        ctaText: "View Appointment Details",
        ctaUrl: viewUrl || "/dashboard",
      }),
    };
  },

  interviewReminder1h({ recipientName, recipientRole, otherPartyName, jobTitle, companyName, scheduledAt, timezone, format, location, viewUrl }) {
    const isRecruiter = recipientRole === "recruiter";
    const subject = isRecruiter
      ? `Upcoming Interview in 1 Hour: ${otherPartyName || "Candidate"} (${jobTitle})`
      : `Upcoming Interview in 1 Hour: ${jobTitle} at ${companyName}`;

    return {
      subject,
      html: renderBaseTemplate({
        title: "Interview Starting in 1 Hour",
        preheader: `Your interview for ${jobTitle} begins at ${scheduledAt}`,
        bodyHtml: `
          <p>Hello${recipientName ? ` ${recipientName}` : ""},</p>
          <p>Your interview appointment for <strong style="color: #ffffff;">${jobTitle}</strong> is starting in approximately <strong style="color: #818cf8;">1 hour</strong>.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Scheduled Time:</span><span class="meta-value" style="color: #818cf8; font-weight: 600;">${scheduledAt} (${timezone || "UTC"})</span></div>
            <div class="meta-row"><span class="meta-label">Format:</span><span class="meta-value" style="text-transform: capitalize;">${format || "Video"}</span></div>
            ${location ? `<div class="meta-row"><span class="meta-label">Meeting Room / Location:</span><span class="meta-value">${location}</span></div>` : ""}
            ${otherPartyName ? `<div class="meta-row"><span class="meta-label">${isRecruiter ? "Candidate" : "Interviewer"}:</span><span class="meta-value">${otherPartyName}</span></div>` : ""}
          </div>
          <p>Please join on time. Access your meeting link and details below.</p>
        `,
        ctaText: "Open Interview Details",
        ctaUrl: viewUrl || "/dashboard",
      }),
    };
  },

  offlineMessageDigest({ recipientName, unreadCount, senders = [], jobTitles = [], inboxUrl }) {
    const count = Number(unreadCount) || 1;
    const sendersList = senders.length > 0 ? senders.slice(0, 3).join(", ") : "hiring team members";
    const jobsList = jobTitles.length > 0 ? jobTitles.slice(0, 3).join(", ") : "your applications";

    return {
      subject: `You have ${count} unread message${count > 1 ? "s" : ""} on HireLoop`,
      html: renderBaseTemplate({
        title: "Unread Messages Digest",
        preheader: `You have ${count} unread message${count > 1 ? "s" : ""} from ${sendersList}`,
        bodyHtml: `
          <p>Hello${recipientName ? ` ${recipientName}` : ""},</p>
          <p>You have <strong style="color: #818cf8;">${count} unread message${count > 1 ? "s" : ""}</strong> waiting for you on HireLoop from <strong style="color: #ffffff;">${sendersList}</strong> regarding <strong style="color: #ffffff;">${jobsList}</strong>.</p>
          <div class="meta-box">
            <div class="meta-row"><span class="meta-label">Unread Messages:</span><span class="meta-value" style="color: #818cf8; font-weight: 600;">${count}</span></div>
            <div class="meta-row"><span class="meta-label">Recent Activity:</span><span class="meta-value">${sendersList}</span></div>
            <div class="meta-row"><span class="meta-label">Topics:</span><span class="meta-value">${jobsList}</span></div>
          </div>
          <p style="font-size: 13px; color: #a1a1aa;">To protect candidate privacy and conversation security, full message transcripts are available inside your authenticated messaging workspace.</p>
        `,
        ctaText: "Open Messaging Inbox",
        ctaUrl: inboxUrl || "/dashboard",
      }),
    };
  },
};

/**
 * Sends an email using the configured external provider (Resend or SMTP)
 * or records as simulated in dev/test environment without external credentials.
 */
async function sendViaProvider({ to, subject, html, text, headers }) {
  // 1. Resend API integration (if RESEND_API_KEY is configured)
  if (config.resendApiKey && config.resendApiKey !== "re_placeholder_key") {
    const payload = {
      from: config.emailFrom,
      to: [to],
      subject,
      html,
      text: text || subject,
    };
    if (headers && Object.keys(headers).length > 0) {
      payload.headers = headers;
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Resend API error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    return { provider: "resend", messageId: data.id };
  }

  // 2. Safe local simulation (fallback when external API keys are not supplied)
  if (config.nodeEnv !== "test") {
    console.log(`[EmailService] Simulated delivery to ${to}: "${subject}" (Provider not configured)`);
  }

  return { provider: "simulated", messageId: `sim_${Date.now()}_${Math.random().toString(36).substring(2, 8)}` };
}

/**
 * Queues and immediately attempts reliable delivery of a transactional email
 * via the MongoDB email_outbox pattern with preference suppression check.
 */
export async function queueTransactionalEmail({
  to,
  type,
  templateData,
  idempotencyKey = null,
}) {
  if (!to) return null;
  const normalizedTo = to.toLowerCase().trim();

  const templateFn = emailTemplates[type];
  if (!templateFn) {
    console.warn(`[EmailService] Unknown email template type: "${type}"`);
    return null;
  }

  const db = getDb();

  // Deduplication check via idempotency key
  if (idempotencyKey) {
    const existing = await db.collection("email_outbox").findOne({ idempotencyKey });
    if (existing) {
      return existing;
    }
  }

  const isEssential = ESSENTIAL_TEMPLATES.has(type);
  let rawUnsubToken = null;
  let unsubscribeUrl = null;

  if (!isEssential) {
    try {
      rawUnsubToken = await generateUnsubscribeToken(normalizedTo, type);
      if (rawUnsubToken) {
        const clientUrl = config.clientOrigin || "http://localhost:3000";
        unsubscribeUrl = `${clientUrl}/unsubscribe?token=${rawUnsubToken}`;
      }
    } catch {
      // Continue safely if token generation fails
    }
  }

  const enrichedData = {
    ...templateData,
    unsubscribeUrl,
    canUnsubscribe: !isEssential,
  };

  const { subject, html: rawHtml } = templateFn(enrichedData);

  // Inject unsubscribe link into HTML footer if slot is present
  const unsubHtml = !isEssential && unsubscribeUrl
    ? `<br><a href="${unsubscribeUrl}" style="color: #a1a1aa; text-decoration: underline;">Unsubscribe or update notification preferences</a>`
    : "";
  const html = rawHtml ? rawHtml.replace("<!-- UNSUBSCRIBE_SLOT -->", unsubHtml) : rawHtml;

  // Pre-queue preference check
  const preferenceCheck = await shouldDeliverEmail(normalizedTo, type);
  if (!preferenceCheck.deliver) {
    const suppressedDoc = {
      to: normalizedTo,
      type,
      subject,
      html,
      unsubscribeToken: null, // Raw token not retained for suppressed items
      idempotencyKey: idempotencyKey || null,
      status: "suppressed", // Accurately marked as suppressed
      attempts: 0,
      maxAttempts: 3,
      lastError: `Suppressed at queue time by user preference (${preferenceCheck.reason})`,
      provider: null,
      messageId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      const insertResult = await db.collection("email_outbox").insertOne(suppressedDoc);
      suppressedDoc._id = insertResult.insertedId;
    } catch (err) {
      if (err.code === 11000) {
        return await db.collection("email_outbox").findOne({ idempotencyKey });
      }
      throw err;
    }
    return suppressedDoc;
  }

  const outboxDoc = {
    to: normalizedTo,
    type,
    subject,
    html,
    unsubscribeToken: rawUnsubToken,
    idempotencyKey: idempotencyKey || null,
    status: "pending", // "pending" | "sent" | "failed" | "suppressed"
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    provider: null,
    messageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const insertResult = await db.collection("email_outbox").insertOne(outboxDoc);
    outboxDoc._id = insertResult.insertedId;
  } catch (err) {
    if (err.code === 11000) {
      return await db.collection("email_outbox").findOne({ idempotencyKey });
    }
    throw err;
  }

  // Attempt immediate asynchronous delivery without delaying the calling API response
  deliverOutboxItem(outboxDoc._id).catch((err) => {
    console.error(`[EmailService] Async delivery failure for outbox ${outboxDoc._id}:`, err.message);
  });

  return outboxDoc;
}

/**
 * Delivers a single outbox record with retry, re-checking preferences right before sending.
 */
export async function deliverOutboxItem(outboxId) {
  const db = getDb();
  const item = await db.collection("email_outbox").findOne({ _id: outboxId });
  if (!item || item.status === "sent" || item.status === "suppressed") return item;

  // Re-check preference right before provider delivery (prevent stale send if preference changed while queued)
  const preferenceCheck = await shouldDeliverEmail(item.to, item.type);
  if (!preferenceCheck.deliver) {
    await db.collection("email_outbox").updateOne(
      { _id: item._id },
      {
        $set: {
          status: "suppressed",
          lastError: `Suppressed before delivery by user preference (${preferenceCheck.reason})`,
          updatedAt: new Date(),
        },
        $unset: { unsubscribeToken: "" }, // Minimize token lifetime immediately upon suppression
      }
    );
    return { ...item, status: "suppressed", lastError: `Suppressed: ${preferenceCheck.reason}` };
  }

  // Build RFC 8058 one-click unsubscribe headers if token exists
  const headers = {};
  if (item.unsubscribeToken) {
    const serverUrl = config.serverOrigin || `http://localhost:${config.port || 5001}`;
    headers["List-Unsubscribe"] = `<${serverUrl}/api/notifications/unsubscribe/one-click?token=${item.unsubscribeToken}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  try {
    const result = await sendViaProvider({
      to: item.to,
      subject: item.subject,
      html: item.html,
      headers,
    });

    await db.collection("email_outbox").updateOne(
      { _id: item._id },
      {
        $set: {
          status: "sent",
          provider: result.provider,
          messageId: result.messageId,
          sentAt: new Date(),
          updatedAt: new Date(),
        },
        $unset: { unsubscribeToken: "" }, // Minimize token lifetime immediately upon successful delivery
        $inc: { attempts: 1 },
      }
    );

    return { ...item, status: "sent", messageId: result.messageId };
  } catch (err) {
    const nextAttempt = item.attempts + 1;
    const isExhausted = nextAttempt >= item.maxAttempts;

    await db.collection("email_outbox").updateOne(
      { _id: item._id },
      {
        $set: {
          status: isExhausted ? "failed" : "pending",
          lastError: err.message,
          nextAttemptAt: new Date(Date.now() + 60000 * Math.pow(2, nextAttempt)), // Exponential backoff
          updatedAt: new Date(),
        },
        ...(isExhausted ? { $unset: { unsubscribeToken: "" } } : {}),
        $inc: { attempts: 1 },
      }
    );

    throw err;
  }
}
