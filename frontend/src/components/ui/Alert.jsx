import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "lucide-react";

export function Alert({ type = "error", children, ...props }) {
  const variants = {
    error: {
      cls: "border-rose-500/25 bg-rose-500/10 text-rose-200",
      Icon: AlertCircle,
    },
    success: {
      cls: "border-emerald-500/25 bg-emerald-500/10 text-emerald-200",
      Icon: CheckCircle2,
    },
    warning: {
      cls: "border-amber-500/25 bg-amber-500/10 text-amber-200",
      Icon: TriangleAlert,
    },
    info: {
      cls: "border-[var(--border-accent)] bg-[var(--accent-dim)] text-[var(--text)]",
      Icon: Info,
    },
  };

  const variant = variants[type] ?? variants.error;
  const Icon = variant.Icon;

  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${variant.cls}`}
      {...props}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
