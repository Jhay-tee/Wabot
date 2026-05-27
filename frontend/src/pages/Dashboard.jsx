import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BookOpen, Bot, CreditCard, KeyRound, LayoutGrid, Logs as LogsIcon, Menu, MessageSquare, MoonStar, Settings as SettingsIcon, Shield, SunMedium, X } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { useDashboard } from "../hooks/useDashboard.js";
import { billingApi } from "../api/billing.js";
import { PageSpinner } from "../components/ui/Spinner.jsx";
import { Overview } from "./dashboard/Overview.jsx";
import { Bots } from "./dashboard/Bots.jsx";
import Conversations from "./dashboard/Conversations.jsx";
import { Logs } from "./dashboard/Logs.jsx";
import { ApiKeys } from "./dashboard/ApiKeys.jsx";
import { Billing } from "./dashboard/Billing.jsx";
import { Settings } from "./dashboard/Settings.jsx";
import BotWorkspace from "./dashboard/BotWorkspace.jsx";
import { ResendVerificationModal } from "../components/auth/ResendVerificationModal.jsx";
import Admin from "./Admin.jsx";

// Base tabs for all users
const BASE_TABS = [
  { id: "overview", icon: LayoutGrid, label: "Overview" },
  { id: "conversations", icon: MessageSquare, label: "Conversations" },
  { id: "bots", icon: Bot, label: "Bots" },
  { id: "logs", icon: LogsIcon, label: "Logs" },
  { id: "apikeys", icon: KeyRound, label: "API Keys" },
  { id: "billing", icon: CreditCard, label: "Billing" },
  { id: "settings", icon: SettingsIcon, label: "Settings" },
];

// Admin-only tab - only shown to superadmins
const ADMIN_TAB = { id: "admin", icon: Shield, label: "Admin" };

const EXTERNAL_LINKS = [{ href: "/docs", icon: BookOpen, label: "API Docs" }];

