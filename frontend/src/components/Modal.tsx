import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

/** Lightweight centered overlay dialog. Closes on backdrop click or Escape. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      style={{ animation: "fade-in 0.15s ease-out" }}
    >
      <div
        className="bg-card border border-border/70 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border/60 bg-card/60 flex-shrink-0">
          <div className="font-semibold text-sm truncate min-w-0">{title}</div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground flex-shrink-0"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-4 min-h-0">{children}</div>
      </div>
    </div>
  );
}
