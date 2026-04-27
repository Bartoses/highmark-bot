// verticals.js — Sprint 6: Industry-specific landing pages
//
// Renders 3 vertical pages — /tour-operators, /snowmobile-rentals,
// /service-businesses — that share the homepage's nav, pricing,
// demo CTAs, and footer, but have unique hero, intro, dual-channel
// SMS + Web Chat demo conversations, FAQ, and JSON-LD schema.
//
// Pricing markup mirrors public/home.html — keep them in sync.

export const DEMO_PHONE          = "+18668906657";
export const DEMO_PHONE_DISPLAY  = "(866) 890-6657";
export const SMS_DEMO_HREF       = `sms:${DEMO_PHONE}?body=DEMO`;
export const SITE_BASE           = "https://www.usehighmark.com";
export const VERTICAL_SLUGS      = ["tour-operators", "snowmobile-rentals", "service-businesses"];

// ─────────────────────────────────────────────────────────────────────────────
// VERTICAL CONFIGS
// ─────────────────────────────────────────────────────────────────────────────
export const VERTICALS = {
  "tour-operators": {
    slug: "tour-operators",
    metaTitle: "AI Concierge for Tour Operators — Highmark",
    metaDescription:
      "Answer every guest inquiry via SMS and web chat automatically. Highmark keeps your phones quiet so you can focus on delivering great experiences.",
    h1: "Your guests text or chat at 11pm. Highmark answers.",
    intro:
      "Tour operators lose bookings every night when potential guests can't get a quick answer. Highmark gives you a 24/7 AI concierge that handles availability questions, sends booking links, and captures leads — on SMS and on your website.",
    canonical: `${SITE_BASE}/tour-operators`,
    schema_service_type: "Tour Operator Software",
    audience_label: "tour operator",
    nav_label: "Tour Operators",
    sms_demo: {
      title: "SMS — What your customers experience",
      messages: [
        { role: "guest", text: "Hey, do you have any guided tours available this Saturday for 4 people?" },
        { role: "bot", text: "Great news! We have a few options for Saturday — here's what's available:\n1. Morning Guided Tour (9am) — 4 spots left\n2. Afternoon Scenic Tour (2pm) — fully booked\n3. Sunset Photography Tour (5pm) — 6 spots\n\nWhich one sounds good? I can send you the booking link right now." },
        { role: "guest", text: "Let's do the morning one" },
        { role: "bot", text: "Perfect choice! Here's the booking link for the 9am Saturday tour:\nhttps://fareharbor.com/example/items/morning-tour/\n\nBook now and you're all set. Let me know if you have any questions!" },
      ],
    },
    web_demo: {
      title: "Web Chat — Right on your website",
      messages: [
        { role: "guest", text: "What's included in the guided tours?" },
        { role: "bot", text: "Our guided tours include everything you need — equipment, safety briefing, and an experienced local guide who knows every trail. Most tours run 2–4 hours depending on the option you choose. Is there a specific type of experience you're looking for? I can help match you with the right tour." },
        { role: "guest", text: "We're a group of 6 beginners" },
        { role: "bot", text: "Perfect — our Beginner Group Tour is built exactly for that. It's designed for first-timers, the pace is relaxed, and your guide will make sure everyone's comfortable the whole time. Ready to check availability? I can pull up open dates for groups of 6 right now." },
      ],
    },
    faqs: [
      { q: "Can Highmark handle questions about specific tours?",   a: "Yes — your bot is trained on your tour descriptions, availability, pricing, and policies. It can answer detailed questions about any tour you offer." },
      { q: "What happens when a guest is ready to book?",           a: "Your bot sends them the direct booking link for the specific tour they're interested in — your FareHarbor page, your booking software, or any URL you configure." },
      { q: "Does it work for both SMS and website inquiries?",      a: "Exactly. The same AI handles both channels. Guest texts your number? Handled. Guest chats on your website? Same knowledge, same responses, tracked separately." },
    ],
  },

  "snowmobile-rentals": {
    slug: "snowmobile-rentals",
    metaTitle: "AI Concierge for Snowmobile & RZR Rentals — Highmark",
    metaDescription:
      "Stop spending your mornings answering the same questions. Highmark handles trail conditions, availability, and booking links automatically via SMS and web chat.",
    h1: "Book more sleds. Answer fewer texts — and web chats.",
    intro:
      "Snowmobile and RZR rental operators field the same questions every day: trail conditions, what's available, do I need a license, how do I book. Highmark answers all of it automatically — over SMS and on your website — so your team can focus on the mountain.",
    canonical: `${SITE_BASE}/snowmobile-rentals`,
    schema_service_type: "Snowmobile Rental Software",
    audience_label: "snowmobile and RZR rental",
    nav_label: "Snowmobile Rentals",
    sms_demo: {
      title: "SMS — Conditions and availability at 2am",
      messages: [
        { role: "guest", text: "How's the snow right now? We're thinking about coming up this weekend" },
        { role: "bot", text: "Conditions are great right now! Rabbit Ears Pass is sitting at 68\" base with 4\" of fresh snow from yesterday. Temps are forecast around 28°F Saturday — perfect riding weather.\n\nWant me to check what's available for your group this weekend?" },
        { role: "guest", text: "Yes, 3 people for Sunday" },
        { role: "bot", text: "We have 3 sleds available Sunday — looks like the 10am and 1pm slots both have openings. Here's the booking link:\nhttps://polarisadventures.com/book\n\nBook online and you're locked in. Anything else I can help with?" },
      ],
    },
    web_demo: {
      title: "Web Chat — Converts visitors into bookings",
      messages: [
        { role: "guest", text: "Do I need a license to rent a snowmobile?" },
        { role: "bot", text: "Great question! In Colorado, you don't need a specific snowmobile license — a valid driver's license works. We'll walk you through a quick safety orientation before you head out, and all our sleds come with helmets and safety gear included. How many people are in your group?" },
        { role: "guest", text: "Just 2 of us, first time" },
        { role: "bot", text: "Perfect for first-timers — our 2-hour beginner-friendly rental is ideal. The trail we put new riders on is well-marked and gorgeous. Want me to check what dates we have available for two people?" },
      ],
    },
    faqs: [
      { q: "Can your bot answer questions about trail conditions?",       a: "Yes — Highmark pulls live SNOTEL data and weather forecasts for your area so it can answer trail condition questions with real numbers, not just 'call us.'" },
      { q: "What if someone asks about something the bot doesn't know?",  a: "The bot escalates gracefully — it'll let the customer know it's flagging their question for a human, and notifies you with their contact info." },
      { q: "Can it handle both snowmobile and RZR inquiries?",            a: "Absolutely. You can configure separate booking flows and availability for each product type. The bot detects what the customer is asking about and routes accordingly." },
    ],
  },

  "service-businesses": {
    slug: "service-businesses",
    metaTitle: "AI Concierge for Outdoor Service Businesses — Highmark",
    metaDescription:
      "Capture every lead, answer every inquiry automatically. Highmark gives outdoor service shops an AI assistant for SMS and web chat that never takes a day off.",
    h1: "Every inquiry answered — by text or website chat.",
    intro:
      "Bike shops, ski tune shops, guide services, equipment outfitters — every outdoor service business misses leads when the phone's not answered. Highmark captures every inquiry automatically via SMS and your website, qualifies the lead, and notifies you when it's time to follow up.",
    canonical: `${SITE_BASE}/service-businesses`,
    schema_service_type: "Outdoor Service Business Software",
    audience_label: "outdoor service",
    nav_label: "Service Businesses",
    sms_demo: {
      title: "SMS — Capture leads you'd normally miss",
      messages: [
        { role: "guest", text: "Hey, do you do bike tune-ups? What does that cost?" },
        { role: "bot", text: "Yes! We offer full tune-ups starting at $85, which covers a safety inspection, adjustment of all derailleurs and brakes, cable tension, and a test ride.\n\nWant to schedule a drop-off? We can usually turn around in 2–3 business days, or we offer same-day express service for $20 more. What type of bike do you have?" },
        { role: "guest", text: "Mountain bike, 2022 Trek" },
        { role: "bot", text: "Nice bike — Treks are easy to work with. Our $85 tune-up would cover everything it needs. Want to leave your name and number so we can reach out to schedule a drop-off time that works for you?" },
      ],
    },
    web_demo: {
      title: "Web Chat — Turn website visitors into customers",
      messages: [
        { role: "guest", text: "Do you rent bikes or just sell/service?" },
        { role: "bot", text: "We do all three! Rentals by the hour or day, new bike sales with expert fitting, and service for any brand. What brings you in — are you looking to rent for a trail day, or something more long-term?" },
        { role: "guest", text: "Just renting for tomorrow, 2 bikes" },
        { role: "bot", text: "Easy — we have plenty of great trail bikes available tomorrow. Here's our rental booking page where you can pick your bikes and reserve a pickup time:\nhttps://example.com/rentals\n\nAny questions about trail recommendations while you're here? Happy to point you toward the best rides for your level." },
      ],
    },
    faqs: [
      { q: "Our business is appointment-based — can Highmark help with scheduling?", a: "Yes — your bot can answer questions about your services and pricing, then direct customers to your booking link or capture their contact info for you to call back. It handles the inquiry so you focus on the appointment." },
      { q: "Can we use it for both a physical shop and a website?",                   a: "That's exactly the use case. SMS covers customers who find your number on Google or Yelp. The web chat widget covers visitors to your website. Both go to the same AI, same knowledge base." },
      { q: "How quickly can we get set up?",                                          a: "Most service businesses are live within 1–3 business days. We configure the bot with your services, pricing, and policies — you review it, approve it, and we go live." },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function newlinesToBr(str) {
  return escapeHtml(str).replace(/\n/g, "<br>");
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED FRAGMENTS — keep markup in sync with public/home.html
// ─────────────────────────────────────────────────────────────────────────────
function renderHead(v) {
  const ogImage = `${SITE_BASE}/og-image.png`;

  const faqSchema = {
    "@context": "https://schema.org",
    "@type":    "FAQPage",
    "mainEntity": v.faqs.map((f) => ({
      "@type": "Question",
      "name":  f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a },
    })),
  };

  const appSchema = {
    "@context":              "https://schema.org",
    "@type":                 "SoftwareApplication",
    "name":                  "Highmark",
    "applicationCategory":   "BusinessApplication",
    "applicationSubCategory": v.schema_service_type,
    "description":           v.metaDescription,
    "url":                   v.canonical,
    "operatingSystem":       "Web",
    "offers": [
      { "@type": "Offer", "name": "Free",   "price": "0",   "priceCurrency": "USD" },
      { "@type": "Offer", "name": "Growth", "price": "249", "priceCurrency": "USD" },
      { "@type": "Offer", "name": "Pro",    "price": "449", "priceCurrency": "USD" },
    ],
  };

  // Stringify, then neutralise the </script close-tag sequence so
  // the embedded JSON-LD can never terminate its host <script> tag.
  const faqJson = JSON.stringify(faqSchema).replace(/<\/(script)/gi, "<\\/$1");
  const appJson = JSON.stringify(appSchema).replace(/<\/(script)/gi, "<\\/$1");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(v.metaTitle)}</title>
  <meta name="description" content="${escapeHtml(v.metaDescription)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(v.canonical)}">
  <meta property="og:title" content="${escapeHtml(v.metaTitle)}">
  <meta property="og:description" content="${escapeHtml(v.metaDescription)}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(v.metaTitle)}">
  <meta name="twitter:description" content="${escapeHtml(v.metaDescription)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <link rel="canonical" href="${escapeHtml(v.canonical)}">
  <script type="application/ld+json">${faqJson}</script>
  <script type="application/ld+json">${appJson}</script>
  <style>${BASE_STYLES}</style>
</head>`;
}

function renderNav(activeSlug) {
  const link = (slug, label) => {
    const isActive = activeSlug === slug;
    const cls = isActive ? "nav-link active" : "nav-link";
    return `<a href="/${slug}" class="${cls}">${escapeHtml(label)}</a>`;
  };
  return `<nav>
  <div class="inner">
    <a href="/" class="nav-logo">High<span>mark</span></a>
    <div class="nav-links">
      ${link("tour-operators",    "Tour Operators")}
      ${link("snowmobile-rentals", "Snowmobile")}
      ${link("service-businesses", "Service")}
      <a href="/#pricing" class="nav-link">Pricing</a>
    </div>
    <div class="nav-right">
      <a href="https://highmark-bot-production.up.railway.app/portal/login" class="nav-login">Client login</a>
      <a href="${SMS_DEMO_HREF}" class="nav-cta">Text the demo →</a>
    </div>
  </div>
</nav>`;
}

function renderHero(v) {
  return `<section class="hero">
  <div class="container">
    <div class="hero-badge">🏔 ${escapeHtml(v.nav_label)} · Live demo available</div>
    <h1>${escapeHtml(v.h1)}</h1>
    <p>${escapeHtml(v.intro)}</p>
    <div class="cta-group">
      <a href="${SMS_DEMO_HREF}" class="btn-primary">📱 Text DEMO to see it live</a>
      <a href="#demo-conversations" class="btn-ghost">See a conversation ↓</a>
    </div>
    <div class="hero-proof">
      <div class="proof-item"><div class="proof-dot"></div> SMS Concierge</div>
      <div class="proof-item"><div class="proof-dot"></div> Web Chat Widget</div>
      <div class="proof-item"><div class="proof-dot"></div> Live in 1–3 days</div>
    </div>
  </div>
</section>`;
}

function renderBubble(role, text) {
  const cls = role === "guest" ? "bubble user" : "bubble bot";
  return `<div class="${cls}">${newlinesToBr(text)}</div>`;
}

function renderDualChannelDemos(v) {
  const smsBubbles = v.sms_demo.messages.map((m) => renderBubble(m.role, m.text)).join("\n          ");
  const webBubbles = v.web_demo.messages.map((m) => renderBubble(m.role, m.text)).join("\n          ");

  return `<section id="demo-conversations">
  <div class="container">
    <div class="section-label">See it in action</div>
    <h2>Same AI. Two channels. Both work the same way.</h2>
    <p class="section-sub">SMS for customers who find your number. Web Chat for visitors on your website. Same knowledge base, same booking links.</p>
    <div class="demo-grid">
      <div class="demo-channel">
        <div class="channel-label">📱 ${escapeHtml(v.sms_demo.title)}</div>
        <div class="demo-convo sms-thread">
          ${smsBubbles}
        </div>
      </div>
      <div class="demo-channel">
        <div class="channel-label">💬 ${escapeHtml(v.web_demo.title)}</div>
        <div class="demo-convo sms-thread">
          ${webBubbles}
        </div>
      </div>
    </div>
  </div>
</section>`;
}

function renderFaq(v) {
  const items = v.faqs.map((f) => `<details>
        <summary>${escapeHtml(f.q)}</summary>
        <div class="faq-answer">${escapeHtml(f.a)}</div>
      </details>`).join("\n      ");

  return `<section style="background:var(--surface)">
  <div class="container">
    <div class="section-label">FAQ</div>
    <h2>Questions from ${escapeHtml(v.audience_label)} businesses</h2>
    <div class="faq-list">
      ${items}
    </div>
  </div>
</section>`;
}

// Pricing markup is byte-equivalent to public/home.html (#pricing section).
// If you change pricing, update both this function and home.html.
function renderPricingSection() {
  return `<section id="pricing">
  <div class="container">
    <div class="section-label">Pricing</div>
    <h2>Start free. Scale when you're ready.</h2>
    <p class="section-sub">No long-term contracts. No per-message fees. Most clients go live in 1–3 days.</p>
    <div class="pricing-grid">

      <div class="price-card">
        <div class="price-tier">Free</div>
        <div class="price-amount">$0</div>
        <div class="price-period">forever, limited</div>
        <div class="price-desc">Try Highmark with your business — no risk, no credit card.</div>
        <ul class="price-features">
          <li class="active"><span class="check">✓</span> Basic SMS Q&amp;A chatbot</li>
          <li class="active"><span class="check">✓</span> Up to 100 messages/month</li>
          <li class="active"><span class="check">✓</span> Shared Twilio number</li>
          <li class="active"><span class="check">✓</span> FAQ answering from your website</li>
          <li><span class="cross">✗</span> Lead capture</li>
          <li><span class="cross">✗</span> CRM &amp; contact records</li>
          <li><span class="cross">✗</span> Booking integration</li>
          <li><span class="cross">✗</span> Campaign messaging</li>
        </ul>
        <a href="${SMS_DEMO_HREF}" class="price-cta ghost">Text the demo →</a>
      </div>

      <div class="price-card featured">
        <div class="price-badge">Most Popular</div>
        <div class="price-tier">Growth</div>
        <div class="price-amount"><sup>$</sup>249<span style="font-size:1.2rem;font-weight:400;color:var(--muted)">/mo</span></div>
        <div class="price-period">billed monthly · setup included</div>
        <div class="price-desc">Everything you need to capture every lead and never miss a customer.</div>
        <ul class="price-features">
          <li class="active"><span class="check">✓</span> Everything in Free</li>
          <li class="active"><span class="check">✓</span> Unlimited messages</li>
          <li class="active"><span class="check">✓</span> Dedicated Twilio number</li>
          <li class="active"><span class="check">✓</span> Lead capture + team notifications</li>
          <li class="active"><span class="check">✓</span> CRM — contacts, tags, opt-in/out</li>
          <li class="active"><span class="check">✓</span> Custom bot persona &amp; tone</li>
          <li class="active"><span class="check">✓</span> Weekly website knowledge refresh</li>
          <li><span class="cross">✗</span> Live booking integration</li>
          <li><span class="cross">✗</span> Campaign messaging</li>
        </ul>
        <a href="mailto:hello@whiteoutsolutions.co?subject=Highmark%20Growth%20Plan" class="price-cta primary">Get started →</a>
      </div>

      <div class="price-card">
        <div class="price-tier">Pro</div>
        <div class="price-amount"><sup>$</sup>449<span style="font-size:1.2rem;font-weight:400;color:var(--muted)">/mo</span></div>
        <div class="price-period">billed monthly · setup included</div>
        <div class="price-desc">Full platform. Real-time availability, booking automation, and more.</div>
        <ul class="price-features">
          <li class="active"><span class="check">✓</span> Everything in Growth</li>
          <li class="active"><span class="check">✓</span> Live booking availability</li>
          <li class="active"><span class="check">✓</span> FareHarbor integration</li>
          <li class="active"><span class="check">✓</span> Booking confirmation texts</li>
          <li class="active"><span class="check">✓</span> 30-min follow-up automation</li>
          <li class="active"><span class="check">✓</span> Priority support</li>
          <li class="active"><span class="check">✓</span> Campaign messaging</li>
          <li class="active"><span class="check">✓</span> Analytics dashboard</li>
        </ul>
        <a href="mailto:hello@whiteoutsolutions.co?subject=Highmark%20Pro%20Plan" class="price-cta ghost">Talk to us →</a>
      </div>

    </div>
    <p style="text-align:center; margin-top:28px; font-size:.85rem; color:var(--muted);">
      Pricing shown is per client. Volume discounts available for agencies. <a href="${SMS_DEMO_HREF}" style="color:var(--accent)">Contact us</a> for custom plans.
    </p>
  </div>
</section>`;
}

function renderDemoBand() {
  return `<div class="demo-band">
  <div class="container">
    <div class="section-label" style="color: #93c5fd;">Live demo</div>
    <h2>See it work right now</h2>
    <p class="sub">Text the demo number below. Ask anything — pricing, availability, how it works. Highmark will respond in seconds.</p>
    <div class="phone-number"><a href="${SMS_DEMO_HREF}">${DEMO_PHONE_DISPLAY}</a></div>
    <div class="phone-hint">Text anything to start · Works on any phone</div>
    <a href="${SMS_DEMO_HREF}" class="btn-primary" style="display:inline-flex;">📱 Open in Messages</a>
  </div>
</div>`;
}

function renderFinalCta() {
  return `<section class="final-cta">
  <div class="container">
    <div class="section-label">Get started</div>
    <h2>Your customers are texting right now</h2>
    <p>See Highmark work on your phone in the next 30 seconds — no signup required.</p>
    <div class="cta-group">
      <a href="${SMS_DEMO_HREF}" class="btn-primary">📱 Text DEMO to ${DEMO_PHONE_DISPLAY}</a>
      <a href="mailto:hello@whiteoutsolutions.co?subject=Highmark%20Inquiry" class="btn-ghost">Talk to us →</a>
    </div>
  </div>
</section>`;
}

function renderFooter() {
  return `<footer>
  <div class="container">
    <p style="margin-bottom:10px;">
      <a href="/privacy">Privacy Policy</a>
      &nbsp;·&nbsp;
      <a href="/terms">Terms of Service</a>
      &nbsp;·&nbsp;
      <a href="/sms-consent">SMS Consent</a>
    </p>
    <p>
      <strong style="color:var(--muted)">Highmark</strong> by
      <a href="mailto:hello@whiteoutsolutions.co">Whiteout Solutions</a>
      &nbsp;·&nbsp;
      <a href="mailto:hello@whiteoutsolutions.co">hello@whiteoutsolutions.co</a>
      &nbsp;·&nbsp;
      Steamboat Springs, CO
    </p>
  </div>
</footer>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY — renderVerticalPage(slug) → full HTML string
// ─────────────────────────────────────────────────────────────────────────────
export function renderVerticalPage(slug) {
  const v = VERTICALS[slug];
  if (!v) return null;

  return `${renderHead(v)}
<body>

${renderNav(v.slug)}

${renderHero(v)}

${renderDualChannelDemos(v)}

${renderFaq(v)}

${renderPricingSection()}

${renderDemoBand()}

${renderFinalCta()}

${renderFooter()}

</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED CSS
// Mirrors public/home.html style block, extended with `.demo-grid` + nav links.
// ─────────────────────────────────────────────────────────────────────────────
const BASE_STYLES = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:         #090d18;
  --surface:    #0f1623;
  --card:       #151e30;
  --card-hover: #1a2540;
  --accent:     #3b82f6;
  --accent-dim: rgba(59,130,246,.12);
  --green:      #22c55e;
  --green-dim:  rgba(34,197,94,.12);
  --text:       #f1f5f9;
  --muted:      #94a3b8;
  --border:     rgba(255,255,255,.08);
  --radius:     12px;
  --max:        1100px;
}

html { scroll-behavior: smooth; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.container { max-width: var(--max); margin: 0 auto; padding: 0 20px; }

/* ── NAV ── */
nav {
  position: sticky; top: 0; z-index: 100;
  background: rgba(9,13,24,.9);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  padding: 14px 0;
}
nav .inner {
  max-width: var(--max); margin: 0 auto; padding: 0 20px;
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px;
}
.nav-logo {
  font-size: 1.2rem; font-weight: 700; color: var(--text);
  letter-spacing: -.02em; text-decoration: none;
}
.nav-logo span { color: var(--accent); }
.nav-links { display: flex; gap: 18px; align-items: center; }
.nav-link {
  color: var(--muted); font-size: .88rem; font-weight: 500;
  white-space: nowrap; transition: color .15s;
}
.nav-link:hover { color: var(--text); text-decoration: none; }
.nav-link.active { color: var(--text); }
.nav-cta {
  background: var(--accent); color: #fff;
  padding: 8px 18px; border-radius: 8px;
  font-size: .88rem; font-weight: 600;
  white-space: nowrap;
  transition: background .15s;
}
.nav-cta:hover { background: #2563eb; text-decoration: none; }
.nav-login {
  color: var(--muted); font-size: .88rem; font-weight: 500;
  white-space: nowrap; transition: color .15s;
}
.nav-login:hover { color: var(--text); text-decoration: none; }
.nav-right { display: flex; align-items: center; gap: 16px; }

/* ── HERO ── */
.hero {
  padding: 96px 0 72px;
  text-align: center;
  background: radial-gradient(ellipse 80% 50% at 50% 0%, rgba(59,130,246,.15) 0%, transparent 70%);
}
.hero-badge {
  display: inline-block; margin-bottom: 20px;
  background: var(--accent-dim); border: 1px solid rgba(59,130,246,.3);
  color: #93c5fd; border-radius: 100px; padding: 5px 14px; font-size: .82rem; font-weight: 500;
}
.hero h1 {
  font-size: clamp(2.2rem, 6vw, 3.8rem);
  font-weight: 800; line-height: 1.12; letter-spacing: -.04em;
  max-width: 860px; margin: 0 auto 20px;
}
.hero h1 em { color: var(--accent); font-style: normal; }
.hero p {
  font-size: clamp(1rem, 2.5vw, 1.2rem); color: var(--muted);
  max-width: 620px; margin: 0 auto 36px;
}
.cta-group {
  display: flex; flex-wrap: wrap; gap: 12px;
  justify-content: center; align-items: center;
}
.btn-primary {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--accent); color: #fff;
  padding: 14px 28px; border-radius: 10px;
  font-size: 1rem; font-weight: 700;
  transition: background .15s, transform .1s;
}
.btn-primary:hover { background: #2563eb; text-decoration: none; transform: translateY(-1px); }
.btn-ghost {
  display: inline-flex; align-items: center; gap: 8px;
  border: 1px solid var(--border); color: var(--muted);
  padding: 14px 24px; border-radius: 10px;
  font-size: 1rem; font-weight: 500;
  transition: border-color .15s, color .15s;
}
.btn-ghost:hover { border-color: var(--accent); color: var(--text); text-decoration: none; }

.hero-proof {
  margin-top: 48px;
  display: flex; flex-wrap: wrap; gap: 24px;
  justify-content: center; align-items: center;
}
.proof-item {
  display: flex; align-items: center; gap: 8px;
  font-size: .88rem; color: var(--muted);
}
.proof-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); flex-shrink: 0; }

/* ── SECTION SHARED ── */
section { padding: 80px 0; }
.section-label {
  font-size: .78rem; font-weight: 600; letter-spacing: .1em;
  text-transform: uppercase; color: var(--accent); margin-bottom: 12px;
}
h2 {
  font-size: clamp(1.6rem, 4vw, 2.4rem);
  font-weight: 800; letter-spacing: -.03em; line-height: 1.2;
  margin-bottom: 16px;
}
.section-sub { font-size: 1.05rem; color: var(--muted); max-width: 560px; }

/* ── DUAL-CHANNEL DEMO GRID ── */
.demo-grid {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 24px; margin: 36px 0 0;
}
.demo-channel {
  display: flex; flex-direction: column; gap: 12px;
}
.channel-label {
  font-size: .85rem; font-weight: 600; color: var(--text);
  letter-spacing: .02em;
}
.demo-convo {
  background: var(--card); border: 1px solid var(--border);
  border-radius: 20px; padding: 24px 20px;
  display: flex; flex-direction: column; gap: 10px;
}
.bubble {
  padding: 10px 14px; border-radius: 16px;
  font-size: .9rem; line-height: 1.45; max-width: 86%;
}
.bubble.user {
  background: var(--accent); color: #fff;
  border-radius: 16px 16px 4px 16px;
  align-self: flex-end;
}
.bubble.bot {
  background: #1e2d47; color: var(--text);
  border-radius: 16px 16px 16px 4px;
  align-self: flex-start;
}

/* ── DEMO CTA BAND ── */
.demo-band {
  background: linear-gradient(135deg, #0c1a3d 0%, #0a2050 100%);
  border-top: 1px solid rgba(59,130,246,.2);
  border-bottom: 1px solid rgba(59,130,246,.2);
  text-align: center; padding: 72px 0;
}
.demo-band h2 { margin-bottom: 12px; }
.demo-band .sub { color: var(--muted); font-size: 1.05rem; margin-bottom: 32px; }
.phone-number {
  font-size: clamp(1.8rem, 5vw, 3rem);
  font-weight: 800; letter-spacing: .02em;
  color: #fff; margin-bottom: 8px;
}
.phone-number a { color: inherit; }
.phone-hint { font-size: .88rem; color: #64748b; margin-bottom: 36px; }

/* ── PRICING ── */
.pricing-grid {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 20px; margin-top: 48px; align-items: start;
}
.price-card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 32px 28px;
  position: relative;
}
.price-card.featured {
  border-color: var(--accent);
  background: linear-gradient(180deg, rgba(59,130,246,.08) 0%, var(--card) 100%);
}
.price-badge {
  position: absolute; top: -12px; left: 50%; transform: translateX(-50%);
  background: var(--accent); color: #fff;
  font-size: .72rem; font-weight: 700; letter-spacing: .06em;
  text-transform: uppercase; padding: 4px 14px; border-radius: 100px;
  white-space: nowrap;
}
.price-tier { font-size: .82rem; font-weight: 600; color: var(--muted); margin-bottom: 10px; letter-spacing: .05em; text-transform: uppercase; }
.price-amount {
  font-size: 2.4rem; font-weight: 800; letter-spacing: -.03em;
  line-height: 1; margin-bottom: 4px;
}
.price-amount sup { font-size: 1.2rem; font-weight: 600; vertical-align: super; }
.price-period { font-size: .85rem; color: var(--muted); margin-bottom: 20px; }
.price-desc { font-size: .88rem; color: var(--muted); margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 20px; }
.price-features { list-style: none; display: flex; flex-direction: column; gap: 10px; margin-bottom: 28px; }
.price-features li {
  display: flex; gap: 10px; align-items: flex-start;
  font-size: .88rem; color: var(--muted);
}
.price-features li .check { color: var(--green); flex-shrink: 0; margin-top: 1px; }
.price-features li .cross { color: #475569; flex-shrink: 0; margin-top: 1px; }
.price-features li.active { color: var(--text); }
.price-cta {
  display: block; text-align: center;
  padding: 12px 20px; border-radius: 8px;
  font-size: .92rem; font-weight: 600;
  transition: background .15s, transform .1s;
}
.price-cta.primary { background: var(--accent); color: #fff; }
.price-cta.primary:hover { background: #2563eb; text-decoration: none; transform: translateY(-1px); }
.price-cta.ghost { border: 1px solid var(--border); color: var(--muted); }
.price-cta.ghost:hover { border-color: var(--accent); color: var(--text); text-decoration: none; }

/* ── FAQ ── */
.faq-list { margin-top: 48px; display: flex; flex-direction: column; gap: 2px; max-width: 760px; }
details {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); overflow: hidden;
  transition: background .15s;
}
details[open] { background: var(--card-hover); }
summary {
  cursor: pointer; list-style: none; padding: 18px 22px;
  display: flex; justify-content: space-between; align-items: center;
  font-weight: 600; font-size: .95rem; gap: 12px;
  user-select: none;
}
summary::-webkit-details-marker { display: none; }
summary::after { content: "+"; color: var(--accent); font-size: 1.3rem; flex-shrink: 0; transition: transform .2s; }
details[open] summary::after { transform: rotate(45deg); }
.faq-answer { padding: 0 22px 18px; font-size: .9rem; color: var(--muted); line-height: 1.6; }

/* ── FINAL CTA ── */
.final-cta {
  text-align: center; padding: 96px 0;
  background: radial-gradient(ellipse 70% 60% at 50% 100%, rgba(59,130,246,.12) 0%, transparent 70%);
}
.final-cta h2 { margin-bottom: 12px; }
.final-cta p { font-size: 1.05rem; color: var(--muted); margin-bottom: 36px; }

/* ── FOOTER ── */
footer {
  background: var(--surface); border-top: 1px solid var(--border);
  padding: 28px 0; text-align: center;
  font-size: .82rem; color: #475569;
}
footer a { color: #64748b; }
footer a:hover { color: var(--muted); }

/* ── RESPONSIVE ── */
@media (max-width: 800px) {
  .pricing-grid { grid-template-columns: 1fr; }
  .demo-grid    { grid-template-columns: 1fr; }
  .nav-links    { display: none; }
  .hero { padding: 64px 0 48px; }
  section { padding: 56px 0; }
  .demo-band { padding: 56px 0; }
  .final-cta { padding: 64px 0; }
}
@media (max-width: 480px) {
  .cta-group { flex-direction: column; align-items: stretch; }
  .btn-primary, .btn-ghost { justify-content: center; }
  .hero-proof { gap: 12px; flex-direction: column; }
}
`;
