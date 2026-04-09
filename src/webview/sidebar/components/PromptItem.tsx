import React, { useState } from 'react';
import type { PromptConfig, SidebarViewMode } from '../../../types/prompt';
import { useT } from '../../shared/i18n';

interface Props {
  prompt: PromptConfig;
  viewMode: SidebarViewMode;
  isSelected: boolean;
  isSaving?: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onExport: (id: string) => void;
}

const STATUS_ICONS: Record<string, string> = {
  'draft': '📝',
  'in-progress': '🚀',
  'stopped': '▣',
  'cancelled': '❌',
  'completed': '✅',
  'report': '🧾',
  'review': '🔎',
  'closed': '🔒',
};

const STATUS_COLORS: Record<string, string> = {
  'draft': 'var(--vscode-descriptionForeground)',
  'in-progress': 'var(--vscode-editorInfo-foreground, #3794ff)',
  'stopped': 'var(--vscode-editorWarning-foreground, #cca700)',
  'cancelled': 'var(--vscode-errorForeground, #f44747)',
  'completed': 'var(--vscode-testing-iconPassed, #73c991)',
  'report': 'var(--vscode-textLink-foreground)',
  'review': 'var(--vscode-editorWarning-foreground, #cca700)',
  'closed': 'var(--vscode-disabledForeground)',
};


