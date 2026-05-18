import { useCallback, useEffect, useRef, useState } from "react";
import { Modal }   from "../ui/Modal.jsx";
import { Alert }   from "../ui/Alert.jsx";
import { Spinner } from "../ui/Spinner.jsx";
import { botsApi } from "../../api/bots.js";

const BOT_TYPES = [
  {
    id:    "dm",
    icon:  "💬",
    label: "DM Bot",
    desc:  "Responds to direct (1-on-1) WhatsApp messages. Perfect for customer support, sales, and personal bots."
  },
  {
    id:    "group",
    icon:  "👥",
    label: "Group Bot",
    desc:  "Responds inside WhatsApp group chats. Ideal for community management, announcements, and group commands."
  }
];

const WARNINGS = [
  {
    icon: "⚠️",
    title: "Unofficial automation",
    desc: "WaBot uses the Baileys library which is not officially supported by WhatsApp. Your account may be flagged or banned for using automation."
  },
  {
    icon: "🚫",
    title: "Risk of account ban",
    desc: "WhatsApp actively detects and bans accounts using unofficial clients. Use a dedicated number — never your personal or primary business number."
  },
  {
    icon: "👤",
    title: "You are responsible",
    desc: "You are solely responsible for how this bot is used. WaBot is not liable for bans, data loss, or any consequences of using WhatsApp automation."
  },
  {
    icon: "💼",
    title: "Business use",
    desc: "For official, high-volume WhatsApp business messaging, consider the official WhatsApp Business API (Meta) which is ban-safe and compliant."
  }
];

const POLL_MS    = 12_000;
const TIMEOUT_MS = 10 * 60_000;
const QR_LIFE_S  = 20;