export default function Dashboard() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { botId } = useParams();
  const { data, loading, refresh } = useDashboard();

  const [tab, setTab] = useState("overview");
  const [showVerifyModal, setShowVerifyModal] = useState(false);

  const { theme, toggle: toggleTheme } = useTheme();

  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState("");
  const [managing, setManaging] = useState(false);
  const [sidebarOpen, setSidebar] = useState(false);

  const user = data.user ?? auth.user;
  const emailVerified = user?.emailVerified ?? user?.email_verified;
  const userEmail = user?.email ?? user?.email_address;
  
  // Check if user is superadmin (from the /me endpoint)
  const isSuperAdmin = user?.isSuperAdmin === true;

  // Build tabs dynamically - add Admin tab only for superadmins
  const TABS = isSuperAdmin ? [...BASE_TABS, ADMIN_TAB] : BASE_TABS;

  /* Switch to billing tab if redirected back from Paystack checkout */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing")) {
      setTab("billing");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (botId) {
      setTab("bots");
    }
  }, [botId]);

  /* Open verification modal for unverified users */
  useEffect(() => {
    if (emailVerified === false) setShowVerifyModal(true);
  }, [emailVerified]);

  /* Allow Overview CTA to open the modal via a global event */
  useEffect(() => {
    const handler = () => setShowVerifyModal(true);
    window.addEventListener("wabot:open-resend-verification", handler);
    return () => window.removeEventListener("wabot:open-resend-verification", handler);
  }, []);

  const handleUpgrade = useCallback(async () => {
    setUpgradeError("");
    setUpgrading(true);
    try {
      const { url } = await billingApi.checkout();
      if (url) window.location.href = url;
    } catch (err) {
      setUpgradeError(err.message ?? "Could not start checkout. Please try again.");
      throw err;
    } finally {
      setUpgrading(false);
    }
  }, []);

  const handleManage = useCallback(async () => {
    setManaging(true);
    try {
      const { url } = await billingApi.portal();
      if (url) window.location.href = url;
    } catch (err) {
      throw err;
    } finally {
      setManaging(false);
    }
  }, []);

  const handleLogout = () => {
    auth.logout();
    navigate("/", { replace: true });
  };

  if (loading && !data.bots.length) return <PageSpinner />;

  return (
    <div className="flex min-h-screen bg-[var(--bg)] text-[var(--text)]">
      {showVerifyModal && (
        <ResendVerificationModal
          open={showVerifyModal}
          email={userEmail}
          onClose={() => setShowVerifyModal(false)}
          onResent={() => setShowVerifyModal(true)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 flex h-dvh w-72 flex-col overflow-hidden border-r border-white/10 bg-[var(--bg2)] px-4 py-5 transition-transform duration-200 lg:static lg:h-auto lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-2 pb-5">
          <div className="flex items-center gap-3">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent)] text-white">
              <Bot size={20} />
            </div>
            <div>
              <div className="text-base font-semibold">WaBot</div>
              <div className="text-xs uppercase tracking-[0.24em] text-[var(--text3)]">Control Center</div>
            </div>
          </div>
          <button className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-[var(--text2)] lg:hidden" onClick={() => setSidebar(false)}>
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <nav className="flex flex-col gap-2">
          {TABS.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-left text-sm transition ${
                tab === id
                  ? "border border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--text)]"
                  : "text-[var(--text2)] hover:bg-white/5 hover:text-[var(--text)]"
              }`}
              onClick={() => {
                if (botId) navigate("/dashboard");
                setTab(id);
                setSidebar(false);
              }}
            >
              <Icon size={18} />
              <span className="font-medium">{label}</span>
            </button>
          ))}
        </nav>

        <div className="mt-6 border-t border-white/10 pt-4">
          {EXTERNAL_LINKS.map(({ href, icon: Icon, label }) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 rounded-2xl px-4 py-3 text-sm text-[var(--text2)] transition hover:bg-white/5 hover:text-[var(--text)]"
            >
              <Icon size={18} />
              <span className="font-medium">{label}</span>
              <ArrowUpRightBadge />
            </a>
          ))}
        </div>
        </div>

        <div className="mt-4 border-t border-white/10 pt-5 pb-[env(safe-area-inset-bottom)]">
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent)]/20 font-semibold text-[var(--accent)]">
              {(user?.full_name ?? user?.fullName ?? user?.email ?? "?")[0].toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{user?.full_name ?? user?.fullName ?? "Account"}</div>
              <div className="truncate text-xs text-[var(--text3)]">{user?.email}</div>
            </div>
          </div>

          <button
            className="mt-3 inline-flex w-full items-center justify-center rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-[var(--text)] transition hover:border-[var(--border-accent)]"
            onClick={handleLogout}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setSidebar(false)} />}

      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 bg-[var(--bg)]/90 px-4 py-4 backdrop-blur md:px-6">
          <button className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 text-[var(--text2)] lg:hidden" onClick={() => setSidebar((o) => !o)}>
            <Menu size={18} />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">{TABS.find((t) => t.id === tab)?.label ?? "Dashboard"}</h1>
            <div className="text-xs uppercase tracking-[0.22em] text-[var(--text3)]">Workspace</div>
          </div>
          <button className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-[var(--text2)] transition hover:border-[var(--border-accent)] hover:text-[var(--text)]" onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} aria-label="Toggle theme">
            {theme === "dark" ? <SunMedium size={18} /> : <MoonStar size={18} />}
          </button>
        </header>

        <div className="px-4 py-6 md:px-6">
          {botId ? (
            <BotWorkspace user={user} onRefreshDashboard={refresh} />
          ) : tab === "overview" && (
            <Overview
              data={data}
              onGoToBots={() => setTab("bots")}
              onResendVerification={() => setShowVerifyModal(true)}
            />
          )}
          {!botId && tab === "conversations" && <Conversations bots={data.bots} />}
          {!botId && tab === "bots" && <Bots data={data} onRefresh={refresh} />}
          {!botId && tab === "logs" && <Logs activity={data.activity} bots={data.bots} />}
          {!botId && tab === "apikeys" && <ApiKeys user={user} />}
          {!botId && tab === "billing" && (
            <Billing
              user={user}
              onUpgrade={handleUpgrade}
              upgrading={upgrading}
              upgradeError={upgradeError}
              onManage={handleManage}
              managing={managing}
            />
          )}
          {!botId && tab === "settings" && (
            <Settings user={user} onUserUpdated={(updated) => auth.patchUser(updated)} />
          )}
          {!botId && tab === "admin" && <Admin />}
        </div>
      </main>
    </div>
  );
}

function ArrowUpRightBadge() {
  return <span className="ml-auto text-xs text-[var(--text3)]">↗</span>;
}
