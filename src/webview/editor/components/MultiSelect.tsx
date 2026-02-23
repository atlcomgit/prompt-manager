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
  const [draft, setDraft] = useState<string[]>(selected);
  const containerRef = useRef<HTMLDivElement>(null);
  const t = useT();

  // Sync draft when selected changes externally or dropdown opens
  useEffect(() => {
    if (isOpen) {
      setDraft(selected);
    }
  }, [isOpen]);

  // Close on click outside — treat as cancel
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        if (isOpen) {
          setDraft(selected); // revert
          setIsOpen(false);
          setSearch('');
        }
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, selected]);

  const filteredOptions = options.filter(o =>
    o.name.toLowerCase().includes(search.toLowerCase()) ||
    (o.description || '').toLowerCase().includes(search.toLowerCase())
  );

  // Custom items in draft that are not in the options list
  const customDraftItems = draft.filter(id => !options.find(o => o.id === id));

  const toggleDraft = (id: string) => {
    setDraft(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  };

  const addCustom = () => {
    if (search && !draft.includes(search)) {
      setDraft(prev => [...prev, search]);
      setSearch('');
    }
  };

  const handleSave = () => {
    onChange(draft);
    setIsOpen(false);
    setSearch('');
  };

  const handleCancel = () => {
    setDraft(selected);
    setIsOpen(false);
    setSearch('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && allowCustom && search) {
      e.preventDefault();
      addCustom();
    }
    if (e.key === 'Escape') {
      handleCancel();
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
          onKeyDown={handleKeyDown}
          placeholder={selected.length === 0 ? placeholder : ''}
          style={styles.input}
        />
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div style={styles.dropdown}>
          <div style={styles.dropdownScroll}>
            {/* Show custom draft items */}
            {customDraftItems.length > 0 && customDraftItems.map(id => (
              <button
                key={id}
                style={{
                  ...styles.option,
                  ...(draft.includes(id) ? styles.optionSelected : {}),
                }}
                onClick={() => toggleDraft(id)}
              >
                <span style={styles.optionCheck}>
                  {draft.includes(id) ? '☑' : '☐'}
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
                    ...(draft.includes(opt.id) ? styles.optionSelected : {}),
                  }}
                  onClick={() => toggleDraft(opt.id)}
                >
                  <span style={styles.optionCheck}>
                    {draft.includes(opt.id) ? '☑' : '☐'}
                  </span>
                  <div style={styles.optionContent}>
                    <span style={styles.optionName}>{opt.name}</span>
                    {opt.description && (
                      <span style={styles.optionDesc}>{opt.description}</span>
                    )}
                  </div>
                </button>
              ))
            ) : customDraftItems.length === 0 ? (
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
          {/* Save / Cancel buttons */}
          <div style={styles.dropdownActions}>
            <button style={styles.cancelBtn} onClick={handleCancel}>{t('common.cancel')}</button>
            <button style={styles.saveBtn} onClick={handleSave}>{t('common.save')}</button>
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
  dropdownActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '6px',
    padding: '6px 8px',
    borderTop: '1px solid var(--vscode-panel-border)',
  },
  cancelBtn: {
    padding: '4px 12px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
  },
  saveBtn: {
    padding: '4px 12px',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
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
