import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";

/* ── helpers ──────────────────────────────────────────────────── */
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusBadge(status) {
  const map = {
    active:           { cls: "badge-active",   label: "Active" },
    awaiting_qr_scan: { cls: "badge-pending",  label: "Awaiting QR" },
    connected:        { cls: "badge-active",   label: "Connected" },
    disconnected:     { cls: "badge-inactive", label: "Disconnected" },
  };
  const { cls, label } = map[status] || { cls: "badge-inactive", label: status };
  return <span className={`badge ${cls}`}>{label}</span>;
}

/* ── nav items ────────────────────────────────────────────────── */
const NAV = [
  { id: "overview", icon: "⊞",  label: "Overview" },
  { id: "bots",     icon: "🤖", label: "My Bots" },
  { id: "activity", icon: "📋", label: "Activity" },
  { id: "billing",  icon: "💳", label: "Billing" },
];

/* ── sub-views ────────────────────────────────────────────────── */
function Overview({ data, onGoToBots }) {
  const { user, bots, activity } = data;
  const maxBots   = user?.planTier === "paid" ? 100 : 2;
  const activeCnt = bots.filter((b) => b.status === "active" || b.status === "connected").length;

  return (
    <div className="flex-col gap-6" style={{ display: "flex" }}>
      {/* stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">🤖</div>
          <div className="stat-value">{bots.length}</div>
          <div className="stat-label">Total bots</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-value">{activeCnt}</div>
          <div className="stat-label">Active bots</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">📦</div>
          <div className="stat-value">{bots.length}/{maxBots}</div>
          <div className="stat-label">Slots used</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">📧</div>
          <div className="stat-value">{user?.emailVerified ? "✓" : "✗"}</div>
          <div className="stat-label">Email verified</div>
        </div>
      </div>

      {/* recent bots */}
      <div className="card">
        <div className="section-heading" style={{ marginBottom: "1rem" }}>
          <span>Recent Bots</span>
          <button className="btn btn-sm btn-secondary" onClick={onGoToBots}>View all</button>
        </div>
        {bots.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🤖</div>
            <div className="empty-title">No bots yet</div>
            <div className="empty-desc">Deploy your first bot to get started.</div>
            <button className="btn btn-primary btn-sm" style={{ marginTop: "0.25rem" }} onClick={onGoToBots}>Deploy a bot</button>
          </div>
        ) : (
          <div className="activity-list">
            {bots.slice(0, 4).map((b) => (
              <div className="activity-row" key={b.id}>
                <div className="activity-dot" />
                <div className="flex-1">
                  <div className="activity-event">{b.bot_name}</div>
                  <div className="activity-detail">{statusBadge(b.status)}</div>
                </div>
                <div className="activity-time">{timeAgo(b.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* recent activity */}
      {activity.length > 0 && (
        <div className="card">
          <div className="section-heading" style={{ marginBottom: "1rem" }}>Recent Activity</div>
          <div className="activity-list">
            {activity.slice(0, 5).map((a) => (
              <div className="activity-row" key={a.id}>
                <div className="activity-dot" />
                <div className="flex-1">
                  <div className="activity-event">{a.event_type.replace(/_/g, " ")}</div>
                  {a.details && <div className="activity-detail">{a.details}</div>}
                </div>
                <div className="activity-time">{timeAgo(a.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QrModal({ bot, qrUrl, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div style={{ fontSize: "2rem" }}>🤖</div>
        <h3>Scan QR to connect</h3>
        <p>Open WhatsApp → Linked Devices → Link a Device, then scan:</p>
        <div className="qr-wrap">
          <img src={qrUrl} alt="QR code" />
        </div>
        <p className="text-xs text-muted3">Bot: <strong style={{ color: "var(--text)" }}>{bot?.bot_name}</strong></p>
        <button className="btn btn-secondary w-full" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function DeployModal({ onClose, onDeployed, user }) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Bot name is required.");
    setError("");
    setLoading(true);
    try {
      const data = await apiFetch("/bots/deploy", {
        method: "POST",
        body: JSON.stringify({ botName: name.trim() }),
      });
      onDeployed(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!user?.emailVerified) {
    return (
      <div className="overlay" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close" onClick={onClose}>✕</button>
          <div style={{ fontSize: "2rem" }}>📧</div>
          <h3>Verify your email first</h3>
          <p>You need to verify your email before deploying bots. Check your inbox for the verification link.</p>
          <button className="btn btn-primary w-full" onClick={onClose}>Got it</button>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div style={{ fontSize: "2rem" }}>🚀</div>
        <h3>Deploy a new bot</h3>
        <p>Give your bot a name. You'll scan a QR code to connect it to WhatsApp.</p>
        <form onSubmit={submit} style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {error && <div className="alert alert-error">{error}</div>}
          <input
            className="input"
            placeholder="e.g. sales-assistant"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button type="submit" className="btn btn-primary w-full" disabled={loading}>
            {loading ? <><span className="spinner spinner-sm" /> Deploying…</> : "Deploy bot"}
          </button>
        </form>
      </div>
    </div>
  );
}

function BotsView({ data, onRefresh }) {
  const { user, bots } = data;
  const [showDeploy, setShowDeploy]  = useState(false);
  const [qrState,    setQrState]     = useState(null); // { bot, qrUrl }
  const [deleting,   setDeleting]    = useState(null);
  const maxBots = user?.planTier === "paid" ? 100 : 2;
  const atLimit = bots.length >= maxBots;

  const handleDeployed = (res) => {
    setShowDeploy(false);
    setQrState({ bot: res.bot, qrUrl: res.qrCodeDataUrl });
    onRefresh();
  };

  const handleDelete = async (botId) => {
    if (!window.confirm("Delete this bot? This cannot be undone.")) return;
    setDeleting(botId);
    try {
      await apiFetch(`/bots/${botId}`, { method: "DELETE" });
      onRefresh();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      {showDeploy && <DeployModal user={user} onClose={() => setShowDeploy(false)} onDeployed={handleDeployed} />}
      {qrState    && <QrModal bot={qrState.bot} qrUrl={qrState.qrUrl} onClose={() => setQrState(null)} />}

      <div className="flex-col gap-5" style={{ display: "flex" }}>
        <div className="section-heading">
          <span>My Bots <span className="badge badge-inactive" style={{ fontSize: "0.7rem" }}>{bots.length}/{maxBots}</span></span>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowDeploy(true)}
            disabled={atLimit}
            title={atLimit ? "Upgrade to deploy more bots" : "Deploy a new bot"}
          >
            + Deploy bot
          </button>
        </div>

        {atLimit && (
          <div className="alert alert-info">
            You've reached the <strong>{user?.planTier}</strong> plan limit of {maxBots} bot{maxBots !== 1 ? "s" : ""}.
            {user?.planTier !== "paid" && <> <strong style={{ color: "var(--accent)", cursor: "pointer" }}>Upgrade to Pro</strong> for 100 bots.</>}
          </div>
        )}

        {bots.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <div className="empty-icon">🤖</div>
              <div className="empty-title">No bots deployed yet</div>
              <div className="empty-desc">Click "Deploy bot" to launch your first WhatsApp bot.</div>
            </div>
          </div>
        ) : (
          <div className="bots-grid">
            {bots.map((bot) => (
              <div className="bot-card" key={bot.id}>
                <div className="bot-card-top">
                  <div className="bot-card-icon">🤖</div>
                  <div>{statusBadge(bot.status)}</div>
                </div>
                <div>
                  <div className="bot-card-name">{bot.bot_name}</div>
                  <div className="bot-card-date">Created {timeAgo(bot.created_at)}</div>
                </div>
                <div className="bot-card-actions">
                  {bot.qr_payload && (
                    <button
                      className="btn btn-secondary btn-sm flex-1"
                      onClick={() => {
                        apiFetch(`/bots/${bot.id}/qr`)
                          .then((d) => setQrState({ bot, qrUrl: d.qrCodeDataUrl }))
                          .catch(() => {});
                      }}
                    >
                      View QR
                    </button>
                  )}
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => handleDelete(bot.id)}
                    disabled={deleting === bot.id}
                  >
                    {deleting === bot.id ? <span className="spinner spinner-sm" /> : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ActivityView({ activity }) {
  return (
    <div className="card">
      <div className="section-heading" style={{ marginBottom: "1rem" }}>Activity Log</div>
      {activity.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <div className="empty-title">No activity yet</div>
          <div className="empty-desc">Deploy a bot to see events here.</div>
        </div>
      ) : (
        <div className="activity-list">
          {activity.map((a) => (
            <div className="activity-row" key={a.id}>
              <div className="activity-dot" />
              <div className="flex-1">
                <div className="activity-event">{a.event_type.replace(/_/g, " ")}</div>
                {a.details && <div className="activity-detail">{a.details}</div>}
              </div>
              <div className="activity-time">{timeAgo(a.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BillingView({ user, onUpgrade }) {
  const isPro = user?.planTier === "paid";

  return (
    <div className="flex-col gap-5" style={{ display: "flex" }}>
      <div className="card card-accent">
        <div className="flex items-center gap-4" style={{ display: "flex" }}>
          <div style={{ fontSize: "2.5rem" }}>💳</div>
          <div className="flex-1">
            <div className="flex items-center gap-2" style={{ display: "flex", marginBottom: "0.25rem" }}>
              <span className="font-bold">Current plan</span>
              <span className={`badge ${isPro ? "badge-pro" : "badge-free"}`}>{isPro ? "Pro" : "Free"}</span>
            </div>
            <div className="text-muted text-sm">{isPro ? "Up to 100 bots · Stripe billing" : "Up to 2 bots · Free forever"}</div>
          </div>
          {!isPro && (
            <button className="btn btn-primary" onClick={onUpgrade}>Upgrade to Pro</button>
          )}
        </div>
      </div>

      {!isPro && (
        <div className="upgrade-banner">
          <div>
            <div className="font-bold" style={{ marginBottom: "0.25rem" }}>Unlock Pro</div>
            <div className="text-sm text-muted">Get 100 bot slots, priority support, and all future features for $19/mo.</div>
          </div>
          <button className="btn btn-primary" onClick={onUpgrade}>Upgrade now →</button>
        </div>
      )}

      <div className="card">
        <div className="section-heading" style={{ marginBottom: "1rem" }}>Plan features</div>
        {[
          { label: "Bots allowed",      free: "2",      pro: "100"       },
          { label: "Dashboard access",  free: "✓",      pro: "✓"         },
          { label: "Activity feed",     free: "✓",      pro: "✓"         },
          { label: "QR deployment",     free: "✓",      pro: "✓"         },
          { label: "Priority support",  free: "—",      pro: "✓"         },
          { label: "Billing portal",    free: "—",      pro: "✓"         },
        ].map((row) => (
          <div key={row.label} style={{ display: "flex", alignItems: "center", padding: "0.625rem 0", borderBottom: "1px solid var(--border)" }}>
            <span className="flex-1 text-sm">{row.label}</span>
            <span className="text-sm text-muted" style={{ width: "80px", textAlign: "center" }}>{row.free}</span>
            <span className="text-sm" style={{ width: "80px", textAlign: "center", color: isPro ? "var(--success)" : "var(--text2)" }}>{row.pro}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Dashboard shell ──────────────────────────────────────────── */
export default function Dashboard() {
  const auth     = useAuth();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState("overview");
  const [data,      setData]      = useState({ user: auth.user, bots: [], activity: [] });
  const [loading,   setLoading]   = useState(true);
  const [upgrading, setUpgrading] = useState(false);
  const pollRef = useRef(null);

  const fetchDashboard = useCallback(async () => {
    try {
      const d = await apiFetch("/bots/dashboard");
      setData(d);
      auth.patchUser(d.user ? {
        planTier: d.user.plan_tier,
        emailVerified: d.user.email_verified,
        fullName: d.user.full_name,
      } : {});
    } catch (err) {
      if (err.status === 401) {
        auth.logout();
        navigate("/login", { replace: true });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    pollRef.current = setInterval(fetchDashboard, 30000);
    return () => clearInterval(pollRef.current);
  }, [fetchDashboard]);

  const handleUpgrade = async () => {
    setUpgrading(true);
    try {
      const { url } = await apiFetch("/billing/checkout", { method: "POST" });
      window.location.href = url;
    } catch (err) {
      alert(err.message);
    } finally {
      setUpgrading(false);
    }
  };

  const user    = data.user || auth.user || {};
  const initials = (user.full_name || user.email || "U")[0].toUpperCase();
  const isPro   = user.plan_tier === "paid" || user.planTier === "paid";
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();

  return (
    <div className="dash-layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🤖</div>
          WwaBot
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-label">Menu</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`sidebar-nav-item ${activeTab === n.id ? "active" : ""}`}
              onClick={() => setActiveTab(n.id)}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="user-pill">
            <div className="user-avatar">{initials}</div>
            <div className="flex-1" style={{ minWidth: 0 }}>
              <div className="user-name truncate">{user.full_name || "User"}</div>
              <div className="user-email truncate">{user.email || ""}</div>
            </div>
            <span className={`badge ${isPro ? "badge-pro" : "badge-free"}`}>{isPro ? "Pro" : "Free"}</span>
          </div>
          <button
            className="sidebar-nav-item"
            style={{ marginTop: "0.375rem", color: "var(--error)" }}
            onClick={auth.logout}
          >
            <span className="nav-icon">⏎</span> Sign out
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="dash-main">
        <div className="dash-topbar">
          <div>
            <div className="font-bold" style={{ fontSize: "1.0625rem" }}>
              {greeting}, {(user.full_name || user.email || "").split(" ")[0] || "there"} 👋
            </div>
            <div className="text-sm text-muted">
              {NAV.find((n) => n.id === activeTab)?.label}
            </div>
          </div>
          <div className="flex items-center gap-3" style={{ display: "flex" }}>
            {!user.email_verified && !user.emailVerified && (
              <div className="alert alert-info" style={{ padding: "0.375rem 0.75rem", fontSize: "0.8rem" }}>
                ⚠ Verify your email to deploy bots
              </div>
            )}
            {!isPro && (
              <button className="btn btn-primary btn-sm" onClick={handleUpgrade} disabled={upgrading}>
                {upgrading ? <span className="spinner spinner-sm" /> : "⚡ Upgrade"}
              </button>
            )}
          </div>
        </div>

        <div className="dash-content">
          {loading ? (
            <div className="flex items-center justify-center" style={{ display: "flex", padding: "4rem" }}>
              <span className="spinner spinner-lg" />
            </div>
          ) : (
            <>
              {activeTab === "overview" && <Overview data={data} onGoToBots={() => setActiveTab("bots")} />}
              {activeTab === "bots"     && <BotsView data={data} onRefresh={fetchDashboard} />}
              {activeTab === "activity" && <ActivityView activity={data.activity} />}
              {activeTab === "billing"  && <BillingView user={user} onUpgrade={handleUpgrade} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
