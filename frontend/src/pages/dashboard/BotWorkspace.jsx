import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CalendarClock, ImagePlus, MessageSquare, QrCode, Send, Settings2, Trash2 } from "lucide-react";
import { botsApi } from "../../api/bots.js";
import { Alert } from "../../components/ui/Alert.jsx";
import { Spinner } from "../../components/ui/Spinner.jsx";
import { StatusBadge } from "../../components/ui/Badge.jsx";
import { BotConfigModal } from "../../components/bots/BotConfigModal.jsx";
import { SendDMModal } from "../../components/bots/SendDMModal.jsx";

function toLocalDateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function detectMediaType(file) {
  if (!file) return null;
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "document";
}

function statusTone(status) {
  if (status === "posted") return "success";
  if (status === "failed") return "error";
  return "info";
}

export function BotWorkspace({ user, onRefreshDashboard }) {
  const navigate = useNavigate();
  const { botId } = useParams();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [refreshingPosts, setRefreshingPosts] = useState(false);
  const [bot, setBot] = useState(null);
  const [posts, setPosts] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState({ text: "", type: "info" });
  const [configBot, setConfigBot] = useState(null);
  const [dmBot, setDmBot] = useState(null);
  const [deletingPostId, setDeletingPostId] = useState(null);
  const [form, setForm] = useState({
    text: "",
    scheduleAt: "",
    backgroundColor: "#075e54",
    font: "0",
  });
  const [selectedFile, setSelectedFile] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [{ bot: loadedBot }, { posts: loadedPosts }] = await Promise.all([
        botsApi.get(botId),
        botsApi.listStatusPosts(botId, 100),
      ]);
      setBot(loadedBot);
      setPosts(loadedPosts ?? []);
    } catch (err) {
      setError(err.message || "Could not load this bot workspace.");
    } finally {
      setLoading(false);
    }
  }, [botId]);

  const refreshBot = useCallback(async () => {
    try {
      const { bot: loadedBot } = await botsApi.get(botId);
      setBot(loadedBot);
    } catch (err) {
      setNotice({ text: err.message || "Could not refresh bot details.", type: "error" });
    }
  }, [botId]);

  const refreshPosts = useCallback(async () => {
    setRefreshingPosts(true);
    try {
      const { posts: loadedPosts } = await botsApi.listStatusPosts(botId, 100);
      setPosts(loadedPosts ?? []);
    } catch (err) {
      setNotice({ text: err.message || "Could not refresh scheduled posts.", type: "error" });
    } finally {
      setRefreshingPosts(false);
    }
  }, [botId]);

  useEffect(() => {
    load();
  }, [load]);

  const scheduledPosts = useMemo(
    () => posts.filter((post) => post.status === "scheduled").sort((a, b) => new Date(a.publish_at) - new Date(b.publish_at)),
    [posts]
  );

  const recentPosts = useMemo(
    () => posts.filter((post) => post.status !== "scheduled").sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 12),
    [posts]
  );

  const handleFileChange = (event) => {
    setSelectedFile(event.target.files?.[0] ?? null);
  };

  const buildPayload = useCallback(async () => {
    const trimmedText = form.text.trim();
    if (!trimmedText && !selectedFile) {
      throw new Error("Add text or choose a media file first.");
    }

    if (!selectedFile) {
      return {
        message: trimmedText,
        backgroundColor: form.backgroundColor,
        font: Number(form.font),
      };
    }

    if (selectedFile.size > 16 * 1024 * 1024) {
      throw new Error("Media file too large. Maximum size is 16MB.");
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(selectedFile);
    });

    return {
      message: {
        media: {
          type: detectMediaType(selectedFile),
          url: dataUrl,
          caption: trimmedText,
          fileName: selectedFile.name,
          mimetype: selectedFile.type,
        },
      },
      backgroundColor: form.backgroundColor,
      font: Number(form.font),
    };
  }, [form.backgroundColor, form.font, form.text, selectedFile]);

  const submitPost = async (mode) => {
    if (!bot) return;
    setSubmitting(true);
    setNotice({ text: "", type: "info" });

    try {
      const payload = await buildPayload();
      if (mode === "schedule") {
        if (!form.scheduleAt) {
          throw new Error("Choose a schedule time first.");
        }
        payload.publish_at = new Date(form.scheduleAt).toISOString();
      }

      const response = await botsApi.createStatusPost(bot.id, payload);
      setNotice({
        text: response.message || (mode === "schedule" ? "Status post scheduled." : "Status posted successfully."),
        type: "success",
      });
      setForm((current) => ({ ...current, text: "", scheduleAt: "" }));
      setSelectedFile(null);
      const fileInput = document.getElementById("status-post-file");
      if (fileInput) fileInput.value = "";
      await Promise.all([refreshPosts(), refreshBot()]);
      onRefreshDashboard?.();
    } catch (err) {
      setNotice({ text: err.message || "Could not create status post.", type: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  const deleteScheduledPost = async (postId) => {
    setDeletingPostId(postId);
    try {
      await botsApi.deleteStatusPost(botId, postId);
      setPosts((current) => current.filter((post) => post.id !== postId));
      setNotice({ text: "Scheduled post deleted.", type: "success" });
    } catch (err) {
      setNotice({ text: err.message || "Could not delete scheduled post.", type: "error" });
    } finally {
      setDeletingPostId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-[calc(100dvh-8.5rem)] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!bot) {
    return <Alert type="error">{error || "Bot not found."}</Alert>;
  }

  return (
    <>
      {configBot && (
        <BotConfigModal
          bot={configBot}
          user={user}
          onClose={() => setConfigBot(null)}
          onSaved={(updated) => {
            setBot((current) => ({ ...current, ...updated }));
            setConfigBot((current) => (current ? { ...current, ...updated } : null));
            onRefreshDashboard?.();
          }}
        />
      )}
      {dmBot && <SendDMModal bot={dmBot} onClose={() => setDmBot(null)} />}

      <div className="flex flex-col gap-5">
        <section className="rounded-[30px] border border-white/10 bg-[var(--card)] p-5 shadow-lg">
          <button
            className="inline-flex items-center gap-2 text-sm font-medium text-[var(--text2)] transition hover:text-[var(--text)]"
            onClick={() => navigate("/dashboard")}
          >
            <ArrowLeft size={16} />
            Back to all bots
          </button>

          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text3)]">Bot Workspace</div>
              <h2 className="mt-2 text-3xl font-semibold text-[var(--text)]">{bot.bot_name}</h2>
              <p className="mt-2 max-w-2xl text-sm text-[var(--text2)]">
                A dedicated control room for this bot. Configure automations, open pairing tools, send manual messages, and manage WhatsApp status posts from one place.
              </p>
            </div>
            <StatusBadge status={bot.status} />
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <button className="rounded-[22px] border border-white/10 bg-white/5 p-4 text-left transition hover:border-[var(--border-accent)]" onClick={() => setConfigBot(bot)}>
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]"><Settings2 size={16} /> Setup & automation</div>
              <div className="mt-2 text-xs text-[var(--text3)]">Open the full bot configuration panel.</div>
            </button>

            <button className="rounded-[22px] border border-white/10 bg-white/5 p-4 text-left transition hover:border-[var(--border-accent)]" onClick={() => setConfigBot({ ...bot, _openQr: true })}>
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]"><QrCode size={16} /> Pairing & reconnect</div>
              <div className="mt-2 text-xs text-[var(--text3)]">Manage QR and pairing code auth for this session.</div>
            </button>

            <button className="rounded-[22px] border border-white/10 bg-white/5 p-4 text-left transition hover:border-[var(--border-accent)] disabled:opacity-50" onClick={() => setDmBot(bot)} disabled={bot.status !== "connected"}>
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]"><MessageSquare size={16} /> Send message</div>
              <div className="mt-2 text-xs text-[var(--text3)]">Manually send a DM or media message from this bot.</div>
            </button>

            <div className="rounded-[22px] border border-white/10 bg-white/5 p-4">
              <div className="text-sm font-semibold text-[var(--text)]">Status posting ready</div>
              <div className="mt-2 text-xs text-[var(--text3)]">Immediate publish and future scheduling are both available below.</div>
            </div>
          </div>
        </section>

        {notice.text && <Alert type={notice.type}>{notice.text}</Alert>}
        {error && <Alert type="error">{error}</Alert>}

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <section className="rounded-[30px] border border-white/10 bg-[var(--card)] p-5 shadow-lg">
            <div className="flex items-center gap-3">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-dim)] text-[var(--accent)]">
                <ImagePlus size={20} />
              </div>
              <div>
                <h3 className="text-xl font-semibold text-[var(--text)]">Post to WhatsApp Status</h3>
                <p className="text-sm text-[var(--text2)]">Publish text, images, videos, audio, or document-style media as a status update.</p>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-4">
              <div className="field">
                <label className="field-label">Status text or caption</label>
                <textarea
                  className="input min-h-[150px] resize-y"
                  value={form.text}
                  onChange={(event) => setForm((current) => ({ ...current, text: event.target.value }))}
                  placeholder="Write a text status or add a caption for media..."
                />
              </div>

              <div className="field">
                <label className="field-label">Media file (optional)</label>
                <input
                  id="status-post-file"
                  type="file"
                  accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                  className="text-sm text-[var(--text2)]"
                  onChange={handleFileChange}
                />
                <div className="mt-2 text-xs text-[var(--text3)]">
                  Supports images, videos, audio, PDFs, and office files up to 16MB.
                </div>
                {selectedFile && (
                  <div className="mt-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-[var(--text2)]">
                    Selected: {selectedFile.name}
                  </div>
                )}
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="field">
                  <label className="field-label">Text status background</label>
                  <input
                    type="color"
                    className="h-12 w-full rounded-2xl border border-white/10 bg-transparent"
                    value={form.backgroundColor}
                    onChange={(event) => setForm((current) => ({ ...current, backgroundColor: event.target.value }))}
                  />
                </div>

                <div className="field">
                  <label className="field-label">Text status font</label>
                  <select
                    className="input h-12"
                    value={form.font}
                    onChange={(event) => setForm((current) => ({ ...current, font: event.target.value }))}
                  >
                    {Array.from({ length: 6 }).map((_, index) => (
                      <option key={index} value={String(index)}>Font {index}</option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="field-label">Schedule for later</label>
                  <input
                    type="datetime-local"
                    className="input h-12"
                    value={form.scheduleAt}
                    onChange={(event) => setForm((current) => ({ ...current, scheduleAt: event.target.value }))}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <button className="btn btn-primary" disabled={submitting || bot.status !== "connected"} onClick={() => submitPost("now")}>
                  {submitting ? <><Spinner size="sm" /> Working…</> : <><Send size={16} /> Post now</>}
                </button>
                <button className="btn btn-secondary" disabled={submitting} onClick={() => submitPost("schedule")}>
                  <CalendarClock size={16} />
                  Schedule post
                </button>
              </div>
              {bot.status !== "connected" && (
                <div className="text-xs text-[var(--warning)]">
                  This bot must be connected before it can publish a status.
                </div>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-5">
            <div className="rounded-[30px] border border-white/10 bg-[var(--card)] p-5 shadow-lg">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold text-[var(--text)]">Scheduled posts</h3>
                  <p className="text-sm text-[var(--text2)]">Delete any scheduled status before it goes out.</p>
                </div>
                <button className="btn btn-ghost" onClick={refreshPosts} disabled={refreshingPosts}>
                  {refreshingPosts ? <Spinner size="sm" /> : "Refresh"}
                </button>
              </div>

              <div className="mt-4 flex flex-col gap-3">
                {scheduledPosts.length === 0 && (
                  <div className="rounded-[22px] border border-dashed border-white/10 bg-black/10 p-5 text-sm text-[var(--text3)]">
                    No scheduled posts yet.
                  </div>
                )}

                {scheduledPosts.map((post) => (
                  <div key={post.id} className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-[var(--text)]">{post.caption || "Media-only scheduled status"}</div>
                        <div className="mt-1 text-xs text-[var(--text3)]">
                          Publishes {new Date(post.publish_at).toLocaleString()}
                        </div>
                        {post.media_type && (
                          <div className="mt-2 text-xs text-[var(--text2)]">Media: {post.media_type}</div>
                        )}
                      </div>
                      <button
                        className="inline-flex items-center gap-2 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
                        onClick={() => deleteScheduledPost(post.id)}
                        disabled={deletingPostId === post.id}
                      >
                        {deletingPostId === post.id ? <Spinner size="sm" /> : <Trash2 size={15} />}
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[30px] border border-white/10 bg-[var(--card)] p-5 shadow-lg">
              <h3 className="text-xl font-semibold text-[var(--text)]">Recent status activity</h3>
              <div className="mt-4 flex flex-col gap-3">
                {recentPosts.length === 0 && (
                  <div className="rounded-[22px] border border-dashed border-white/10 bg-black/10 p-5 text-sm text-[var(--text3)]">
                    No recent status activity yet.
                  </div>
                )}
                {recentPosts.map((post) => (
                  <div key={post.id} className="rounded-[22px] border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[var(--text)]">{post.caption || "Status update"}</div>
                        <div className="mt-1 text-xs text-[var(--text3)]">
                          {post.posted_at ? `Posted ${new Date(post.posted_at).toLocaleString()}` : `Created ${new Date(post.created_at).toLocaleString()}`}
                        </div>
                        {post.error_message && <div className="mt-2 text-xs text-rose-200">{post.error_message}</div>}
                      </div>
                      <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                        statusTone(post.status) === "success"
                          ? "bg-emerald-500/10 text-emerald-200"
                          : statusTone(post.status) === "error"
                            ? "bg-rose-500/10 text-rose-200"
                            : "bg-white/10 text-[var(--text2)]"
                      }`}>
                        {post.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

export default BotWorkspace;
