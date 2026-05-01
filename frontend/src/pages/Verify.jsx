import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client.js";

export default function Verify() {
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
    apiFetch(`/auth/verify?token=${encodeURIComponent(token)}`)
      .then(() => setState("success"))
      .catch((err) => {
        setState("error");
        setMsg(err.message || "Verification failed.");
      });
  }, []);

  return (
    <div className="auth-layout">
      <div className="auth-box">
        <div className="auth-header">
          <Link to="/" className="auth-logo-wrap">🤖</Link>
          <div>
            <div className="auth-title">
              {state === "loading" && "Verifying…"}
              {state === "success" && "Email verified!"}
              {state === "error"   && "Verification failed"}
            </div>
            <div className="auth-subtitle">
              {state === "loading" && "Please wait while we confirm your email."}
              {state === "success" && "Your account is ready to use."}
              {state === "error"   && "The link may have expired or already been used."}
            </div>
          </div>
        </div>

        <div className="auth-card" style={{ alignItems: "center", textAlign: "center", gap: "1.5rem" }}>
          {state === "loading" && <span className="spinner spinner-lg" />}

          {state === "success" && (
            <>
              <div style={{ fontSize: "3rem" }}>✅</div>
              <p className="text-muted text-sm">
                Your email has been confirmed. You can now log in and start deploying bots.
              </p>
              <Link to="/login" className="btn btn-primary w-full">Sign in to WaBot</Link>
            </>
          )}

          {state === "error" && (
            <>
              <div style={{ fontSize: "3rem" }}>❌</div>
              {msg && <div className="alert alert-error w-full">{msg}</div>}
              <div className="flex gap-3" style={{ width: "100%" }}>
                <Link to="/signup" className="btn btn-secondary flex-1">Sign up again</Link>
                <Link to="/login"  className="btn btn-primary  flex-1">Sign in</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
