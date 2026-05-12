export function Spinner({ size = "md" }) {
  return <span className={`spinner spinner-${size}`} />;
}

export function PageSpinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
      <Spinner size="lg" />
    </div>
  );
}
