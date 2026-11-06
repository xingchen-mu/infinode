import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface DropdownOption<T extends string | number> {
  value: T;
  label: ReactNode;
  desc?: ReactNode;
  disabled?: boolean;
  title?: string;
  /** Heading shown above the first option of each section. */
  section?: string;
  /** Rendered as a command (e.g. "管理工作流…") rather than a choice. */
  action?: boolean;
}

/** Compact select that opens upwards (the composer sits at the bottom). */
export function Dropdown<T extends string | number>(props: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  icon?: ReactNode;
  display?: ReactNode;
  title?: string;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  const current = props.options.find((o) => o.value === props.value);
  return (
    <div className="dd" ref={ref}>
      <button className={`dd-btn ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)} title={props.title}>
        {props.icon}
        <span>{props.display ?? current?.label ?? String(props.value)}</span>
        <ChevronDown className="dd-caret" />
      </button>
      {open && (
        <div className={`dd-menu ${props.wide ? 'wide' : ''}`} data-scrollable>
          {props.options.map((o, i) => (
            <div key={String(o.value)}>
              {o.section && o.section !== props.options[i - 1]?.section && <div className="dd-section">{o.section}</div>}
              <button
                className={`dd-item ${o.value === props.value ? 'on' : ''} ${o.action ? 'action' : ''}`}
                disabled={o.disabled}
                title={o.title}
                onClick={() => {
                  props.onChange(o.value);
                  setOpen(false);
                }}
              >
                <div className="dd-item-main">
                  <span>{o.label}</span>
                  {o.desc && <small>{o.desc}</small>}
                </div>
                {o.value === props.value && <Check className="dd-check" />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
