import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Bot, Mail, MailCheck, Send } from "lucide-react";
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
              <div className="text-3xl font-semibold tracking-tight">Recover access without exposing internal state.</div>
              <p className="max-w-md text-sm leading-7 text-[var(--text2)]">
                The reset link is delivered by email and the final password update happens through a single-use recovery session.
              </p>
            </div>
            <div className="text-xs uppercase tracking-[0.24em] text-[var(--text3)]">Secure Recovery Flow</div>
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

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess(false);
    setLoading(true);

    try {
      await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSuccess(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Reset password"
      subtitle="Enter your account email and we’ll send a recovery link."
      footer={<>Remember your password? <Link to="/login" className="font-medium text-[var(--text)] underline decoration-[var(--border-accent)] underline-offset-4">Back to sign in</Link></>}
    >
      <form className="space-y-5" onSubmit={handleSubmit} noValidate>
        {error && <Alert type="error">{error}</Alert>}
        {success && <Alert type="success"><span className="inline-flex items-center gap-2"><MailCheck size={16} /> Password reset link sent. Check your inbox, including spam.</span></Alert>}

        <label className="block space-y-2">
          <span className="text-sm font-medium text-[var(--text2)]">Email address</span>
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[var(--bg2)] px-4 py-3 focus-within:border-[var(--border-accent)]">
            <Mail size={18} className="text-[var(--text3)]" />
            <input
              type="email"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text3)]"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              disabled={success}
            />
          </div>
        </label>

        <button
          type="submit"
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading || success}
        >
          {loading ? <><Spinner size="sm" /> Sending reset link</> : success ? <>Email sent <ArrowRight size={16} /></> : <><Send size={16} /> Send reset link</>}
        </button>
      </form>
    </AuthLayout>
  );
}
