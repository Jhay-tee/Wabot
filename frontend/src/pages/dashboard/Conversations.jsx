import { useEffect, useState, useRef, useCallback } from "react";
import { botsApi } from "../../api/bots.js";
import { Spinner } from "../../components/ui/Spinner.jsx";

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [threadMessages]);

  // Load thread when conversation is selected
  const loadThread = useCallback(async (conversation) => {
    if (!conversation) return;
    try {
      const data = await botsApi.v1ConversationThread(
        conversation.bot_id,
        conversation.conversation_key,
        200
      );
      setThreadMessages(data.messages || []);
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
    
    const to = selected.metadata?.chat_jid || selected.metadata?.from || selected.details;
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
      await loadThread(selected);
      
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
    <div className="grid h-[calc(100dvh-8.5rem)] gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <section className={`flex min-h-0 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[var(--card)] ${selected ? "hidden xl:flex" : "flex"}`}>
        <div className="border-b border-white/10 bg-[var(--card2)] p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-2xl border border-white/10 bg-black/10 p-1">
              <button className={`rounded-xl px-3 py-2 text-sm ${view === "dm" ? "bg-[var(--accent)] text-white" : "text-[var(--text2)]"}`} onClick={() => setView("dm")}>DMs</button>
              <button className={`rounded-xl px-3 py-2 text-sm ${view === "group" ? "bg-[var(--accent)] text-white" : "text-[var(--text2)]"}`} onClick={() => setView("group")}>Groups</button>
              <button className={`rounded-xl px-3 py-2 text-sm ${view === "all" ? "bg-[var(--accent)] text-white" : "text-[var(--text2)]"}`} onClick={() => setView("all")}>All</button>
            </div>
            <div className="min-w-[180px] flex-1">
              <input
                type="text"
                className="input h-11"
                placeholder="Search conversations"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <button className="btn btn-ghost" onClick={() => setOffset(Math.max(0, offset - 50))} title="Previous" disabled={offset === 0}>←</button>
              <button className="btn btn-ghost" onClick={() => setOffset(offset + 50)} title="Next">→</button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text3)]">
            <div>{visibleConvs.length} conversation{visibleConvs.length !== 1 ? "s" : ""}</div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={persistRead} onChange={(e) => setPersistRead(e.target.checked)} />
              <span>Persist reads</span>
            </label>
            <button className="btn btn-ghost btn-sm" onClick={markVisibleRead}>Mark all read</button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {visibleConvs.length === 0 && (
            <div className="rounded-[24px] border border-dashed border-white/10 bg-black/10 p-8 text-center text-sm text-[var(--text3)]">
              {searchTerm ? "No matching conversations" : "No conversations yet"}
            </div>
          )}

          {visibleConvs.map((c) => (
            <div
              id={`conv-${c.id}`}
              key={c.id}
              className={`mb-2 cursor-pointer rounded-[22px] border p-4 transition ${selected?.id === c.id ? "border-[var(--border-accent)] bg-[var(--accent-dim)]" : "border-white/10 bg-black/10 hover:bg-white/5"}`}
              style={{ touchAction: "pan-y", transition: "transform 0.2s ease, background 0.2s ease" }}
              onClick={() => open(c)}
              onTouchStart={(e) => handleTouchStart(e, c.id)}
              onTouchMove={(e) => handleTouchMove(e, c.id)}
              onTouchEnd={(e) => handleTouchEnd(e, c.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-dim)] text-sm font-semibold text-[var(--accent)]">
                    {getSenderName(c).slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[var(--text)]">{getSenderName(c)}</div>
                    <div className="truncate text-[11px] uppercase tracking-[0.18em] text-[var(--text3)]">{c.bot_id?.slice(0, 8)}...</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--text3)]">{formatTimestamp(c.created_at)}</span>
                  <button className="btn btn-ghost btn-sm" onClick={(ev) => { ev.stopPropagation(); dismiss(c.id); }}>
                    Dismiss
                  </button>
                </div>
              </div>
              <div className="mt-2 line-clamp-2 text-sm text-[var(--text2)]">
                {getPreviewText(c)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={`min-h-0 overflow-hidden rounded-[28px] border border-white/10 bg-[var(--card)] ${selected ? "flex" : "hidden xl:flex"} flex-col`}>
        {!selected && (
          <div className="m-4 flex flex-1 items-center justify-center rounded-[24px] border border-dashed border-white/10 bg-black/10 p-10 text-center text-[var(--text3)]">
            <div>
              <div className="mb-3 text-5xl">💬</div>
              <div className="text-base font-medium text-[var(--text)]">Select a conversation to open the thread</div>
              <p className="mt-2 text-sm">Messages, attachments, timestamps, and replies stay in one place.</p>
            </div>
          </div>
        )}

        {selected && (
          <>
            <div className="border-b border-white/10 bg-[var(--card2)] px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-[var(--text)]">
                    {getSenderName(selected)} {isGroupConv(selected) && <span className="text-sm text-[var(--text3)]">(Group)</span>}
                  </div>
                  <div className="text-xs uppercase tracking-[0.18em] text-[var(--text3)]">
                    Bot: {selected.bot_id}
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={close}>Close</button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))] p-4">
              {threadMessages.length === 0 && (
                <div className="flex h-full items-center justify-center text-sm text-[var(--text3)]">No messages in this thread yet.</div>
              )}
              {threadMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`mb-3 flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
                >
                  <div className={`max-w-[85%] rounded-[22px] border px-4 py-3 shadow-sm xl:max-w-[72%] ${msg.direction === "outbound" ? "border-[var(--border-accent)] bg-[var(--accent-dim)]" : "border-white/10 bg-[var(--bg2)]"}`}>
                    <div className="whitespace-pre-wrap text-sm text-[var(--text)]">
                      {msg.body || "Unsupported message"}
                    </div>
                    <div className="mt-2 text-[11px] text-[var(--text3)]">
                      {formatTimestamp(msg.created_at)}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="border-t border-white/10 bg-[var(--card)] p-4">
              <div className="field">
                <label className="field-label">Reply message</label>
                <textarea
                  className="input min-h-[120px] resize-y"
                  rows={5}
                  placeholder="Type your reply here..."
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
              </div>

              <div className="field mt-4">
                <label className="field-label">Attach file (optional)</label>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/*,application/pdf,.doc,.docx"
                  className="text-sm text-[var(--text2)]"
                />
                <div className="mt-1 text-xs text-[var(--text3)]">
                  Max 16MB. Supports images, videos, PDFs, and documents.
                </div>
              </div>

              {result && (
                <div className={`alert mt-4 ${result.ok ? "alert-success" : "alert-error"}`} style={{ marginBottom: 0 }}>
                  {result.text}
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-3">
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
      </section>
    </div>
  );
}

export default Conversations;
