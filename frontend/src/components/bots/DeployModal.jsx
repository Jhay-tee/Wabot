import { useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Link2,
  Phone,
  QrCode,
  Rocket,
  ShieldAlert,
  Smartphone,
  Users,
} from "lucide-react";
import { Modal }   from "../ui/Modal.jsx";
import { Alert }   from "../ui/Alert.jsx";
import { Spinner } from "../ui/Spinner.jsx";
import { botsApi } from "../../api/bots.js";
import { PHONE_COUNTRIES, getCountryByCode, normalizePhoneNumber } from "../../utils/phone.js";

const BOT_TYPES = [
  {
    id:    "dm",
    icon:  Bot,
    label: "DM Bot",
    desc:  "Responds to direct (1-on-1) WhatsApp messages."
  },
  {
    id:    "group",
    icon:  Users,
    label: "Group Bot",
    desc:  "Responds inside WhatsApp group chats."
  }
];

const WARNINGS = [
  {
    icon: AlertTriangle,
    title: "Unofficial automation",
    desc: "WaBot uses Baileys which is not officially supported by WhatsApp."
  },
  {
    icon: ShieldAlert,
    title: "Risk of account ban",
    desc: "Use a dedicated number — never your personal or primary business number."
  },
  {
    icon: CheckCircle2,
    title: "You are responsible",
    desc: "You are solely responsible for how this bot is used."
  }
];

