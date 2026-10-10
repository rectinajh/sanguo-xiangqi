export type ToastItem = { id: string; title: string; body?: string; kind?: "slash" | "info" };

export function ToastHost({ items }: { items: ToastItem[] }) {
  return (
    <div className="toast-host">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "slash" ? "slash" : ""}`}>
          <div className="title">{t.title}</div>
          {t.body && <div className="body">{t.body}</div>}
        </div>
      ))}
    </div>
  );
}
