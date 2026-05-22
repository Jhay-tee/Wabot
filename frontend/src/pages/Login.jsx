import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Bot, LockKeyhole, LogIn, Mail } from "lucide-react";
import { Alert } from "../components/ui/Alert.jsx";
import { Spinner } from "../components/ui/Spinner.jsx";
import { apiFetch } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

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
              <div className="text-3xl font-semibold tracking-tight">Run WhatsApp operations from one clean control plane.</div>
              <p className="max-w-md text-sm leading-7 text-[var(--text2)]">
                Pair accounts safely, manage automation rules, and keep API access under control without the clutter from the older UI.
              </p>
            </div>
            <div className="text-xs uppercase tracking-[0.24em] text-[var(--text3)]">Professional WhatsApp Automation</div>
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

export default function Login() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const data = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.email, password: form.password }),
      });
      auth.login(data.token, data.user);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to manage bots, pairing sessions, API keys, and automation settings."
      footer={<>Don&apos;t have an account? <Link to="/signup" className="font-medium text-[var(--text)] underline decoration-[var(--border-accent)] underline-offset-4">Create one free</Link></>}
    >
      <form className="space-y-5" onSubmit={handleSubmit} noValidate>
        {searchParams.get("reset") === "requested" && !error && (
          <Alert type="success">Password reset instructions have been sent if the email exists.</Alert>
        )}
        {searchParams.get("reset") === "success" && !error && (
          <Alert type="success">Password updated. Sign in with your new password.</Alert>
        )}
        {searchParams.get("verified") === "1" && !error && (
          <Alert type="success">Email confirmed. You can sign in now.</Alert>
        )}
        {error && <Alert type="error">{error}</Alert>}

        <label className="block space-y-2">
          <span className="text-sm font-medium text-[var(--text2)]">Email address</span>
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[var(--bg2)] px-4 py-3 focus-within:border-[var(--border-accent)]">
            <Mail size={18} className="text-[var(--text3)]" />
            <input
              id="email"
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
              id="password"
              type="password"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text3)]"
              placeholder="Enter your password"
              value={form.password}
              onChange={set("password")}
              required
              autoComplete="current-password"
            />
          </div>
        </label>

        <div className="flex items-center justify-between text-sm">
          <span className="text-[var(--text3)]">Secure session login</span>
          <Link to="/forgot-password" className="font-medium text-[var(--text)] underline decoration-[var(--border-accent)] underline-offset-4">
            Forgot password?
          </Link>
        </div>

        <button
          type="submit"
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading}
        >
          {loading ? <><Spinner size="sm" /> Signing in</> : <><LogIn size={16} /> Sign in <ArrowRight size={16} /></>}
        </button>
      </form>
    </AuthLayout>
  );
}
