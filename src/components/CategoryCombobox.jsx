import { useEffect, useMemo, useRef, useState } from 'react';

export default function CategoryCombobox({
  id,
  value = '',
  onChange,
  suggestions = [],
  placeholder = '',
  disabled = false,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);
  const safeId = String(id || 'category-combobox').trim() || 'category-combobox';
  const optionsId = `${safeId}-options`;
  const normalizedSuggestions = useMemo(() => {
    const seen = new Set();
    return suggestions
      .map((item) => String(item || '').trim())
      .filter((item) => {
        if (!item || seen.has(item.toLowerCase())) return false;
        seen.add(item.toLowerCase());
        return true;
      });
  }, [suggestions]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (wrapperRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const updateValue = (nextValue) => {
    onChange?.(nextValue);
  };

  const chooseCategory = (category) => {
    updateValue(category);
    setOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus?.());
  };

  return (
    <div
      ref={wrapperRef}
      className={`studyhub-category-combobox${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
    >
      <input
        ref={inputRef}
        id={safeId}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(event) => updateValue(event.target.value)}
        onFocus={() => {
          if (!disabled) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!disabled) setOpen(true);
          }
          if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls={optionsId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
      />
      <button
        type="button"
        className="studyhub-category-combobox-toggle"
        aria-label="Show category options"
        aria-expanded={open}
        aria-controls={optionsId}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
          requestAnimationFrame(() => inputRef.current?.focus?.());
        }}
        disabled={disabled}
      >
        ▾
      </button>
      {open && normalizedSuggestions.length > 0 && (
        <ul id={optionsId} className="studyhub-category-combobox-list" role="listbox">
          {normalizedSuggestions.map((category) => (
            <li key={`${safeId}-${category}`} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={String(value || '').trim().toLowerCase() === category.toLowerCase()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseCategory(category)}
              >
                {category}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
