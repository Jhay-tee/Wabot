export function EmptyState({ icon, title, desc, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-white/10 bg-black/10 px-6 py-12 text-center">
      {icon && <div className="mb-4 text-[var(--accent)]">{icon}</div>}
      <div className="text-lg font-semibold text-[var(--text)]">{title}</div>
      {desc && <div className="mt-2 max-w-xl text-sm text-[var(--text2)]">{desc}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
