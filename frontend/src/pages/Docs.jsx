import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BASE } from "../api/client.js";

const SECTIONS = [
  { id: "overview",      label: "Overview"            },
  { id: "auth",          label: "Authentication"       },
  { id: "limits",        label: "Limits"               },
  { id: "send",          label: "Send message"         },
  { id: "presets",       label: "OTP / Forms / Welcome"},
  { id: "bots",          label: "Bots"                 },
  { id: "templates",     label: "Templates"            },
  { id: "webhooks",      label: "Webhook test"         },
  { id: "deployment",    label: "Deployment process"   },
  { id: "ai",            label: "AI integration"       },
  { id: "limitations",   label: "WhatsApp limitations" },
  { id: "antispm",       label: "Safety & anti-spam"   },
  { id: "qrtrouble",     label: "QR troubleshooting"   },
  { id: "errors",        label: "Errors"               },
  { id: "faq",           label: "FAQ"                  },
];

const RATE_LIMITS = [
  { plan: "Free", calls: "30 calls / min", messages: "1,000 messages / month", keys: "1 API key" },
  { plan: "Pro",  calls: "300 calls / min", messages: "100,000 messages / month", keys: "10 API keys" },
];

const FAQ = [
  {
    q: "Can I use my personal WhatsApp number?",
    a: "We strongly advise against it. Use a dedicated SIM card or a number you can afford to lose. WhatsApp may ban unofficial automation accounts without warning."
  },
  {
    q: "How long does the QR code last?",
    a: "Each QR code is valid for approximately 20 seconds. WaBot automatically generates a fresh one when it expires. You have a 10-minute window to complete the scan."
  },
  {
    q: "Will my bot reconnect after a server restart?",
    a: "Yes — WaBot persists your WhatsApp session credentials in Supabase. As long as your phone stays connected to the internet, the bot will reconnect without requiring a new QR scan."
  },
  {
    q: "What happens if I exceed my message limit?",
    a: "Once the monthly message cap is reached (1,000 for Free, 100,000 for Pro) the bot stops sending automated replies. Manual sends via the API also stop. The counter resets at the start of each billing period."
  },
  {
    q: "Can multiple bots share one WhatsApp account?",
    a: "No. Each bot must be linked to a unique WhatsApp number. One phone number can only be paired to one bot instance at a time."
  },
  {
    q: "How do I disconnect a bot from WhatsApp?",
    a: "Delete the bot from your dashboard. This terminates the session and clears the stored credentials. To reconnect, deploy a new bot and scan the QR code again."
  },
  {
    q: "Is my WhatsApp session data encrypted?",
    a: "Session credentials (creds) are stored in your Supabase project which you control. AI API keys are encrypted with AES-256-GCM before being stored. Your raw API key is never persisted in plain text."
  },
  {
    q: "Can I use AI replies on the Free plan?",
    a: "No. AI integration (OpenAI, Gemini) is a Pro plan feature. Free users have access to all other features: keyword triggers, sales agent, auto-reply, webhooks, and commands."
  },
];

const LIMITATIONS = [
  { icon: "⚡", title: "Rate limits", desc: "WhatsApp limits how fast you can send messages. Sending too many messages too quickly is a primary reason accounts get banned. WaBot enforces a minimum 1.5-second gap between outgoing messages." },
  { icon: "🔗", title: "No broadcast lists", desc: "Bulk sending to broadcast lists via the Baileys API is not supported and will likely result in a ban. For bulk messaging, use the official WhatsApp Business API." },
  { icon: "🖼", title: "Media messages", desc: "Bots can receive image, video, audio, and document messages but automated replies to media content are limited. Text-based auto-replies are the most stable." },
  { icon: "📵", title: "Groups you are not admin in", desc: "Group management commands (.kick, .lock, .warn etc.) only work if the bot's WhatsApp account is a group admin. Regular member bots cannot moderate groups." },
  { icon: "🔄", title: "Session expiry", desc: "If your phone is offline for an extended period, WhatsApp may invalidate the linked session. The bot will be put into a disconnected state and require a new QR scan." },
  { icon: "📋", title: "Message history", desc: "Baileys does not sync full message history. The bot only processes messages received while it is running. Historical messages are not replayed on restart." },
];