export const PromptItem: React.FC<Props> = ({
  prompt,
  viewMode,
  isSelected,
  isSaving = false,
  onOpen,
  onDelete,
  onDuplicate,
  onToggleFavorite,
  onExport,
}) => {
  const MENU_WIDTH = 170;
  const MENU_ITEM_HEIGHT = 34;
  const MENU_GAP = 4;

  const t = useT();
  const STATUS_LABELS: Record<string, string> = {
    'draft': t('status.draft'),
    'in-progress': t('status.inProgress'),
    'stopped': t('status.stopped'),
    'cancelled': t('status.cancelled'),
    'completed': t('status.completed'),
    'report': t('status.report'),
    'review': t('status.review'),
    'closed': t('status.closed'),
  };
  const [showActions, setShowActions] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [hoveredMenuItem, setHoveredMenuItem] = useState<string | null>(null);
  const [contextTargeted, setContextTargeted] = useState(false);

  const selFg = isSelected ? 'var(--vscode-list-activeSelectionForeground)' : undefined;
  const selBg = isSelected ? 'var(--vscode-list-activeSelectionBackground)' : undefined;
  const statusAccent = STATUS_COLORS[prompt.status] || 'var(--vscode-descriptionForeground)';
  const compactTaskNumber = prompt.taskNumber?.trim() || '—';
  const compactTitle = prompt.title?.trim() || prompt.id;
  const menuItems: Array<{
    id: string;
    icon: string;
    label: string;
    onClick: () => void;
    danger?: boolean;
  }> = [
    {
      id: 'open',
      icon: '↗',
      label: t('editor.open'),
      onClick: () => onOpen(prompt.id),
    },
    {
      id: 'favorite',
      icon: prompt.favorite ? '★' : '☆',
      label: prompt.favorite ? t('item.removeFavorite') : t('item.addFavorite'),
      onClick: () => onToggleFavorite(prompt.id),
    },
    {
      id: 'duplicate',
      icon: '📋',
      label: t('item.duplicate'),
      onClick: () => onDuplicate(prompt.id),
    },
    {
      id: 'export',
      icon: '📤',
      label: t('item.export'),
      onClick: () => onExport(prompt.id),
    },
    {
      id: 'delete',
      icon: '🗑',
      label: t('common.delete'),
      onClick: () => onDelete(prompt.id),
      danger: true,
    },
  ];
  const MENU_HEIGHT = menuItems.length * MENU_ITEM_HEIGHT;

  const closeMenu = () => {
    setShowMenu(false);
    setHoveredMenuItem(null);
    setContextTargeted(false);
  };

  const openMenuAtPointer = (event: React.MouseEvent<HTMLElement>) => {
    const itemRect = event.currentTarget.closest('[data-prompt-item]')?.getBoundingClientRect();

    if (itemRect) {
      const maxX = Math.max(MENU_GAP, itemRect.width - MENU_WIDTH - MENU_GAP);
      const maxY = Math.max(MENU_GAP, itemRect.height - MENU_HEIGHT - MENU_GAP);
      const x = Math.min(Math.max(event.clientX - itemRect.left, MENU_GAP), maxX);
      const y = Math.min(Math.max(event.clientY - itemRect.top, MENU_GAP), maxY);

      setMenuPosition({
        x,
        y,
      });
    } else {
      setMenuPosition(null);
    }

    setShowMenu(true);
    setContextTargeted(true);
  };

  return (
    <div
      data-prompt-item
      style={{
        ...styles.item,
        ...(isSelected ? styles.itemSelected : {}),
        ...(!isSelected && contextTargeted ? styles.itemContextTargeted : {}),
      }}
      onClick={() => onOpen(prompt.id)}
      onContextMenu={event => {
        event.preventDefault();
        event.stopPropagation();
        setShowActions(true);
        openMenuAtPointer(event);
      }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => {
        setShowActions(false);
        closeMenu();
      }}
      title={prompt.description || prompt.title || prompt.id}
    >
      {viewMode === 'compact' ? (
        <div
          style={{
            ...styles.compactRow,
            ...(showActions ? styles.compactRowWithActions : {}),
          }}
        >
          <div style={{ ...styles.compactTask, ...(selFg ? { color: selFg } : {}) }}>
            {compactTaskNumber}
          </div>
          <div style={styles.compactTitle}>
            <span style={{ ...styles.compactTitleText, ...(selFg ? { color: selFg } : {}) }}>
              {compactTitle}
            </span>
            {prompt.favorite && <span style={styles.compactMarker}>⭐</span>}
            {prompt.archived && (
              <span
                style={{
                  ...styles.compactArchiveBadge,
                  ...(selFg ? { color: selFg, borderColor: selFg } : {}),
                }}
              >
                {t('sidebar.archivedBadge')}
              </span>
            )}
          </div>
          <div
            style={{
              ...styles.compactStatus,
              color: selFg || statusAccent,
            }}
          >
            {STATUS_LABELS[prompt.status]}
          </div>
        </div>
      ) : (
        <div style={styles.row}>
          <span style={styles.statusIcon}>
            <span
              style={{
                ...styles.statusIconGlyph,
                color: isSelected ? 'var(--vscode-list-activeSelectionForeground)' : statusAccent,
                textShadow: isSelected ? '0 0 1px var(--vscode-list-activeSelectionBackground)' : 'none',
              }}
            >
              {STATUS_ICONS[prompt.status] || '◇'}
            </span>
          </span>
          <div style={styles.content}>
            <div style={{ ...styles.title, ...(selFg ? { color: selFg } : {}) }}>
              {prompt.favorite && <span style={styles.star}>⭐</span>}
              {prompt.title || prompt.id}
            </div>
            <div style={{
              ...styles.description,
              ...(selFg ? { color: selFg } : {}),
            }}>{prompt.description || 'Описание не указано'}</div>
            <div style={{
              ...styles.meta,
              ...(selFg ? { color: selFg } : {}),
            }}>
              {prompt.taskNumber && (
                <>
                  <span style={{
                    ...styles.taskBadge,
                    ...(selFg ? { color: selFg } : {}),
                  }}>
                    🎫 {prompt.taskNumber}
                  </span>
                  <span>·</span>
                </>
              )}
              <span
                style={{
                  ...styles.statusBadge,
                  color: selFg || statusAccent,
                  borderColor: isSelected ? 'var(--vscode-list-activeSelectionForeground)' : statusAccent,
                  background: selBg ? 'color-mix(in srgb, var(--vscode-list-activeSelectionForeground) 14%, var(--vscode-list-activeSelectionBackground))' : 'transparent',
                }}
              >
                <span>{STATUS_LABELS[prompt.status]}</span>
              </span>
              {prompt.archived && (
                <>
                  <span>·</span>
                  <span
                    style={{
                      ...(isSelected ? styles.metaBadgeSelected : styles.metaBadgeText),
                    }}
                  >
                    {t('sidebar.archivedBadge')}
                  </span>
                </>
              )}
              {prompt.chatMode && (
                <>
                  <span>·</span>
                  <span
                    style={{
                      ...(isSelected ? styles.metaBadgeSelected : styles.metaBadgeText),
                    }}
                  >
                    {prompt.chatMode === 'agent' ? t('editor.chatModeAgent') : t('editor.chatModePlan')}
                  </span>
                </>
              )}
              {prompt.model && (
                <>
                  <span>·</span>
                  <span
                    style={{
                      ...(isSelected ? styles.metaBadgeSelected : styles.metaBadgeText),
                    }}
                  >
                    {prompt.model}
                  </span>
                </>
              )}
              {prompt.projects.length > 0 && (
                <>
                  <span>·</span>
                  <span>{prompt.projects.slice(0, 2).join(', ')}</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      <div
        style={{
          ...styles.actions,
          visibility: showActions ? 'visible' : 'hidden',
          pointerEvents: showActions ? 'auto' : 'none',
          background: isSelected
            ? 'linear-gradient(to right, transparent, var(--vscode-list-activeSelectionBackground) 28%)'
            : contextTargeted
              ? 'linear-gradient(to right, transparent, color-mix(in srgb, var(--vscode-list-hoverBackground) 85%, transparent) 28%)'
              : 'linear-gradient(to right, transparent, var(--vscode-sideBar-background, var(--vscode-editor-background)) 28%)',
        }}
      >
            <button
              style={{
                ...styles.actionBtn,
                ...(selFg ? { color: selFg, opacity: 1 } : {}),
              }}
              onClick={e => { e.stopPropagation(); onToggleFavorite(prompt.id); }}
              title={prompt.favorite ? t('item.removeFavorite') : t('item.addFavorite')}
            >
              {prompt.favorite ? '★' : '☆'}
            </button>
            <button
              style={{
                ...styles.actionBtn,
                ...(selFg ? { color: selFg, opacity: 1 } : {}),
              }}
              onClick={event => {
                event.stopPropagation();
                if (showMenu) {
                  closeMenu();
                  return;
                }
                openMenuAtPointer(event);
              }}
              title={t('item.more')}
            >
              ⋯
            </button>
          </div>
      {showMenu && (
        <div
          style={{
            ...styles.menu,
            ...(menuPosition ? { left: `${menuPosition.x}px`, top: `${menuPosition.y}px`, right: 'auto' } : {}),
          }}
        >
          {menuItems.map(item => (
            <button
              key={item.id}
              style={{
                ...styles.menuItem,
                ...(hoveredMenuItem === item.id ? styles.menuItemHover : {}),
                ...(item.danger && hoveredMenuItem !== item.id ? styles.menuItemDanger : {}),
              }}
              onMouseEnter={() => setHoveredMenuItem(item.id)}
              onMouseLeave={() => setHoveredMenuItem(null)}
              onClick={e => {
                e.stopPropagation();
                item.onClick();
                closeMenu();
              }}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </div>
      )}
      {isSaving && (
        <div style={styles.savingOverlay}>
          <div style={styles.savingLabel}>Сохранение...</div>
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
  itemContextTargeted: {
    background: 'color-mix(in srgb, var(--vscode-list-hoverBackground) 85%, transparent)',
  },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
  },
  compactRow: {
    display: 'grid',
    gridTemplateColumns: '44px minmax(0, 1fr) max-content',
    alignItems: 'center',
    columnGap: '16px',
    minHeight: '22px',
    width: '100%',
    boxSizing: 'border-box',
    paddingLeft: '8px',
    paddingRight: '8px',
  },
  compactRowWithActions: {
    paddingRight: '40px',
  },
  compactTask: {
    minWidth: 0,
    textAlign: 'left',
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: 700,
    color: 'var(--vscode-textLink-foreground)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  compactTitle: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    fontWeight: 500,
    textAlign: 'left',
  },
  compactTitleText: {
    minWidth: 0,
    flex: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  compactStatus: {
    minWidth: 0,
    fontSize: '11px',
    fontWeight: 600,
    justifySelf: 'end',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    textAlign: 'right',
  },
  compactMarker: {
    flexShrink: 0,
    fontSize: '10px',
  },
  compactArchiveBadge: {
    flexShrink: 0,
    padding: '1px 5px',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '999px',
    fontSize: '9px',
    lineHeight: '12px',
    color: 'var(--vscode-descriptionForeground)',
    maxWidth: '64px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  statusIcon: {
    width: '18px',
    height: '20px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  statusIconGlyph: {
    fontSize: '15px',
    fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
    lineHeight: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
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
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  meta: {
    display: 'flex',
    gap: '4px',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    marginTop: '2px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: '1px 7px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    fontSize: '10px',
    lineHeight: '14px',
    fontWeight: 600,
  },
  metaBadgeText: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px',
    fontSize: '10px',
    lineHeight: '14px',
    fontWeight: 500,
    color: 'var(--vscode-descriptionForeground)',
    background: 'transparent',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '120px',
  },
  metaBadgeSelected: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    border: '1px solid #000000',
    borderRadius: '4px',
    fontSize: '10px',
    lineHeight: '14px',
    fontWeight: 500,
    color: '#000000',
    background: '#ffffff',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '120px',
  },
  actions: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    paddingLeft: '20px',
    paddingRight: '4px',
  },
  actionBtn: {
    background: 'var(--vscode-button-secondaryBackground, rgba(128,128,128,0.18))',
    border: '1px solid var(--vscode-button-border, transparent)',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    cursor: 'pointer',
    padding: '3px 7px',
    borderRadius: '4px',
    fontSize: '15px',
    lineHeight: '18px',
    opacity: 1,
    fontWeight: 600,
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
  menuItemHover: {
    background: 'var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground))',
    color: 'var(--vscode-menu-selectionForeground, var(--vscode-menu-foreground, var(--vscode-foreground)))',
  },
  menuItemDanger: {
    color: 'var(--vscode-errorForeground)',
  },
  savingOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'color-mix(in srgb, var(--vscode-editor-background) 40%, transparent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    zIndex: 2,
  },
  savingLabel: {
    fontSize: '12px',
    fontWeight: 700,
    color: 'var(--vscode-button-foreground)',
    background: 'var(--vscode-button-background)',
    padding: '3px 8px',
    borderRadius: '999px',
    boxShadow: '0 0 0 1px color-mix(in srgb, var(--vscode-button-background) 70%, var(--vscode-panel-border))',
    whiteSpace: 'nowrap',
  },
};
