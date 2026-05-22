import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Bot, CheckCircle2, CircleX, LoaderCircle } from "lucide-react";
import { Alert } from "../components/ui/Alert.jsx";
import { authApi } from "../api/auth.js";

function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] px-4 py-8 text-[var(--text)]">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center justify-center">
        <div className="grid w-full overflow-hidden rounded-[32px] border border-white/10 bg-[var(--card)] shadow-2xl lg:grid-cols-[1.05fr_0.95fr]">
          <div className="hidden bg-[var(--bg2)] p-10 lg:flex lg:flex-col lg:justify-between">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] text-white">
              <Bot size={22} />
            </div>
            <div className="space-y-4">
              <div className="text-3xl font-semibold tracking-tight">Verify once, then move straight into the dashboard.</div>
              <p className="max-w-md text-sm leading-7 text-[var(--text2)]">
                Confirmation links are single-use. Once activated, the token is cleared and cannot be reused.
              </p>
            </div>
            <div className="text-xs uppercase tracking-[0.24em] text-[var(--text3)]">Account Confirmation</div>
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

export default function Verify() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [state, setState] = useState("loading");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setState("error");
      setMsg("No verification token found in the URL.");
      return;
    }

    authApi.verify(token)
      .then(() => setState("success"))
      .catch((err) => {
        setState("error");
        setMsg(err.message || "Verification failed.");
      });
  }, [params]);

  useEffect(() => {
    if (state !== "success") return;
    const timer = setTimeout(() => navigate("/login?verified=1", { replace: true }), 3000);
    return () => clearTimeout(timer);
  }, [navigate, state]);

  return (
    <AuthLayout
      title={state === "loading" ? "Confirming your account" : state === "success" ? "Account confirmed" : "Verification failed"}
      subtitle={
        state === "loading"
          ? "Please wait while we validate your email link."
          : state === "success"
            ? "Your account is now active and the confirmation link has been invalidated."
            : "This link may have expired, already been used, or be invalid."
      }
    >
      <div className="space-y-6">
        <div className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl ${
          state === "success"
            ? "bg-emerald-500/10 text-emerald-300"
            : state === "error"
              ? "bg-rose-500/10 text-rose-300"
              : "bg-[var(--accent-dim)] text-[var(--accent)]"
        }`}>
          {state === "loading" && <LoaderCircle size={28} className="animate-spin" />}
          {state === "success" && <CheckCircle2 size={28} />}
          {state === "error" && <CircleX size={28} />}
        </div>

        {state === "error" && msg && <Alert type="error">{msg}</Alert>}
        {state === "success" && <Alert type="success">Your email has been confirmed. Redirecting to sign in.</Alert>}

        <div className="flex flex-col gap-3 sm:flex-row">
          {state === "error" ? (
            <>
              <Link to="/signup" className="inline-flex flex-1 items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-[var(--text)] transition hover:border-[var(--border-accent)]">
                Sign up again
              </Link>
              <Link to="/login" className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90">
                Sign in
                <ArrowRight size={16} />
              </Link>
            </>
          ) : (
            <Link to="/login?verified=1" className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90">
              Continue to sign in
              <ArrowRight size={16} />
            </Link>
          )}
        </div>
      </div>
    </AuthLayout>
  );
}
