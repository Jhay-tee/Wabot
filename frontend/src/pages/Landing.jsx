import { Link } from "react-router-dom";
import { BASE } from "../api/client.js";
import { useTheme } from "../context/ThemeContext.jsx";

const FEATURES = [
  { icon: "01", title: "Faster deployment", desc: "Create a bot, pair the device, and manage live runtime state from one dashboard." },
  { icon: "02", title: "DM and group coverage", desc: "Handle support inboxes, community groups, or a hybrid workflow without splitting tools." },
  { icon: "03", title: "Realtime operations", desc: "Track pairing state, message delivery, and bot health without refreshing the page." },
  { icon: "04", title: "AI with guardrails", desc: "Swap OpenAI, Gemini, or Groq at runtime with encrypted key storage and cleaner logs." },
  { icon: "05", title: "Sales and automation", desc: "Use catalogs, commands, keyword routing, and webhook triggers in the same flow." },
  { icon: "06", title: "Developer API", desc: "Send messages, inspect bots, and connect internal systems over a documented REST surface." },
  { icon: "07", title: "Safer delivery", desc: "Queue-aware sending, backoff, signed webhooks, and bounded runtime behavior by default." },
  { icon: "08", title: "Built for teams", desc: "Give operators a cleaner control center while keeping the backend predictable under load." },
];

const TERMINAL_LINES = [
  { ts: "10:42:01", text: "Initialising WaBot deployment...", tone: "text-[var(--text2)]" },
  { ts: "10:42:02", text: "QR payload generated", tone: "text-[var(--accent)]" },
  { ts: "10:42:08", text: "Phone paired and session restored", tone: "text-emerald-400" },
  { ts: "10:42:09", text: "Webhook signed and ready", tone: "text-sky-400" },
  { ts: "10:42:10", text: "AI runtime synced from dashboard config", tone: "text-[var(--accent)]" },
  { ts: "10:42:11", text: "Bot listening for inbound messages", tone: "text-[var(--text)]" },
];

const STACK_STATS = [
  { value: "1k", label: "Free monthly messages" },
  { value: "50", label: "Bots on Pro" },
  { value: "<1s", label: "Realtime dashboard sync" },
  { value: "24/7", label: "Operational visibility" },
];

const DEV_FEATURES = [
  { title: "Realtime control", desc: "Change AI provider, timing, webhook config, or commands without redeploying." },
  { title: "Natural pacing", desc: "Typing presence, randomized wait windows, and queue-aware response timing." },
  { title: "Safer runtime", desc: "Bounded queues, retry policies, dedupe logic, and encrypted provider keys." },
  { title: "Simple integration", desc: "Use one API key for sends, webhooks, QR status, and bot lifecycle management." },
];

const CODE_SNIPPET = `const res = await fetch("${BASE}/v1/messages/send", {
  method: "POST",
  headers: {
    Authorization: "Bearer wbk_YOUR_API_KEY",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    bot_id: "your-bot-id",
    to: "2348012345678",
    message: "Order confirmed. Track it here: https://track.co/abc"
  })
});

const data = await res.json();`;

const PRICING = [
  {
    name: "Free",
    price: "₦0",
    cta: "Start for free",
    ctaClass: "btn btn-secondary w-full",
    items: [
      "1 bot",
      "1,000 messages per month",
      "QR deployment",
      "Webhooks",
      "Sales agent",
      "Activity feed",
    ],
  },
  {
    name: "Pro",
    price: "₦1,500/mo",
    cta: "Get started",
    ctaClass: "btn btn-primary w-full",
    featured: true,
    items: [
      "Up to 50 bots",
      "100,000 messages per month",
      "AI replies",
      "Custom commands",
      "More API keys",
      "Priority support",
    ],
  },
];

function SectionHeading({ eyebrow, title, body }) {
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center">
      <div className="mb-3 inline-flex rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text2)]">
        {eyebrow}
      </div>
      <h2 className="text-3xl font-black tracking-tight text-[var(--text)] sm:text-4xl">{title}</h2>
      <p className="mt-3 text-sm leading-7 text-[var(--text2)] sm:text-base">{body}</p>
    </div>
  );
}

