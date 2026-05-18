import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

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
    a: "Yes — WaBot persists your WhatsApp session credentials. As long as your phone stays connected to the internet, the bot will reconnect without requiring a new QR scan."
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
    a: "Session credentials are stored in your Supabase project which you control. AI API keys are encrypted with AES-256-GCM before being stored. Your raw API key is never persisted in plain text."
  },
  {
    q: "Can I use AI replies on the Free plan?",
    a: "No. AI integration (OpenAI, Gemini) is a Pro plan feature. Free users have access to all other features: keyword triggers, sales agent, auto-reply, webhooks, and commands."
  },
];

const LIMITATIONS = [
  { icon: "⚡", title: "Rate limits", desc: "WhatsApp limits how fast you can send messages. Sending too many messages too quickly is a primary reason accounts get banned. WaBot enforces a minimum 1.5-second gap between outgoing messages." },
  { icon: "🔗", title: "No broadcast lists", desc: "Bulk sending to broadcast lists via the API is not supported and will likely result in a ban. For bulk messaging, use the official WhatsApp Business API." },
  { icon: "🖼", title: "Media messages", desc: "Bots can receive image, video, audio, and document messages but automated replies to media content are limited. Text-based auto-replies are the most stable." },
  { icon: "📵", title: "Groups you are not admin in", desc: "Group management commands (.kick, .lock, .warn etc.) only work if the bot's WhatsApp account is a group admin. Regular member bots cannot moderate groups." },
  { icon: "🔄", title: "Session expiry", desc: "If your phone is offline for an extended period, WhatsApp may invalidate the linked session. The bot will be put into a disconnected state and require a new QR scan." },
  { icon: "📋", title: "Message history", desc: "The bot only processes messages received while it is running. Historical messages are not replayed on restart." },
];

const SAFETY_RULES = [
  { rule: "Use a dedicated number", detail: "Never use your primary personal or business number for bot automation." },
  { rule: "Keep message rates low", detail: "Don't send more than 1 message per 2 seconds. WaBot's queue enforces this automatically." },
  { rule: "No @everyone / @all tags", detail: "Mass @-mentioning all members of a group is a direct ban signal. Always target specific members." },
  { rule: "No unsolicited bulk messages", detail: "Sending marketing messages to numbers that have not opted in violates WhatsApp's terms of service." },
  { rule: "No spam loops", detail: "Configure AI reply trigger modes carefully. Use 'mention-only' or 'keyword' modes in groups." },
  { rule: "Warm up new numbers", detail: "A brand new SIM card should exchange natural messages for 1–2 weeks before being used for automation." },
];

const QR_STEPS = [
  { step: 1, title: "Open WhatsApp on your phone", detail: "Make sure your phone has an active internet connection." },
  { step: 2, title: "Go to Linked Devices", detail: "On iOS: Settings → Linked Devices. On Android: three-dot menu → Linked Devices." },
  { step: 3, title: "Tap 'Link a Device'", detail: "Point your phone camera at the QR code shown in WaBot." },
  { step: 4, title: "Wait for confirmation", detail: "The QR screen will automatically close and the bot status will change to 'connected'." },
];

const QR_ERRORS = [
  { err: "QR code expired before scan", fix: "WaBot automatically generates a new code every ~20 seconds. Wait for the fresh QR and scan quickly." },
  { err: "Scan worked but bot stays 'connecting'", fix: "Wait 10–15 seconds. If it stays stuck, delete the bot and deploy again." },
  { err: "QR timed out (2-minute timeout)", fix: "Click 'Reconnect' in the bot settings QR tab to generate a fresh code." },
  { err: "Bot was working but suddenly disconnected", fix: "Check WhatsApp → Linked Devices. If WaBot is not listed, delete and redeploy the bot." },
];

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-label">EXAMPLE</span>
        <button className={`code-copy-btn ${copied ? "copied" : ""}`} onClick={copy}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-block-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="faq-item">
      <button className="faq-question" onClick={() => setOpen(!open)}>
        <span>{q}</span>
        <span className={`faq-icon ${open ? "open" : ""}`}>+</span>
      </button>
      {open && <div className="faq-answer">{a}</div>}
    </div>
  );
}

