import { Link } from "react-router-dom";

const FEATURES = [
  { icon: "⚡", title: "Deploy in 60 seconds",  desc: "Name your bot, scan the QR code, and you're live instantly. No coding required." },
  { icon: "💬", title: "DM & Group bots",        desc: "Deploy dedicated bots for direct messages or group chat management — with separate configs for each." },
  { icon: "🔗", title: "Webhook events",          desc: "Receive real-time HTTP webhooks on every message, join, or leave event your bots capture." },
  { icon: "🛒", title: "Sales agent",             desc: "Built-in product catalog, smart keyword triggers, and greeting messages. Turn WhatsApp into a storefront." },
  { icon: "🤖", title: "AI-powered replies",      desc: "Connect OpenAI, Gemini, Claude, or Meta Llama. Your bot answers intelligently when no rule matches. (Pro)" },
  { icon: "⌨️", title: "Command system",          desc: "Default commands like /catalog, /price, /help built in. Pro users can customise responses and disable commands live." },
  { icon: "🔑", title: "Developer API",           desc: "REST API with API key auth. Send messages, list bots, fetch conversations. 5 languages + 4 frameworks documented." },
  { icon: "🛡", title: "Secure by default",       desc: "JWT auth, bcrypt passwords, AES-256 key encryption, rate limiting, HMAC webhook signing, Helmet headers." },
  { icon: "📊", title: "Live dashboard",          desc: "Monitor message counts, bot status, activity logs, and monthly usage from one control panel." },
];

const TERMINAL_LINES = [
  { ts: "10:42:01", text: "Initialising WaBot deployment...",       cls: "" },
  { ts: "10:42:01", text: "Connecting to WhatsApp servers...",      cls: "t-acc" },
  { ts: "10:42:02", text: "Generating QR payload...",               cls: "" },
  { ts: "10:42:03", text: "✓ QR code ready — scan with WhatsApp",  cls: "t-ok" },
  { ts: "10:42:14", text: "✓ Phone paired — session established",   cls: "t-ok" },
  { ts: "10:42:14", text: "Bot 'sales-assistant' [DM] is ACTIVE",   cls: "t-ok" },
  { ts: "10:42:15", text: "Webhook URL: https://yourapp.com/hook",  cls: "t-url" },
  { ts: "10:42:15", text: "AI: OpenAI gpt-4o-mini connected",       cls: "t-acc" },
  { ts: "10:42:15", text: "Listening for messages...",              cls: "t-dim" },
];

const CODE_SNIPPET = `// Send a WhatsApp message via WaBot API
const res = await fetch("https://api.wabot.app/api/v1/messages/send", {
  method: "POST",
  headers: {
    "Authorization": "Bearer wbk_YOUR_API_KEY",
    "Content-Type":  "application/json"
  },
  body: JSON.stringify({
    bot_id:  "your-bot-id",
    to:      "2348012345678",
    message: "Order confirmed! 🎉 Track at: https://track.co/abc"
  })
});
const data = await res.json();
// { ok: true, message: "Message sent.", timestamp: 1714939200000 }`;

const DEV_FEATURES = [
  { icon: "📡", title: "5 languages",        desc: "JavaScript, Python, PHP, Ruby, Go — plus TypeScript, Rust, Dart" },
  { icon: "🏗",  title: "4 frameworks",       desc: "Express, Next.js, FastAPI, Laravel examples included"           },
  { icon: "🔒", title: "Signed webhooks",     desc: "HMAC-SHA256 signatures on every outbound event"                 },
  { icon: "⚡", title: "Real-time SSE",        desc: "Server-sent events for live QR codes and bot status"            },
];

