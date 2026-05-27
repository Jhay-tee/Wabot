import { Bot, FolderKanban, MessageSquare, QrCode, RefreshCcw, Settings2, Trash2, Users, Globe2, Link2, Sparkles, Hash } from "lucide-react";
import { StatusBadge } from "../ui/Badge.jsx";
import { Spinner } from "../ui/Spinner.jsx";
import { timeAgo } from "../../utils/format.js";

const TYPE_ICON = {
  dm: Bot,
  group: Users,
  all: Globe2,
};

export function BotCard({ bot, onOpenPage, onConfigure, onShowQr, onSendDM, onDelete, deleting }) {
  const hasSalesAgent = bot.sales_agent_config?.enabled;
  const hasKeywords = Array.isArray(bot.keyword_triggers) && bot.keyword_triggers.length > 0;
  const needsReconnect = ["disconnected", "failed", "qr_timeout", "error", "connecting", "reconnecting"].includes(bot.status);
  const isAwaitingPairing = ["awaiting_pairing", "awaiting_code", "code_generated", "awaiting_link"].includes(bot.status);
  const isAwaitingQR = ["awaiting_qr", "awaiting_qr_scan", "qr_generated"].includes(bot.status);
  const canSendDM = bot.status === "connected";
  const TypeIcon = TYPE_ICON[bot.bot_type] ?? Bot;

  return (
    <div
      className="group rounded-[28px] border border-white/10 bg-[var(--card)] p-5 shadow-lg transition hover:border-[var(--border-accent)] hover:bg-[var(--card2)]"
      onClick={() => onConfigure(bot)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-dim)] text-[var(--accent)]">
          <TypeIcon size={22} />
        </div>
        <StatusBadge status={bot.status} />
      </div>

      <div className="mt-5">
        <div className="text-lg font-semibold text-[var(--text)]">{bot.bot_name}</div>
        {bot.description && <div className="mt-2 line-clamp-2 text-sm text-[var(--text2)]">{bot.description}</div>}
        <div className="mt-3 text-xs uppercase tracking-[0.22em] text-[var(--text3)]">
          Created {timeAgo(bot.created_at)}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <Stat label="Messages" value={(bot.messages_count ?? 0).toLocaleString()} />
        <Stat label="This month" value={(bot.messages_this_month ?? 0).toLocaleString()} />
        {bot.last_activity && <Stat label="Last active" value={timeAgo(bot.last_activity)} />}
        <Stat label="Type" value={String(bot.bot_type ?? "dm").toUpperCase()} accent />
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {bot.webhook_url && <MiniPill icon={Link2} label="Webhook" />}
        {bot.auto_reply_enabled && <MiniPill icon={MessageSquare} label="Auto Reply" />}
        {hasSalesAgent && <MiniPill icon={Sparkles} label="Sales Agent" />}
        {hasKeywords && <MiniPill icon={Hash} label={`${bot.keyword_triggers.length} Triggers`} />}
      </div>

      <div className="mt-5 flex flex-wrap gap-2" onClick={(event) => event.stopPropagation()}>
        {isAwaitingPairing && (
          <ActionButton primary onClick={() => onConfigure({ ...bot, _openQr: true })} icon={QrCode} label="Pairing code" />
        )}

        {isAwaitingQR && (
          <ActionButton onClick={() => onShowQr?.(bot) ?? onConfigure({ ...bot, _openQr: true })} icon={QrCode} label="Show QR" />
        )}

        {needsReconnect && !isAwaitingPairing && !isAwaitingQR && (
          <ActionButton
            onClick={() => onConfigure({ ...bot, _openQr: true })}
            icon={RefreshCcw}
            label={bot.status === "connecting" || bot.status === "reconnecting" ? "Connecting" : "Reconnect"}
            disabled={bot.status === "connecting" || bot.status === "reconnecting"}
            busy={bot.status === "connecting" || bot.status === "reconnecting"}
          />
        )}

        {canSendDM && onSendDM && (
          <ActionButton success onClick={() => onSendDM(bot)} icon={MessageSquare} label="Send message" />
        )}

        {onOpenPage && (
          <ActionButton onClick={() => onOpenPage(bot)} icon={FolderKanban} label="Open page" />
        )}

        <ActionButton onClick={() => onConfigure(bot)} icon={Settings2} label="Configure" />

        <button
          className="inline-flex items-center gap-2 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={deleting === bot.id}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(bot);
          }}
        >
          {deleting === bot.id ? <Spinner size="sm" /> : <Trash2 size={16} />}
          <span>{deleting === bot.id ? "Deleting" : "Delete"}</span>
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, accent = false }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/10 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text3)]">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${accent ? "text-[var(--accent)]" : "text-[var(--text)]"}`}>{value}</div>
    </div>
  );
}

function MiniPill({ icon: Icon, label }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-[var(--text2)]">
      <Icon size={13} />
      {label}
    </span>
  );
}

function ActionButton({ icon: Icon, label, onClick, primary = false, success = false, disabled = false, busy = false }) {
  const variant = primary
    ? "border-[var(--border-accent)] bg-[var(--accent)] text-white"
    : success
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
      : "border-white/10 bg-white/5 text-[var(--text)]";

  return (
    <button
      className={`inline-flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm font-medium transition hover:border-[var(--border-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {busy ? <Spinner size="sm" /> : <Icon size={16} />}
      <span>{label}</span>
    </button>
  );
}
