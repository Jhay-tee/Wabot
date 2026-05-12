import { useMemo, useState } from "react";
import { Modal }   from "../ui/Modal.jsx";
import { Alert }   from "../ui/Alert.jsx";
import { Spinner } from "../ui/Spinner.jsx";
import { botsApi } from "../../api/bots.js";

const PRESETS = [
  { id: "custom", label: "Custom" },
  { id: "otp", label: "OTP" },
  { id: "form", label: "Form" },
  { id: "welcome", label: "Welcome" },
];

function emptyField() {
  return { key: "", value: "" };
}

export function SendDMModal({ bot, onClose }) {
  const [preset, setPreset] = useState("custom");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpAppName, setOtpAppName] = useState("");
  const [otpExpiry, setOtpExpiry] = useState("10");
  const [welcomeName, setWelcomeName] = useState("");
  const [formName, setFormName] = useState("");
  const [formHeading, setFormHeading] = useState("");
  const [formFields, setFormFields] = useState([emptyField(), emptyField()]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const preview = useMemo(() => {
    if (preset === "otp") {
      if (!otpCode.trim()) return "";
      const intro = `Your ${otpAppName.trim() || "verification"} code is ready.`;
      const expiry = otpExpiry.trim() ? `\nExpires in ${otpExpiry.trim()} minute(s).` : "";
      return `${intro}\nOTP: ${otpCode.trim()}${expiry}`;
    }

    if (preset === "welcome") {
      return message.trim() || (welcomeName.trim()
        ? `Welcome ${welcomeName.trim()}! We received your message and will reply shortly.`
        : "Welcome! We received your message and will reply shortly.");
    }

    if (preset === "form") {
      const entries = formFields
        .filter((field) => field.key.trim() && field.value.trim())
        .map((field) => `- ${field.key.trim()}: ${field.value.trim()}`);
      return [formHeading.trim() || `New submission: ${formName.trim() || "Form"}`, ...entries].join("\n");
    }

    return message.trim();
  }, [preset, otpCode, otpAppName, otpExpiry, welcomeName, formFields, formHeading, formName, message]);

  const canSend = (() => {
    if (sending || bot.status !== "connected" || to.trim().length < 7) return false;
    if (preset === "otp") return /^\d{4,10}$/.test(otpCode.trim());
    if (preset === "form") return formFields.some((field) => field.key.trim() && field.value.trim());
    return preview.trim().length > 0;
  })();

  const setField = (index, key, value) => {
    setFormFields((current) => current.map((field, idx) => idx === index ? { ...field, [key]: value } : field));
  };

  const addField = () => setFormFields((current) => [...current, emptyField()]);
  const removeField = (index) => setFormFields((current) => current.length === 1 ? current : current.filter((_, idx) => idx !== index));

  const buildPayload = () => {
    const normalizedTo = to.replace(/\D/g, "");

    if (preset === "otp") {
      return {
        to: normalizedTo,
        preset,
        code: otpCode.trim(),
        app_name: otpAppName.trim(),
        expires_in_minutes: otpExpiry.trim() ? Number(otpExpiry.trim()) : undefined,
      };
    }

    if (preset === "welcome") {
      return {
        to: normalizedTo,
        preset,
        name: welcomeName.trim(),
        message: message.trim(),
      };
    }

    if (preset === "form") {
      const fields = {};
      for (const field of formFields) {
        const key = field.key.trim();
        const value = field.value.trim();
        if (key && value) fields[key] = value;
      }
      return {
        to: normalizedTo,
        preset,
        form_name: formName.trim(),
        heading: formHeading.trim(),
        fields,
      };
    }

    return {
      to: normalizedTo,
      preset,
      message: message.trim(),
    };
  };

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      await botsApi.sendDM(bot.id, buildPayload());
      setResult({ ok: true, text: `Message sent to ${to.trim()}` });
      if (preset === "custom" || preset === "welcome") setMessage("");
      if (preset === "otp") setOtpCode("");
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal onClose={onClose} wide>
      <div style={{ width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1.25rem" }}>
          <div style={{ fontSize: "1.5rem" }}>💬</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: "1rem" }}>Send WhatsApp Message</div>
            <div style={{ fontSize: "0.8rem", color: "var(--text3)" }}>via {bot.bot_name}</div>
          </div>
        </div>

        {bot.status !== "connected" && (
          <div className="alert alert-warning" style={{ marginBottom: "1rem" }}>
            <span>⚠️</span>
            <span>This bot is not connected. Please deploy and scan the QR code first.</span>
          </div>
        )}

        {result && (
          <Alert type={result.ok ? "success" : "error"} style={{ marginBottom: "1rem" }}>
            {result.text}
          </Alert>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <div className="field">
            <label className="field-label">Phone number (with country code)</label>
            <input
              className="input"
              type="tel"
              placeholder="e.g. 2348012345678"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <span className="field-hint">No spaces or dashes. Start with country code.</span>
          </div>

          <div className="field">
            <label className="field-label">Preset</label>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {PRESETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`btn btn-sm ${preset === item.id ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setPreset(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {preset === "custom" && (
            <div className="field">
              <label className="field-label">Message</label>
              <textarea
                className="input"
                rows={5}
                placeholder="Type your message here…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={4096}
              />
              <span className="field-hint">{message.length}/4096 characters</span>
            </div>
          )}

          {preset === "otp" && (
            <>
              <div className="field">
                <label className="field-label">OTP code</label>
                <input className="input" value={otpCode} onChange={(e) => setOtpCode(e.target.value)} placeholder="123456" />
              </div>
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">App name</label>
                  <input className="input" value={otpAppName} onChange={(e) => setOtpAppName(e.target.value)} placeholder="WaBot" />
                </div>
                <div className="field" style={{ width: 160 }}>
                  <label className="field-label">Expires in</label>
                  <input className="input" value={otpExpiry} onChange={(e) => setOtpExpiry(e.target.value)} placeholder="10" />
                </div>
              </div>
            </>
          )}

          {preset === "welcome" && (
            <>
              <div className="field">
                <label className="field-label">Recipient name</label>
                <input className="input" value={welcomeName} onChange={(e) => setWelcomeName(e.target.value)} placeholder="Ada" />
              </div>
              <div className="field">
                <label className="field-label">Custom welcome message</label>
                <textarea
                  className="input"
                  rows={4}
                  placeholder="Optional. Leave blank to use the default welcome text."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  maxLength={4096}
                />
              </div>
            </>
          )}

          {preset === "form" && (
            <>
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">Form name</label>
                  <input className="input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Lead Capture" />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">Heading</label>
                  <input className="input" value={formHeading} onChange={(e) => setFormHeading(e.target.value)} placeholder="New submission: Lead Capture" />
                </div>
              </div>

              <div className="field">
                <label className="field-label">Fields</label>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {formFields.map((field, index) => (
                    <div key={index} style={{ display: "flex", gap: "0.5rem" }}>
                      <input className="input" style={{ flex: 1 }} value={field.key} onChange={(e) => setField(index, "key", e.target.value)} placeholder="email" />
                      <input className="input" style={{ flex: 2 }} value={field.value} onChange={(e) => setField(index, "value", e.target.value)} placeholder="ada@example.com" />
                      <button type="button" className="btn btn-danger btn-icon" onClick={() => removeField(index)}>✕</button>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: "0.5rem" }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addField}>+ Add field</button>
                </div>
              </div>
            </>
          )}

          <div className="field">
            <label className="field-label">Preview</label>
            <div className="card" style={{ background: "var(--bg)", border: "1px solid var(--border)", whiteSpace: "pre-wrap", minHeight: 100 }}>
              {preview || "Nothing to preview yet."}
            </div>
          </div>

          <button
            className="btn btn-primary w-full"
            onClick={send}
            disabled={!canSend}
          >
            {sending ? <><Spinner size="sm" /> Sending…</> : `Send ${PRESETS.find((item) => item.id === preset)?.label}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
