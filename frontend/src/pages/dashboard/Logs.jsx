import { useState } from "react";
import { EmptyState } from "../../components/ui/EmptyState.jsx";
import { timeAgo }   from "../../utils/format.js";

const EVENT_ICONS = {
  bot_deployed:        "🚀",
  deploy_started:      "🚀",
  bot_connected:       "✅",
  bot_disconnected:    "🔌",
  message_received:    "💬",
  auto_reply_sent:     "🤖",
  keyword_reply_sent:  "🔑",
  ai_reply_sent:       "🧠",
  ai_response:         "🧠",
  command_handled:     "⌨️",
  api_message_sent:    "📤",
  dm_sent:             "📤",
  broadcast_sent:      "📢",
  webhook_fired:       "🔗",
  webhook_sent:        "🔗",
  bot_updated:         "✏️",
  bot_deleted:         "🗑️",
  error:               "⚠️",
};

export function Logs({ activity, bots }) {
  const botMap = Object.fromEntries((bots ?? []).map((b) => [b.id, b.bot_name]));
  const botIds = [...new Set(activity.map((a) => a.bot_id).filter(Boolean))];
  const [filter, setFilter] = useState("all");

  const filtered = filter === "all"
    ? activity
    : activity.filter((a) => a.bot_id === filter);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="section-heading">
        <span>Activity Logs</span>
        <select className="input"
          style={{ width: "auto", padding: "0.375rem 0.75rem", fontSize: "0.8125rem" }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All bots</option>
          {botIds.map((id) => (
            <option key={id} value={id}>{botMap[id] ?? id?.slice(0, 8)}</option>
          ))}
        </select>
      </div>

      <div className="card">
        {filtered.length === 0 ? (
          <EmptyState icon="📋" title="No logs yet"
            desc="Deploy a bot and start messaging — activity will appear here." />
        ) : (
          <div className="activity-list">
            {filtered.map((a) => (
              <div className="activity-row" key={a.id}>
                <div className="activity-dot" />
                <div className="flex-1">
                  <div className="activity-event" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span>{EVENT_ICONS[a.event_type] ?? "📌"}</span>
                    {a.event_type.replace(/_/g, " ")}
                    {a.bot_id && botMap[a.bot_id] && (
                      <span className="badge badge-inactive" style={{ fontSize: "0.65rem" }}>
                        {botMap[a.bot_id]}
                      </span>
                    )}
                  </div>
                  {a.details && <div className="activity-detail">{a.details}</div>}
                </div>
                <div className="activity-time">{timeAgo(a.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