export function DeployModal({ user, onClose, onDeployed }) {
  const [step,         setStep]         = useState("warning");
  const [accepted,     setAccepted]     = useState(false);
  const [name,         setName]         = useState("");
  const [desc,         setDesc]         = useState("");
  const [botType,      setBotType]      = useState("dm");
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState("");
  const [qrUrl,        setQrUrl]        = useState(null);
  const [countdown,    setCountdown]    = useState(QR_LIFE_S);
  const [reconnecting, setReconnecting] = useState(false);

  const esRef        = useRef(null);
  const timeoutRef   = useRef(null);
  const pollRef      = useRef(null);
  const cdRef        = useRef(null);
  const connectedRef = useRef(false);

  useEffect(() => () => {
    esRef.current?.close();
    clearTimeout(timeoutRef.current);
    clearInterval(pollRef.current);
    clearInterval(cdRef.current);
  }, []);

  const startCountdown = useCallback(() => {
    clearInterval(cdRef.current);
    setCountdown(QR_LIFE_S);
    cdRef.current = setInterval(() => {
      setCountdown((c) => (c <= 1 ? QR_LIFE_S : c - 1));
    }, 1000);
  }, []);

  const markQr = useCallback((url) => {
    setQrUrl(url);
    setReconnecting(false);
    startCountdown();
  }, [startCountdown]);

  const markConnected = useCallback((es) => {
    if (connectedRef.current) return;
    connectedRef.current = true;
    clearTimeout(timeoutRef.current);
    clearInterval(pollRef.current);
    clearInterval(cdRef.current);
    setStep("done");
    es?.close();
    onDeployed();
  }, [onDeployed]);

  const startPoll = useCallback((botId) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      if (connectedRef.current) { clearInterval(pollRef.current); return; }
      try {
        const data = await botsApi.qr(botId);
        if (data?.qrCodeDataUrl) markQr(data.qrCodeDataUrl);
      } catch {
        setReconnecting(true);
      }
    }, POLL_MS);
  }, [markQr]);

  const connectSse = useCallback((botId) => {
    const token = localStorage.getItem("wabot_token") ?? "";
    const es    = new EventSource(botsApi.eventsUrl(botId, token));
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "qr")     markQr(msg.qrUrl);
        if (msg.type === "status") {
          if (msg.status === "connected")    markConnected(es);
          if (msg.status === "connecting" || msg.status === "reconnecting") setReconnecting(true);
        }
      } catch {}
    };
    es.onerror = () => {};

    timeoutRef.current = setTimeout(() => {
      if (!connectedRef.current) {
        es.close();
        clearInterval(pollRef.current);
        clearInterval(cdRef.current);
        setError("Connection timed out (10 min). Please try deploying again.");
        setStep("form");
      }
    }, TIMEOUT_MS);
  }, [markQr, markConnected]);

  const deploy = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Bot name is required.");
    setError(""); setLoading(true);
    try {
      const data = await botsApi.deploy({ botName: name.trim(), description: desc.trim(), botType });
      connectedRef.current = false;
      setStep("qr");
      connectSse(data.bot.id);
      startPoll(data.bot.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!user?.emailVerified && !user?.email_verified) {
    return (
      <Modal onClose={onClose}>
        <div style={{ fontSize: "2rem" }}>📧</div>
        <h3>Verify your email first</h3>
        <p>Check your inbox for the verification link, then come back to deploy bots.</p>
        <button className="btn btn-primary w-full" onClick={onClose}>Got it</button>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>

      {/* ── Step 0: Warning ── */}
      {step === "warning" && (
        <>
          <div style={{ fontSize: "2rem" }}>⚠️</div>
          <h3 style={{ color: "var(--warning)" }}>Before you deploy</h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: "0.25rem" }}>
            Please read and acknowledge the following before deploying a WhatsApp bot.
          </p>

          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            {WARNINGS.map((w) => (
              <div
                key={w.title}
                style={{
                  background: "var(--warning-bg)",
                  border: "1px solid rgba(245,158,11,0.2)",
                  borderRadius: "var(--radius)",
                  padding: "0.75rem 1rem",
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "flex-start"
                }}
              >
                <span style={{ fontSize: "1.1rem", flexShrink: 0 }}>{w.icon}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.8125rem", color: "var(--text)", marginBottom: "0.2rem" }}>
                    {w.title}
                  </div>
                  <div style={{ fontSize: "0.775rem", color: "var(--text2)", lineHeight: 1.5 }}>
                    {w.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <label style={{
            width: "100%",
            display: "flex",
            alignItems: "flex-start",
            gap: "0.75rem",
            padding: "0.875rem",
            background: "var(--bg2)",
            border: `1.5px solid ${accepted ? "var(--accent)" : "var(--border)"}`,
            borderRadius: "var(--radius)",
            cursor: "pointer",
            transition: "border-color 0.14s ease"
          }}>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              style={{ marginTop: "2px", accentColor: "var(--accent)", width: "16px", height: "16px", flexShrink: 0 }}
            />
            <span style={{ fontSize: "0.8125rem", color: "var(--text2)", lineHeight: 1.5 }}>
              I understand that WhatsApp automation is unofficial and may result in my account being banned.
              I accept full responsibility for how this bot is used, and I will not use it to send spam.
            </span>
          </label>

          <div style={{ width: "100%", display: "flex", gap: "0.75rem" }}>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={!accepted}
              onClick={() => setStep("form")}
            >
              I understand — Continue
            </button>
          </div>
        </>
      )}

      {/* ── Step 1: form ── */}
      {step === "form" && (
        <>
          <div style={{ fontSize: "2rem" }}>🚀</div>
          <h3>Deploy a new bot</h3>

          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "0.25rem" }}>
            <div style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text2)" }}>Bot type</div>
            <div className="deploy-type-grid">
              {BOT_TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setBotType(t.id)}
                  style={{
                    padding: "0.875rem",
                    borderRadius: "var(--radius)",
                    border: `1.5px solid ${botType === t.id ? "var(--accent)" : "var(--border)"}`,
                    background: botType === t.id ? "var(--accent-dim)" : "var(--card)",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 0.14s ease"
                  }}
                >
                  <div style={{ fontSize: "1.25rem", marginBottom: "0.25rem" }}>{t.icon}</div>
                  <div style={{ fontWeight: 700, fontSize: "0.875rem", color: botType === t.id ? "var(--accent)" : "var(--text)", marginBottom: "0.25rem" }}>{t.label}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text3)", lineHeight: 1.4 }}>{t.desc}</div>
                </button>
              ))}
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text3)", background: "var(--bg)", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
              ⚠ Bot type cannot be changed after deployment.
            </div>
          </div>

          <form onSubmit={deploy} style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {error && <Alert type="error">{error}</Alert>}
            <div className="field">
              <label className="field-label">Bot name *</label>
              <input
                className="input"
                placeholder={botType === "group" ? "e.g. group-helper" : "e.g. support-bot"}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <label className="field-label">Description (optional)</label>
              <input className="input" placeholder="What does this bot do?" value={desc}
                onChange={(e) => setDesc(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={loading}>
              {loading ? <><Spinner size="sm" /> Deploying…</> : `Deploy ${botType === "group" ? "Group" : "DM"} Bot`}
            </button>
          </form>
        </>
      )}

      {/* ── Step 2: QR ── */}
      {step === "qr" && (
        <>
          <div style={{ fontSize: "2rem" }}>📱</div>
          <h3>Scan to connect</h3>

          {reconnecting && !qrUrl ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem", padding: "1.5rem" }}>
              <Spinner size="lg" />
              <span style={{ fontSize: "0.8125rem", color: "var(--text2)", textAlign: "center" }}>
                Reconnecting to WhatsApp… a fresh QR is on its way
              </span>
            </div>
          ) : qrUrl ? (
            <>
              <p style={{ fontSize: "0.875rem", color: "var(--text2)", textAlign: "center" }}>
                Open WhatsApp → Linked Devices → Link a Device, then scan:
              </p>
              <div className="qr-wrap">
                <img src={qrUrl} alt="WhatsApp QR code" />
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text3)", textAlign: "center" }}>
                Refreshes in{" "}
                <strong style={{ color: countdown <= 5 ? "var(--warning)" : "var(--text2)" }}>
                  {countdown}s
                </strong>
                {" "}· window stays open 10 min
              </div>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem", padding: "1.5rem" }}>
              <Spinner size="lg" />
              <span style={{ fontSize: "0.8125rem", color: "var(--text2)" }}>Generating QR code…</span>
            </div>
          )}

          {error && <Alert type="error">{error}</Alert>}
          <button className="btn btn-secondary w-full" onClick={onClose}>Cancel</button>
        </>
      )}

    </Modal>
  );
}
