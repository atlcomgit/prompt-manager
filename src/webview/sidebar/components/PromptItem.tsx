import React, { useMemo, useState } from 'react';
import { PROMPT_STATUS_ORDER, type PromptConfig, type PromptStatus, type SidebarViewMode } from '../../../types/prompt';
import {
  normalizeCompactTaskNumber,
  resolveCompactPromptGridTemplateColumns,
  resolveCompactTaskColumnTrack,
} from '../../../utils/sidebarCompactLayout.js';
import { useT } from '../../shared/i18n';
import {
  buildPromptStatusOptions,
  getPromptStatusLabel,
  PROMPT_STATUS_COLORS,
  PROMPT_STATUS_ICONS,
} from '../../shared/promptStatus';

interface Props {
  prompt: PromptConfig;
  viewMode: SidebarViewMode;
  compactTaskColumnTrack?: string;
  isSelected: boolean;
  isBusy?: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onExport: (id: string) => void;
  onUpdateStatus: (id: string, status: PromptStatus) => void;
}

/** Small inline SVG spinner that works inside webview static markup. */
function BusySpinner({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      style={styles.busySpinnerSvg}
    >
      <circle cx="10" cy="10" r="6.8" fill="none" opacity="0.24" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16.8 10a6.8 6.8 0 0 0-6.8-6.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9">
        <animateTransform
          attributeName="transform"
          attributeType="XML"
          dur="0.75s"
          from="0 10 10"
          repeatCount="indefinite"
          to="360 10 10"
          type="rotate"
        />
      </path>
    </svg>
  );
}

/** Duplicate progress text into track and fill layers so each part keeps its own contrast. */
function ProgressValueLabel({
  value,
  baseStyle,
  overlayStyle,
  trackTone,
  fillTone,
}: {
  value: number;
  baseStyle: React.CSSProperties;
  overlayStyle: React.CSSProperties;
  trackTone: string;
  fillTone: string;
}) {
  const normalizedValue = Math.max(0, Math.min(value, 100));

  return (
    <>
      <span style={{ ...baseStyle, color: trackTone }}>{value}%</span>
      <span
        aria-hidden="true"
        style={{
          ...overlayStyle,
          color: fillTone,
          clipPath: `inset(0 ${100 - normalizedValue}% 0 0)`,
        }}
      >
        {value}%
      </span>
    </>
  );
}

