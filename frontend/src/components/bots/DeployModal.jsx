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

const QR_LIFE_S    = 60;
const FIRST_POLL_MS = 3_000;
const POLL_MS       = 8_000;
const TIMEOUT_MS    = 10 * 60_000;

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
  const [qrExpired,    setQrExpired]    = useState(false);
  const [method,       setMethod]       = useState("qr");
  const [pairCode,     setPairCode]     = useState(null);
  const [pairExpiresAt, setPairExpiresAt] = useState(null);
  const [phoneInput,   setPhoneInput]   = useState("");
  const [showMethodSelect, setShowMethodSelect] = useState(false);
  const [deployCompleted, setDeployCompleted] = useState(false);

  const esRef          = useRef(null);
  const timeoutRef     = useRef(null);
  const pollRef        = useRef(null);
  const firstPollRef   = useRef(null);
  const cdRef          = useRef(null);
  const connectedRef   = useRef(false);
  const botIdRef       = useRef(null);

  /* ── cleanup on unmount ──────────────────────────────────────── */
  useEffect(() => () => {
    esRef.current?.close();
    clearTimeout(timeoutRef.current);
    clearTimeout(firstPollRef.current);
    clearInterval(pollRef.current);
    clearInterval(cdRef.current);
  }, []);

  /* ── countdown ───────────────────────────────────────────────── */
  const startCountdown = useCallback(() => {
    clearInterval(cdRef.current);
    setCountdown(QR_LIFE_S);
    setQrExpired(false);
    cdRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          setQrExpired(true);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }, []);

  const markQr = useCallback((url) => {
    setQrUrl(url);
    setQrExpired(false);
    startCountdown();
  }, [startCountdown]);

  const markConnected = useCallback((es) => {
    if (connectedRef.current) return;
    connectedRef.current = true;
    setDeployCompleted(true);
    clearTimeout(timeoutRef.current);
    clearTimeout(firstPollRef.current);
    clearInterval(pollRef.current);
    clearInterval(cdRef.current);
    try { es?.close(); } catch (e) {}
    // Close modal immediately after successful connection
    setTimeout(() => {
      try { onDeployed(); } catch (e) {}
      try { onClose(); } catch (e) {}
    }, 1000);
  }, [onDeployed, onClose]);

  const doPoll = useCallback(async () => {
    if (connectedRef.current) return;
    try {
      const data = await botsApi.qr(botIdRef.current);
      if (data?.qrCodeDataUrl) markQr(data.qrCodeDataUrl);
    } catch {
      // ignore
    }
  }, [markQr]);

  const startPolling = useCallback((botId) => {
    botIdRef.current = botId;
    clearTimeout(firstPollRef.current);
    clearInterval(pollRef.current);
    firstPollRef.current = setTimeout(doPoll, FIRST_POLL_MS);
    pollRef.current = setInterval(doPoll, POLL_MS);
  }, [doPoll]);

  const connectSse = useCallback((botId, onConn) => {
    const token = localStorage.getItem("wabot_token") ?? "";
    const es    = new EventSource(botsApi.eventsUrl(botId, token));
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "qr")     markQr(msg.qrUrl);
        if (msg.type === "pair_code") {
          if (typeof msg.code === "string") setPairCode(msg.code);
          else if (msg.code && typeof msg.code === "object") {
            setPairCode(msg.code.code ?? null);
            setPairExpiresAt(msg.code.expiresAt ?? null);
          }
        }
        if (msg.type === "status") {
          if (msg.status === "connected") onConn(es);
        }
      } catch {}
    };
    es.onerror = () => {};

    timeoutRef.current = setTimeout(() => {
      if (!connectedRef.current) {
        es.close();
        clearTimeout(firstPollRef.current);
        clearInterval(pollRef.current);
        clearInterval(cdRef.current);
        setError("Connection timed out (10 min). Please try deploying again.");
        setStep("form");
        setShowMethodSelect(false);
      }
    }, TIMEOUT_MS);
  }, [markQr]);

  const handleFormSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Bot name is required.");
    setError("");
    setShowMethodSelect(true);
  };

  const deployWithMethod = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await botsApi.deploy({ 
        botName: name.trim(), 
        description: desc.trim(), 
        botType, 
        method,
        phone: method === "code" ? phoneInput.replace(/[^0-9]/g, '') : undefined
      });
      const botId = data.bot.id;
      
      if (data.pairing?.code) {
        setPairCode(data.pairing.code);
        if (data.pairing.expiresAt) setPairExpiresAt(data.pairing.expiresAt);
      }
      
      connectedRef.current = false;
      setQrUrl(null);
      setQrExpired(false);
      setDeployCompleted(false);
      // Move to connection screen (will show QR or pairing code)
      setStep("connecting");
      
      connectSse(botId, markConnected);
      startPolling(botId);
      
      if (method === "code" && !pairCode && phoneInput) {
        try {
          const resp = await botsApi.createPairingCode(botId, phoneInput.replace(/[^0-9]/g, ''));
          setPairCode(resp.code);
          setPairExpiresAt(resp.expiresAt);
        } catch (e) {
          // ignore
        }
      }
    } catch (err) {
      setError(err.message);
      setShowMethodSelect(true);
    } finally {
      setLoading(false);
    }
  };

  const refreshPairingCode = async () => {
    if (!botIdRef.current) return;
    try {
      const resp = await botsApi.createPairingCode(botIdRef.current, phoneInput.replace(/[^0-9]/g, ''));
      setPairCode(resp.code);
      setPairExpiresAt(resp.expiresAt);
    } catch (e) {
      setError(e.message || "Could not refresh pairing code.");
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

      {/* ── Step 0: Warning ──────────────────────────────────── */}
      {step === "warning" && (
        <>
          <div style={{ fontSize: "2rem" }}>⚠️</div>
          <h3 style={{ color: "var(--warning)" }}>Before you deploy</h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text2)", marginBottom: "0.25rem" }}>
            Please read and acknowledge the following before deploying a WhatsApp bot.
          </p>

          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            {WARNINGS.map((w) => (
              <div key={w.title} style={{
                background: "var(--warning-bg)",
                border: "1px solid rgba(245,158,11,0.2)",
                borderRadius: "var(--radius)",
                padding: "0.75rem 1rem",
                display: "flex",
                gap: "0.75rem",
                alignItems: "flex-start"
              }}>
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
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" type="button" disabled={!accepted} onClick={() => setStep("form")} style={{ flex: 1 }}>
              I understand — Continue
            </button>
          </div>
        </>
      )}

      {/* ── Step 1: Form (Bot details) ───────────────────────── */}
      {step === "form" && !showMethodSelect && (
        <>
          <div style={{ fontSize: "2rem" }}>🚀</div>
          <h3>Deploy a new bot</h3>

          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "0.25rem" }}>
            <div style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text2)" }}>Bot type</div>
            <div className="deploy-type-grid">
              {BOT_TYPES.map((t) => (
                <button key={t.id} type="button" onClick={() => setBotType(t.id)} style={{
                  padding: "0.875rem",
                  borderRadius: "var(--radius)",
                  border: `1.5px solid ${botType === t.id ? "var(--accent)" : "var(--border)"}`,
                  background: botType === t.id ? "var(--accent-dim)" : "var(--card)",
                  cursor: "pointer",
                  textAlign: "left",
                }}>
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

          <form onSubmit={handleFormSubmit} style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {error && <Alert type="error">{error}</Alert>}
            <div className="field">
              <label className="field-label">Bot name *</label>
              <input className="input" placeholder={botType === "group" ? "e.g. group-helper" : "e.g. support-bot"} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label className="field-label">Description (optional)</label>
              <input className="input" placeholder="What does this bot do?" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary w-full">Continue to connection method →</button>
          </form>
        </>
      )}

      {/* ── Step 1.5: Method Selection ───────────────────────── */}
      {step === "form" && showMethodSelect && (
        <>
          <div style={{ fontSize: "2rem" }}>🔌</div>
          <h3>Choose connection method</h3>
          
          <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
            <button className={method === "qr" ? "btn btn-primary" : "btn btn-secondary"} onClick={() => setMethod("qr")} style={{ flex: 1 }}>📱 QR Code</button>
            <button className={method === "code" ? "btn btn-primary" : "btn btn-secondary"} onClick={() => setMethod("code")} style={{ flex: 1 }}>🔢 Pairing Code (mobile recommended)</button>
          </div>

          {method === "code" && (
            <div style={{ marginBottom: "1rem" }}>
              <label className="field-label">Phone number (international format)</label>
              <input className="input" placeholder="e.g. 628123456789" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} />
              <div style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: "0.25rem" }}>
                No + sign, no spaces, no parentheses. Just numbers with country code.
              </div>
            </div>
          )}

          {error && <Alert type="error">{error}</Alert>}

          <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowMethodSelect(false)}>← Back</button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={deployWithMethod} disabled={loading || (method === "code" && !phoneInput)}>
              {loading ? <><Spinner size="sm" /> Deploying…</> : `Deploy & Connect`}
            </button>
          </div>
        </>
      )}

      {/* ── Step 2: Connection Screen (QR or Pairing Code) ────── */}
      {step === "connecting" && (
        <>
          <div style={{ fontSize: "2rem" }}>{method === "qr" ? "📱" : "🔢"}</div>
          <h3>{method === "qr" ? "Scan QR Code" : "Enter Pairing Code on Your Phone"}</h3>

          {method === "pairing" || method === "code" ? (
            // SHOW PAIRING CODE PROMINENTLY
            <div style={{ textAlign: "center", width: "100%" }}>
              <div style={{ 
                fontSize: "3rem", 
                fontWeight: "bold", 
                letterSpacing: "0.75rem",
                background: "linear-gradient(135deg, var(--accent) 0%, #c084fc 100%)",
                padding: "1.5rem",
                borderRadius: "var(--radius-xl)",
                fontFamily: "monospace",
                color: "white",
                textShadow: "0 2px 4px rgba(0,0,0,0.2)",
                marginBottom: "1rem"
              }}>
                {pairCode || "──────"}
              </div>
              
              <div style={{ 
                background: "var(--accent-dim)", 
                padding: "1rem", 
                borderRadius: "var(--radius)",
                marginBottom: "1rem",
                textAlign: "left"
              }}>
                <p style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>📋 Instructions:</p>
                <ol style={{ marginLeft: "1.25rem", color: "var(--text2)", lineHeight: "1.8" }}>
                  <li>Open WhatsApp on your <strong>phone</strong></li>
                  <li>Go to <strong>Settings</strong> (iOS) or <strong>three-dot menu</strong> (Android)</li>
                  <li>Tap <strong>Linked Devices</strong></li>
                  <li>Tap <strong>Link with phone number</strong></li>
                  <li>Enter this code: <strong style={{ color: "var(--accent)", fontSize: "1.1rem" }}>{pairCode || "waiting..."}</strong></li>
                </ol>
              </div>

              {pairExpiresAt && (
                <p style={{ fontSize: "0.875rem", color: "var(--text3)" }}>
                  ⏱ Code expires: {new Date(pairExpiresAt).toLocaleTimeString()}
                </p>
              )}
              
              <button className="btn btn-secondary" onClick={refreshPairingCode} style={{ marginTop: "0.5rem" }}>
                ⟳ Refresh Code
              </button>
              <p style={{ fontSize: "0.75rem", color: "var(--text3)", marginTop: "0.75rem" }}>
                The modal will close automatically once connected
              </p>
            </div>
          ) : (
            // SHOW QR CODE
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.625rem", width: "100%" }}>
              {qrUrl ? (
                <>
                  <p style={{ fontSize: "0.8125rem", color: "var(--text2)", textAlign: "center" }}>
                    Open WhatsApp → <strong>Linked Devices</strong> → <strong>Link a Device</strong>, then scan:
                  </p>
                  <div className="qr-wrap" style={{ position: "relative" }}>
                    <img src={qrUrl} alt="WhatsApp QR code" style={{ opacity: qrExpired ? 0.35 : 1 }} />
                    {qrExpired && (
                      <div style={{
                        position: "absolute", inset: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: "rgba(0,0,0,0.6)", borderRadius: "var(--radius)"
                      }}>
                        <Spinner size="md" />
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text3)" }}>
                    Refreshes in {countdown}s · window stays open 10 min
                  </div>
                </>
              ) : (
                <div style={{ padding: "2rem", textAlign: "center" }}>
                  <Spinner size="lg" />
                  <p style={{ marginTop: "1rem", color: "var(--text2)" }}>Generating {method === "qr" ? "QR code" : "pairing code"}…</p>
                </div>
              )}
            </div>
          )}

          {error && <Alert type="error">{error}</Alert>}
          
          {!deployCompleted && (
            <button className="btn btn-secondary w-full" onClick={onClose}>Cancel</button>
          )}
        </>
      )}

    </Modal>
  );
}