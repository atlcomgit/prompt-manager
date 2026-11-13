import React from 'react';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}

/** Поле сжимается до доступного места, не задавая браузерную min-content ширину форме. */
export const TextField: React.FC<Props> = ({ label, value, onChange, placeholder, required }) => {
  return (
    <div style={styles.field}>
      <label style={styles.label}>
        {label}
        {required && <span style={styles.required}> *</span>}
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={styles.input}
      />
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  field: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    flex: 1,
  },
  label: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
  },
  required: {
    color: 'var(--vscode-errorForeground)',
  },
  input: {
    minWidth: 0,
    width: '100%',
    padding: '6px 8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    fontSize: '13px',
    fontFamily: 'var(--vscode-font-family)',
    outline: 'none',
  },
};