export function DeployModal({ user, onClose, onDeployed }) {
  const [step, setStep] = useState("warning");
  const [accepted, setAccepted] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [botType, setBotType] = useState("dm");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [method, setMethod] = useState("qr");
  const [pairCountry, setPairCountry] = useState("NG");
  const [phoneInput, setPhoneInput] = useState("");
  const [showMethodSelect, setShowMethodSelect] = useState(false);
  const selectedPairCountry = getCountryByCode(pairCountry);
  const normalizedPairPhone = normalizePhoneNumber(pairCountry, phoneInput);

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
      });
      await onDeployed?.({
        bot: data.bot,
        preferredAuthMethod: method,
        preferredPairPhone: method === "code" ? normalizedPairPhone : null,
      });
    } catch (err) {
      setError(err.message || "Could not deploy this bot right now. Please try again.");
      setShowMethodSelect(true);
    } finally {
      setLoading(false);
    }
  };

  if (!user?.emailVerified && !user?.email_verified) {
    return (
      <Modal onClose={onClose}>
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-dim)] text-[var(--accent)]">
            <Link2 size={28} />
          </div>
          <h3 className="text-xl font-semibold">Verify your email first</h3>
          <p className="text-sm text-[var(--text2)]">Check your inbox for the verification link before deploying a bot.</p>
          <button className="inline-flex w-full items-center justify-center rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white" onClick={onClose}>Got it</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ width: "100%" }}>

        {/* Step 0: Warning */}
        {step === "warning" && (
          <div className="space-y-5">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-300">
                <AlertTriangle size={28} />
              </div>
              <h3 className="text-xl font-semibold text-amber-200">Before you deploy</h3>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem", maxHeight: "280px", overflowY: "auto", marginBottom: "1rem" }}>
              {WARNINGS.map((w) => (
                (() => {
                  const Icon = w.icon;
                  return (
                <div key={w.title} style={{
                  background: "var(--warning-bg)",
                  border: "1px solid rgba(245,158,11,0.2)",
                  borderRadius: "var(--radius)",
                  padding: "0.75rem",
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "flex-start"
                }}>
                  <span style={{ flexShrink: 0, color: "var(--warning)" }}><Icon size={18} /></span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.8rem", color: "var(--text)", marginBottom: "0.2rem" }}>{w.title}</div>
                    <div style={{ fontSize: "0.73rem", color: "var(--text2)", lineHeight: 1.45 }}>{w.desc}</div>
                  </div>
                </div>
                  );
                })()
              ))}
            </div>

            <label style={{
              width: "100%",
              display: "flex",
              alignItems: "flex-start",
              gap: "0.75rem",
              padding: "0.75rem",
              background: "var(--bg2)",
              border: `1.5px solid ${accepted ? "var(--accent)" : "var(--border)"}`,
              borderRadius: "var(--radius)",
              cursor: "pointer",
              marginBottom: "1rem"
            }}>
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} style={{ marginTop: "2px", flexShrink: 0 }} />
              <span style={{ fontSize: "0.73rem", color: "var(--text2)", lineHeight: 1.4 }}>
                I understand the risks and accept responsibility.
              </span>
            </label>

            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!accepted} onClick={() => setStep("form")} style={{ flex: 1 }}>Continue</button>
            </div>
          </div>
        )}

        {/* Step 1: Bot Details Form */}
        {step === "form" && !showMethodSelect && (
          <div>
            <div className="mb-4 flex flex-col items-center gap-3 text-center">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-dim)] text-[var(--accent)]">
                <Rocket size={28} />
              </div>
              <h3 className="text-xl font-semibold">Deploy a new bot</h3>
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--text2)", marginBottom: "0.5rem" }}>Bot type</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {BOT_TYPES.map((t) => {
                  const Icon = t.icon;
                  return (
                  <button key={t.id} type="button" onClick={() => setBotType(t.id)} style={{
                    padding: "0.875rem",
                    borderRadius: "var(--radius)",
                    border: `1.5px solid ${botType === t.id ? "var(--accent)" : "var(--border)"}`,
                    background: botType === t.id ? "var(--accent-dim)" : "var(--card)",
                    cursor: "pointer",
                    textAlign: "center",
                    width: "100%"
                  }}>
                    <div style={{ display: "flex", justifyContent: "center", marginBottom: "0.25rem", color: botType === t.id ? "var(--accent)" : "var(--text2)" }}><Icon size={22} /></div>
                    <div style={{ fontWeight: 700, fontSize: "0.875rem", color: botType === t.id ? "var(--accent)" : "var(--text)" }}>{t.label}</div>
                    <div style={{ fontSize: "0.7rem", color: "var(--text3)", lineHeight: 1.4 }}>{t.desc}</div>
                  </button>
                  );
                })}
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--text3)", background: "var(--bg)", padding: "0.5rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", marginTop: "0.5rem", textAlign: "center" }}>
                Bot type cannot be changed after deployment.
              </div>
            </div>

            <form onSubmit={handleFormSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {error && <Alert type="error">{error}</Alert>}
              <div className="field">
                <label className="field-label">Bot name *</label>
                <input className="input" placeholder={botType === "group" ? "e.g. group-helper" : "e.g. support-bot"} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </div>
              <div className="field">
                <label className="field-label">Description (optional)</label>
                <input className="input" placeholder="What does this bot do?" value={desc} onChange={(e) => setDesc(e.target.value)} />
              </div>
              <button type="submit" className="btn btn-primary w-full">Continue</button>
            </form>
          </div>
        )}

        {/* Step 1.5: Method Selection */}
        {step === "form" && showMethodSelect && (
          <div>
            <div className="mb-4 flex flex-col items-center gap-3 text-center">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--accent-dim)] text-[var(--accent)]">
                <Smartphone size={28} />
              </div>
              <h3 className="text-xl font-semibold">Choose connection method</h3>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1rem" }}>
              <button className={method === "qr" ? "btn btn-primary" : "btn btn-secondary"} onClick={() => setMethod("qr")} style={{ width: "100%", padding: "0.875rem" }}><QrCode size={16} /> QR Code</button>
              <button className={method === "code" ? "btn btn-primary" : "btn btn-secondary"} onClick={() => setMethod("code")} style={{ width: "100%", padding: "0.875rem" }}><Phone size={16} /> Pairing Code</button>
            </div>

            {method === "code" && (
              <div style={{ marginBottom: "1rem" }}>
                <label className="field-label">Phone number</label>
                <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "0.75rem" }}>
                  <select className="input" value={pairCountry} onChange={(e) => setPairCountry(e.target.value)}>
                    {PHONE_COUNTRIES.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.name} (+{item.dialCode})
                      </option>
                    ))}
                  </select>
                  <input className="input" placeholder={selectedPairCountry.example} value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} />
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--text3)", marginTop: "0.25rem" }}>
                  We convert this to WhatsApp format automatically: {normalizedPairPhone ? `+${normalizedPairPhone}` : "enter the local number"}.
                </div>
              </div>
            )}

            {error && <Alert type="error">{error}</Alert>}

            <div style={{ display: "flex", gap: "0.75rem", flexDirection: "column", marginTop: "0.5rem" }}>
              <button className="btn btn-secondary" onClick={() => setShowMethodSelect(false)}>Back</button>
              <button className="btn btn-primary" onClick={deployWithMethod} disabled={loading || (method === "code" && !normalizedPairPhone)} style={{ width: "100%" }}>
                {loading ? <><Spinner size="sm" /> Deploying…</> : "Deploy bot"}
              </button>
            </div>
            <p style={{ marginTop: "0.75rem", textAlign: "center", fontSize: "0.72rem", color: "var(--text3)" }}>
              After deployment, this modal closes so the new bot card and connection controls are visible immediately.
            </p>
          </div>
        )}

      </div>
    </Modal>
  );
}
