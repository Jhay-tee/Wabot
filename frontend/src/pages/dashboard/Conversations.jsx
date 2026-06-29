import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, RefreshCw, Search, Send, Smile, Users } from "lucide-react";
import { botsApi } from "../../api/bots.js";
import { openEventStream } from "../../api/client.js";
import { Spinner } from "../../components/ui/Spinner.jsx";

const POLL_MS = 30_000;
const SSE_DEBOUNCE_MS = 1200;

function formatSidebarTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatBubbleTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatPhoneLabel(value) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

function getConversationTarget(conversation) {
  return conversation?.chat_jid || conversation?.metadata?.chat_jid || conversation?.contact_jid || conversation?.metadata?.from || conversation?.metadata?.to || "";
}

function getMessagePreview(message) {
  const body = String(message?.body ?? "").trim();
  if (body) return body;

  switch (message?.payload_type) {
    case "image":
      return "Photo";
    case "video":
      return "Video";
    case "audio":
    case "voice_note":
      return "Voice note";
    case "document":
      return "Document";
    case "location":
      return "Location";
    case "contact":
    case "contacts":
      return "Contact";
    default:
      return "Unsupported message";
  }
}

function getConversationTitle(conversation) {
  const title = String(conversation?.title ?? "").trim();
  if (title && !title.includes("@")) return title;
  const phone = formatPhoneLabel(conversation?.phone_number);
  if (phone) return phone;
  return title || "Unknown contact";
}

function getConversationSubtitle(conversation) {
  if (conversation?.is_group) return "Group chat";
  const phone = formatPhoneLabel(conversation?.phone_number);
  if (phone) return phone;
  return "Direct message";
}

function getMessageSenderLabel(message, conversation) {
  if (!message) return "";
  if (message.direction === "outbound") return "You";

  const name = String(message.sender_name ?? "").trim();
  if (name) return name;

  const senderJid = String(message.sender_jid ?? "").trim();
  if (senderJid) {
    const phone = formatPhoneLabel(senderJid);
    if (phone) return phone;
    return senderJid
      .replace(/:\d+@/, "@")
      .replace("@s.whatsapp.net", "")
      .replace("@lid", "")
      .replace("@g.us", "");
  }

  return getConversationTitle(conversation);
}

function mergeConversations(current, incoming) {
  const map = new Map(current.map((item) => [`${item.bot_id}:${item.conversation_key}`, item]));
  for (const item of incoming) {
    map.set(`${item.bot_id}:${item.conversation_key}`, { ...map.get(`${item.bot_id}:${item.conversation_key}`), ...item });
  }
  return [...map.values()].sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
}

