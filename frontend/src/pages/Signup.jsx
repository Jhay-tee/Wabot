import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Bot, CheckCheck, LockKeyhole, Mail, User, UserPlus } from "lucide-react";
import { Alert } from "../components/ui/Alert.jsx";
import { Spinner } from "../components/ui/Spinner.jsx";
import { apiFetch } from "../api/client.js";

function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] px-4 py-8 text-[var(--text)]">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center justify-center">
        <div className="grid w-full overflow-hidden rounded-[32px] border border-white/10 bg-[var(--card)] shadow-2xl lg:grid-cols-[1.05fr_0.95fr]">
          <div className="hidden bg-[var(--bg2)] p-10 lg:flex lg:flex-col lg:justify-between">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] text-white">
              <Bot size={22} />
            </div>
            <div className="space-y-4">
              <div className="text-3xl font-semibold tracking-tight">Create a workspace built for repeatable operations.</div>
              <p className="max-w-md text-sm leading-7 text-[var(--text2)]">
                Pair accounts, test webhooks, and manage AI-assisted replies from one place while keeping the current brand theme intact.
              </p>
            </div>
            <div className="text-xs uppercase tracking-[0.24em] text-[var(--text3)]">Free Plan Available</div>
          </div>

          <div className="p-6 sm:p-8 lg:p-10">
            <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm text-[var(--text2)] transition hover:text-[var(--text)]">
              <Bot size={16} />
              <span>WaBot</span>
            </Link>
            <div className="mb-8">
              <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
              <p className="mt-2 text-sm text-[var(--text2)]">{subtitle}</p>
            </div>
            {children}
            <div className="mt-8 text-sm text-[var(--text2)]">{footer}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Signup() {
  const [form, setForm] = useState({ fullName: "", email: "", password: "" });
  const [msg, setMsg] = useState({ text: "", ok: false });
  const [loading, setLoading] = useState(false);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setMsg({ text: "", ok: false });

    if (form.password.length < 8) {
      setMsg({ text: "Password must be at least 8 characters.", ok: false });
      return;
    }

    setLoading(true);
    try {
      await apiFetch("/auth/signup", { method: "POST", body: JSON.stringify(form) });
      setMsg({ text: "Account created! Check your email to verify before logging in.", ok: true });
    } catch (err) {
      setMsg({ text: err.message, ok: false });
    } finally {
      setLoading(false);
    }
  };

  if (msg.ok) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle={`We sent a confirmation link to ${form.email}.`}
        footer={<>Already verified? <Link to="/login" className="font-medium text-[var(--text)] underline decoration-[var(--border-accent)] underline-offset-4">Go to sign in</Link></>}
      >
        <div className="space-y-6">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-300">
            <CheckCheck size={28} />
          </div>
          <Alert type="success">{msg.text}</Alert>
          <Link
            to="/login"
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90"
          >
            Go to sign in
            <ArrowRight size={16} />
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start with the free plan and upgrade only when you need more bots or AI features."
      footer={<>Already have an account? <Link to="/login" className="font-medium text-[var(--text)] underline decoration-[var(--border-accent)] underline-offset-4">Sign in</Link></>}
    >
      <form className="space-y-5" onSubmit={handleSubmit} noValidate>
        {msg.text && <Alert type={msg.ok ? "success" : "error"}>{msg.text}</Alert>}

        <label className="block space-y-2">
          <span className="text-sm font-medium text-[var(--text2)]">Full name</span>
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[var(--bg2)] px-4 py-3 focus-within:border-[var(--border-accent)]">
            <User size={18} className="text-[var(--text3)]" />
            <input
              type="text"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text3)]"
              placeholder="Jane Smith"
              value={form.fullName}
              onChange={set("fullName")}
              autoComplete="name"
            />
          </div>
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-[var(--text2)]">Email address</span>
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[var(--bg2)] px-4 py-3 focus-within:border-[var(--border-accent)]">
            <Mail size={18} className="text-[var(--text3)]" />
            <input
              type="email"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text3)]"
              placeholder="you@example.com"
              value={form.email}
              onChange={set("email")}
              required
              autoComplete="email"
            />
          </div>
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-[var(--text2)]">Password</span>
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[var(--bg2)] px-4 py-3 focus-within:border-[var(--border-accent)]">
            <LockKeyhole size={18} className="text-[var(--text3)]" />
            <input
              type="password"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text3)]"
              placeholder="Min 8 chars, uppercase + number"
              value={form.password}
              onChange={set("password")}
              required
              autoComplete="new-password"
            />
          </div>
          <span className="text-xs text-[var(--text3)]">At least 8 characters with uppercase letters and a number.</span>
        </label>

        <button
          type="submit"
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading}
        >
          {loading ? <><Spinner size="sm" /> Creating account</> : <><UserPlus size={16} /> Create account <ArrowRight size={16} /></>}
        </button>
      </form>
    </AuthLayout>
  );
}
