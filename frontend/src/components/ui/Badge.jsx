const STATUS_MAP = {
  connected:        { cls: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200", label: "Connected" },
  active:           { cls: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200", label: "Active" },
  idle:             { cls: "border-white/10 bg-white/5 text-[var(--text2)]", label: "Idle" },
  awaiting_pairing: { cls: "border-amber-500/20 bg-amber-500/10 text-amber-200", label: "Awaiting Code" },
  awaiting_code:    { cls: "border-amber-500/20 bg-amber-500/10 text-amber-200", label: "Awaiting Code" },
  code_generated:   { cls: "border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--accent)]", label: "Code Ready" },
  awaiting_link:    { cls: "border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--accent)]", label: "Awaiting Link" },
  awaiting_qr:      { cls: "border-amber-500/20 bg-amber-500/10 text-amber-200", label: "Awaiting QR" },
  awaiting_qr_scan: { cls: "border-amber-500/20 bg-amber-500/10 text-amber-200", label: "Awaiting QR" },
  qr_generated:     { cls: "border-amber-500/20 bg-amber-500/10 text-amber-200", label: "QR Ready" },
  connecting:       { cls: "border-amber-500/20 bg-amber-500/10 text-amber-200", label: "Connecting…" },
  reconnecting:     { cls: "border-amber-500/20 bg-amber-500/10 text-amber-200", label: "Reconnecting" },
  disconnected:     { cls: "border-white/10 bg-white/5 text-[var(--text2)]", label: "Disconnected" },
  qr_timeout:       { cls: "border-white/10 bg-white/5 text-[var(--text2)]", label: "QR Timeout" },
  failed:           { cls: "border-rose-500/20 bg-rose-500/10 text-rose-200", label: "Failed" },
  error:            { cls: "border-rose-500/20 bg-rose-500/10 text-rose-200", label: "Error" },
  free:             { cls: "border-sky-500/20 bg-sky-500/10 text-sky-200", label: "Free" },
  paid:             { cls: "border-[var(--border-accent)] bg-[var(--accent)] text-white", label: "Pro" },
};

export function StatusBadge({ status }) {
  const { cls, label } = STATUS_MAP[status] ?? { cls: "border-white/10 bg-white/5 text-[var(--text2)]", label: status ?? "Unknown" };
  return <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${cls}`}>{label}</span>;
}

export function PlanBadge({ plan }) {
  const isPro = plan === "paid";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${
        isPro
          ? "border-[var(--border-accent)] bg-[var(--accent)] text-white"
          : "border-sky-500/20 bg-sky-500/10 text-sky-200"
      }`}
    >
      {isPro ? "Pro" : "Free"}
    </span>
  );
}
