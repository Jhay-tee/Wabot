import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Bot, CheckCircle2, KeyRound, LockKeyhole } from "lucide-react";
import { Alert } from "../components/ui/Alert.jsx";
import { Spinner } from "../components/ui/Spinner.jsx";
import { parseRecoveryHash, updatePasswordWithRecovery } from "../lib/supabaseRecovery.js";

function AuthFrame({ title, subtitle, children }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] px-4 py-8 text-[var(--text)]">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center justify-center">
        <div className="grid w-full overflow-hidden rounded-[32px] border border-white/10 bg-[var(--card)] shadow-2xl lg:grid-cols-[1.1fr_0.9fr]">
          <div className="hidden bg-[var(--bg2)] p-10 lg:flex lg:flex-col lg:justify-between">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] text-white">
              <Bot size={22} />
            </div>
            <div className="space-y-4">
              <div className="text-3xl font-semibold tracking-tight">Secure your WaBot workspace.</div>
              <p className="max-w-md text-sm leading-7 text-[var(--text2)]">
                Reset links are single-use. Once this password is updated, the old recovery link can no longer be used.
              </p>
            </div>
            <div className="text-xs uppercase tracking-[0.24em] text-[var(--text3)]">Account Recovery</div>
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
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ResetPassword() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ password: "", confirm: "" });
  const [status, setStatus] = useState("ready");
  const [message, setMessage] = useState("");

  const recovery = useMemo(() => parseRecoveryHash(), []);

  useEffect(() => {
    if (recovery.error) {
      setStatus("error");
      setMessage(recovery.error);
      return;
    }

    if (!recovery.accessToken || recovery.type !== "recovery") {
      setStatus("error");
      setMessage("This password reset link is invalid or has already been used.");
    }
  }, [recovery]);

  useEffect(() => {
    if (status !== "success") return;
    const timer = setTimeout(() => navigate("/login?reset=success", { replace: true }), 3000);
    return () => clearTimeout(timer);
  }, [navigate, status]);

  const submit = async (event) => {
    event.preventDefault();
    if (form.password !== form.confirm) {
      setStatus("error");
      setMessage("The new passwords do not match.");
      return;
    }
    if (form.password.length < 8) {
      setStatus("error");
      setMessage("Use at least 8 characters for the new password.");
      return;
    }

    setStatus("loading");
    setMessage("");

    try {
      await updatePasswordWithRecovery(recovery.accessToken, form.password);
      window.history.replaceState({}, "", window.location.pathname);
      setStatus("success");
      setMessage("Password updated. Redirecting to sign in.");
    } catch (err) {
      setStatus("error");
      setMessage(err.message || "Could not reset password.");
    }
  };

  return (
    <AuthFrame
      title={status === "success" ? "Password updated" : "Reset your password"}
      subtitle={
        status === "success"
          ? "Your recovery link has been consumed and is no longer valid."
          : "Choose a new password for your account."
      }
    >
      {status === "success" ? (
        <div className="space-y-6">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-300">
            <CheckCircle2 size={28} />
          </div>
          <Alert type="success">{message}</Alert>
          <Link
            to="/login?reset=success"
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90"
          >
            Continue to sign in
            <ArrowRight size={16} />
          </Link>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={submit}>
          {message && <Alert type={status === "error" ? "error" : "info"}>{message}</Alert>}

          <label className="block space-y-2">
            <span className="text-sm font-medium text-[var(--text2)]">New password</span>
            <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[var(--bg2)] px-4 py-3 focus-within:border-[var(--border-accent)]">
              <LockKeyhole size={18} className="text-[var(--text3)]" />
              <input
                type="password"
                className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text3)]"
                placeholder="Minimum 8 characters"
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                autoComplete="new-password"
              />
            </div>
          </label>

          <label className="block space-y-2">
            <span className="text-sm font-medium text-[var(--text2)]">Confirm password</span>
            <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[var(--bg2)] px-4 py-3 focus-within:border-[var(--border-accent)]">
              <KeyRound size={18} className="text-[var(--text3)]" />
              <input
                type="password"
                className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text3)]"
                placeholder="Repeat the new password"
                value={form.confirm}
                onChange={(event) => setForm((current) => ({ ...current, confirm: event.target.value }))}
                autoComplete="new-password"
              />
            </div>
          </label>

          <button
            type="submit"
            disabled={status === "loading" || status === "error" && !recovery.accessToken}
            className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "loading" ? <><Spinner size="sm" /> Updating password</> : <>Update password <ArrowRight size={16} /></>}
          </button>

          <div className="text-sm text-[var(--text2)]">
            Remembered it?{" "}
            <Link to="/login" className="font-medium text-[var(--text)] underline decoration-[var(--border-accent)] underline-offset-4">
              Back to sign in
            </Link>
          </div>
        </form>
      )}
    </AuthFrame>
  );
}
