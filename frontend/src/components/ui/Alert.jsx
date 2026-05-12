export function Alert({ type = "error", children, ...props }) {
  const cls = {
    error:   "alert-error",
    success: "alert-success",
    warning: "alert-warning",
    info:    "alert-info",
  }[type] ?? "alert-error";

  return <div className={`alert ${cls}`} {...props}>{children}</div>;
}
