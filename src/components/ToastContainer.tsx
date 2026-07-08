// Unified toast stack - renders the store's toast queue at a fixed
// bottom-center position. Each toast auto-dismisses after its own duration
// (0 = persistent until removed) and can always be dismissed by click.

import { useEffect } from "react";
import { useStore } from "../store";
import type { Toast } from "../store";

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useStore((s) => s.removeToast);

  useEffect(() => {
    if (toast.duration <= 0) return;
    const t = setTimeout(() => removeToast(toast.id), toast.duration);
    return () => clearTimeout(t);
  }, [toast.id, toast.duration, removeToast]);

  return (
    <div
      className={`toast-item toast-item--${toast.type}`}
      role="status"
      onClick={() => removeToast(toast.id)}
      title="Dismiss"
    >
      {toast.message}
    </div>
  );
}

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
