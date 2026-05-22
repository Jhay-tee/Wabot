import { useEffect, useState } from "react";
import { Alert }      from "../../components/ui/Alert.jsx";
import { Spinner }    from "../../components/ui/Spinner.jsx";
import { EmptyState } from "../../components/ui/EmptyState.jsx";
import { authApi }    from "../../api/auth.js";
import { timeAgo }    from "../../utils/format.js";

export function ApiKeys({ user }) {
  const [keys,      setKeys]      = useState([]);
  const [meta,      setMeta]      = useState({ maxKeys: 1, rateLimits: { callsPerMinute: 30, messagesPerMonth: 1000 } });
  const [loading,   setLoading]   = useState(true);
  const [newKeyVal, setNewKeyVal] = useState(null);   /* raw key shown once */
  const [newKeyLabel, setNewKeyLabel] = useState(""); /* name of newly created/rotated key */
  const [name,      setName]      = useState("");
  const [creating,  setCreating]  = useState(false);
  const [rotating,  setRotating]  = useState(null);  /* keyId being rotated */
  const [deleting,  setDeleting]  = useState(null);
  const [error,     setError]     = useState("");
  const [copied,    setCopied]    = useState(false);

  const isPro   = user?.plan_tier === "paid";
  const maxKeys = meta.maxKeys;
  const atLimit = keys.length >= maxKeys;

  useEffect(() => {
    setLoading(true);
    authApi.listApiKeys()
      .then((d) => {
        setKeys(d.keys ?? []);
        setMeta({
          maxKeys:    d.maxKeys ?? (isPro ? 10 : 1),
          rateLimits: d.rateLimits ?? { callsPerMinute: isPro ? 300 : 30, messagesPerMonth: isPro ? 100000 : 1000 }
        });
      })
      .catch(() => setKeys([]))
      .finally(() => setLoading(false));
  }, [isPro]);

  /* ── Create ── */
  const create = async () => {
    if (!name.trim()) return setError("Key name is required.");
    if (atLimit)      return setError(`${isPro ? "Pro" : "Free"} plan limit: ${maxKeys} key${maxKeys === 1 ? "" : "s"}.`);
    setError(""); setCreating(true);
    try {
      const d = await authApi.createApiKey({ name: name.trim() });
      setNewKeyVal(d.key);
      setNewKeyLabel(d.entry.name);
      setKeys((prev) => [d.entry, ...prev]);
      setName("");
    } catch (err) { setError(err.message); }
    finally { setCreating(false); }
  };

  /* ── Rotate ── */
  const rotate = async (key) => {
    if (!window.confirm(`Rotate "${key.name}"? The current key will stop working immediately and a new one will be generated.`)) return;
    setRotating(key.id); setError("");
    try {
      const d = await authApi.rotateApiKey(key.id);
      setNewKeyVal(d.key);
      setNewKeyLabel(d.entry.name);
      setKeys((prev) => prev.map((k) => k.id === key.id ? { ...k, key_prefix: d.entry.key_prefix, last_used: null } : k));
    } catch (err) { setError(err.message); }
    finally { setRotating(null); }
  };

  /* ── Delete ── */
  const remove = async (key) => {
    if (!window.confirm(`Delete "${key.name}"? All requests using this key will stop working immediately.`)) return;
    setDeleting(key.id); setError("");
    try {
      await authApi.deleteApiKey(key.id);
      setKeys((prev) => prev.filter((k) => k.id !== key.id));
      if (newKeyVal) setNewKeyVal(null);
    } catch (err) { setError(err.message); }
    finally { setDeleting(null); }
  };

  /* ── Copy ── */
  const copy = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div className="section-heading"><span>API Keys</span></div>

      {/* Plan info strip */}
      <div className="api-plan-strip">
        <div className="api-plan-item">
          <span className="api-plan-label">Rate limit</span>
          <span className="api-plan-value">{meta.rateLimits.callsPerMinute} calls/min</span>
        </div>
        <div className="api-plan-divider" />
        <div className="api-plan-item">
          <span className="api-plan-label">Monthly messages</span>
          <span className="api-plan-value">{meta.rateLimits.messagesPerMonth.toLocaleString()}</span>
        </div>
        <div className="api-plan-divider" />
        <div className="api-plan-item">
          <span className="api-plan-label">Keys allowed</span>
          <span className="api-plan-value">{keys.length}/{maxKeys}</span>
        </div>
        {!isPro && (
          <>
            <div className="api-plan-divider" />
            <div className="api-plan-item">
              <span style={{ fontSize: "0.8rem", color: "var(--accent)", fontWeight: 600 }}>
                Upgrade to Pro → 10 keys · 300 calls/min · 100k messages
              </span>
            </div>
          </>
        )}
      </div>

      {/* New key banner */}
      {newKeyVal && (
        <div className="alert alert-success" style={{ flexDirection: "column", gap: "0.625rem" }}>
          <strong>🔑 "{newKeyLabel}" — copy your key now. You won't see it again.</strong>
          <div className="api-key-row">
            <span className="api-key-value mono">{newKeyVal}</span>
            <button className="btn btn-sm btn-secondary" onClick={() => copy(newKeyVal)}>
              {copied ? "✓ Copied!" : "Copy"}
            </button>
          </div>
          <div style={{ fontSize: "0.8rem", color: "rgba(34,197,94,0.7)" }}>
            Add to requests: <code>Authorization: Bearer {newKeyVal}</code>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-end" }}
            onClick={() => setNewKeyVal(null)}>Dismiss</button>
        </div>
      )}

      {error && <Alert type="error">{error}</Alert>}

      {/* Create card */}
      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: "0.875rem", fontSize: "0.875rem" }}>
          Create new API key {atLimit && <span style={{ color: "var(--error)", fontWeight: 400, fontSize: "0.8rem" }}>— limit reached</span>}
        </div>
        <div style={{ display: "flex", gap: "0.625rem" }}>
          <input className="input" placeholder='Key name (e.g. "Production server")' value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !atLimit && create()}
            disabled={atLimit} />
          <button className="btn btn-primary" style={{ whiteSpace: "nowrap" }}
            onClick={create} disabled={creating || atLimit}>
            {creating ? <><Spinner size="sm" /> Creating…</> : "Generate key"}
          </button>
        </div>
        <p className="text-xs text-muted3" style={{ marginTop: "0.5rem" }}>
          {atLimit
            ? `You've used all ${maxKeys} key slot${maxKeys === 1 ? "" : "s"}. Delete a key or upgrade to Pro to create more.`
            : `${keys.length}/${maxKeys} keys used · Include in requests: Authorization: Bearer wbk_…`
          }
        </p>
      </div>

      {/* Keys list */}
      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: "1rem", fontSize: "0.875rem" }}>
          Your API keys ({keys.length}/{maxKeys})
        </div>

        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "2rem" }}><Spinner /></div>
        ) : keys.length === 0 ? (
          <EmptyState icon="🔑" title="No API keys yet"
            desc="Create a key above to start using the WaBot REST API." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            {keys.map((k) => (
              <div key={k.id} className="api-key-card">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{k.name}</div>
                  <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
                    <code className="mono text-muted3" style={{ fontSize: "0.775rem" }}>
                      {k.key_prefix}••••••••••••••••
                    </code>
                    <span className="text-xs text-muted3">Created {timeAgo(k.created_at)}</span>
                    {k.last_used && <span className="text-xs text-muted3">Last used {timeAgo(k.last_used)}</span>}
                    {!k.last_used && <span className="text-xs" style={{ color: "var(--text3)" }}>Never used</span>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                  {/* Rotate */}
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => rotate(k)}
                    disabled={rotating === k.id}
                    title="Generate a new secret for this key (old secret stops working immediately)"
                  >
                    {rotating === k.id ? <Spinner size="sm" /> : "↻ Rotate"}
                  </button>
                  {/* Delete */}
                  <button
                    className="btn btn-danger btn-sm btn-icon"
                    onClick={() => remove(k)}
                    disabled={deleting === k.id}
                    title="Delete key permanently"
                  >
                    {deleting === k.id ? <Spinner size="sm" /> : "✕"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Security tips */}
      <div className="card" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
        <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.75rem" }}>🔒 Security tips</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {[
            "Never commit API keys to GitHub or share them in chat.",
            "If a key leaks, rotate it immediately — the old secret is invalidated instantly.",
            "Use environment variables (process.env.WABOT_KEY) to store keys in your code.",
            "Each key is hashed with SHA-256 in our database — we cannot recover lost keys.",
            "Free plan: 30 API calls/min. Pro: 300 calls/min. Monthly limits reset on the 1st.",
          ].map((tip) => (
            <div key={tip} style={{ display: "flex", gap: "0.625rem", fontSize: "0.8125rem", color: "var(--text3)" }}>
              <span style={{ color: "var(--success)", flexShrink: 0 }}>✓</span>
              {tip}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
