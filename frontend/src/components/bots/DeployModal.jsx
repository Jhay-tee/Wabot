import { useEffect, useRef, useState } from "react";
import { Modal }   from "../ui/Modal.jsx";
import { Alert }   from "../ui/Alert.jsx";
import { Spinner } from "../ui/Spinner.jsx";
import { botsApi } from "../../api/bots.js";

const BOT_TYPES = [
  {
    id:    "dm",
    icon:  "💬",
    label: "DM Bot",
    desc:  "Responds to direct (1-on-1) WhatsApp messages only. Perfect for customer support, sales automation, and personal bots."
  },
  {
    id:    "group",
    icon:  "👥",
    label: "Group Bot",
    desc:  "Responds inside WhatsApp group chats. Ideal for community management, announcements, and group commands."
  }
];

export function DeployModal({ user, onClose, onDeployed }) {
  const [step, setStep]       = useState("form");
  const [name, setName]       = useState("");
  const [desc, setDesc]       = useState("");
  const [botType, setBotType] = useState("dm");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [qrUrl, setQrUrl]     = useState(null);
  const esRef                 = useRef(null);
  const timeoutRef            = useRef(null);
  /* Ref to track connection success — avoids stale closure in timeout callback */
  const connectedRef          = useRef(false);

  useEffect(() => () => {
    esRef.current?.close();
    clearTimeout(timeoutRef.current);
  }, []);

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

  const deploy = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError("Bot name is required.");
    setError(""); setLoading(true);
    try {
      const data = await botsApi.deploy({ botName: name.trim(), description: desc.trim(), botType });
      connectedRef.current = false;
      setStep("qr");
      connectSse(data.bot.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const connectSse = (botId) => {
    const token = localStorage.getItem("wabot_token") ?? "";
    const url   = botsApi.eventsUrl(botId, token);
    const es    = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "qr") setQrUrl(msg.qrUrl);
        if (msg.type === "status" && msg.status === "connected") {
          connectedRef.current = true;
          clearTimeout(timeoutRef.current);
          setStep("done");
          es.close();
          onDeployed();
        }
      } catch {}
    };
    es.onerror = () => {};

    timeoutRef.current = setTimeout(() => {
      /* Use ref — not `step` state — to avoid stale closure */
      if (!connectedRef.current) {
        es.close();
        setError("QR code timed out. Please try deploying again.");
        setStep("form");
      }
    }, 3 * 60_000);
  };

  return (
    <Modal onClose={onClose}>
      {step === "form" && (
        <>
          <div style={{ fontSize: "2rem" }}>🚀</div>
          <h3>Deploy a new bot</h3>

          {/* Bot type selection */}
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "0.25rem" }}>
            <div style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text2)" }}>Bot type</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.625rem" }}>
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
              ⚠ You cannot switch a bot's type after deployment. Deploy separate bots for DMs and groups.
            </div>
          </div>

          <form onSubmit={deploy} style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {error && <Alert type="error">{error}</Alert>}
            <div className="field">
              <label className="field-label">Bot name *</label>
              <input className="input" placeholder={botType === "group" ? "e.g. group-helper" : "e.g. support-bot"}
                value={name} onChange={(e) => setName(e.target.value)} autoFocus />
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

      {step === "qr" && (
        <>
          <div style={{ fontSize: "2rem" }}>📱</div>
          <h3>Scan to connect</h3>
          <p style={{ fontSize: "0.875rem", color: "var(--text2)", textAlign: "center" }}>
            Open WhatsApp → Linked Devices → Link a Device, then scan:
          </p>
          {qrUrl ? (
            <div className="qr-wrap"><img src={qrUrl} alt="WhatsApp QR code" /></div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem", padding: "2rem" }}>
              <Spinner size="lg" />
              <span style={{ fontSize: "0.8125rem", color: "var(--text2)" }}>Generating QR code…</span>
            </div>
          )}
          <p style={{ fontSize: "0.75rem", color: "var(--text3)", textAlign: "center" }}>
            QR codes refresh every ~20 s. Window closes automatically once connected.
          </p>
          <button className="btn btn-secondary w-full" onClick={onClose}>Cancel</button>
        </>
      )}
    </Modal>
  );
}