const SAFETY_RULES = [
  { rule: "Use a dedicated number", detail: "Never use your primary personal or business number for bot automation." },
  { rule: "Keep message rates low", detail: "Don't send more than 1 message per 2 seconds. WaBot's queue enforces this automatically." },
  { rule: "No @everyone / @all tags", detail: "Mass @-mentioning all members of a group is a direct ban signal. Always target specific members." },
  { rule: "No unsolicited bulk messages", detail: "Sending marketing messages to numbers that have not opted in to receive them violates WhatsApp's terms of service." },
  { rule: "No spam loops", detail: "Configure AI reply trigger modes carefully. Use 'mention-only' or 'keyword' modes in groups to prevent the bot replying to every single message." },
  { rule: "Warm up new numbers", detail: "A brand new SIM card should exchange natural messages for 1–2 weeks before being used for automation. Instantly deploying a bot on a fresh number is a strong ban signal." },
];

const QR_STEPS = [
  { step: 1, title: "Open WhatsApp on your phone", detail: "Make sure your phone has an active internet connection and WhatsApp is updated to the latest version." },
  { step: 2, title: "Go to Linked Devices", detail: "On iOS: Settings → Linked Devices. On Android: the three-dot menu → Linked Devices." },
  { step: 3, title: "Tap 'Link a Device'", detail: "Tap the button and point your phone camera at the QR code shown in WaBot." },
  { step: 4, title: "Wait for confirmation", detail: "The QR screen in WaBot will automatically close and the bot status will change to 'connected' within a few seconds." },
];

const QR_ERRORS = [
  { err: "QR code expired before scan", fix: "WaBot automatically generates a new code every ~20 seconds. Wait for the fresh QR and scan quickly." },
  { err: "Scan worked but bot stays 'connecting'", fix: "Wait 10–15 seconds. The server needs time to confirm the handshake. If it stays stuck, delete the bot and deploy again." },
  { err: "QR timed out (2-minute timeout)", fix: "WaBot stops generating QR codes after 2 minutes with no scan to prevent ban signals. Click 'Reconnect' in the bot settings QR tab." },
  { err: "Bot was working but suddenly disconnected", fix: "Your phone may have lost internet connectivity or WhatsApp revoked the linked session. Open WhatsApp → Linked Devices and check if WaBot is still listed. If not, delete and redeploy the bot." },
  { err: "Phone says 'This QR code has already been scanned'", fix: "Refresh the QR tab in the bot settings — a fresh code should appear. If not, stop and restart the bot from the dashboard." },
];

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  return (
    <div style={{
      border: "1px solid rgba(168,85,247,0.2)",
      borderRadius: "16px",
      overflow: "hidden",
      background: "#050508",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.7rem 1rem",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "rgba(255,255,255,0.45)", letterSpacing: "0.04em" }}>
          EXAMPLE
        </span>
        <button
          onClick={copy}
          style={{
            padding: "0.25rem 0.7rem",
            borderRadius: "6px",
            background: copied ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.06)",
            border: `1px solid ${copied ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.1)"}`,
            color: copied ? "#22c55e" : "rgba(255,255,255,0.6)",
            fontSize: "0.75rem",
            cursor: "pointer",
            transition: "all 0.14s ease",
          }}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: "1rem",
        overflowX: "auto",
        color: "#c4b5fd",
        fontSize: "0.8rem",
        lineHeight: 1.7,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function DocSection({ id, title, eyebrow, children }) {
  return (
    <section id={id} style={{ scrollMarginTop: "5rem" }}>
      {eyebrow && (
        <div style={{
          display: "inline-block",
          fontSize: "0.7rem",
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "#a855f7",
          marginBottom: "0.5rem",
        }}>
          {eyebrow}
        </div>
      )}
      <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "1rem", color: "#eeeeff" }}>
        {title}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem", color: "rgba(238,238,255,0.6)" }}>
        {children}
      </div>
    </section>
  );
}

