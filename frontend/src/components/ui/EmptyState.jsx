export function EmptyState({ icon, title, desc, action }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {desc   && <div className="empty-desc">{desc}</div>}
      {action && <div style={{ marginTop: "1rem" }}>{action}</div>}
    </div>
  );
}
