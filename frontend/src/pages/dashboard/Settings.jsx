import { useState }  from "react";
import { Alert }     from "../../components/ui/Alert.jsx";
import { Spinner }   from "../../components/ui/Spinner.jsx";
import { PlanBadge } from "../../components/ui/Badge.jsx";
import { authApi }   from "../../api/auth.js";
import { fmtDate }   from "../../utils/format.js";

export function Settings({ user, onUserUpdated }) {
  const [name, setName]   = useState(user?.full_name ?? user?.fullName ?? "");
  const [saving, setSaving] = useState(false);
  const [nameMsg, setNameMsg] = useState({ text: "", ok: false });

  const [pwd, setPwd]         = useState({ current: "", next: "", confirm: "" });
  const [savingPwd, setSavingPwd] = useState(false);
  const [pwdMsg,  setPwdMsg]  = useState({ text: "", ok: false });

  const set = (k) => (e) => setPwd((p) => ({ ...p, [k]: e.target.value }));

  const saveName = async () => {
    if (!name.trim()) return;
    setSaving(true); setNameMsg({ text: "", ok: false });
    try {
      const updated = await authApi.patchMe({ fullName: name.trim() });
      setNameMsg({ text: "Name updated.", ok: true });
      onUserUpdated(updated);
    } catch (err) {
      setNameMsg({ text: err.message, ok: false });
    } finally { setSaving(false); }
  };

  const savePwd = async () => {
    if (pwd.next !== pwd.confirm)
      return setPwdMsg({ text: "New passwords don't match.", ok: false });
    if (pwd.next.length < 8)
      return setPwdMsg({ text: "Password must be at least 8 characters.", ok: false });
    setSavingPwd(true); setPwdMsg({ text: "", ok: false });
    try {
      await authApi.password({ currentPassword: pwd.current, newPassword: pwd.next });
      setPwdMsg({ text: "Password changed successfully.", ok: true });
      setPwd({ current: "", next: "", confirm: "" });
    } catch (err) {
      setPwdMsg({ text: err.message, ok: false });
    } finally { setSavingPwd(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "520px" }}>
      <div className="section-heading"><span>Account Settings</span></div>

      {/* Profile card */}
      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: "1rem", fontSize: "0.875rem" }}>Profile</div>
        {nameMsg.text && (
          <Alert type={nameMsg.ok ? "success" : "error"} style={{ marginBottom: "0.875rem" }}>
            {nameMsg.text}
          </Alert>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <div className="field">
            <label className="field-label">Full name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">Email</label>
            <input className="input" value={user?.email ?? ""} disabled style={{ opacity: 0.6 }} />
            <span className="field-hint">Email cannot be changed.</span>
          </div>
          <div className="field">
            <label className="field-label">Plan</label>
            <div style={{ paddingTop: "0.25rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <PlanBadge plan={user?.plan_tier ?? user?.planTier} />
              {!(user?.email_verified ?? user?.emailVerified) && (
                <span style={{ fontSize: "0.75rem", color: "var(--warning)" }}>⚠ Email not verified</span>
              )}
            </div>
          </div>
          <button className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }}
            onClick={saveName} disabled={saving || !name.trim()}>
            {saving ? <><Spinner size="sm" /> Saving…</> : "Save name"}
          </button>
        </div>
      </div>

      {/* Change password card */}
      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: "1rem", fontSize: "0.875rem" }}>Change password</div>
        {pwdMsg.text && (
          <Alert type={pwdMsg.ok ? "success" : "error"} style={{ marginBottom: "0.875rem" }}>
            {pwdMsg.text}
          </Alert>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          {[
            { label: "Current password", key: "current" },
            { label: "New password",     key: "next"    },
            { label: "Confirm new password", key: "confirm" }
          ].map(({ label, key }) => (
            <div className="field" key={key}>
              <label className="field-label">{label}</label>
              <input type="password" className="input" value={pwd[key]} onChange={set(key)} />
            </div>
          ))}
          <button className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }}
            onClick={savePwd} disabled={savingPwd}>
            {savingPwd ? <><Spinner size="sm" /> Updating…</> : "Update password"}
          </button>
        </div>
      </div>

      {/* Member since */}
      <div className="card" style={{ opacity: 0.75 }}>
        <div style={{ fontWeight: 700, marginBottom: "0.375rem", fontSize: "0.875rem" }}>Member since</div>
        <div className="text-sm text-muted">{fmtDate(user?.created_at ?? user?.createdAt)}</div>
      </div>
    </div>
  );
}