function mergeThreadMessages(current, incoming) {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

export function Conversations({ bots = [] }) {
  const hasBots = bots.length > 0;
  const [activeBotId, setActiveBotId] = useState("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [sending, setSending] = useState(false);
  const [composer, setComposer] = useState("");
  const [result, setResult] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [view, setView] = useState("all");

  const fileRef = useRef(null);
  const endRef = useRef(null);
  const refreshTimerRef = useRef(null);
  const sseTimerRef = useRef(null);
  const threadSinceRef = useRef(null);
  const selectedRef = useRef(null);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    if (!hasBots) {
      setActiveBotId("all");
      return;
    }

    const stillExists = activeBotId === "all" || bots.some((bot) => bot.id === activeBotId);
    if (!stillExists) {
      setActiveBotId(bots[0].id);
    }
  }, [activeBotId, bots, hasBots]);

  const loadConversations = useCallback(async ({ silent = false, merge = false } = {}) => {
    if (!hasBots) {
      setConversations([]);
      setLoading(false);
      return;
    }

    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const data = await botsApi.v1Conversations(activeBotId === "all" ? undefined : activeBotId, 200, 0);
      const next = data.conversations ?? [];
      setConversations((current) => (merge ? mergeConversations(current, next) : next));
      setSelected((current) => {
        if (!current) return current;
        const replacement = next.find((item) => item.conversation_key === current.conversation_key && item.bot_id === current.bot_id);
        return replacement ? { ...current, ...replacement } : null;
      });
    } catch (err) {
      if (!silent) setResult({ ok: false, text: err.message || "Could not load conversations." });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeBotId, hasBots]);

  const loadThread = useCallback(async (conversation, { silent = false, incremental = false } = {}) => {
    if (!conversation) {
      setThreadMessages([]);
      threadSinceRef.current = null;
      return;
    }

    if (!silent) setThreadLoading(true);
    try {
      const since = incremental ? threadSinceRef.current : null;
      const data = await botsApi.v1ConversationThread(
        conversation.bot_id,
        conversation.conversation_key,
        300,
        since
      );
      const messages = data.messages ?? [];

      setThreadMessages((current) => {
        if (!incremental || current.length === 0) return messages;
        return mergeThreadMessages(current, messages);
      });

      if (messages.length > 0) {
        threadSinceRef.current = data.latest_at || messages[messages.length - 1].created_at;
      }

      if (conversation.unread) {
        const unreadIds = messages
          .filter((message) => message.direction === "inbound")
          .map((message) => message.id)
          .filter(Boolean);

        const idsToMark = unreadIds.length > 0 ? unreadIds : [conversation.id];
        setConversations((current) => current.map((item) => (
          item.bot_id === conversation.bot_id && item.conversation_key === conversation.conversation_key
            ? { ...item, unread: false, unread_count: 0 }
            : item
        )));

        try {
          await botsApi.v1MarkConversationsRead(idsToMark);
        } catch {}
      }
    } catch (err) {
      if (!silent) setResult({ ok: false, text: err.message || "Could not load thread." });
    } finally {
      if (!silent) setThreadLoading(false);
    }
  }, []);

  const refreshOpenViews = useCallback(async ({ silent = true, incremental = true } = {}) => {
    await loadConversations({ silent, merge: true });
    const current = selectedRef.current;
    if (current) {
      await loadThread(current, { silent, incremental });
    }
  }, [loadConversations, loadThread]);

  useEffect(() => {
    threadSinceRef.current = null;
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = setInterval(() => {
      refreshOpenViews({ silent: true, incremental: true });
    }, POLL_MS);

    return () => clearInterval(refreshTimerRef.current);
  }, [refreshOpenViews]);

  useEffect(() => {
    const closeStream = openEventStream("/bots/dashboard/events", () => {
      clearTimeout(sseTimerRef.current);
      sseTimerRef.current = setTimeout(() => {
        refreshOpenViews({ silent: true, incremental: true });
      }, SSE_DEBOUNCE_MS);
    });

    return () => {
      clearTimeout(sseTimerRef.current);
      closeStream();
    };
  }, [refreshOpenViews]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [threadMessages]);

  const visibleConversations = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    return conversations
      .filter((conversation) => {
        if (view === "groups") return conversation.is_group;
        if (view === "unread") return conversation.unread;
        return true;
      })
      .filter((conversation) => {
        if (!needle) return true;
        const haystacks = [
          getConversationTitle(conversation),
          getConversationSubtitle(conversation),
          conversation.preview,
          conversation.phone_number,
        ].filter(Boolean).map((value) => String(value).toLowerCase());
        return haystacks.some((value) => value.includes(needle));
      });
  }, [conversations, searchTerm, view]);

  const selectedBot = activeBotId === "all" ? null : bots.find((bot) => bot.id === activeBotId) ?? null;

  const openConversation = useCallback((conversation) => {
    setSelected(conversation);
    setComposer("");
    setResult(null);
    threadSinceRef.current = null;
    loadThread(conversation);
  }, [loadThread]);

  const sendReply = useCallback(async () => {
    if (!selected) return;

    const textValue = composer.trim();
    const file = fileRef.current?.files?.[0];
    if (!textValue && !file) {
      setResult({ ok: false, text: "Type a message or attach a file first." });
      return;
    }

    setSending(true);
    setResult(null);

    try {
      const to = getConversationTarget(selected);
      if (!to) throw new Error("This conversation has no valid WhatsApp destination.");

      if (file) {
        if (file.size > 16 * 1024 * 1024) {
          throw new Error("File too large. Maximum size is 16MB.");
        }

        const readerResult = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const mediaType = file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("video/")
            ? "video"
            : file.type.startsWith("audio/")
              ? "audio"
              : "document";

        await botsApi.sendDM(selected.bot_id, {
          to,
          message: {
            media: {
              type: mediaType,
              url: readerResult,
              caption: textValue,
              fileName: file.name,
              mimetype: file.type,
            },
          },
        });
      } else {
        await botsApi.sendDM(selected.bot_id, { to, message: textValue });
      }

      setComposer("");
      if (fileRef.current) fileRef.current.value = "";
      await refreshOpenViews({ silent: true, incremental: false });
      setResult({ ok: true, text: "Message sent." });
      setTimeout(() => setResult(null), 2500);
    } catch (err) {
      setResult({ ok: false, text: err.message || "Failed to send message." });
    } finally {
      setSending(false);
    }
  }, [composer, refreshOpenViews, selected]);

  if (!hasBots) {
    return (
      <div className="rounded-[30px] border border-white/10 bg-[var(--card)] p-10 text-center shadow-lg">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-[var(--accent-dim)] text-[var(--accent)]">
          <Users size={28} />
        </div>
        <h2 className="mt-5 text-2xl font-semibold text-[var(--text)]">No bot inboxes yet</h2>
        <p className="mx-auto mt-3 max-w-xl text-sm text-[var(--text2)]">
          Deploy and connect a bot first. As soon as a WhatsApp session starts receiving messages, its own conversations workspace will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[680px] flex-col gap-4">
      <section className="rounded-[30px] border border-white/10 bg-[var(--card)] p-4 shadow-lg">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.26em] text-[var(--text3)]">Conversations</div>
            <h2 className="mt-2 text-2xl font-semibold text-[var(--text)]">
              {selectedBot ? `${selectedBot.bot_name} inbox` : "All bot inboxes"}
            </h2>
            <p className="mt-2 text-sm text-[var(--text2)]">
              Live inbox updates without full-page refresh. Long replies are sent in multiple parts automatically.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-[var(--text2)] transition hover:border-[var(--border-accent)] hover:text-[var(--text)]"
              onClick={() => loadConversations({ silent: true, merge: false })}
              disabled={refreshing}
            >
              {refreshing ? <Spinner size="sm" /> : <RefreshCw size={15} />}
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className={`rounded-2xl px-4 py-2 text-sm font-medium transition ${activeBotId === "all" ? "bg-[var(--accent)] text-white" : "border border-white/10 bg-white/5 text-[var(--text2)] hover:text-[var(--text)]"}`}
            onClick={() => setActiveBotId("all")}
          >
            All bots
          </button>
          {bots.map((bot) => (
            <button
              key={bot.id}
              className={`rounded-2xl px-4 py-2 text-sm font-medium transition ${activeBotId === bot.id ? "bg-[var(--accent)] text-white" : "border border-white/10 bg-white/5 text-[var(--text2)] hover:text-[var(--text)]"}`}
              onClick={() => setActiveBotId(bot.id)}
            >
              {bot.bot_name}
            </button>
          ))}
        </div>
      </section>

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <section className={`min-h-0 overflow-hidden rounded-[30px] border border-white/10 bg-[var(--card)] shadow-lg ${selected ? "hidden xl:flex" : "flex"} flex-col`}>
          <div className="border-b border-white/10 bg-[linear-gradient(135deg,var(--accent-dim),rgba(255,255,255,0.03))] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] text-white">
                <Search size={18} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-[var(--text)]">Inbox</div>
                <div className="text-xs text-[var(--text3)]">
                  {visibleConversations.length} chat{visibleConversations.length === 1 ? "" : "s"} visible
                </div>
              </div>
            </div>

            <div className="relative mt-4">
              <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text3)]" />
              <input
                type="text"
                className="input h-12 pl-11"
                placeholder="Search chats"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>

            <div className="mt-4 flex gap-2">
              {[
                { id: "all", label: "All" },
                { id: "unread", label: "Unread" },
                { id: "groups", label: "Groups" },
              ].map((option) => (
                <button
                  key={option.id}
                  className={`rounded-full px-4 py-2 text-xs font-semibold transition ${view === option.id ? "bg-[var(--accent)] text-white" : "border border-white/10 bg-white/5 text-[var(--text2)]"}`}
                  onClick={() => setView(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--card)]">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Spinner size="lg" />
              </div>
            ) : visibleConversations.length === 0 ? (
              <div className="m-4 rounded-[26px] border border-dashed border-white/10 bg-black/10 p-8 text-center text-sm text-[var(--text3)]">
                No conversations match this view yet.
              </div>
            ) : (
              visibleConversations.map((conversation) => (
                <button
                  key={`${conversation.bot_id}:${conversation.conversation_key}`}
                  className={`flex w-full items-start gap-3 border-b border-white/5 px-4 py-4 text-left transition ${selected?.conversation_key === conversation.conversation_key && selected?.bot_id === conversation.bot_id ? "bg-[var(--accent-dim)]" : "hover:bg-white/5"}`}
                  onClick={() => openConversation(conversation)}
                >
                  <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${conversation.unread ? "bg-[var(--accent)] text-white" : "bg-white/10 text-[var(--text)]"}`}>
                    {getConversationTitle(conversation).slice(0, 1).toUpperCase()}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className={`truncate text-sm font-semibold ${conversation.unread ? "text-[var(--text)]" : "text-[var(--text)]/90"}`}>
                          {getConversationTitle(conversation)}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-[var(--text3)]">
                          {activeBotId === "all" ? bots.find((bot) => bot.id === conversation.bot_id)?.bot_name ?? "Bot" : getConversationSubtitle(conversation)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className={`text-[11px] ${conversation.unread ? "text-[var(--accent)]" : "text-[var(--text3)]"}`}>
                          {formatSidebarTime(conversation.last_message_at)}
                        </div>
                        {conversation.unread_count > 0 && (
                          <div className="mt-2 inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-[var(--accent)] px-2 py-1 text-[11px] font-semibold text-white">
                            {conversation.unread_count > 99 ? "99+" : conversation.unread_count}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className={`mt-2 truncate text-sm ${conversation.unread ? "font-medium text-[var(--text2)]" : "text-[var(--text3)]"}`}>
                      {conversation.is_group ? "Group · " : ""}
                      {conversation.preview || "No preview yet"}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </section>

        <section className={`min-h-0 overflow-hidden rounded-[30px] border border-white/10 bg-[var(--card)] shadow-lg ${selected ? "flex" : "hidden xl:flex"} flex-col`}>
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(0,0,0,0.05))] p-10 text-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--accent-dim)] text-[var(--accent)]">
                <Users size={34} />
              </div>
              <h3 className="mt-6 text-2xl font-semibold text-[var(--text)]">Open a chat</h3>
              <p className="mt-3 max-w-md text-sm text-[var(--text2)]">
                Pick a bot on the left, choose a thread, and reply from a workspace designed to feel familiar to WhatsApp users while keeping your app’s theme.
              </p>
            </div>
          ) : (
            <>
              <div className="border-b border-white/10 bg-[linear-gradient(135deg,var(--accent-dim),rgba(255,255,255,0.03))] px-4 py-4">
                <div className="flex items-center gap-3">
                  <button
                    className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-[var(--text2)] xl:hidden"
                    onClick={() => setSelected(null)}
                  >
                    ←
                  </button>

                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-semibold text-white">
                    {getConversationTitle(selected).slice(0, 1).toUpperCase()}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold text-[var(--text)]">{getConversationTitle(selected)}</div>
                    <div className="truncate text-xs text-[var(--text3)]">
                      {bots.find((bot) => bot.id === selected.bot_id)?.bot_name ?? "Bot"} · {getConversationSubtitle(selected)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.06),transparent_40%),linear-gradient(180deg,rgba(255,255,255,0.02),rgba(0,0,0,0.06))] px-4 py-5">
                {threadLoading && threadMessages.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <Spinner size="lg" />
                  </div>
                ) : threadMessages.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-[var(--text3)]">
                    No messages in this thread yet.
                  </div>
                ) : (
                  threadMessages.map((message) => {
                    const outbound = message.direction === "outbound";
                    const senderLabel = getMessageSenderLabel(message, selected);
                    return (
                      <div key={message.id} className={`mb-3 flex ${outbound ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[88%] rounded-[18px] px-4 py-3 shadow-sm xl:max-w-[72%] ${
                            outbound
                              ? "rounded-br-md bg-[var(--accent)] text-white"
                              : "rounded-bl-md border border-white/10 bg-[var(--card2)] text-[var(--text)]"
                          }`}
                        >
                          <div className={`mb-1 text-[11px] font-semibold ${outbound ? "text-white/80" : "text-[var(--accent)]"}`}>
                            {senderLabel}
                          </div>
                          <div className="whitespace-pre-wrap break-words text-sm">
                            {getMessagePreview(message)}
                          </div>
                          <div className={`mt-2 text-[11px] ${outbound ? "text-white/70" : "text-[var(--text3)]"}`}>
                            {formatBubbleTime(message.created_at)}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={endRef} />
              </div>

              <div className="border-t border-white/10 bg-[var(--card)] p-4">
                {result && (
                  <div className={`mb-3 rounded-2xl border px-4 py-3 text-sm ${result.ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-100" : "border-rose-500/20 bg-rose-500/10 text-rose-100"}`}>
                    {result.text}
                  </div>
                )}

                <div className="rounded-[26px] border border-white/10 bg-[var(--bg2)] p-3">
                  <div className="flex items-end gap-3">
                    <button
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[var(--text2)] transition hover:text-[var(--text)]"
                      onClick={() => setPickerOpen((open) => !open)}
                      type="button"
                    >
                      <Paperclip size={18} />
                    </button>

                    <div className="flex-1">
                      <textarea
                        className="w-full resize-none border-0 bg-transparent px-1 py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text3)]"
                        rows={pickerOpen ? 4 : 2}
                        placeholder="Type a message"
                        value={composer}
                        onChange={(event) => setComposer(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            if (!sending) sendReply();
                          }
                        }}
                      />
                    </div>

                    <button
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[var(--text2)] transition hover:text-[var(--text)]"
                      type="button"
                    >
                      <Smile size={18} />
                    </button>

                    <button
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={sendReply}
                      disabled={sending || (!composer.trim() && !fileRef.current?.files?.[0])}
                      type="button"
                    >
                      {sending ? <Spinner size="sm" /> : <Send size={18} />}
                    </button>
                  </div>

                  {pickerOpen && (
                    <div className="mt-3 rounded-2xl border border-dashed border-white/10 bg-white/5 p-3">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                        className="block w-full text-sm text-[var(--text2)] file:mr-3 file:rounded-full file:border-0 file:bg-[var(--accent)] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
                      />
                      <div className="mt-2 text-xs text-[var(--text3)]">
                        Send photos, videos, audio, PDFs, and office documents up to 16MB. Long text is split automatically.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export default Conversations;