export default function Docs() {
  // Use a generic placeholder instead of exposing the actual backend URL
  const apiBase = "/api/v1";

  const snippets = {
    curlSend: `curl -X POST "/api/v1/messages/send" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "message": "Hello from WaBot"
  }'`,
    jsSend: `const response = await fetch("/api/v1/messages/send", {
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
});`,
    otpSend: `curl -X POST "/api/v1/messages/otp" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "app_name": "WaBot",
    "code": "482901",
    "expires_in_minutes": 10
  }'`,
    formSend: `curl -X POST "/api/v1/messages/form-submission" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "form_name": "Lead Capture",
    "fields": {
      "name": "Ada",
      "email": "ada@example.com"
    }
  }'`,
    welcomeSend: `curl -X POST "/api/v1/messages/welcome" \\
  -H "Authorization: Bearer wbk_YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "bot_id": "your-bot-id",
    "to": "2348012345678",
    "name": "Ada"
  }'`,
    botsList: `GET /api/v1/bots
Authorization: Bearer wbk_YOUR_API_KEY`,
    templateSend: `{
  "bot_id": "your-bot-id",
  "to": "2348012345678",
  "template": "welcome",
  "vars": {
    "name": "Ada"
  }
}`,
    webhookTest: `curl -X POST "/api/v1/webhooks/test" \\
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
    "system_prompt": "You are a helpful WhatsApp assistant.",
    "dm_trigger_mode": "all",
    "group_trigger_mode": "mention"
  }
}`,
  };

  return (
    <div className="docs-page">
      {/* Navbar */}
      <nav className="docs-nav">
        <div className="docs-nav-inner">
          <div>
            <div className="docs-nav-logo">
              <span>🤖</span> WaBot API Docs
            </div>
            <div className="docs-nav-sub">REST API · Rate-limited by plan</div>
          </div>
          <div className="docs-nav-actions">
            <Link to="/" className="docs-nav-home">← Home</Link>
            <Link to="/signup" className="docs-nav-signup">Get API key</Link>
          </div>
        </div>
      </nav>

      {/* Body */}
      <div className="docs-container">
        {/* Sidebar */}
        <aside className="docs-sidebar">
          <div className="docs-sidebar-title">Sections</div>
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="docs-sidebar-link">
              {s.label}
            </a>
          ))}
        </aside>

        {/* Main Content */}
        <main className="docs-main">
          {/* Hero */}
          <div className="docs-hero">
            <div className="docs-hero-tag">⚡ Developer API · REST + API keys</div>
            <h1 className="docs-hero-title">
              Ship WhatsApp automation without guessing the backend shape.
            </h1>
            <p className="docs-hero-desc">
              Use your dashboard API key to send messages, manage templates, inspect bot activity,
              and test webhooks. Free and Pro plans share the same API surface with different rate limits.
            </p>
            <div className="docs-meta-grid">
              <div className="docs-meta-tile"><div className="docs-meta-label">Auth</div><div className="docs-meta-value">Bearer wbk_ key</div></div>
              <div className="docs-meta-tile"><div className="docs-meta-label">Free</div><div className="docs-meta-value">30 req / min</div></div>
              <div className="docs-meta-tile"><div className="docs-meta-label">Pro</div><div className="docs-meta-value">300 req / min</div></div>
              <div className="docs-meta-tile"><div className="docs-meta-label">Billing</div><div className="docs-meta-value">Paystack · ₦1,500 / mo</div></div>
            </div>
          </div>

          {/* Main Card */}
          <div className="docs-card">
            {/* Overview */}
            <section id="overview" className="docs-section">
              <h2>Overview</h2>
              <p>Base path: <code className="inline-code">/api/v1</code>. All developer endpoints live under <code className="inline-code">/api/v1</code>.</p>
              <p>Authentication accepts either a dashboard JWT or a generated API key that starts with <code className="inline-code">wbk_</code>.</p>
            </section>

            <hr className="docs-divider" />

            {/* Auth */}
            <section id="auth" className="docs-section">
              <h2>Authentication</h2>
              <p>All requests require an <code className="inline-code">Authorization</code> header:</p>
              <CodeBlock code={`Authorization: Bearer wbk_YOUR_API_KEY\nContent-Type: application/json`} />
              <p>Create, rotate, and revoke API keys from the dashboard under <strong>API Keys</strong>. Free users get 1 key; Pro users get 10.</p>
            </section>

            <hr className="docs-divider" />

            {/* Limits */}
            <section id="limits" className="docs-section">
              <h2>Rate limits</h2>
              <div className="docs-limits-grid">
                {RATE_LIMITS.map((item) => (
                  <div key={item.plan} className={`docs-limit-card ${item.plan === "Pro" ? "pro" : ""}`}>
                    <div className="docs-limit-plan">{item.plan}</div>
                    <div className="docs-limit-details">
                      <div>{item.calls}</div>
                      <div>{item.messages}</div>
                      <div>{item.keys}</div>
                    </div>
                  </div>
                ))}
              </div>
              <p>Monthly message counters reset at the start of each billing period. AI features require the Pro plan.</p>
            </section>

            <hr className="docs-divider" />

            {/* Send Message */}
            <section id="send" className="docs-section">
              <h2>Send message</h2>
              <p><code className="inline-code">POST /v1/messages/send</code> sends a single WhatsApp message through one connected bot.</p>
              <CodeBlock code={snippets.curlSend} />
              <CodeBlock code={snippets.jsSend} />
            </section>

            <hr className="docs-divider" />

            {/* Presets */}
            <section id="presets" className="docs-section">
              <h2>OTP / Forms / Welcome</h2>
              <p><code className="inline-code">POST /v1/messages/otp</code> — formats a one-time password message.</p>
              <CodeBlock code={snippets.otpSend} />
              <p><code className="inline-code">POST /v1/messages/form-submission</code> — turns form data into a readable notification.</p>
              <CodeBlock code={snippets.formSend} />
              <p><code className="inline-code">POST /v1/messages/welcome</code> — sends a welcome message.</p>
              <CodeBlock code={snippets.welcomeSend} />
            </section>

            <hr className="docs-divider" />

            {/* Bots */}
            <section id="bots" className="docs-section">
              <h2>Bots</h2>
              <CodeBlock code={snippets.botsList} />
              <div className="docs-endpoints">
                <div><code className="inline-code">GET</code> <code className="inline-code">/v1/bots</code> <span>List all bots</span></div>
                <div><code className="inline-code">GET</code> <code className="inline-code">/v1/bots/:id</code> <span>Get a single bot</span></div>
                <div><code className="inline-code">GET</code> <code className="inline-code">/v1/bots/:id/stats</code> <span>Usage stats</span></div>
                <div><code className="inline-code">GET</code> <code className="inline-code">/v1/bots/:id/config</code> <span>Get configuration</span></div>
                <div><code className="inline-code">PATCH</code> <code className="inline-code">/v1/bots/:id/config</code> <span>Update configuration</span></div>
              </div>
            </section>

            <hr className="docs-divider" />

            {/* Templates */}
            <section id="templates" className="docs-section">
              <h2>Templates</h2>
              <CodeBlock code={snippets.templateSend} />
              <p>CRUD endpoints: <code className="inline-code">GET /v1/templates</code>, <code className="inline-code">POST /v1/templates</code>, <code className="inline-code">PATCH /v1/templates/:id</code>, <code className="inline-code">DELETE /v1/templates/:id</code>.</p>
            </section>

            <hr className="docs-divider" />

            {/* Webhooks */}
            <section id="webhooks" className="docs-section">
              <h2>Webhook test</h2>
              <CodeBlock code={snippets.webhookTest} />
              <p>Every webhook delivery includes an <code className="inline-code">X-WaBot-Signature</code> header (HMAC-SHA256). Always verify this in your receiver.</p>
            </section>
          </div>

          {/* Deployment Card */}
          <div className="docs-card">
            <section id="deployment" className="docs-section">
              <div className="docs-eyebrow">Guide</div>
              <h2>Bot deployment process</h2>
              <div className="docs-steps">
                <div className="docs-step"><div className="docs-step-num">1</div><div><strong>Name and configure your bot</strong> — Choose a name, select DM or Group mode.</div></div>
                <div className="docs-step"><div className="docs-step-num">2</div><div><strong>Accept the safety warning</strong> — Acknowledge WhatsApp automation risks.</div></div>
                <div className="docs-step"><div className="docs-step-num">3</div><div><strong>Scan the QR code</strong> — WhatsApp → Linked Devices → Link a Device.</div></div>
                <div className="docs-step"><div className="docs-step-num">4</div><div><strong>Configure and go live</strong> — Set up auto-replies, triggers, and webhooks.</div></div>
              </div>
            </section>

            <hr className="docs-divider" />

            <section id="ai" className="docs-section">
              <div className="docs-eyebrow pro">Pro feature</div>
              <h2>AI integration</h2>
              <div className="docs-providers-grid">
                <div className="docs-provider"><div className="docs-provider-name">OpenAI</div><div className="docs-provider-models">gpt-4o, gpt-4o-mini, gpt-3.5-turbo</div></div>
                <div className="docs-provider"><div className="docs-provider-name">Google Gemini</div><div className="docs-provider-models">gemini-1.5-pro, gemini-1.5-flash</div></div>
              </div>
              <CodeBlock code={snippets.aiConfig} />
            </section>
          </div>

          {/* Safety Card */}
          <div className="docs-card">
            <section id="limitations" className="docs-section">
              <div className="docs-eyebrow">Important</div>
              <h2>WhatsApp limitations</h2>
              {LIMITATIONS.map((l) => (
                <div key={l.title} className="docs-limitation">
                  <span className="docs-limitation-icon">{l.icon}</span>
                  <div><strong>{l.title}</strong> — {l.desc}</div>
                </div>
              ))}
            </section>

            <hr className="docs-divider" />

            <section id="antispm" className="docs-section">
              <div className="docs-eyebrow">Safety</div>
              <h2>Anti-spam rules</h2>
              {SAFETY_RULES.map((r) => (
                <div key={r.rule} className="docs-safety-rule">
                  <span className="docs-safety-check">✓</span>
                  <div><strong>{r.rule}</strong> — {r.detail}</div>
                </div>
              ))}
            </section>

            <hr className="docs-divider" />

            <section id="qrtrouble" className="docs-section">
              <div className="docs-eyebrow">Troubleshooting</div>
              <h2>QR code issues</h2>
              {QR_ERRORS.map((e) => (
                <div key={e.err} className="docs-qr-error">
                  <div className="docs-qr-error-title">⚠ {e.err}</div>
                  <div className="docs-qr-error-fix">{e.fix}</div>
                </div>
              ))}
              <div className="docs-steps">
                {QR_STEPS.map((s) => (
                  <div key={s.step} className="docs-step"><div className="docs-step-num">{s.step}</div><div><strong>{s.title}</strong> — {s.detail}</div></div>
                ))}
              </div>
            </section>

            <hr className="docs-divider" />

            <section id="errors" className="docs-section">
              <h2>HTTP error codes</h2>
              <div className="docs-errors">
                <div><code className="inline-code">401</code> <span>Missing, invalid, or expired token / API key.</span></div>
                <div><code className="inline-code">403</code> <span>Plan-gated feature (AI config, Pro-only endpoints).</span></div>
                <div><code className="inline-code">404</code> <span>Bot, template, or subscription not found.</span></div>
                <div><code className="inline-code">409</code> <span>Bot exists but is not connected yet.</span></div>
                <div><code className="inline-code">429</code> <span>Rate limit or monthly usage limit reached.</span></div>
                <div><code className="inline-code">503</code> <span>Service not configured on this backend.</span></div>
              </div>
            </section>
          </div>

          {/* FAQ Card */}
          <div className="docs-card">
            <section id="faq" className="docs-section">
              <div className="docs-eyebrow">FAQ</div>
              <h2>Frequently asked questions</h2>
              {FAQ.map((item, i) => <FaqItem key={i} q={item.q} a={item.a} />)}
            </section>
          </div>

          {/* Footer */}
          <div className="docs-footer">
            WaBot API Docs · <a href="/">wabot.app</a> · © {new Date().getFullYear()}
          </div>
        </main>
      </div>
    </div>
  );
}