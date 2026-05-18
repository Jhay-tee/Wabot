import { StatusBadge }  from "../ui/Badge.jsx";
import { Spinner }       from "../ui/Spinner.jsx";
import { timeAgo }       from "../../utils/format.js";

export function BotCard({ bot, onConfigure, onShowQr, onSendDM, onDelete, deleting }) {
  const hasSalesAgent = bot.sales_agent_config?.enabled;
  const hasKeywords   = Array.isArray(bot.keyword_triggers) && bot.keyword_triggers.length > 0;

  return (
    <div className="bot-card" onClick={() => onConfigure(bot)}>
      <div className="bot-card-top">
        <div className="bot-card-icon">
          {bot.bot_type === "group" ? "👥" : bot.bot_type === "all" ? "🌐" : "🤖"}
        </div>
        <StatusBadge status={bot.status} />
      </div>

      <div>
        <div className="bot-card-name">{bot.bot_name}</div>
        {bot.description && (
          <div className="bot-card-desc" style={{ marginTop: "0.25rem" }}>{bot.description}</div>
        )}
        <div className="bot-card-meta">Created {timeAgo(bot.created_at)}</div>
      </div>

      <div className="bot-card-stats">
        <div className="bot-card-stat">
          Messages: <span>{(bot.messages_count ?? 0).toLocaleString()}</span>
        </div>
        <div className="bot-card-stat">
          This month: <span>{(bot.messages_this_month ?? 0).toLocaleString()}</span>
        </div>
        {bot.last_activity && (
          <div className="bot-card-stat">
            Last active: <span>{timeAgo(bot.last_activity)}</span>
          </div>
        )}
        {bot.webhook_url && (
          <div className="bot-card-stat">Webhook: <span style={{ color: "var(--success)" }}>✓</span></div>
        )}
        {bot.auto_reply_enabled && (
          <div className="bot-card-stat">Auto-reply: <span style={{ color: "var(--success)" }}>✓</span></div>
        )}
        {hasSalesAgent && (
          <div className="bot-card-stat">Sales agent: <span style={{ color: "var(--accent)" }}>✓</span></div>
        )}
        {hasKeywords && (
          <div className="bot-card-stat">Triggers: <span style={{ color: "var(--text2)" }}>{bot.keyword_triggers.length}</span></div>
        )}
      </div>

      <div className="bot-card-actions" onClick={(e) => e.stopPropagation()}>
        {(bot.status === "awaiting_qr_scan" || bot.status === "connecting" || bot.status === "reconnecting") && (
          <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}
            onClick={() => onShowQr(bot)}>
            Show QR
          </button>
        )}
        {(bot.status === "disconnected" || bot.status === "failed" || bot.status === "qr_timeout" || bot.status === "error") && (
          <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}
            onClick={() => onConfigure({ ...bot, _openQr: true })}>
            Reconnect
          </button>
        )}
        {bot.status === "connected" && onSendDM && (
          <button className="btn btn-success btn-sm" style={{ flex: 1 }}
            onClick={() => onSendDM(bot)}
            title="Send a direct WhatsApp message">
            💬 DM
          </button>
        )}
        <button className="btn btn-secondary btn-sm" style={{ flex: 1 }}
          onClick={() => onConfigure(bot)}>
          Configure
        </button>
        <button className="btn btn-danger btn-sm"
          disabled={deleting === bot.id}
          onClick={(e) => { e.stopPropagation(); onDelete(bot); }}>
          {deleting === bot.id ? <Spinner size="sm" /> : "Delete"}
        </button>
      </div>
    </div>
  );
}