function Divider() {
  return <div style={{ height: "1px", background: "rgba(255,255,255,0.05)", margin: "0.25rem 0" }} />;
}

function InlineCode({ children }) {
  return (
    <code style={{
      background: "rgba(168,85,247,0.12)",
      border: "1px solid rgba(168,85,247,0.2)",
      borderRadius: "5px",
      padding: "0.1em 0.45em",
      fontSize: "0.875em",
      color: "#c4b5fd",
    }}>
      {children}
    </code>
  );
}

export default function Docs() {
  const apiBase = useMemo(() => BASE, []);

  const snippets = useMemo(() => ({
    curlSend: `curl -X POST "${apiBase}/v1/messages/send" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "message": "Hello from WaBot"
  }'`,
    jsSend: `const response = await fetch("${apiBase}/v1/messages/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer wbk_YOUR_API_KEY",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    bot_id: "your-bot-id",
    to: "2348012345678",
    message: "Order confirmed ✅"
  })
});

const data = await response.json();
// { ok: true, message: "Message sent.", timestamp: 1714939200000 }`,
    otpSend: `curl -X POST "${apiBase}/v1/messages/otp" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "app_name": "WaBot",
    "code": "482901",
    "expires_in_minutes": 10
  }'`,
    formSend: `curl -X POST "${apiBase}/v1/messages/form-submission" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "form_name": "Lead Capture",
    "fields": {
      "name": "Ada",
      "email": "ada@example.com",
      "plan": "Pro"
    }
  }'`,
    welcomeSend: `curl -X POST "${apiBase}/v1/messages/welcome" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "name": "Ada"
  }'`,
    botsList: `GET ${apiBase}/v1/bots
Authorization: Bearer wbk_YOUR_API_KEY`,
    templateSend: `{
  "bot_id": "your-bot-id",
  "to": "2348012345678",
  "template": "welcome",
  "vars": {
    "name": "Ada",
    "company": "Northwind"
  }
}`,
    webhookTest: `curl -X POST "${apiBase}/v1/webhooks/test" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://your-app.com/webhooks/wabot",
    "secret": "whsec_your_outbound_secret"
  }'`,
    aiConfig: `// PATCH /api/bots/:id — configure AI for a bot (Pro plan only)
{
  "ai_config": {
    "enabled": true,
    "provider": "openai",
    "model": "gpt-4o-mini",
    "api_key": "sk-...",
    "system_prompt": "You are a helpful WhatsApp assistant for Northwind Foods.",
    "dm_trigger_mode": "all",
    "group_trigger_mode": "mention"
  }
}`,
  }), [apiBase]);

  const styles = {
    page: {
      minHeight: "100vh",
      background: "#07070c",
      color: "#eeeeff",
      fontFamily: "'Inter', system-ui, sans-serif",
    },
    nav: {
      position: "sticky",
      top: 0,
      zIndex: 30,
      background: "rgba(7,7,12,0.92)",
      backdropFilter: "blur(20px)",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
    },
    navInner: {
      maxWidth: "1160px",
      margin: "0 auto",
      padding: "0.875rem 1.25rem",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "1rem",
      flexWrap: "wrap",
    },
    container: {
      maxWidth: "1160px",
      margin: "0 auto",
      padding: "2.5rem 1.25rem 5rem",
      display: "grid",
      gridTemplateColumns: "220px 1fr",
      gap: "2.5rem",
      alignItems: "start",
    },
    sidebar: {
      position: "sticky",
      top: "5rem",
      display: "flex",
      flexDirection: "column",
      gap: "0.25rem",
    },
    sidebarLink: {
      display: "block",
      padding: "0.45rem 0.75rem",
      borderRadius: "8px",
      fontSize: "0.82rem",
      color: "rgba(238,238,255,0.5)",
      textDecoration: "none",
      transition: "all 0.12s ease",
      borderLeft: "2px solid transparent",
    },
    content: {
      display: "flex",
      flexDirection: "column",
      gap: "2.5rem",
    },
    card: {
      background: "#0d0d14",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: "16px",
      padding: "1.5rem",
      display: "flex",
      flexDirection: "column",
      gap: "1.25rem",
    },
    heroCard: {
      background: "linear-gradient(135deg, #0f0a1e 0%, #0d0d20 50%, #0a0f1e 100%)",
      border: "1px solid rgba(168,85,247,0.2)",
      borderRadius: "20px",
      padding: "2rem",
    },
    tag: {
      display: "inline-flex",
      alignItems: "center",
      gap: "0.4rem",
      padding: "0.3rem 0.75rem",
      borderRadius: "999px",
      background: "rgba(168,85,247,0.12)",
      border: "1px solid rgba(168,85,247,0.2)",
      fontSize: "0.78rem",
      color: "#a855f7",
      fontWeight: 600,
    },
    metaGrid: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
      gap: "0.75rem",
      marginTop: "0.5rem",
    },
    metaTile: {
      border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: "12px",
      padding: "0.875rem",
      background: "rgba(255,255,255,0.03)",
    },
  };

  return (
    <div style={styles.page}>

      {/* ── Navbar ── */}
      <nav style={styles.nav}>
        <div style={styles.navInner}>
          <div>
            <div style={{ fontWeight: 800, fontSize: "1rem", color: "#eeeeff", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ fontSize: "1.1rem" }}>🤖</span> WaBot API Docs
            </div>
            <div style={{ fontSize: "0.75rem", color: "rgba(238,238,255,0.35)", marginTop: "0.1rem" }}>
              REST API · Split-deploy ready · Rate-limited by plan
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.625rem", flexWrap: "wrap" }}>
            <Link to="/" style={{
              padding: "0.4rem 0.875rem",
              borderRadius: "8px",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              fontSize: "0.82rem",
              color: "rgba(238,238,255,0.7)",
              textDecoration: "none",
            }}>
              ← Home
            </Link>
            <Link to="/signup" style={{
              padding: "0.4rem 0.875rem",
              borderRadius: "8px",
              background: "#a855f7",
              border: "none",
              fontSize: "0.82rem",
              color: "#fff",
              fontWeight: 600,
              textDecoration: "none",
            }}>
              Get API key
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Body ── */}
      <div style={styles.container}>

        {/* ── Sidebar ── */}
        <aside style={styles.sidebar}>
          <div style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.25)", padding: "0 0.75rem", marginBottom: "0.25rem" }}>
            Sections
          </div>
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              style={styles.sidebarLink}
              onMouseEnter={(e) => { e.target.style.color = "#eeeeff"; e.target.style.background = "rgba(255,255,255,0.05)"; e.target.style.borderLeftColor = "#a855f7"; }}
              onMouseLeave={(e) => { e.target.style.color = "rgba(238,238,255,0.5)"; e.target.style.background = "transparent"; e.target.style.borderLeftColor = "transparent"; }}
            >
              {s.label}
            </a>
          ))}
        </aside>

        {/* ── Main content ── */}
        <main style={styles.content}>

          {/* Hero */}
          <div style={styles.heroCard}>
            <div style={styles.tag}>
              <span>⚡</span> Developer API · REST + API keys
            </div>
            <h1 style={{ fontSize: "clamp(1.75rem, 3vw, 2.5rem)", lineHeight: 1.1, margin: "0.875rem 0", color: "#eeeeff" }}>
              Ship WhatsApp automation without guessing the backend shape.
            </h1>
            <p style={{ maxWidth: "640px", color: "rgba(238,238,255,0.6)", lineHeight: 1.75, fontSize: "0.9375rem" }}>
              Use your dashboard API key to send messages, manage templates, inspect bot activity,
              and test webhooks. Free and Pro plans share the same API surface with different rate limits.
            </p>
            <div style={styles.metaGrid}>
              {[
                { label: "Auth", value: "Bearer wbk_ key" },
                { label: "Free", value: "30 req / min" },
                { label: "Pro",  value: "300 req / min" },
                { label: "Billing", value: "Paystack · ₦1,500 / mo" },
              ].map((item) => (
                <div key={item.label} style={styles.metaTile}>
                  <div style={{ fontSize: "0.72rem", color: "rgba(238,238,255,0.4)", marginBottom: "0.25rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>{item.label}</div>
                  <div style={{ fontWeight: 700, color: "#eeeeff", fontSize: "0.875rem" }}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* API Reference card */}
          <div style={styles.card}>

            <DocSection id="overview" title="Overview">
              <p>Base path: <InlineCode>{apiBase}/v1</InlineCode>. All developer endpoints live under <InlineCode>/api/v1</InlineCode> on the backend.</p>
              <p>Authentication accepts either a dashboard JWT for first-party usage or a generated API key that starts with <InlineCode>wbk_</InlineCode>.</p>
              <p>The frontend and backend can run on separate servers. In production, set <InlineCode>VITE_API_BASE_URL</InlineCode> to your backend origin. If you omit <InlineCode>/api</InlineCode>, the client adds it automatically.</p>
            </DocSection>

            <Divider />

            <DocSection id="auth" title="Authentication">
              <p>All requests require an <InlineCode>Authorization</InlineCode> header:</p>
              <CodeBlock code={`Authorization: Bearer wbk_YOUR_API_KEY\nContent-Type: application/json`} />
              <p>Create, rotate, and revoke API keys from the dashboard under <strong style={{ color: "#eeeeff" }}>API Keys</strong>. Free users get 1 key; Pro users get 10.</p>
            </DocSection>

            <Divider />

            <DocSection id="limits" title="Rate limits">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem" }}>
                {RATE_LIMITS.map((item) => (
                  <div key={item.plan} style={{ border: "1px solid rgba(255,255,255,0.07)", borderRadius: "12px", padding: "1rem", background: "rgba(255,255,255,0.02)" }}>
                    <div style={{ fontWeight: 800, marginBottom: "0.5rem", color: item.plan === "Pro" ? "#a855f7" : "#eeeeff" }}>{item.plan}</div>
                    <div style={{ fontSize: "0.82rem", lineHeight: 1.8 }}>
                      <div>{item.calls}</div>
                      <div>{item.messages}</div>
                      <div>{item.keys}</div>
                    </div>
                  </div>
                ))}
              </div>
              <p>Monthly message counters reset at the start of each billing period. AI features require the Pro plan.</p>
            </DocSection>

            <Divider />

            <DocSection id="send" title="Send message">
              <p><InlineCode>POST /v1/messages/send</InlineCode> sends a single WhatsApp message through one connected bot.</p>
              <CodeBlock code={snippets.curlSend} />
              <CodeBlock code={snippets.jsSend} />
              <p>All outgoing messages pass through WaBot's rate-limiting queue — a minimum 1.5-second gap is enforced between consecutive sends to reduce ban risk.</p>
            </DocSection>

            <Divider />

            <DocSection id="presets" title="OTP / Forms / Welcome">
              <p>Purpose-built endpoints format outgoing messages for common workflows automatically.</p>
              <p><InlineCode>POST /v1/messages/otp</InlineCode> — formats a one-time password message with optional expiry.</p>
              <CodeBlock code={snippets.otpSend} />
              <p><InlineCode>POST /v1/messages/form-submission</InlineCode> — turns a form submission object into a readable WhatsApp notification.</p>
              <CodeBlock code={snippets.formSend} />
              <p><InlineCode>POST /v1/messages/welcome</InlineCode> — sends a lightweight welcome or acknowledgment message.</p>
              <CodeBlock code={snippets.welcomeSend} />
            </DocSection>

            <Divider />

            <DocSection id="bots" title="Bots">
              <p>Inspect and manage the bot layer behind your API usage.</p>
              <CodeBlock code={snippets.botsList} />
              <p>Available endpoints:</p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {[
                  ["GET",   "/v1/bots",                 "List all bots"],
                  ["GET",   "/v1/bots/:id",              "Get a single bot"],
                  ["GET",   "/v1/bots/:id/stats",        "Usage stats for a bot"],
                  ["GET",   "/v1/bots/:id/config",       "Get bot configuration"],
                  ["PATCH", "/v1/bots/:id/config",       "Update bot configuration"],
                ].map(([method, path, desc]) => (
                  <div key={`${method}-${path}`} style={{ display: "flex", gap: "0.75rem", alignItems: "center", fontSize: "0.82rem" }}>
                    <InlineCode>{method}</InlineCode>
                    <InlineCode>{path}</InlineCode>
                    <span style={{ color: "rgba(238,238,255,0.4)" }}>{desc}</span>
                  </div>
                ))}
              </div>
            </DocSection>

            <Divider />

            <DocSection id="templates" title="Templates">
              <p>Templates let you store reusable message content and substitute variables at send time.</p>
              <CodeBlock code={snippets.templateSend} />
              <p>CRUD endpoints: <InlineCode>GET /v1/templates</InlineCode>, <InlineCode>POST /v1/templates</InlineCode>, <InlineCode>PATCH /v1/templates/:id</InlineCode>, <InlineCode>DELETE /v1/templates/:id</InlineCode>.</p>
            </DocSection>

            <Divider />

            <DocSection id="webhooks" title="Webhook test">
              <p><InlineCode>POST /v1/webhooks/test</InlineCode> verifies outbound webhook reachability and HMAC signing before trusting production traffic.</p>
              <CodeBlock code={snippets.webhookTest} />
              <p>Every webhook delivery includes an <InlineCode>X-WaBot-Signature</InlineCode> header (HMAC-SHA256 of the payload body using your webhook secret). Always verify this in your receiver.</p>
            </DocSection>

          </div>

          {/* ── Deployment guide card ── */}
          <div style={styles.card}>

            <DocSection id="deployment" eyebrow="Guide" title="Bot deployment process">
              <p>Deploying a bot on WaBot follows a simple four-step process that takes about 60 seconds.</p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {[
                  ["1", "Name and configure your bot", "Choose a name, select DM or Group mode, and optionally add a description. Bot type cannot be changed after deployment."],
                  ["2", "Accept the safety warning", "You must acknowledge the WhatsApp automation risks before proceeding. This protects both you and the platform."],
                  ["3", "Scan the QR code", "Open WhatsApp on your phone → Linked Devices → Link a Device, then scan the QR shown in WaBot. The code refreshes every ~20 seconds."],
                  ["4", "Configure and go live", "Once connected, configure auto-replies, keyword triggers, AI responses, and webhooks from the bot settings modal. Changes apply live without reconnecting."],
                ].map(([num, title, detail]) => (
                  <div key={num} style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
                    <div style={{
                      width: "28px",
                      height: "28px",
                      borderRadius: "50%",
                      background: "rgba(168,85,247,0.15)",
                      border: "1px solid rgba(168,85,247,0.3)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.8rem",
                      fontWeight: 700,
                      color: "#a855f7",
                      flexShrink: 0,
                      marginTop: "2px",
                    }}>{num}</div>
                    <div>
                      <div style={{ fontWeight: 600, color: "#eeeeff", fontSize: "0.875rem", marginBottom: "0.2rem" }}>{title}</div>
                      <div style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>{detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </DocSection>

            <Divider />

            <DocSection id="ai" eyebrow="Pro feature" title="AI integration">
              <p>Pro plan users can connect OpenAI or Google Gemini to power intelligent auto-replies.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem" }}>
                {[
                  { provider: "OpenAI", models: "gpt-4o, gpt-4o-mini, gpt-3.5-turbo", link: "https://platform.openai.com/api-keys" },
                  { provider: "Google Gemini", models: "gemini-1.5-pro, gemini-1.5-flash, gemini-2.0-flash", link: "https://aistudio.google.com/apikey" },
                ].map((p) => (
                  <div key={p.provider} style={{ border: "1px solid rgba(255,255,255,0.07)", borderRadius: "12px", padding: "0.875rem", background: "rgba(255,255,255,0.02)" }}>
                    <div style={{ fontWeight: 700, color: "#eeeeff", marginBottom: "0.4rem" }}>{p.provider}</div>
                    <div style={{ fontSize: "0.78rem", color: "rgba(238,238,255,0.5)", marginBottom: "0.5rem", lineHeight: 1.6 }}>{p.models}</div>
                    <a href={p.link} target="_blank" rel="noreferrer" style={{ fontSize: "0.75rem", color: "#a855f7" }}>Get API key →</a>
                  </div>
                ))}
              </div>
              <p>AI API keys are encrypted with AES-256-GCM before being stored. The raw key is never persisted in plain text and is never returned to the frontend after saving.</p>
              <p>Configure trigger modes to prevent AI reply spam:</p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {[
                  ["all",     "Reply to every message — best for DM bots"],
                  ["mention", "Reply only when the bot is @-mentioned — recommended for groups"],
                  ["keyword", "Reply only when message starts with a configured prefix (e.g. @bot)"],
                ].map(([mode, desc]) => (
                  <div key={mode} style={{ display: "flex", gap: "0.75rem", alignItems: "center", fontSize: "0.82rem" }}>
                    <InlineCode>{mode}</InlineCode>
                    <span style={{ color: "rgba(238,238,255,0.5)" }}>{desc}</span>
                  </div>
                ))}
              </div>
              <CodeBlock code={snippets.aiConfig} />
            </DocSection>

          </div>

          {/* ── Safety card ── */}
          <div style={styles.card}>

            <DocSection id="limitations" eyebrow="Important" title="WhatsApp limitations">
              <p>WaBot uses the Baileys library which is an unofficial WhatsApp client. Be aware of the following constraints:</p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
                {LIMITATIONS.map((l) => (
                  <div key={l.title} style={{ display: "flex", gap: "0.875rem", alignItems: "flex-start" }}>
                    <span style={{ fontSize: "1.15rem", flexShrink: 0 }}>{l.icon}</span>
                    <div>
                      <div style={{ fontWeight: 600, color: "#eeeeff", fontSize: "0.875rem", marginBottom: "0.2rem" }}>{l.title}</div>
                      <div style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>{l.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </DocSection>

            <Divider />

            <DocSection id="antispm" eyebrow="Safety" title="Anti-spam rules">
              <p>Violating WhatsApp's usage policies is the quickest way to get your number banned permanently. Follow these rules:</p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
                {SAFETY_RULES.map((r) => (
                  <div key={r.rule} style={{
                    display: "flex",
                    gap: "0.75rem",
                    padding: "0.75rem",
                    borderRadius: "10px",
                    background: "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}>
                    <span style={{ color: "#22c55e", fontWeight: 700, flexShrink: 0, fontSize: "0.875rem" }}>✓</span>
                    <div>
                      <div style={{ fontWeight: 600, color: "#eeeeff", fontSize: "0.8125rem", marginBottom: "0.15rem" }}>{r.rule}</div>
                      <div style={{ fontSize: "0.775rem", lineHeight: 1.55 }}>{r.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </DocSection>

            <Divider />

            <DocSection id="qrtrouble" eyebrow="Troubleshooting" title="QR code issues">
              <p>These are the most common QR-related problems and how to fix them:</p>
              <div style={{ display: "grid", gap: "0.75rem" }}>
                {QR_ERRORS.map((e) => (
                  <div key={e.err} style={{ border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", padding: "0.875rem" }}>
                    <div style={{ fontWeight: 600, color: "#f59e0b", fontSize: "0.8125rem", marginBottom: "0.35rem", display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                      <span style={{ flexShrink: 0 }}>⚠</span> {e.err}
                    </div>
                    <div style={{ fontSize: "0.78rem", lineHeight: 1.6, paddingLeft: "1.25rem" }}>{e.fix}</div>
                  </div>
                ))}
              </div>
              <p>For the step-by-step scan process:</p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {QR_STEPS.map((s) => (
                  <div key={s.step} style={{ display: "flex", gap: "0.875rem", alignItems: "flex-start", fontSize: "0.82rem" }}>
                    <div style={{
                      width: "22px",
                      height: "22px",
                      borderRadius: "50%",
                      background: "rgba(168,85,247,0.15)",
                      border: "1px solid rgba(168,85,247,0.25)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.7rem",
                      fontWeight: 700,
                      color: "#a855f7",
                      flexShrink: 0,
                      marginTop: "2px",
                    }}>{s.step}</div>
                    <div>
                      <span style={{ fontWeight: 600, color: "#eeeeff" }}>{s.title}</span>
                      <span style={{ color: "rgba(238,238,255,0.45)" }}> — {s.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            </DocSection>

            <Divider />

            <DocSection id="errors" title="HTTP error codes">
              <div style={{ display: "grid", gap: "0.625rem" }}>
                {[
                  ["401", "Missing, invalid, or expired token / API key."],
                  ["403", "Plan-gated feature (AI config, Pro-only endpoints)."],
                  ["404", "Bot, template, or subscription resource not found."],
                  ["409", "Bot exists but is not connected yet."],
                  ["429", "Rate limit or monthly usage limit reached."],
                  ["503", "Billing or email provider not configured on this backend."],
                ].map(([code, text]) => (
                  <div key={code} style={{
                    display: "grid",
                    gridTemplateColumns: "64px 1fr",
                    gap: "0.875rem",
                    border: "1px solid rgba(255,255,255,0.06)",
                    borderRadius: "10px",
                    padding: "0.75rem 0.875rem",
                    alignItems: "center",
                  }}>
                    <code style={{ fontWeight: 700, color: code === "429" || code === "401" ? "#f43f5e" : "#f59e0b", fontSize: "0.875rem" }}>{code}</code>
                    <span style={{ fontSize: "0.82rem" }}>{text}</span>
                  </div>
                ))}
              </div>
            </DocSection>

          </div>

          {/* ── FAQ card ── */}
          <div style={styles.card}>
            <DocSection id="faq" eyebrow="FAQ" title="Frequently asked questions">
              <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
                {FAQ.map((item, i) => (
                  <FaqItem key={i} q={item.q} a={item.a} />
                ))}
              </div>
            </DocSection>
          </div>

          {/* Footer */}
          <div style={{ textAlign: "center", paddingTop: "1rem" }}>
            <div style={{ fontSize: "0.82rem", color: "rgba(238,238,255,0.25)" }}>
              WaBot API Docs · <a href="/" style={{ color: "#a855f7" }}>wabot.app</a> · © {new Date().getFullYear()}
            </div>
          </div>

        </main>
      </div>
    </div>
  );
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "1rem 0",
          background: "none",
          border: "none",
          color: "#eeeeff",
          fontSize: "0.875rem",
          fontWeight: 600,
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <span>{q}</span>
        <span style={{
          color: "#a855f7",
          fontSize: "1.1rem",
          transition: "transform 0.2s ease",
          transform: open ? "rotate(45deg)" : "none",
          flexShrink: 0,
        }}>+</span>
      </button>
      {open && (
        <div style={{
          paddingBottom: "1rem",
          fontSize: "0.8125rem",
          color: "rgba(238,238,255,0.55)",
          lineHeight: 1.7,
        }}>
          {a}
        </div>
      )}
    </div>
  );
}
