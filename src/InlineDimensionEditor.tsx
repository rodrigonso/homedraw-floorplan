import { useEffect, useRef, useState } from "react";
import type { Point } from "./model";

export default function InlineDimensionEditor({
  value, formatValue, parseValue, label = "Edit dimension", quantity = "length", tolerance = 0.01,
  hint, position, onApply, onClose,
}: {
  value: number;
  formatValue: (value: number) => string;
  parseValue: (text: string) => number;
  label?: string;
  quantity?: string;
  tolerance?: number;
  hint?: string;
  position: Point;
  onApply: (value: number) => boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState(() => formatValue(value));
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const close = () => {
    finished.current = true;
    onClose();
  };
  const apply = () => {
    if (finished.current) return;
    try {
      if (edited) {
        const next = parseValue(text);
        if (Math.abs(next - value) > tolerance && !onApply(next)) {
          setError(`This ${quantity} cannot be applied. See the properties panel.`);
          return;
        }
      }
      close();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setError(error.message);
    }
  };

  return <div className="inline-dimension-editor" style={{ left: position.x, top: position.y }}>
    <input ref={input} aria-label={label} aria-invalid={!!error}
      aria-describedby={error ? "inline-dimension-error" : "inline-dimension-hint"}
      value={text} spellCheck={false} onChange={event => { setText(event.target.value); setEdited(true); setError(""); }}
      onBlur={apply} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); apply(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      }} />
    {error ? <div id="inline-dimension-error" className="inline-dimension-error" role="alert">{error}</div>
      : <span id="inline-dimension-hint" className="inline-dimension-hint">Enter to apply / Esc to cancel{hint && <><br />{hint}</>}</span>}
  </div>;
}
