// ─────────────────────────────────────────────────────────────────────────────
// COMPLIANCE HELPERS — Highmark SMS Platform
//
// Provides reusable disclosure text, Twilio campaign submission templates,
// and copy-paste snippets for client websites.
//
// Usage:
//   import { smsDisclosure, TWILIO_CAMPAIGN_TEMPLATE, SMS_CHECKBOX_SNIPPET } from "./compliance.js";
//
//   const text = smsDisclosure("Colorado Sled Rentals");
//   // → "By providing your phone number, you agree to receive SMS messages from
//   //    Colorado Sled Rentals via Highmark for customer support, booking
//   //    assistance, and service updates. ..."
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_BASE_URL = "https://usehighmark.com";

// ── smsDisclosure ─────────────────────────────────────────────────────────────
// Returns the full Twilio-compliant SMS opt-in disclosure for a business.
//
// Parameters:
//   businessName  — display name of the client business (e.g. "Colorado Sled Rentals")
//   options       — optional overrides:
//     purposes    — array of purpose strings (default: booking, support, updates)
//     includeLinks — whether to append policy URLs (default: true)
//
// Example:
//   smsDisclosure("Rabbit Ears Adventures")
//   smsDisclosure("Lone Pine Performance", { purposes: ["service scheduling", "follow-up"] })

export function smsDisclosure(businessName, options = {}) {
  const purposes = options.purposes ?? [
    "customer support",
    "booking assistance",
    "service updates",
  ];
  const includeLinks = options.includeLinks !== false;

  const purposeStr = purposes.join(", ");

  let text =
    `By providing your phone number, you agree to receive SMS messages from ` +
    `${businessName} via Highmark for ${purposeStr}. ` +
    `Message frequency varies. Message and data rates may apply. ` +
    `Reply STOP to unsubscribe or HELP for help.`;

  if (includeLinks) {
    text +=
      ` Privacy Policy: ${PLATFORM_BASE_URL}/privacy.` +
      ` Terms: ${PLATFORM_BASE_URL}/terms.`;
  }

  return text;
}

// ── Per-client disclosure registry ───────────────────────────────────────────
// Add an entry here for each active Highmark client.
// These are the canonical opt-in disclosures used in Twilio submissions.

export const CLIENT_DISCLOSURES = {
  csr_rea: smsDisclosure("Colorado Sled Rentals + Rabbit Ears Adventures", {
    purposes: ["booking assistance", "tour availability", "customer support", "reservation updates"],
  }),
  lone_pine: smsDisclosure("Lone Pine Performance", {
    purposes: ["service scheduling", "follow-up", "customer support"],
  }),
};

// ── Twilio Campaign Submission Template ───────────────────────────────────────
// Copy-paste ready content for Twilio A2P 10DLC / toll-free campaign submissions.
// Fill in <PLACEHOLDER> fields before submitting.

