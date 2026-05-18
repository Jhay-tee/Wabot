import { useEffect, useState, useRef, useCallback } from "react";
import { botsApi } from "../../api/bots.js";
import { Spinner } from "../../components/ui/Spinner.jsx";
import { Modal } from "../../components/ui/Modal.jsx";

const DISMISSED_KEY = "wabot:convs-dismissed";

function loadDismissed() {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function saveDismissed(arr) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(arr)); } catch {}
}

function formatTimestamp(date) {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return then.toLocaleDateString();
}

export function Conversations() {
  const [loading, setLoading] = useState(true);
  const [convs, setConvs] = useState([]);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [view, setView] = useState("dm");
  const [dismissed, setDismissed] = useState(() => loadDismissed());
  const [persistRead, setPersistRead] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [threadMessages, setThreadMessages] = useState([]);

  const touchState = useRef({});
  const fileRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Load conversations
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    botsApi.v1Conversations(undefined, 50, offset)
      .then((d) => {
        if (!mounted) return;
        setConvs(d.conversations ?? []);
        setLoading(false);
      })
      .catch(() => { if (mounted) setLoading(false); });
    return () => mounted = false;
  }, [offset]);

  // Save dismissed to localStorage
  useEffect(() => { saveDismissed(dismissed); }, [dismissed]);

  // Load thread when conversation is selected
  const loadThread = useCallback(async (conversation) => {
    if (!conversation) return;
    try {
      const data = await botsApi.v1Conversations(undefined, 200, 0);
      const thread = (data.conversations || []).filter((m) => 
        m.id === conversation.id || 
        (m.metadata?.from === conversation.metadata?.from)
      );
      setThreadMessages(thread);
    } catch (err) {
      console.error("Failed to load thread:", err);
    }
  }, []);

  const open = (c) => {
    setSelected(c);
    setReply("");
    setResult(null);
    setThreadMessages([]);
    loadThread(c);
  };
  
  const close = () => { 
    setSelected(null); 
    setReply(""); 
    setResult(null);
    setThreadMessages([]);
  };

  const isGroupConv = (c) => {
    if (c?.metadata?.isGroup !== undefined) return Boolean(c.metadata.isGroup);
    if (c?.metadata?.from) return String(c.metadata.from).includes("@g.") || String(c.metadata.from).includes("@g.us");
    return String(c?.details ?? "").includes("@g.") || String(c?.details ?? "").includes("@g.us");
  };

  const getSenderName = (c) => {
    if (c?.metadata?.from) {
      const from = String(c.metadata.from);
      return from.replace("@s.whatsapp.net", "").replace("@g.us", "").split("@")[0];
    }
    return c?.details?.split(" ")[0] || "Unknown";
  };

  const getPreviewText = (c) => {
    if (c?.metadata?.body) return c.metadata.body.slice(0, 60);
    if (c?.details) return c.details.slice(0, 60);
    return "No message preview";
  };

  // Filter conversations
  const visibleConvs = convs
    .filter((c) => c.event_type === "message_received")
    .filter((c) => !dismissed.includes(c.id))
    .filter((c) => {
      if (view === "all") return true;
      return view === "group" ? isGroupConv(c) : !isGroupConv(c);
    })
    .filter((c) => {
      if (!searchTerm) return true;
      const searchLower = searchTerm.toLowerCase();
      return getSenderName(c).toLowerCase().includes(searchLower) ||
             getPreviewText(c).toLowerCase().includes(searchLower);
    });

  const dismiss = (id) => {
    setDismissed((s) => {
      const next = Array.from(new Set([...(s || []), id]));
      saveDismissed(next);
      return next;
    });
    setConvs((s) => s.filter((c) => c.id !== id));
    if (persistRead) {
      botsApi.v1MarkConversationsRead([id]).catch(() => {});
    }
    if (selected?.id === id) close();
  };

  const markVisibleRead = async () => {
    const ids = visibleConvs.map((c) => c.id);
    setDismissed((s) => Array.from(new Set([...(s || []), ...ids])));
    setConvs((s) => s.filter((c) => !ids.includes(c.id)));
    if (persistRead && ids.length) {
      await botsApi.v1MarkConversationsRead(ids).catch(() => {});
    }
  };

  // Touch handlers for swipe-to-dismiss
  const handleTouchStart = (e, id) => {
    const t = e.touches?.[0];
    if (!t) return;
    touchState.current[id] = { startX: t.clientX, deltaX: 0 };
  };
  
  const handleTouchMove = (e, id) => {
    const t = e.touches?.[0];
    if (!t || !touchState.current[id]) return;
    touchState.current[id].deltaX = t.clientX - touchState.current[id].startX;
    const el = document.getElementById(`conv-${id}`);
    if (el) {
      const dx = Math.max(-160, Math.min(0, touchState.current[id].deltaX));
      el.style.transform = `translateX(${dx}px)`;
      el.style.transition = "transform 0s";
    }
  };
  
  const handleTouchEnd = (e, id) => {
    const state = touchState.current[id];
    if (!state) return;
    const el = document.getElementById(`conv-${id}`);
    const dx = state.deltaX;
    if (el) {
      el.style.transition = "transform 200ms ease";
      if (dx <= -80) {
        el.style.transform = "translateX(-100%)";
        setTimeout(() => dismiss(id), 180);
      } else {
        el.style.transform = "translateX(0)";
      }
    }
    delete touchState.current[id];
  };

  const doReply = async () => {
    if (!selected) return;
    setSending(true); 
    setResult(null);
    
    const to = selected.metadata?.from ?? selected.details;
    const textMsg = reply.trim();
    
    if (!textMsg && !fileRef.current?.files?.[0]) {
      setResult({ ok: false, text: "Please enter a message or attach a file" });
      setSending(false);
      return;
    }
    
    try {
      const file = fileRef.current?.files?.[0];
      if (file) {
        // Check file size (max 16MB)
        if (file.size > 16 * 1024 * 1024) {
          throw new Error("File too large. Max 16MB.");
        }
        
        const reader = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        
        const mediaType = file.type.startsWith("image/") ? "image" : 
                         file.type.startsWith("video/") ? "video" : "document";
        
        await botsApi.sendDM(selected.bot_id, { 
          to, 
          message: { 
            media: { 
              type: mediaType, 
              url: reader, 
              caption: textMsg, 
              fileName: file.name, 
              mimetype: file.type 
            } 
          } 
        });
        
        // Clear file input after send
        if (fileRef.current) fileRef.current.value = "";
      } else {
        await botsApi.sendDM(selected.bot_id, { to, message: textMsg });
      }
      
      setResult({ ok: true, text: "✓ Reply sent successfully" });
      setReply("");
      dismiss(selected.id);
      
      // Clear success message after 3 seconds
      setTimeout(() => setResult(null), 3000);
    } catch (err) {
      setResult({ ok: false, text: err?.message || "Failed to send reply" });
    } finally { 
      setSending(false); 
    }
  };

  if (loading) return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: 400 }}>
      <Spinner size="lg" />
    </div>
  );

  return (
    <div style={{ display: "flex", gap: "1.5rem", height: "calc(100vh - 120px)", overflow: "hidden" }}>
      {/* Left Panel - Conversation List */}
      <div style={{ width: 380, display: "flex", flexDirection: "column", gap: "0.75rem", overflow: "hidden" }}>
        {/* Toolbar */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center", paddingBottom: "0.5rem", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: "0.25rem", background: "var(--bg-secondary)", borderRadius: "8px", padding: "2px" }}>
            <button className={`btn ${view === "dm" ? "btn-primary" : "btn-ghost"}`} onClick={() => setView("dm")} style={{ padding: "4px 12px" }}>💬 DMs</button>
            <button className={`btn ${view === "group" ? "btn-primary" : "btn-ghost"}`} onClick={() => setView("group")} style={{ padding: "4px 12px" }}>👥 Groups</button>
            <button className={`btn ${view === "all" ? "btn-primary" : "btn-ghost"}`} onClick={() => setView("all")} style={{ padding: "4px 12px" }}>📋 All</button>
          </div>
          
          <div style={{ flex: 1, minWidth: 150 }}>
            <input 
              type="text" 
              className="input" 
              placeholder="🔍 Search contacts..." 
              value={searchTerm} 
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ padding: "6px 10px", fontSize: "0.85rem" }}
            />
          </div>
          
          <div style={{ display: "flex", gap: "0.25rem" }}>
            <button className="btn btn-ghost" onClick={() => setOffset(Math.max(0, offset - 50))} title="Previous" disabled={offset === 0}>←</button>
            <button className="btn btn-ghost" onClick={() => setOffset(offset + 50)} title="Next">→</button>
          </div>
        </div>
        
        {/* Filters Row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {visibleConvs.length} conversation{visibleConvs.length !== 1 ? "s" : ""}
          </div>
          <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.75rem" }}>
            <input type="checkbox" checked={persistRead} onChange={(e) => setPersistRead(e.target.checked)} />
            <span>Persist reads to server</span>
          </label>
          <button className="btn btn-ghost btn-sm" onClick={markVisibleRead}>✓ Mark all read</button>
        </div>

        {/* Conversation List */}
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {visibleConvs.length === 0 && (
            <div className="card" style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)" }}>
              {searchTerm ? "No matching conversations" : "No conversations yet"}
            </div>
          )}
          
          {visibleConvs.map((c) => (
            <div
              id={`conv-${c.id}`}
              key={c.id}
              className={`card ${selected?.id === c.id ? "selected" : ""}`}
              style={{ 
                marginBottom: 0, 
                cursor: "pointer", 
                touchAction: "pan-y",
                transition: "transform 0.2s ease, background 0.2s ease",
                background: selected?.id === c.id ? "var(--bg-selected, rgba(168, 85, 247, 0.1))" : "var(--card-bg)",
                border: selected?.id === c.id ? "1px solid var(--primary)" : "1px solid var(--border)"
              }}
              onClick={() => open(c)}
              onTouchStart={(e) => handleTouchStart(e, c.id)}
              onTouchMove={(e) => handleTouchMove(e, c.id)}
              onTouchEnd={(e) => handleTouchEnd(e, c.id)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span style={{ fontSize: "1.25rem" }}>{isGroupConv(c) ? "👥" : "👤"}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{getSenderName(c)}</div>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{c.bot_id?.slice(0, 8)}...</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{formatTimestamp(c.created_at)}</span>
                  <button 
                    className="btn btn-ghost" 
                    style={{ padding: "2px 6px", fontSize: "0.7rem" }} 
                    onClick={(ev) => { ev.stopPropagation(); dismiss(c.id); }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "4px" }}>
                {getPreviewText(c)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Panel - Reply Area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "1rem", overflow: "hidden" }}>
        {!selected && (
          <div className="card" style={{ textAlign: "center", padding: "3rem", color: "var(--text-muted)" }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>💬</div>
            <div>Select a conversation to reply</div>
          </div>
        )}
        
        {selected && (
          <>
            {/* Conversation Header */}
            <div className="card" style={{ padding: "1rem", background: "var(--bg-secondary)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: "1rem" }}>
                    {getSenderName(selected)} {isGroupConv(selected) && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>(Group)</span>}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    Bot: {selected.bot_id}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={close}>✕ Close</button>
              </div>
            </div>

            {/* Message Thread (optional) */}
            {threadMessages.length > 0 && (
              <div className="card" style={{ maxHeight: 200, overflowY: "auto", marginBottom: 0 }}>
                <div style={{ fontSize: "0.75rem", fontWeight: 600, marginBottom: "0.5rem", color: "var(--text-muted)" }}>Recent messages</div>
                {threadMessages.slice(-5).map((msg, idx) => (
                  <div key={idx} style={{ fontSize: "0.8rem", padding: "4px 0", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                    {msg.details || msg.metadata?.body || "Message"}
                  </div>
                ))}
              </div>
            )}

            {/* Reply Form */}
            <div className="card" style={{ flex: 1, display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="field">
                <label className="field-label">Reply message</label>
                <textarea 
                  className="input" 
                  rows={5} 
                  placeholder="Type your reply here..." 
                  value={reply} 
                  onChange={(e) => setReply(e.target.value)}
                  style={{ resize: "vertical", fontFamily: "inherit" }}
                />
              </div>

              <div className="field">
                <label className="field-label">Attach file (optional)</label>
                <input 
                  ref={fileRef} 
                  type="file" 
                  accept="image/*,video/*,application/pdf,.doc,.docx"
                  style={{ fontSize: "0.85rem" }}
                />
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "4px" }}>
                  Max 16MB. Supports images, videos, PDFs, and documents.
                </div>
              </div>

              {result && (
                <div className={`alert ${result.ok ? "alert-success" : "alert-error"}`} style={{ marginBottom: 0 }}>
                  {result.text}
                </div>
              )}

              <div style={{ display: "flex", gap: "0.75rem" }}>
                <button 
                  className="btn btn-primary" 
                  disabled={sending || (!reply.trim() && !fileRef.current?.files?.[0])} 
                  onClick={doReply}
                >
                  {sending ? <><Spinner size="sm" /> Sending...</> : "📤 Send reply"}
                </button>
                <button className="btn btn-secondary" onClick={close}>Cancel</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default Conversations;