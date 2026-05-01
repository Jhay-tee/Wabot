import { Link } from "react-router-dom";

const FEATURES = [
  {
    icon: "⚡",
    title: "Deploy in seconds",
    desc: "Name your bot, scan the QR code, and you're live. No configuration files, no CLI tools.",
  },
  {
    icon: "🔒",
    title: "Secure by default",
    desc: "JWT auth, email verification, bcrypt hashing, rate limiting, and Helmet headers out of the box.",
  },
  {
    icon: "📊",
    title: "Real-time dashboard",
    desc: "Track every bot's status, review activity logs, and manage your fleet from one place.",
  },
  {
    icon: "💳",
    title: "Simple billing",
    desc: "Start free with up to 2 bots. Upgrade to Pro for 100 bots and priority support.",
  },
  {
    icon: "🌐",
    title: "Multi-bot support",
    desc: "Run multiple WhatsApp numbers simultaneously — each isolated and independently managed.",
  },
  {
    icon: "🔔",
    title: "Activity feed",
    desc: "Every deployment, scan, and status change is logged so you always know what's happening.",
  },
];

const TERMINAL_LINES = [
  { ts: "10:42:01.120", text: "Starting WwaBot deployment...", cls: "" },
  { ts: "10:42:01.340", text: "Connecting to WhatsApp servers...", cls: "t-acc" },
  { ts: "10:42:02.100", text: "Generating QR code payload...", cls: "" },
  { ts: "10:42:03.500", text: "✓ QR code ready — scan with WhatsApp", cls: "t-ok" },
  { ts: "10:42:14.880", text: "✓ Phone paired successfully", cls: "t-ok" },
  { ts: "10:42:14.900", text: "Bot 'sales-assistant' is now ACTIVE", cls: "t-ok" },
  { ts: "10:42:14.910", text: "🤖 Listening for messages...", cls: "t-url" },
];

export default function Landing() {
  return (
    <div className="landing">
      {/* ── Nav ── */}
      <nav className="land-nav">
        <div className="land-logo">
          <div className="land-logo-icon">🤖</div>
          WwaBot
        </div>
        <div className="land-nav-links">
          <a href="#features" className="land-nav-link">Features</a>
          <a href="#pricing"  className="land-nav-link">Pricing</a>
        </div>
        <div className="land-nav-actions">
          <Link to="/login" className="btn btn-ghost btn-sm">Sign in</Link>
          <Link to="/signup" className="btn btn-primary btn-sm">Get started free</Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="hero-section">
        <div className="hero-eyebrow">
          <span>🚀</span> WhatsApp automation, simplified
        </div>
        <h1 className="hero-h1">
          Deploy WhatsApp bots<br />
          <span className="gradient-text">faster than ever.</span>
        </h1>
        <p className="hero-sub">
          WwaBot is the all-in-one platform to launch, monitor, and scale your WhatsApp
          bots. Free to start — no credit card required.
        </p>
        <div className="hero-ctas">
          <Link to="/signup" className="btn btn-primary btn-xl">Get started free</Link>
          <a href="#pricing" className="btn btn-ghost btn-xl">See plans</a>
        </div>

        {/* Terminal mockup */}
        <div className="terminal">
          <div className="terminal-bar">
            <div className="t-dots">
              <span className="t-dot t-r" />
              <span className="t-dot t-y" />
              <span className="t-dot t-g" />
            </div>
            <span className="terminal-title">wwabot — deploy</span>
          </div>
          <div className="terminal-body">
            {TERMINAL_LINES.map((l, i) => (
              <div className="t-row" key={i}>
                <span className="t-ts">{l.ts}</span>
                <span className={`t-msg ${l.cls}`}>{l.text}</span>
              </div>
            ))}
            <div className="t-row">
              <span className="t-ts">10:42:15.000</span>
              <span className="t-msg t-dim">$ <span className="t-cursor" /></span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="land-section" id="features">
        <div className="land-section-header">
          <div className="section-eyebrow">Features</div>
          <h2 className="section-h2">Everything you need to ship bots</h2>
          <p className="section-p">
            A complete platform from signup to scale — batteries included.
          </p>
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

      {/* ── Pricing ── */}
      <section className="land-section" id="pricing">
        <div className="land-section-header">
          <div className="section-eyebrow">Pricing</div>
          <h2 className="section-h2">Simple, transparent pricing</h2>
          <p className="section-p">Start free. Upgrade when you need more bots.</p>
        </div>
        <div className="pricing-grid">
          {/* Free */}
          <div className="pricing-card">
            <div>
              <div className="pricing-name">Free</div>
              <div className="pricing-price">$0</div>
              <p className="pricing-desc" style={{ marginTop: "0.5rem" }}>
                Everything you need to get started.
              </p>
            </div>
            <div className="pricing-feats">
              {["Up to 2 bots", "Dashboard & activity feed", "QR-based deployment", "Email support"].map((f) => (
                <div className="pricing-feat" key={f}>
                  <span className="pricing-feat-check">✓</span> {f}
                </div>
              ))}
            </div>
            <Link to="/signup" className="btn btn-secondary w-full">
              Start for free
            </Link>
          </div>

          {/* Pro */}
          <div className="pricing-card popular">
            <div className="pricing-tier-badge">Most popular</div>
            <div>
              <div className="pricing-name">Pro</div>
              <div className="pricing-price">
                $19<sub>/mo</sub>
              </div>
              <p className="pricing-desc" style={{ marginTop: "0.5rem" }}>
                For teams and power users.
              </p>
            </div>
            <div className="pricing-feats">
              {[
                "Up to 100 bots",
                "Everything in Free",
                "Priority support",
                "Stripe subscription billing",
                "Early access to new features",
              ].map((f) => (
                <div className="pricing-feat" key={f}>
                  <span className="pricing-feat-check">✓</span> {f}
                </div>
              ))}
            </div>
            <Link to="/signup" className="btn btn-primary w-full">
              Get started
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="land-footer">
        <div className="land-footer-logo">
          <span>🤖</span> WwaBot
        </div>
        <span>© {new Date().getFullYear()} WwaBot. All rights reserved.</span>
        <span>Built for WhatsApp automation.</span>
      </footer>
    </div>
  );
}
