const STATUS_MAP = {
  connected:        { cls: "badge-active",   label: "Connected"    },
  active:           { cls: "badge-active",   label: "Active"       },
  awaiting_qr_scan: { cls: "badge-pending",  label: "Awaiting QR"  },
  connecting:       { cls: "badge-pending",  label: "Connecting…"  },
  reconnecting:     { cls: "badge-pending",  label: "Reconnecting" },
  disconnected:     { cls: "badge-inactive", label: "Disconnected" },
  qr_timeout:       { cls: "badge-inactive", label: "QR Timeout"   },
  failed:           { cls: "badge-error",    label: "Failed"       },
  error:            { cls: "badge-error",    label: "Error"        },
  free:             { cls: "badge-free",     label: "Free"         },
  paid:             { cls: "badge-pro",      label: "Pro"          },
};

export function StatusBadge({ status }) {
  const { cls, label } = STATUS_MAP[status] ?? { cls: "badge-inactive", label: status ?? "Unknown" };
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function PlanBadge({ plan }) {
  const isPro = plan === "paid";
  return <span className={`badge ${isPro ? "badge-pro" : "badge-free"}`}>{isPro ? "Pro" : "Free"}</span>;
}