export default function Landing() {
  const { theme, toggle: toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-8rem] top-[-6rem] h-72 w-72 rounded-full bg-[var(--accent-dim)] blur-3xl" />
        <div className="absolute right-[-5rem] top-24 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 pb-16 pt-5 sm:px-6 lg:px-8">
        <nav className="sticky top-4 z-30 mb-8 flex items-center justify-between rounded-full border border-[var(--border)] bg-[color:color-mix(in_srgb,var(--bg)_75%,transparent)] px-4 py-3 shadow-[var(--shadow)] backdrop-blur xl:px-6">
          <Link to="/" className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent)] text-lg text-white shadow-lg shadow-[var(--accent-dim)]">
              🤖
            </div>
            <div>
              <div className="text-sm font-black tracking-[0.2em] text-[var(--text)]">WABOT</div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text3)]">Realtime WhatsApp Ops</div>
            </div>
          </Link>

          <div className="hidden items-center gap-6 text-sm text-[var(--text2)] md:flex">
            <a href="#features" className="transition hover:text-[var(--text)]">Features</a>
            <a href="#api" className="transition hover:text-[var(--text)]">API</a>
            <a href="#pricing" className="transition hover:text-[var(--text)]">Pricing</a>
            <Link to="/docs" className="transition hover:text-[var(--text)]">Docs</Link>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-sm text-[var(--text2)] transition hover:border-[var(--border-accent)] hover:text-[var(--text)]"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? "☀️" : "🌙"}
            </button>
            <Link to="/login" className="btn btn-ghost btn-sm hidden sm:inline-flex">Sign in</Link>
            <Link to="/signup" className="btn btn-primary btn-sm">Get started</Link>
          </div>
        </nav>

        <section className="grid gap-8 py-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:py-12">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--border-accent)] bg-[var(--card)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
              <span className="inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
              Production WhatsApp operations
            </div>

            <h1 className="max-w-3xl text-5xl font-black leading-[0.95] tracking-tight sm:text-6xl xl:text-7xl">
              Run WhatsApp bots with
              <span className="block text-[var(--accent)]">clean controls and reliable delivery.</span>
            </h1>

            <p className="mt-6 max-w-2xl text-base leading-8 text-[var(--text2)] sm:text-lg">
              WaBot gives support teams, operators, and SaaS builders a polished control plane for pairing, automation, AI responses, webhooks, and live conversation handling.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/signup" className="btn btn-primary btn-xl">Get started free</Link>
              <Link to="/docs" className="btn btn-ghost btn-xl">Read the docs</Link>
            </div>

            <div className="mt-10 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {STACK_STATS.map((item) => (
                <div key={item.label} className="rounded-3xl border border-[var(--border)] bg-[var(--card)] p-4">
                  <div className="text-2xl font-black text-[var(--text)]">{item.value}</div>
                  <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[var(--text3)]">{item.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-5">
            <div className="overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow)]">
              <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--card2)] px-5 py-4">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-rose-400" />
                  <span className="h-3 w-3 rounded-full bg-amber-400" />
                  <span className="h-3 w-3 rounded-full bg-emerald-400" />
                </div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text3)]">runtime console</div>
              </div>
              <div className="space-y-3 px-5 py-5 font-mono text-sm">
                {TERMINAL_LINES.map((line) => (
                  <div key={`${line.ts}-${line.text}`} className="grid grid-cols-[72px_1fr] gap-3">
                    <span className="text-[var(--text3)]">{line.ts}</span>
                    <span className={line.tone}>{line.text}</span>
                  </div>
                ))}
                <div className="grid grid-cols-[72px_1fr] gap-3">
                  <span className="text-[var(--text3)]">10:42:12</span>
                  <span className="text-[var(--text2)]">$ <span className="ml-1 inline-block h-4 w-2 animate-pulse rounded-sm bg-[var(--accent)] align-middle" /></span>
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-[24px] border border-[var(--border)] bg-[var(--card)] p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text3)]">Operator view</div>
                <div className="mt-3 text-xl font-bold">Live QR, pairing code, status stream</div>
                <p className="mt-2 text-sm leading-7 text-[var(--text2)]">Watch bots connect in real time without refreshing the dashboard.</p>
              </div>
              <div className="rounded-[24px] border border-[var(--border)] bg-[linear-gradient(135deg,var(--card),var(--accent-dim))] p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text3)]">AI runtime</div>
                <div className="mt-3 text-xl font-bold">Provider keys update immediately</div>
                <p className="mt-2 text-sm leading-7 text-[var(--text2)]">Swap providers, timing, and prompts from the dashboard without reconnecting the bot.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="py-20">
          <SectionHeading
            eyebrow="Features"
            title="Built for operators, agencies, and developers"
            body="Keep the setup simple while still exposing the live controls and delivery guarantees serious messaging systems need."
          />

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {FEATURES.map((feature, index) => (
              <div
                key={feature.title}
                className={`rounded-[26px] border border-[var(--border)] p-6 shadow-[var(--shadow)] ${index % 3 === 0 ? "bg-[linear-gradient(180deg,var(--card),var(--card2))]" : "bg-[var(--card)]"}`}
              >
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-dim)] text-sm font-bold tracking-[0.18em] text-[var(--accent)]">
                  {feature.icon}
                </div>
                <h3 className="text-lg font-bold text-[var(--text)]">{feature.title}</h3>
                <p className="mt-3 text-sm leading-7 text-[var(--text2)]">{feature.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="api" className="grid gap-8 py-20 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-[30px] border border-[var(--border)] bg-[var(--card)] p-6 sm:p-8">
            <div className="mb-3 inline-flex rounded-full bg-[var(--accent-dim)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
              Developer API
            </div>
            <h2 className="max-w-lg text-3xl font-black tracking-tight sm:text-4xl">One control plane for bots, sends, and webhook automation</h2>
            <p className="mt-4 max-w-xl text-sm leading-8 text-[var(--text2)] sm:text-base">
              Use the REST API to send messages, drive external workflows, and inspect bot state while the dashboard handles QR events and runtime settings.
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {DEV_FEATURES.map((item) => (
                <div key={item.title} className="rounded-3xl border border-[var(--border)] bg-[var(--bg)] p-4">
                  <div className="text-sm font-bold text-[var(--text)]">{item.title}</div>
                  <p className="mt-2 text-sm leading-7 text-[var(--text2)]">{item.desc}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/docs" className="btn btn-primary btn-sm">View full docs</Link>
              <Link to="/signup" className="btn btn-secondary btn-sm">Create API key</Link>
            </div>
          </div>

          <div className="overflow-hidden rounded-[30px] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--card2)] px-5 py-4">
              <div className="text-sm font-semibold text-[var(--text)]">send-message.js</div>
              <div className="rounded-full border border-[var(--border)] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[var(--text3)]">REST example</div>
            </div>
            <div className="px-5 py-5">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[22px] bg-[var(--bg)] p-5 font-mono text-sm leading-7 text-[var(--text2)]">
                {CODE_SNIPPET}
              </pre>

              <div className="mt-4 flex flex-wrap gap-2">
                {["JavaScript", "Python", "PHP", "Ruby", "Go", "TypeScript", "Rust", "Dart"].map((lang) => (
                  <span key={lang} className="rounded-full border border-[var(--border)] bg-[var(--card2)] px-3 py-1 text-xs font-medium text-[var(--text2)]">
                    {lang}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="pricing" className="py-20">
          <SectionHeading
            eyebrow="Pricing"
            title="Start free, upgrade when the volume is real"
            body="The free plan is enough to prove the workflow. Pro adds AI, scale, and more room for operators."
          />

          <div className="grid gap-6 lg:grid-cols-2">
            {PRICING.map((plan) => (
              <div
                key={plan.name}
                className={`relative rounded-[30px] border p-8 shadow-[var(--shadow)] ${plan.featured ? "border-[var(--border-accent)] bg-[linear-gradient(180deg,var(--card),var(--accent-dim))]" : "border-[var(--border)] bg-[var(--card)]"}`}
              >
                {plan.featured && (
                  <div className="absolute right-6 top-6 rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-white">
                    Most popular
                  </div>
                )}
                <div className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--text3)]">{plan.name}</div>
                <div className="mt-4 text-4xl font-black tracking-tight">{plan.price}</div>
                <div className="mt-6 space-y-3 text-sm text-[var(--text2)]">
                  {plan.items.map((item) => (
                    <div key={item} className="flex items-center gap-3">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent-dim)] text-[var(--accent)]">✓</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-8">
                  <Link to="/signup" className={plan.ctaClass}>{plan.cta}</Link>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[32px] border border-[var(--border)] bg-[linear-gradient(135deg,var(--card),var(--card2),var(--accent-dim))] px-6 py-10 text-center sm:px-10">
          <div className="mx-auto max-w-3xl">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text3)]">Ready to launch</div>
            <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Connect a phone, configure the runtime, and start replying.</h2>
            <p className="mt-4 text-sm leading-8 text-[var(--text2)] sm:text-base">
              WaBot gives you the dashboard layer, delivery layer, and AI runtime controls without forcing a full custom build on day one.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link to="/signup" className="btn btn-primary btn-lg">Get started free</Link>
              <Link to="/login" className="btn btn-ghost btn-lg">Sign in</Link>
            </div>
          </div>
        </section>

        <footer className="flex flex-col gap-5 py-10 text-sm text-[var(--text3)] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[var(--accent)] text-white">🤖</div>
            <div>
              <div className="font-bold tracking-[0.16em] text-[var(--text2)]">WABOT</div>
              <div>© {new Date().getFullYear()} WaBot. All rights reserved.</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-4">
            <Link to="/docs" className="transition hover:text-[var(--text)]">Documentation</Link>
            <a href="#features" className="transition hover:text-[var(--text)]">Features</a>
            <a href="#api" className="transition hover:text-[var(--text)]">API</a>
            <a href="#pricing" className="transition hover:text-[var(--text)]">Pricing</a>
          </div>
        </footer>
      </div>
    </div>
  );
}
