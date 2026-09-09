"use client";
import { useEffect, useRef } from "react";

export function useDialogFocus(onClose: () => void, enabled = true) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    const controls = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ) ?? [],
      );
    controls()[0]?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const elements = controls();
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener("keydown", handle);
    return () => {
      dialog?.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, [enabled]);
  return ref;
}