export const PromptItem: React.FC<Props> = ({
  prompt,
  viewMode,
  compactTaskColumnTrack,
  isSelected,
  isBusy = false,
  onOpen,
  onDelete,
  onDuplicate,
  onToggleFavorite,
  onExport,
  onUpdateStatus,
}) => {
  const MENU_WIDTH = 170;
  const SUBMENU_WIDTH = 220;
  const MENU_ITEM_HEIGHT = 34;
  const MENU_GAP = 4;

  const t = useT();
  const statusOptions = useMemo(() => buildPromptStatusOptions(t), [t]);
  const [showActions, setShowActions] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [menuBounds, setMenuBounds] = useState<{ width: number; height: number } | null>(null);
  const [hoveredMenuItem, setHoveredMenuItem] = useState<string | null>(null);
  const [hoveredStatusOption, setHoveredStatusOption] = useState<PromptStatus | null>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [contextTargeted, setContextTargeted] = useState(false);

  const selFg = isSelected ? 'var(--vscode-list-activeSelectionForeground)' : undefined;
  const selBg = isSelected ? 'var(--vscode-list-activeSelectionBackground)' : undefined;
  const statusAccent = PROMPT_STATUS_COLORS[prompt.status] || 'var(--vscode-descriptionForeground)';
  const currentStatusLabel = getPromptStatusLabel(prompt.status, t);
  const statusTone = selFg || statusAccent;
  const busyTone = isSelected
    ? 'var(--vscode-list-activeSelectionForeground)'
    : 'var(--vscode-progressBar-background, var(--vscode-editorInfo-foreground, #4da3ff))';
  const progressValue = typeof prompt.progress === 'number' ? prompt.progress : 0;
  const completedProgressTone = 'var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, var(--vscode-testing-iconPassed, #2e7d32)))';
  const progressFillTone = progressValue >= 100
    ? completedProgressTone
    : (isSelected ? 'var(--vscode-list-activeSelectionBackground)' : statusAccent);
  const progressTrackBackground = isSelected
    ? 'var(--vscode-sideBar-background, var(--vscode-editor-background))'
    : 'color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 10%, var(--vscode-sideBar-background, var(--vscode-editor-background)))';
  const progressTrackBorder = isSelected
    ? 'color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 76%, var(--vscode-list-activeSelectionForeground))'
    : 'color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 48%, var(--vscode-panel-border))';
  const progressFillOpacity = progressValue >= 100 ? 0.96 : (isSelected ? 0.82 : 0.72);
  const progressTrackTextTone = 'var(--vscode-sideBar-foreground, var(--vscode-foreground))';
  const progressFillTextTone = progressValue >= 100
    ? 'var(--vscode-button-foreground, #ffffff)'
    : (isSelected
      ? 'var(--vscode-list-activeSelectionForeground)'
      : 'var(--vscode-button-foreground, #ffffff)');
  const busyTitle = t('sidebar.promptBusy');
  const compactTaskNumber = normalizeCompactTaskNumber(prompt.taskNumber);
  const resolvedCompactTaskColumnTrack = compactTaskColumnTrack || resolveCompactTaskColumnTrack(prompt.taskNumber);
  const compactTitle = prompt.title?.trim() || prompt.id;
  const statusMenuIndex = 2;
  const menuItems: Array<{
    id: string;
    icon: string;
    label: string;
    onClick?: () => void;
    danger?: boolean;
    hasSubmenu?: boolean;
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
      id: 'status',
      icon: PROMPT_STATUS_ICONS[prompt.status],
      label: t('filter.status'),
      hasSubmenu: true,
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
    setHoveredStatusOption(null);
    setOpenSubmenuId(null);
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
      setMenuBounds({
        width: itemRect.width,
        height: itemRect.height,
      });
    } else {
      setMenuPosition(null);
      setMenuBounds(null);
    }

    setShowMenu(true);
    setOpenSubmenuId(null);
    setContextTargeted(true);
  };

  const preferredSubmenuLeft = (menuPosition?.x ?? MENU_GAP) + MENU_WIDTH - 1;
  const menuWidth = menuBounds?.width ?? Number.POSITIVE_INFINITY;
  const submenuOverflowRight = preferredSubmenuLeft + SUBMENU_WIDTH > menuWidth - MENU_GAP;
  const statusSubmenuPosition = {
    left: submenuOverflowRight
      ? Math.max(MENU_GAP, (menuPosition?.x ?? MENU_GAP) - SUBMENU_WIDTH + 1)
      : preferredSubmenuLeft,
    top: Math.max(MENU_GAP, (menuPosition?.y ?? MENU_GAP) + (statusMenuIndex * MENU_ITEM_HEIGHT) - 1),
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
            gridTemplateColumns: resolveCompactPromptGridTemplateColumns(resolvedCompactTaskColumnTrack),
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
              color: isBusy ? busyTone : statusTone,
            }}
          >
            {isBusy ? (
              <span style={styles.compactBusyIndicator} title={busyTitle} aria-label={busyTitle}>
                <BusySpinner size={18} />
              </span>
            ) : prompt.status === 'in-progress' && typeof prompt.progress === 'number' ? (
              <div
                style={{
                  ...styles.progressBarContainer,
                  background: progressTrackBackground,
                  borderColor: progressTrackBorder,
                }}
                title={`${prompt.progress}%`}
              >
                <div
                  style={{
                    ...styles.progressBarFill,
                    width: `${prompt.progress}%`,
                    background: progressFillTone,
                    opacity: progressFillOpacity,
                  }}
                />
                <ProgressValueLabel
                  value={prompt.progress}
                  baseStyle={styles.progressBarText}
                  overlayStyle={styles.progressBarTextOverlay}
                  trackTone={progressTrackTextTone}
                  fillTone={progressFillTextTone}
                />
              </div>
            ) : (
              currentStatusLabel
            )}
          </div>
        </div>
      ) : (
        <div style={styles.row}>
          <span style={styles.statusIcon}>
            {isBusy ? (
              <span style={{ ...styles.busyIconWrap, color: busyTone }} title={busyTitle} aria-label={busyTitle}>
                <BusySpinner size={18} />
              </span>
            ) : (
              <span
                style={{
                  ...styles.statusIconGlyph,
                  color: isSelected ? 'var(--vscode-list-activeSelectionForeground)' : statusAccent,
                  textShadow: isSelected ? '0 0 1px var(--vscode-list-activeSelectionBackground)' : 'none',
                }}
              >
                {PROMPT_STATUS_ICONS[prompt.status] || '◇'}
              </span>
            )}
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
              {isBusy ? (
                <span
                  style={{
                    ...styles.busyStatusBadge,
                    color: busyTone,
                    borderColor: isSelected ? 'var(--vscode-list-activeSelectionForeground)' : statusAccent,
                    background: selBg
                      ? 'color-mix(in srgb, var(--vscode-list-activeSelectionForeground) 14%, var(--vscode-list-activeSelectionBackground))'
                      : 'transparent',
                  }}
                  title={busyTitle}
                  aria-label={busyTitle}
                >
                  <BusySpinner size={18} />
                </span>
              ) : prompt.status === 'in-progress' && typeof prompt.progress === 'number' ? (
                <div
                  style={{
                    ...styles.detailedProgressBarContainer,
                    background: progressTrackBackground,
                    borderColor: progressTrackBorder,
                  }}
                  title={`${prompt.progress}%`}
                >
                  <div
                    style={{
                      ...styles.detailedProgressBarFill,
                      width: `${prompt.progress}%`,
                      background: progressFillTone,
                      opacity: progressFillOpacity,
                    }}
                  />
                  <ProgressValueLabel
                    value={prompt.progress}
                    baseStyle={styles.detailedProgressBarText}
                    overlayStyle={styles.detailedProgressBarTextOverlay}
                    trackTone={progressTrackTextTone}
                    fillTone={progressFillTextTone}
                  />
                </div>
              ) : (
                <span
                  style={{
                    ...styles.statusBadge,
                    color: selFg || statusAccent,
                    borderColor: isSelected ? 'var(--vscode-list-activeSelectionForeground)' : statusAccent,
                    background: selBg ? 'color-mix(in srgb, var(--vscode-list-activeSelectionForeground) 14%, var(--vscode-list-activeSelectionBackground))' : 'transparent',
                  }}
                >
                  <span>{currentStatusLabel}</span>
                </span>
              )}
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
              onMouseLeave={() => setHoveredMenuItem(null)}
              onFocus={() => {
                setHoveredMenuItem(item.id);
                setOpenSubmenuId(item.hasSubmenu ? item.id : null);
              }}
              onClick={e => {
                e.stopPropagation();
                if (item.hasSubmenu) {
                  setOpenSubmenuId(prev => prev === item.id ? null : item.id);
                  return;
                }

                item.onClick?.();
                closeMenu();
              }}
              onMouseEnter={() => {
                setHoveredMenuItem(item.id);
                setOpenSubmenuId(item.hasSubmenu ? item.id : null);
              }}
            >
              <span style={styles.menuItemLead}>{item.icon}</span>
              <span style={styles.menuItemLabel}>{item.label}</span>
              {item.hasSubmenu ? <span style={styles.menuItemChevron}>▸</span> : null}
            </button>
          ))}
        </div>
      )}
      {showMenu && openSubmenuId === 'status' ? (
        <div
          style={{
            ...styles.submenu,
            left: `${statusSubmenuPosition.left}px`,
            top: `${statusSubmenuPosition.top}px`,
            width: `${SUBMENU_WIDTH}px`,
          }}
          onMouseEnter={() => {
            setHoveredMenuItem('status');
            setOpenSubmenuId('status');
          }}
          onMouseLeave={() => {
            setHoveredStatusOption(null);
          }}
        >
          {statusOptions.map((option) => {
            const isCurrent = option.value === prompt.status;
            return (
              <button
                key={option.value}
                style={{
                  ...styles.submenuItem,
                  ...(hoveredStatusOption === option.value ? styles.submenuItemHover : {}),
                  ...(isCurrent ? styles.submenuItemCurrent : {}),
                }}
                onMouseEnter={() => setHoveredStatusOption(option.value)}
                onMouseLeave={() => setHoveredStatusOption(null)}
                onFocus={() => setHoveredStatusOption(option.value)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!isCurrent) {
                    onUpdateStatus(prompt.id, option.value);
                  }
                  closeMenu();
                }}
              >
                <span style={{ ...styles.submenuStatusIcon, color: option.color }}>
                  {option.icon}
                </span>
                <span style={styles.submenuStatusLabel}>{option.label}</span>
                <span style={styles.submenuStatusCheck}>{isCurrent ? '✓' : ''}</span>
              </button>
            );
          })}
        </div>
      ) : null}
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
    alignItems: 'center',
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
    gridColumn: '1',
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
    gridColumn: '3',
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
    gridColumn: '5',
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
  compactBusyIndicator: {
    display: 'inline-flex',
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    minWidth: '20px',
    height: '16px',
    minHeight: '16px',
    marginLeft: 'auto',
    overflow: 'visible',
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
  busyIconWrap: {
    display: 'inline-flex',
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    overflow: 'visible',
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
  busyStatusBadge: {
    display: 'inline-flex',
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    minWidth: '32px',
    height: '18px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '999px',
    overflow: 'visible',
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
    minWidth: '170px',
  },
  submenu: {
    position: 'absolute',
    zIndex: 101,
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    overflow: 'hidden',
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
  menuItemLead: {
    width: '16px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  menuItemLabel: {
    flex: 1,
    minWidth: 0,
  },
  menuItemChevron: {
    color: 'var(--vscode-descriptionForeground)',
    flexShrink: 0,
  },
  menuItemHover: {
    background: 'var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground))',
    color: 'var(--vscode-menu-selectionForeground, var(--vscode-menu-foreground, var(--vscode-foreground)))',
  },
  menuItemDanger: {
    color: 'var(--vscode-errorForeground)',
  },
  submenuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '7px 12px',
    background: 'none',
    border: 'none',
    color: 'var(--vscode-menu-foreground, var(--vscode-foreground))',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    textAlign: 'left',
    transition: 'background-color 0.12s ease, color 0.12s ease',
  },
  submenuItemHover: {
    background: 'var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground))',
    color: 'var(--vscode-menu-selectionForeground, var(--vscode-menu-foreground, var(--vscode-foreground)))',
  },
  submenuItemCurrent: {
    background: 'var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground))',
    color: 'var(--vscode-menu-selectionForeground, var(--vscode-menu-foreground, var(--vscode-foreground)))',
  },
  submenuStatusIcon: {
    width: '16px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
  },
  submenuStatusLabel: {
    flex: 1,
    minWidth: 0,
  },
  submenuStatusCheck: {
    width: '14px',
    textAlign: 'center',
    color: 'var(--vscode-textLink-foreground)',
    fontWeight: 700,
    flexShrink: 0,
  },
  busySpinnerSvg: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    display: 'block',
    flexShrink: 0,
    overflow: 'visible',
    transformOrigin: 'center',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
  },

  /* ── Compact progress bar ── */
  progressBarContainer: {
    position: 'relative',
    width: '54px',
    height: '14px',
    borderRadius: '2px',
    background: 'color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 18%, transparent)',
    border: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box',
    overflow: 'hidden',
    flexShrink: 0,
    marginLeft: 'auto',
  },
  progressBarFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    borderRadius: '2px',
    opacity: 0.55,
    transition: 'width 0.3s ease',
  },
  progressBarText: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    fontSize: '9px',
    fontWeight: 700,
    lineHeight: 1,
    color: 'var(--vscode-sideBar-foreground, var(--vscode-foreground))',
    textShadow: '0 0 1px color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 78%, transparent)',
    userSelect: 'none',
    zIndex: 1,
  },
  progressBarTextOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    fontSize: '9px',
    fontWeight: 700,
    lineHeight: 1,
    textShadow: '0 0 1px color-mix(in srgb, var(--vscode-button-background, #0e639c) 68%, transparent)',
    userSelect: 'none',
    pointerEvents: 'none',
    zIndex: 2,
  },

  /* ── Detailed progress bar ── */
  detailedProgressBarContainer: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    width: '64px',
    height: '16px',
    borderRadius: '2px',
    background: 'color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 18%, transparent)',
    border: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box',
    overflow: 'hidden',
    flexShrink: 0,
    verticalAlign: 'middle',
  },
  detailedProgressBarFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: '100%',
    borderRadius: '2px',
    opacity: 0.55,
    transition: 'width 0.3s ease',
  },
  detailedProgressBarText: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    fontSize: '10px',
    fontWeight: 700,
    lineHeight: 1,
    color: 'var(--vscode-sideBar-foreground, var(--vscode-foreground))',
    textShadow: '0 0 1px color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 78%, transparent)',
    userSelect: 'none',
    zIndex: 1,
  },
  detailedProgressBarTextOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    fontSize: '10px',
    fontWeight: 700,
    lineHeight: 1,
    textShadow: '0 0 1px color-mix(in srgb, var(--vscode-button-background, #0e639c) 68%, transparent)',
    userSelect: 'none',
    pointerEvents: 'none',
    zIndex: 2,
  },
};
