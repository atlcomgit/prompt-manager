import React from 'react';
import type { PromptStatus } from '../../types/prompt';
import { useT } from './i18n';
import { getPromptStatusColor, getPromptStatusLabel } from './promptStatus';

interface Props {
  status: PromptStatus;
  style?: React.CSSProperties;
  title?: string;
  variant?: 'plain' | 'badge';
}

/** Read-only prompt status text using the shared prompt-list color contract. */
export const PromptStatusText: React.FC<Props> = ({ status, style, title, variant = 'plain' }) => {
  const t = useT();
  const label = getPromptStatusLabel(status, t);
  const statusColor = getPromptStatusColor(status);

  // стиль статуса в шапке блока Заметки
  return (
    <span
      style={{
        ...styles.root,
        color: statusColor,
        ...(variant === 'badge' ? {
          ...styles.badge,
          borderColor: `color-mix(in srgb, ${statusColor} 70%, var(--vscode-panel-border))`,
          // background: `color-mix(in srgb, ${statusColor} 5%, var(--vscode-sideBar-background))`,
          background: `color-mix(in srgb, ${statusColor} 5%, white)`,
        } : null),
        ...style,
      }}
      title={title || label}
    >
      {label}
    </span>
  );
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    fontSize: '11px',
    fontWeight: 600,
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
  },
  badge: {
    padding: '2px 8px',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '6px',
  },
};