export const TWILIO_CAMPAIGN_TEMPLATE = {
  // Brand / company info
  brand: {
    name: "Whiteout Solutions / Highmark",
    website: "https://usehighmark.com",
    contact_email: "hello@whiteoutsolutions.co",
    contact_phone: "<YOUR_SUPPORT_PHONE>",
    ein: "<YOUR_EIN>",
  },

  // Platform description (use in Twilio "Use Case Description" field)
  platform_description:
    "Highmark is an AI SMS concierge platform operated by Whiteout Solutions. " +
    "We enable customer-facing businesses — including tour operators, rental companies, " +
    "and service businesses — to respond to customer inquiries via SMS, confirm bookings, " +
    "and send service updates. Each business collects opt-in consent directly from their " +
    "customers before any messages are sent. Highmark processes and delivers those messages " +
    "on behalf of each business. Messages are sent only to customers who have engaged with " +
    "a specific business and provided their phone number in that context.",

  // Opt-in description (Twilio "How Do End-Users Opt In?" field)
  opt_in_description:
    "End-users opt in by providing their phone number directly to the client business " +
    "(via website form, in-person booking, or direct inquiry). At the point of collection, " +
    "the business displays clear opt-in language explaining that SMS messages will be sent " +
    "via Highmark for customer support, booking assistance, and service updates. " +
    "Users are informed that message and data rates may apply, and that they can reply " +
    "STOP at any time to unsubscribe. Consent is collected per business — a user's " +
    "consent with one business is not shared with or applied to any other Highmark client.",

  // Example opt-in disclosure (shown on client website at point of phone number collection)
  example_opt_in_language:
    "By providing your phone number, you agree to receive SMS messages from [Business Name] " +
    "via Highmark for customer support, booking assistance, and service updates. " +
    "Message frequency varies. Message and data rates may apply. " +
    "Reply STOP to unsubscribe or HELP for help. " +
    "Privacy Policy: https://usehighmark.com/privacy  " +
    "Terms: https://usehighmark.com/terms",

  // Message types (Twilio "Message Types" or "Sample Messages" field)
  message_types: [
    "Customer support — answering questions about services, hours, pricing, and availability.",
    "Booking assistance — helping users select tours, rentals, or appointments.",
    "Booking confirmations — confirming reservation details sent after a booking is made.",
    "Service updates — notifying users of changes to their booking or relevant service info.",
    "Follow-up — one-time follow-up after a customer inquiry if no booking was completed.",
  ],

  // Sample messages for submission
  sample_messages: [
    "Hi! Thanks for reaching out to [Business]. I'm Summit, the AI concierge. How can I help you today? Reply STOP to unsubscribe.",
    "Great news — you're confirmed for the 2hr snowmobile tour on Dec 15 at 10am. Questions? Just reply. Reply STOP to opt out.",
    "Hey [Name], just following up on your inquiry about rentals. We'd love to help — reply here or call us at [phone]. Reply STOP to opt out.",
  ],

  // Opt-out / HELP handling (describe in Twilio submission)
  opt_out_handling:
    "All STOP, UNSUBSCRIBE, QUIT, END, and CANCEL keywords are handled automatically " +
    "before any other processing. When received, an opt-out confirmation is sent and the " +
    "number is flagged — no further messages are sent. HELP returns the program name, " +
    "message frequency notice, STOP instruction, and support phone number. " +
    "START and UNSTOP re-enable messaging for numbers that previously opted out.",

  // Compliance page URLs
  compliance_urls: {
    privacy_policy: "https://usehighmark.com/privacy",
    terms_of_service: "https://usehighmark.com/terms",
    sms_consent_page: "https://usehighmark.com/sms-consent",
  },

  // Multi-client note (important for Twilio reviewers)
  multi_client_note:
    "Highmark is a multi-tenant platform. Each Twilio number is assigned to a specific " +
    "client business. Messages sent from a given number are only sent on behalf of that " +
    "business to customers who have consented with that business. Consent is not shared " +
    "across clients. Each client has its own opt-in flow and contact list.",
};

// ── SMS Checkbox Snippet ───────────────────────────────────────────────────────
// Copy-paste HTML for client websites — place this next to the phone number field.
// Replace [Business Name] with the actual business name before publishing.

export const SMS_CHECKBOX_SNIPPET = `<!-- Highmark SMS Opt-In Disclosure — place next to phone number field -->
<div style="margin-top: 10px; display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: #555;">
  <input type="checkbox" id="sms_consent" name="sms_consent" required
    style="margin-top: 3px; flex-shrink: 0; cursor: pointer;">
  <label for="sms_consent" style="line-height: 1.5; cursor: pointer;">
    By checking this box, you agree to receive SMS messages from
    <strong>[Business Name]</strong> via Highmark for customer support, booking
    assistance, and service updates. Message frequency varies. Message and data
    rates may apply. Reply <strong>STOP</strong> to unsubscribe or
    <strong>HELP</strong> for help.
    <a href="https://usehighmark.com/privacy" target="_blank" rel="noopener">Privacy Policy</a> ·
    <a href="https://usehighmark.com/terms" target="_blank" rel="noopener">Terms</a>
  </label>
</div>`;
