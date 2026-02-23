import React, { useState, useRef, useEffect } from 'react';
import { useT } from '../../shared/i18n';

interface Option {
  id: string;
  name: string;
  description?: string;
}

interface Props {
  label: string;
  selected: string[];
  options: Option[];
  onChange: (selected: string[]) => void;
  allowCustom?: boolean;
  placeholder?: string;
}

export const MultiSelect: React.FC<Props> = ({
  label, selected, options, onChange, allowCustom, placeholder,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const t = useT();

  const normalizeCustomValue = (value: string): string => value.trim();

  const hasValue = (items: string[], value: string): boolean =>
    items.some(item => item.toLowerCase() === value.toLowerCase());

  const hasOption = (value: string): boolean =>
    options.some(option => option.id.toLowerCase() === value.toLowerCase() || option.name.toLowerCase() === value.toLowerCase());

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        if (isOpen) {
          const normalized = normalizeCustomValue(search);
          if (allowCustom && normalized && !hasValue(selected, normalized) && !hasOption(normalized)) {
            onChange([...selected, normalized]);
          }
          setIsOpen(false);
          setSearch('');
        }
      }
    };
    document.addEventListener('pointerdown', handleClick, true);
    return () => document.removeEventListener('pointerdown', handleClick, true);
  }, [allowCustom, isOpen, onChange, options, search, selected]);

  const filteredOptions = options.filter(o =>
    o.name.toLowerCase().includes(search.toLowerCase()) ||
    (o.description || '').toLowerCase().includes(search.toLowerCase())
  );

  // Custom selected items that are not in the options list
  const customSelectedItems = selected.filter(id => !options.find(o => o.id === id));

  const toggleSelected = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter(s => s !== id)
      : [...selected, id];
    onChange(next);
  };

  const addCustom = () => {
    const normalized = normalizeCustomValue(search);
    if (!normalized || hasValue(selected, normalized) || hasOption(normalized)) {
      return;
    }

    onChange([...selected, normalized]);
    setIsOpen(false);
    setSearch('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && allowCustom && search) {
      e.preventDefault();
      addCustom();
      return;
    }
    if (e.key === 'Escape') {
      setIsOpen(false);
      setSearch('');
      return;
    }
    if (e.key === 'Tab') {
      if (allowCustom && search) {
        const normalized = normalizeCustomValue(search);
        if (normalized && !hasValue(selected, normalized) && !hasOption(normalized)) {
          onChange([...selected, normalized]);
        }
      }
      setIsOpen(false);
      setSearch('');
    }
  };

  return (
    <div style={styles.field} ref={containerRef}>
      <label style={styles.label}>{label}</label>

      {/* Selected chips */}
      <div style={styles.chipsContainer}>
        {selected.map(id => {
          const opt = options.find(o => o.id === id);
          return (
            <span key={id} style={styles.chip}>
              {opt?.name || id}
              <button style={styles.chipRemove} onClick={() => onChange(selected.filter(s => s !== id))}>✕</button>
            </span>
          );
        })}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onFocus={() => setIsOpen(true)}
          onBlur={() => {
            requestAnimationFrame(() => {
              if (!containerRef.current?.contains(document.activeElement)) {
                const normalized = normalizeCustomValue(search);
                if (allowCustom && normalized && !hasValue(selected, normalized) && !hasOption(normalized)) {
                  onChange([...selected, normalized]);
                }
                setIsOpen(false);
                setSearch('');
              }
            });
          }}
          onKeyDown={handleKeyDown}
          placeholder={selected.length === 0 ? placeholder : ''}
          style={styles.input}
        />
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div style={styles.dropdown}>
          <div style={styles.dropdownScroll}>
            {/* Show custom selected items */}
            {customSelectedItems.length > 0 && customSelectedItems.map(id => (
              <button
                key={id}
                style={{
                  ...styles.option,
                  ...(selected.includes(id) ? styles.optionSelected : {}),
                }}
                onClick={() => toggleSelected(id)}
              >
                <span style={styles.optionCheck}>
                  {selected.includes(id) ? '☑' : '☐'}
                </span>
                <div style={styles.optionContent}>
                  <span style={styles.optionName}>{id}</span>
                </div>
              </button>
            ))}
            {filteredOptions.length > 0 ? (
              filteredOptions.map(opt => (
                <button
                  key={opt.id}
                  style={{
                    ...styles.option,
                    ...(selected.includes(opt.id) ? styles.optionSelected : {}),
                  }}
                  onClick={() => toggleSelected(opt.id)}
                >
                  <span style={styles.optionCheck}>
                    {selected.includes(opt.id) ? '☑' : '☐'}
                  </span>
                  <div style={styles.optionContent}>
                    <span style={styles.optionName}>{opt.name}</span>
                    {opt.description && (
                      <span style={styles.optionDesc}>{opt.description}</span>
                    )}
                  </div>
                </button>
              ))
            ) : customSelectedItems.length === 0 ? (
              <div style={styles.noResults}>
                {allowCustom && search ? (
                  <button style={styles.addCustomBtn} onClick={addCustom}>
                    + {t('multiSelect.add')} "{search}"
                  </button>
                ) : (
                  <span>{t('multiSelect.noResults')}</span>
                )}
              </div>
            ) : allowCustom && search ? (
              <button style={styles.addCustomBtn} onClick={addCustom}>
                + {t('multiSelect.add')} "{search}"
              </button>
            ) : null}
            {allowCustom && search && filteredOptions.length > 0 && !options.find(o => o.id === search) && (
              <button style={styles.addCustomBtn} onClick={addCustom}>
                + {t('multiSelect.add')} "{search}"
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    position: 'relative',
  },
  label: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
  },
  chipsContainer: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    padding: '4px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    minHeight: '32px',
    alignItems: 'center',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 6px',
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderRadius: '10px',
    fontSize: '11px',
    whiteSpace: 'nowrap' as const,
  },
  chipRemove: {
    background: 'none',
    border: 'none',
    color: 'inherit',
    cursor: 'pointer',
    padding: '0 2px',
    fontSize: '10px',
    opacity: 0.8,
  },
  input: {
    flex: 1,
    minWidth: '80px',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    padding: '2px 4px',
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    zIndex: 100,
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    marginTop: '2px',
    display: 'flex',
    flexDirection: 'column',
  },
  dropdownScroll: {
    maxHeight: '200px',
    overflowY: 'auto',
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '6px 8px',
    background: 'none',
    border: 'none',
    color: 'var(--vscode-menu-foreground, var(--vscode-foreground))',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    textAlign: 'left',
  },
  optionSelected: {
    background: 'var(--vscode-list-hoverBackground)',
  },
  optionCheck: {
    fontSize: '14px',
    flexShrink: 0,
  },
  optionContent: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
  },
  optionName: {
    fontWeight: 500,
  },
  optionDesc: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  noResults: {
    padding: '8px',
    textAlign: 'center',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '12px',
  },
  addCustomBtn: {
    display: 'block',
    width: '100%',
    padding: '6px 8px',
    background: 'none',
    border: 'none',
    borderTop: '1px solid var(--vscode-panel-border)',
    color: 'var(--vscode-textLink-foreground)',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    textAlign: 'left',
  },
};
