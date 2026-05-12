import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth }     from "../context/AuthContext.jsx";
import { adminApi }    from "../api/admin.js";
import { Spinner }     from "../components/ui/Spinner.jsx";
import { timeAgo }     from "../utils/format.js";

/* ── helpers ── */
const fmt  = (n) => Number(n ?? 0).toLocaleString();
const pct  = (a, b) => b ? `${Math.round((a / b) * 100)}%` : "0%";

const EVENT_COLORS = {
  bot_deployed:       "#a78bfa",
  bot_connected:      "#34d399",
  bot_disconnected:   "#f87171",
  api_message_sent:   "#60a5fa",
  message_received:   "#fbbf24",
  webhook_fired:      "#f472b6",
  ai_response:        "#818cf8",
};

function StatCard({ label, value, sub, color = "var(--accent)", icon }) {
  return (
    <div className="admin-stat-card">
      <div className="admin-stat-icon" style={{ background: color + "22", color }}>{icon}</div>
      <div className="admin-stat-body">
        <div className="admin-stat-value">{value}</div>
        <div className="admin-stat-label">{label}</div>
        {sub && <div className="admin-stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

function MiniBar({ value, max, color = "var(--accent)" }) {
  const pct = Math.min(100, max ? Math.round((value / max) * 100) : 0);
  return (
    <div style={{ flex: 1, background: "var(--bg)", borderRadius: 4, height: 6, overflow: "hidden", minWidth: 60 }}>
      <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: 4, transition: "width 0.6s ease" }} />
    </div>
  );
}

function EventBadge({ type }) {
  const color = EVENT_COLORS[type] ?? "var(--text3)";
  return (
    <span style={{
      fontSize: "0.7rem", fontWeight: 600, padding: "2px 7px", borderRadius: 20,
      background: color + "22", color, whiteSpace: "nowrap"
    }}>{type?.replace(/_/g, " ")}</span>
  );
}

export default function Admin() {
  const { user, token }   = useAuth();
  const navigate          = useNavigate();
  const [stats,    setStats]    = useState(null);
  const [users,    setUsers]    = useState([]);
  const [activity, setActivity] = useState([]);
  const [loadingS, setLoadingS] = useState(true);
  const [loadingU, setLoadingU] = useState(true);
  const [loadingA, setLoadingA] = useState(true);
  const [error,    setError]    = useState("");
  const [userPage, setUserPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [userFilter, setUserFilter] = useState("all"); /* all | free | paid */
  const [tab,      setTab]      = useState("overview"); /* overview | users | activity */
  const [refreshed, setRefreshed] = useState(null);

  /* Redirect if not logged in */
  useEffect(() => {
    if (!token) navigate("/login", { replace: true });
  }, [token]);

  const loadStats = useCallback(() => {
    setLoadingS(true);
    adminApi.stats()
      .then(setStats)
      .catch((e) => setError(e.message))
      .finally(() => { setLoadingS(false); setRefreshed(new Date()); });
  }, []);

  const loadUsers = useCallback((page = 1) => {
    setLoadingU(true);
    adminApi.users(page, 50)
      .then((d) => {
        setUsers(d.users ?? []);
        setTotalPages(d.pages ?? 1);
        setUserPage(page);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingU(false));
  }, []);

  const loadActivity = useCallback(() => {
    setLoadingA(true);
    adminApi.activity(150)
      .then((d) => setActivity(d.activity ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoadingA(false));
  }, []);

  useEffect(() => {
    loadStats();
    loadUsers(1);
    loadActivity();
  }, []);

  /* Filter users client-side */
  const filteredUsers = userFilter === "all"
    ? users
    : users.filter((u) => u.plan === userFilter);

  /* ── Access denied ── */
  if (error && error.includes("Forbidden")) {
    return (
      <div className="admin-denied">
        <div style={{ fontSize: "3rem" }}>🚫</div>
        <h2>Access Denied</h2>
        <p>This area is restricted to the platform superadmin only.</p>
        <button className="btn btn-secondary" onClick={() => navigate("/dashboard")}>
          ← Back to Dashboard
        </button>
      </div>
    );
  }

  if (error && error.includes("not configured")) {
    return (
      <div className="admin-denied">
        <div style={{ fontSize: "3rem" }}>⚙️</div>
        <h2>Admin Not Configured</h2>
        <p>Set the <code>SUPERADMIN_EMAIL</code> secret in your Replit Secrets panel to enable the admin panel.</p>
        <button className="btn btn-secondary" onClick={() => navigate("/dashboard")}>
          ← Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="admin-root">
      {/* ── Top bar ── */}
      <header className="admin-header">
        <div className="admin-header-left">
          <div className="admin-logo">
            <span className="admin-logo-icon">⚡</span>
            <span className="admin-logo-text">WaBot</span>
            <span className="admin-badge">ADMIN</span>
          </div>
        </div>
        <div className="admin-header-right">
          {refreshed && (
            <span className="admin-refresh-ts">
              Refreshed {timeAgo(refreshed.toISOString())}
            </span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => { loadStats(); loadUsers(userPage); loadActivity(); }}>
            ↻ Refresh
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate("/dashboard")}>
            ← Dashboard
          </button>
        </div>
      </header>

      <div className="admin-body">
        {/* ── Tab nav ── */}
        <nav className="admin-tabs">
          {[
            { id: "overview", label: "📊 Overview" },
            { id: "users",    label: "👥 Users" },
            { id: "activity", label: "📡 Activity" },
          ].map((t) => (
            <button key={t.id}
              className={`admin-tab${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >{t.label}</button>
          ))}
        </nav>

        {/* ══════════════════════════════ OVERVIEW ══════════════════════════════ */}
        {tab === "overview" && (
          <div className="admin-section">
            {loadingS ? (
              <div className="admin-loading"><Spinner /><span>Loading stats…</span></div>
            ) : stats ? (
              <>
                {/* Row 1 — Users */}
                <div className="admin-section-title">Users</div>
                <div className="admin-stats-grid">
                  <StatCard icon="👥" label="Total users"       value={fmt(stats.users.total)}       color="#818cf8" />
                  <StatCard icon="⭐" label="Pro users"         value={fmt(stats.users.pro)}         sub={pct(stats.users.pro,  stats.users.total) + " of total"} color="#fbbf24" />
                  <StatCard icon="🆓" label="Free users"        value={fmt(stats.users.free)}        sub={pct(stats.users.free, stats.users.total) + " of total"} color="#60a5fa" />
                  <StatCard icon="🆕" label="New today"         value={fmt(stats.users.newToday)}    color="#34d399" />
                  <StatCard icon="📅" label="New this week"     value={fmt(stats.users.newThisWeek)} color="#a78bfa" />
                </div>

                {/* Pro vs Free visual bar */}
                <div className="admin-ratio-bar-wrap">
                  <div className="admin-ratio-bar">
                    <div className="admin-ratio-fill pro"
                      style={{ width: pct(stats.users.pro, stats.users.total) }}
                      title={`Pro: ${stats.users.pro}`} />
                    <div className="admin-ratio-fill free"
                      style={{ width: pct(stats.users.free, stats.users.total) }}
                      title={`Free: ${stats.users.free}`} />
                  </div>
                  <div className="admin-ratio-legend">
                    <span className="pro-dot" /> Pro {fmt(stats.users.pro)}
                    <span className="free-dot" /> Free {fmt(stats.users.free)}
                  </div>
                </div>

                {/* Row 2 — Bots */}
                <div className="admin-section-title" style={{ marginTop: "1.5rem" }}>Bots</div>
                <div className="admin-stats-grid">
                  <StatCard icon="🤖" label="Total bots"         value={fmt(stats.bots.total)}         color="#818cf8" />
                  <StatCard icon="🟢" label="Live right now"      value={fmt(stats.bots.activeLive)}    color="#34d399" />
                  <StatCard icon="🚀" label="Deployed today"      value={fmt(stats.bots.deployedToday)} color="#f472b6" />
                </div>

                {/* Row 3 — Messages & API */}
                <div className="admin-section-title" style={{ marginTop: "1.5rem" }}>Messages & API</div>
                <div className="admin-stats-grid">
                  <StatCard icon="💬" label="Total messages (all time)"  value={fmt(stats.messages.allTime)}       color="#60a5fa" />
                  <StatCard icon="📆" label="Messages this month"        value={fmt(stats.messages.thisMonth)}     color="#a78bfa" />
                  <StatCard icon="⚡" label="API events today"           value={fmt(stats.messages.activityToday)} color="#fbbf24" />
                  <StatCard icon="🔑" label="Total API keys"             value={fmt(stats.apiKeys.total)}          color="#f87171" />
                </div>

                <div className="admin-generated">
                  Last updated: {new Date(stats.generatedAt).toLocaleString()}
                </div>
              </>
            ) : null}
          </div>
        )}

        {/* ══════════════════════════════ USERS ══════════════════════════════ */}
        {tab === "users" && (
          <div className="admin-section">
            <div className="admin-users-toolbar">
              <div className="admin-filter-tabs">
                {["all", "free", "paid"].map((f) => (
                  <button key={f}
                    className={`admin-filter-btn${userFilter === f ? " active" : ""}`}
                    onClick={() => setUserFilter(f)}
                  >{f === "all" ? `All (${users.length})` : f === "paid" ? `Pro (${users.filter(u=>u.plan==="paid").length})` : `Free (${users.filter(u=>u.plan==="free").length})`}</button>
                ))}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => loadUsers(userPage)}>↻ Reload</button>
            </div>

            {loadingU ? (
              <div className="admin-loading"><Spinner /><span>Loading users…</span></div>
            ) : (
              <>
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>Plan</th>
                        <th>Bots</th>
                        <th>Msgs/month</th>
                        <th>Joined</th>
                        <th>Verified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map((u, i) => (
                        <tr key={u.id}>
                          <td className="text-muted3">{(userPage - 1) * 50 + i + 1}</td>
                          <td style={{ fontWeight: 600 }}>{u.name || "—"}</td>
                          <td>
                            <span className={`admin-plan-badge ${u.plan}`}>
                              {u.plan === "paid" ? "⭐ Pro" : "Free"}
                            </span>
                          </td>
                          <td>{u.botCount}</td>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                              <span>{fmt(u.messagesThisMonth)}</span>
                              <MiniBar
                                value={u.messagesThisMonth}
                                max={u.plan === "paid" ? 100000 : 1000}
                                color={u.plan === "paid" ? "#fbbf24" : "#60a5fa"}
                              />
                            </div>
                          </td>
                          <td className="text-muted3">{timeAgo(u.createdAt)}</td>
                          <td style={{ textAlign: "center" }}>{u.emailVerified ? "✓" : <span style={{ color: "var(--error)" }}>✗</span>}</td>
                        </tr>
                      ))}
                      {filteredUsers.length === 0 && (
                        <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text3)", padding: "2rem" }}>No users found.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="admin-pagination">
                    <button className="btn btn-secondary btn-sm" onClick={() => loadUsers(userPage - 1)} disabled={userPage <= 1}>← Prev</button>
                    <span className="text-muted3">Page {userPage} of {totalPages}</span>
                    <button className="btn btn-secondary btn-sm" onClick={() => loadUsers(userPage + 1)} disabled={userPage >= totalPages}>Next →</button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ══════════════════════════════ ACTIVITY ══════════════════════════════ */}
        {tab === "activity" && (
          <div className="admin-section">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>Last 150 system events</div>
              <button className="btn btn-ghost btn-sm" onClick={loadActivity}>↻ Reload</button>
            </div>

            {loadingA ? (
              <div className="admin-loading"><Spinner /><span>Loading activity…</span></div>
            ) : activity.length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--text3)", padding: "3rem" }}>No activity yet.</div>
            ) : (
              <div className="admin-activity-list">
                {activity.map((ev) => (
                  <div key={ev.id} className="admin-activity-row">
                    <EventBadge type={ev.event_type} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "0.8125rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {ev.details || "—"}
                      </div>
                      <div className="text-xs text-muted3 mono">{ev.bot_id}</div>
                    </div>
                    <div className="text-xs text-muted3" style={{ flexShrink: 0 }}>{timeAgo(ev.created_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
