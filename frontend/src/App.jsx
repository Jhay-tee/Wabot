import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "./api";

function useAuth() {
  const [token, setToken] = useState(() => localStorage.getItem("botify_token"));
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem("botify_user");
    return raw ? JSON.parse(raw) : null;
  });

  const login = (nextToken, nextUser) => {
    localStorage.setItem("botify_token", nextToken);
    localStorage.setItem("botify_user", JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
  };

  const logout = () => {
    localStorage.removeItem("botify_token");
    localStorage.removeItem("botify_user");
    setToken(null);
    setUser(null);
  };

  return useMemo(() => ({ token, user, login, logout }), [token, user]);
}

function Landing() {
  return (
    <div className="page">
      <nav className="nav">
        <strong>Botify</strong>
        <div className="row">
          <Link to="/login" className="btn btn-ghost">Sign in</Link>
          <Link to="/signup" className="btn">Start free</Link>
        </div>
      </nav>
      <section className="hero">
        <h1>Manage every WhatsApp bot from one place</h1>
        <p>Launch, monitor, and scale multiple bots with free and paid plans, analytics, and account-level controls.</p>
        <div className="row">
          <Link to="/signup" className="btn">Create account</Link>
          <a href="#pricing" className="btn btn-ghost">See plans</a>
        </div>
      </section>
      <section className="grid3">
        <article className="card"><h3>Email verification</h3><p>New users must confirm email before deploying any bot.</p></article>
        <article className="card"><h3>Deploy with QR</h3><p>Pick a bot name and scan a generated QR code to connect.</p></article>
        <article className="card"><h3>Stripe billing</h3><p>Upgrade to paid for higher limits and scale.</p></article>
      </section>
      <section id="pricing" className="grid2">
        <article className="card"><h3>Free</h3><p>Up to 2 bots, monitoring dashboard, activity feed.</p></article>
        <article className="card featured"><h3>Growth (Paid)</h3><p>Up to 100 bots, subscription billing via Stripe.</p></article>
      </section>
    </div>
  );
}

function Signup() {
  const [form, setForm] = useState({ fullName: "", email: "", password: "" });
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMsg("");
    try {
      await api("/auth/signup", { method: "POST", body: JSON.stringify(form) });
      setMsg("Signup successful. Check your email to verify your account.");
    } catch (error) {
      setMsg(error.message);
    } finally {
      setLoading(false);
    }
  };
  return <AuthShell title="Create account">{authForm(form, setForm, onSubmit, msg, loading, true)}</AuthShell>;
}

function Login({ auth }) {
  const [form, setForm] = useState({ email: "", password: "" });
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMsg("");
    try {
      const data = await api("/auth/login", { method: "POST", body: JSON.stringify(form) });
      auth.login(data.token, data.user);
      navigate("/dashboard");
    } catch (error) {
      setMsg(error.message);
    } finally {
      setLoading(false);
    }
  };
  return <AuthShell title="Welcome back">{authForm(form, setForm, onSubmit, msg, loading, false)}</AuthShell>;
}

function authForm(form, setForm, onSubmit, msg, loading, withName) {
  return (
    <form onSubmit={onSubmit} className="auth-card">
      {withName && <input placeholder="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />}
      <input type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
      <input type="password" placeholder="Password (min 8)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
      <button className="btn" disabled={loading}>{loading ? "Please wait..." : "Continue"}</button>
      {msg && <p>{msg}</p>}
      <p>{withName ? <Link to="/login">Already have an account?</Link> : <Link to="/signup">Create an account</Link>}</p>
    </form>
  );
}

function AuthShell({ title, children }) {
  return <div className="center"><h2>{title}</h2>{children}</div>;
}

function VerifyPage() {
  const [params] = useSearchParams();
  const [msg, setMsg] = useState("Verifying...");
  const token = params.get("token");
  useEffect(() => {
    if (!token) return setMsg("Missing token");
    api(`/auth/verify?token=${token}`)
      .then(() => setMsg("Email verified. You can now log in and deploy bots."))
      .catch((e) => setMsg(e.message));
  }, [token]);
  return <div className="center"><h2>{msg}</h2><Link className="btn" to="/login">Go to login</Link></div>;
}

function Dashboard({ auth }) {
  const [data, setData] = useState({ user: auth.user, bots: [], activity: [] });
  const [botName, setBotName] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("botify_theme") || "light");
  const navigate = useNavigate();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    api("/bots/dashboard")
      .then((d) => setData(d))
      .catch(() => navigate("/login"));
  }, [navigate]);

  const deploy = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const response = await api("/bots/deploy", { method: "POST", body: JSON.stringify({ botName }) });
      setQr(response.qrCodeDataUrl);
      const latest = await api("/bots/dashboard");
      setData(latest);
      setBotName("");
    } catch (err) {
      setError(err.message);
    }
  };

  const checkout = async () => {
    const session = await api("/billing/checkout", { method: "POST" });
    window.location.href = session.url;
  };

  return (
    <div className="page">
      <nav className="nav">
        <strong>Botify Dashboard</strong>
        <div className="row">
          <button className="btn btn-ghost" onClick={() => {
            const next = theme === "dark" ? "light" : "dark";
            setTheme(next);
            localStorage.setItem("botify_theme", next);
          }}>Theme: {theme}</button>
          <button className="btn btn-ghost" onClick={auth.logout}>Logout</button>
        </div>
      </nav>
      <section className="grid3">
        <article className="card"><h3>Plan</h3><p>{data.user?.plan_tier || data.user?.planTier || "free"}</p><button className="btn" onClick={checkout}>Upgrade with Stripe</button></article>
        <article className="card"><h3>Email verified</h3><p>{String(data.user?.email_verified ?? data.user?.emailVerified)}</p></article>
        <article className="card"><h3>Total bots</h3><p>{data.bots.length}</p></article>
      </section>
      <section className="grid2">
        <article className="card">
          <h3>Deploy a bot</h3>
          <form onSubmit={deploy} className="stack">
            <input value={botName} placeholder="Bot name" onChange={(e) => setBotName(e.target.value)} />
            <button className="btn">Deploy bot</button>
          </form>
          {error && <p>{error}</p>}
          {qr && <img alt="Bot QR code" src={qr} className="qr" />}
        </article>
        <article className="card">
          <h3>Your bots</h3>
          <ul>{data.bots.map((bot) => <li key={bot.id}>{bot.bot_name} - {bot.status}</li>)}</ul>
        </article>
      </section>
      <section className="card">
        <h3>Recent activity</h3>
        <ul>{data.activity.map((a) => <li key={a.id}>{a.event_type} - {a.details}</li>)}</ul>
      </section>
    </div>
  );


function Protected({ auth, children }) {
  if (!auth.token) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const auth = useAuth();

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/login" element={<Login auth={auth} />} />
      <Route path="/verify" element={<VerifyPage />} />
      <Route path="/dashboard" element={<Protected auth={auth}><Dashboard auth={auth} /></Protected>} />
    </Routes>
  );
}
