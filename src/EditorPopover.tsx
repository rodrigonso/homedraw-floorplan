import { useEffect, useRef, type ReactNode } from "react";

export default function EditorPopover({ label, trigger, children, className = "" }: {
  label: string; trigger: ReactNode; children: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const details = ref.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const details = ref.current;
      if (event.key !== "Escape" || !details?.open) return;
      event.preventDefault();
      event.stopPropagation();
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, []);
  return <details ref={ref} className={`editor-popover ${className}`} onToggle={event => {
    const details = event.currentTarget;
    if (details.open) {
      details.closest(".app")?.querySelectorAll<HTMLDetailsElement>(".editor-popover[open]").forEach(other => {
        if (other !== details) other.open = false;
      });
    }
  }} onKeyDown={event => {
    if (event.currentTarget.open && !event.ctrlKey && !event.metaKey) event.stopPropagation();
  }} onClick={event => {
    if (event.target instanceof Element && event.target.closest("[data-close-popover]")) {
      ref.current!.open = false;
      ref.current!.querySelector("summary")?.focus();
    }
  }}>
    <summary className="popover-trigger" aria-label={label} title={label}>{trigger}</summary>
    <div className="menu-popover">{children}</div>
  </details>;
}