export default function Landing() {
  return (
    <div className="landing">
      <nav className="land-nav">
        <div className="land-logo">
          <div className="land-logo-icon">🤖</div>
          WaBot
        </div>
        <div className="land-nav-links">
          <a href="#features" className="land-nav-link">Features</a>
          <a href="#api"      className="land-nav-link">API</a>
          <a href="#pricing"  className="land-nav-link">Pricing</a>
          <Link to="/docs"    className="land-nav-link" style={{ color: "var(--accent)" }}>Docs</Link>
        </div>
        <div className="land-nav-actions">
          <Link to="/login"  className="btn btn-ghost btn-sm">Sign in</Link>
          <Link to="/signup" className="btn btn-primary btn-sm">Get started free</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero-section">
        <div className="hero-eyebrow">
          <span>🚀</span> WhatsApp automation, simplified
        </div>
        <h1 className="hero-h1">
          Deploy WhatsApp bots<br />
          <span className="accent-word">faster than ever.</span>
        </h1>
        <p className="hero-sub">
          The all-in-one platform to launch, monitor, and scale your WhatsApp bots.
          Sales agent, AI replies, webhooks, and a full developer API — free to start.
        </p>
        <div className="hero-ctas">
          <Link to="/signup" className="btn btn-primary btn-xl">Get started free</Link>
          <Link to="/docs"   className="btn btn-ghost btn-xl">Read the docs</Link>
        </div>

        <div className="terminal">
          <div className="terminal-bar">
            <div className="t-dots">
              <span className="t-dot t-r"/><span className="t-dot t-y"/><span className="t-dot t-g"/>
            </div>
            <span className="terminal-title">wabot — deploy</span>
          </div>
          <div className="terminal-body">
            {TERMINAL_LINES.map((l, i) => (
              <div className="t-row" key={i}>
                <span className="t-ts">{l.ts}</span>
                <span className={`t-msg ${l.cls}`}>{l.text}</span>
              </div>
            ))}
            <div className="t-row">
              <span className="t-ts">10:42:16</span>
              <span className="t-msg t-dim">$ <span className="t-cursor" /></span>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="land-section" id="features">
        <div className="land-section-header">
          <div className="section-eyebrow">Features</div>
          <h2 className="section-h2">Everything you need to ship bots</h2>
          <p className="section-p">A complete platform from signup to scale — batteries included.</p>
        </div>
        <div className="features-grid">
          {FEATURES.map((f) => (
            <div className="feature-card" key={f.title}>
              <div className="feature-icon-wrap">{f.icon}</div>
              <div className="feature-title">{f.title}</div>
              <p className="feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Developer API section */}
      <section className="land-section land-section-alt" id="api">
        <div className="land-api-grid">
          <div className="land-api-left">
            <div className="section-eyebrow">Developer API</div>
            <h2 className="section-h2" style={{ marginBottom: "1rem" }}>Build on top of WaBot</h2>
            <p className="section-p" style={{ marginBottom: "1.5rem" }}>
              A complete REST API so you can send WhatsApp messages, list bots, fetch conversation history,
              and test webhooks — all with a single API key.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "1.75rem" }}>
              {DEV_FEATURES.map((f) => (
                <div key={f.title} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem" }}>
                  <div style={{ fontSize: "1.25rem", marginBottom: "0.25rem" }}>{f.icon}</div>
                  <div style={{ fontWeight: 700, fontSize: "0.875rem", marginBottom: "0.2rem" }}>{f.title}</div>
                  <div style={{ fontSize: "0.775rem", color: "var(--text3)" }}>{f.desc}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <Link to="/docs" className="btn btn-primary btn-sm">View full docs →</Link>
              <Link to="/signup" className="btn btn-secondary btn-sm">Get API key free</Link>
            </div>
          </div>

          <div className="land-api-right">
            <div className="terminal" style={{ maxWidth: "100%", margin: 0 }}>
              <div className="terminal-bar">
                <div className="t-dots">
                  <span className="t-dot t-r"/><span className="t-dot t-y"/><span className="t-dot t-g"/>
                </div>
                <span className="terminal-title">send-message.js</span>
              </div>
              <div className="terminal-body" style={{ fontSize: "0.775rem" }}>
                <pre style={{ color: "var(--text2)", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.6 }}>
                  {CODE_SNIPPET}
                </pre>
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
              {["JS", "Python", "PHP", "Ruby", "Go", "TypeScript", "Rust", "Dart"].map((lang) => (
                <span key={lang} style={{
                  padding: "0.25rem 0.625rem", borderRadius: "100px",
                  background: "var(--card)", border: "1px solid var(--border)",
                  fontSize: "0.75rem", color: "var(--text3)"
                }}>{lang}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="land-section" id="pricing">
        <div className="land-section-header">
          <div className="section-eyebrow">Pricing</div>
          <h2 className="section-h2">Simple, transparent pricing</h2>
          <p className="section-p">Start free. Upgrade when you need more power.</p>
        </div>
        <div className="pricing-grid">
          <div className="pricing-card">
            <div>
              <div className="pricing-name">Free</div>
              <div className="pricing-price">₦0</div>
              <p className="pricing-desc" style={{ marginTop: "0.5rem" }}>Everything you need to get started.</p>
            </div>
            <div className="pricing-feats">
              {["1 bot (DM or Group)", "1,000 messages/month", "1 API key", "QR-based deployment", "Webhooks", "Sales agent", "Default commands", "Activity feed"].map((f) => (
                <div className="pricing-feat" key={f}><span className="pricing-feat-check">✓</span> {f}</div>
              ))}
            </div>
            <Link to="/signup" className="btn btn-secondary w-full">Start for free</Link>
          </div>

          <div className="pricing-card popular">
            <div className="pricing-tier-badge">Most Popular</div>
            <div>
              <div className="pricing-name">Pro</div>
              <div className="pricing-price">₦1,500<sub>/mo</sub></div>
              <p className="pricing-desc" style={{ marginTop: "0.5rem" }}>For agencies and high-volume operations.</p>
            </div>
            <div className="pricing-feats">
              {[
                "Up to 50 bots",
                "100,000 messages/month",
                "10 API keys",
                "Everything in Free",
                "AI integration (OpenAI, Gemini, Claude…)",
                "Custom command responses",
                "Priority support",
                "Billing portal"
              ].map((f) => (
                <div className="pricing-feat" key={f}><span className="pricing-feat-check">✓</span> {f}</div>
              ))}
            </div>
            <Link to="/signup" className="btn btn-primary w-full">Get started</Link>
          </div>
        </div>
      </section>

      <footer className="land-footer">
        <div className="land-footer-logo"><span>🤖</span> WaBot</div>
        <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", justifyContent: "center" }}>
          <Link to="/docs" style={{ color: "var(--text3)", fontSize: "0.875rem" }}>Documentation</Link>
          <a href="#features" style={{ color: "var(--text3)", fontSize: "0.875rem" }}>Features</a>
          <a href="#pricing"  style={{ color: "var(--text3)", fontSize: "0.875rem" }}>Pricing</a>
          <a href="#api"      style={{ color: "var(--text3)", fontSize: "0.875rem" }}>API</a>
        </div>
        <span style={{ color: "var(--text3)", fontSize: "0.8125rem" }}>© {new Date().getFullYear()} WaBot. All rights reserved.</span>
      </footer>
    </div>
  );
}
