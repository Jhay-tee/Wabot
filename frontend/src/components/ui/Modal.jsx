import { X } from "lucide-react";

export function Modal({ onClose, wide, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`relative max-h-[90vh] w-full overflow-hidden rounded-[28px] border border-white/10 bg-[var(--card)] shadow-2xl ${wide ? "max-w-6xl" : "max-w-2xl"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="absolute right-4 top-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[var(--text2)] transition hover:border-[var(--border-accent)] hover:text-[var(--text)]"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <div className="max-h-[90vh] overflow-y-auto p-6 md:p-8">
          {children}
        </div>
      </div>
    </div>
  );
}
