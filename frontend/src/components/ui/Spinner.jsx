export function Spinner({ size = "md" }) {
  const sizes = {
    sm: "h-4 w-4 border-2",
    md: "h-5 w-5 border-2",
    lg: "h-8 w-8 border-[3px]",
  };

  return (
    <span
      className={`inline-block animate-spin rounded-full border-[color:var(--border)] border-t-[var(--accent)] ${sizes[size] ?? sizes.md}`}
      aria-hidden="true"
    />
  );
}

export function PageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--text)]">
      <Spinner size="lg" />
    </div>
  );
}
