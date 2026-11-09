import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
}

interface SelectMenuProps<T extends string> {
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  title?: string;
}

interface MenuPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
}

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  title
}: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const [position, setPosition] = useState<MenuPosition>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = options[selectedIndex] ?? options[0];

  const positionMenu = (): MenuPosition | undefined => {
    const trigger = triggerRef.current;
    if (!trigger) return undefined;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 132);
    const estimatedHeight = options.length * 40 + 12;
    const openAbove = window.innerHeight - rect.bottom < estimatedHeight + 8 && rect.top > estimatedHeight + 8;
    return {
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width
    };
  };

  const showMenu = () => {
    setActiveIndex(Math.max(0, selectedIndex));
    setPosition(positionMenu());
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  };

  useEffect(() => {
    if (!open) return;
    const reposition = () => setPosition(positionMenu());
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
    };
  }, [open, options.length]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) showMenu();
        else setActiveIndex((index) => Math.min(options.length - 1, index + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (!open) showMenu();
        else setActiveIndex((index) => Math.max(0, index - 1));
        break;
      case 'Home':
        if (!open) return;
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        if (!open) return;
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) choose(activeIndex);
        else showMenu();
        break;
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        closeMenu(true);
        break;
      case 'Tab':
        if (open) closeMenu();
        break;
    }
  };

  return (
    <div className="select-menu">
      <button
        ref={triggerRef}
        className="select-menu__trigger"
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        data-value={value}
        title={title}
        onClick={() => open ? closeMenu() : showMenu()}
        onKeyDown={handleKeyDown}
      >
        <span className="select-menu__value">{selectedOption?.label}</span>
        <ChevronDown className="select-menu__chevron" size={15} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && position && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className="select-menu__listbox"
          role="listbox"
          aria-label={ariaLabel}
          style={{
            top: position.top,
            bottom: position.bottom,
            left: position.left,
            width: position.width
          }}
        >
          {options.map((option, index) => (
            <button
              id={`${listboxId}-option-${index}`}
              key={option.value}
              className={`select-menu__option${index === activeIndex ? ' is-active' : ''}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} strokeWidth={2.2} aria-hidden="true" />}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
