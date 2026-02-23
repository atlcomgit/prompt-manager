import React, { useState } from 'react';
import type { PromptConfig } from '../../../types/prompt';
import { useT } from '../../shared/i18n';

interface Props {
  prompt: PromptConfig;
  isSelected: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onExport: (id: string) => void;
}

const STATUS_ICONS: Record<string, string> = {
  'draft': '📝',
  'in-progress': '�',
  'completed': '✅',
  'stopped': '⏹',
  'cancelled': '❌',
};


export const PromptItem: React.FC<Props> = ({
  prompt, isSelected, onOpen, onDelete, onDuplicate, onToggleFavorite, onExport,
}) => {
  const t = useT();
  const STATUS_LABELS: Record<string, string> = {
    'draft': t('status.draft'),
    'in-progress': t('status.inProgress'),
    'completed': t('status.completed'),
    'stopped': t('status.stopped'),
    'cancelled': t('status.cancelled'),
  };
  const [showActions, setShowActions] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const selFg = isSelected ? 'var(--vscode-list-activeSelectionForeground)' : undefined;

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div
      style={{
        ...styles.item,
        ...(isSelected ? styles.itemSelected : {}),
      }}
      onClick={() => onOpen(prompt.id)}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => { setShowActions(false); setShowMenu(false); }}
      title={prompt.description || prompt.title || prompt.id}
    >
      <div style={styles.row}>
        <span style={styles.statusIcon}>
          {STATUS_ICONS[prompt.status] || '📄'}
        </span>
        <div style={styles.content}>
          <div style={{ ...styles.title, ...(selFg ? { color: selFg } : {}) }}>
            {prompt.favorite && <span style={styles.star}>⭐</span>}
            {prompt.title || prompt.id}
          </div>
          {prompt.description && (
            <div style={{
              ...styles.description,
              ...(selFg ? { color: selFg, opacity: 0.85 } : {}),
            }}>{prompt.description}</div>
          )}
          {prompt.taskNumber && (
            <div style={{
              ...styles.taskBadge,
              ...(selFg ? { color: selFg } : {}),
            }}>
              🎫 {prompt.taskNumber}
            </div>
          )}
          <div style={{
            ...styles.meta,
            ...(selFg ? { color: selFg, opacity: 0.75 } : {}),
          }}>
            <span>{STATUS_LABELS[prompt.status]}</span>
            <span>·</span>
            <span>{formatDate(prompt.updatedAt)}</span>
            {prompt.languages.length > 0 && (
              <>
                <span>·</span>
                <span>{prompt.languages.slice(0, 2).join(', ')}</span>
              </>
            )}
          </div>
        </div>
        {showActions && (
          <div style={styles.actions}>
            <button
              style={{
                ...styles.actionBtn,
                ...(selFg ? { color: selFg } : {}),
              }}
              onClick={e => { e.stopPropagation(); onToggleFavorite(prompt.id); }}
              title={prompt.favorite ? t('item.removeFavorite') : t('item.addFavorite')}
            >
              {prompt.favorite ? '★' : '☆'}
            </button>
            <button
              style={{
                ...styles.actionBtn,
                ...(selFg ? { color: selFg } : {}),
              }}
              onClick={e => { e.stopPropagation(); setShowMenu(!showMenu); }}
              title={t('item.more')}
            >
              ⋯
            </button>
          </div>
        )}
      </div>
      {showMenu && (
        <div style={styles.menu}>
          <button style={styles.menuItem} onClick={e => { e.stopPropagation(); onDuplicate(prompt.id); setShowMenu(false); }}>
            📋 {t('item.duplicate')}
          </button>
          <button style={styles.menuItem} onClick={e => { e.stopPropagation(); onExport(prompt.id); setShowMenu(false); }}>
            📤 {t('item.export')}
          </button>
          <button style={{ ...styles.menuItem, ...styles.menuItemDanger }} onClick={e => { e.stopPropagation(); onDelete(prompt.id); setShowMenu(false); }}>
            🗑 {t('common.delete')}
          </button>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  item: {
    padding: '6px 8px',
    cursor: 'pointer',
    borderBottom: '1px solid var(--vscode-panel-border)',
    transition: 'background 0.1s',
    position: 'relative',
  },
  itemSelected: {
    background: 'var(--vscode-list-activeSelectionBackground)',
    color: 'var(--vscode-list-activeSelectionForeground)',
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
  },
  statusIcon: {
    fontSize: '14px',
    lineHeight: '20px',
    flexShrink: 0,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontWeight: 500,
    fontSize: '13px',
    lineHeight: '20px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  star: {
    fontSize: '10px',
  },
  description: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  taskBadge: {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--vscode-textLink-foreground)',
    marginTop: '2px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  meta: {
    display: 'flex',
    gap: '4px',
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    marginTop: '2px',
  },
  actions: {
    display: 'flex',
    gap: '2px',
    flexShrink: 0,
  },
  actionBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: '3px',
    fontSize: '13px',
    opacity: 0.7,
  },
  menu: {
    position: 'absolute',
    right: '8px',
    top: '100%',
    zIndex: 100,
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    overflow: 'hidden',
    minWidth: '150px',
  },
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '6px 12px',
    background: 'none',
    border: 'none',
    color: 'var(--vscode-menu-foreground, var(--vscode-foreground))',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    textAlign: 'left',
  },
  menuItemDanger: {
    color: 'var(--vscode-errorForeground)',
  },
};
