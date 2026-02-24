import React from 'react';
import { useT } from '../../shared/i18n';

interface Props {
  onSave: () => void;
  onStartChat: () => void;
  onOpenChat: () => void;
  onMarkCompleted: () => void;
  onMarkStopped: () => void;
  showStatusActions: boolean;
  hasChatSession: boolean;
  isDirty: boolean;
  isSaving: boolean;
  isStartingChat: boolean;
  hasContent: boolean;
}

export const ActionBar: React.FC<Props> = ({
  onSave, onStartChat, onOpenChat, onMarkCompleted, onMarkStopped, showStatusActions, hasChatSession, isDirty, isSaving, isStartingChat, hasContent,
}) => {
  const t = useT();
  const startChatDisabled = !hasContent || isStartingChat;
  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <button
          style={{ ...styles.btn, ...styles.btnPrimary }}
          onClick={onSave}
          disabled={isSaving}
        >
          {isSaving ? t('actions.saving') : t('actions.save')}
        </button>

        {hasChatSession ? (
          <button style={{ ...styles.btn, ...styles.btnChat }} onClick={onOpenChat}>
            {t('actions.openChat')}
          </button>
        ) : (
          <button
            style={{ ...styles.btn, ...styles.btnChat, ...(startChatDisabled ? styles.btnDisabled : {}) }}
            onClick={onStartChat}
            disabled={startChatDisabled}
            aria-disabled={startChatDisabled}
            title={!hasContent ? t('actions.enterText') : t('actions.startChatTooltip')}
          >
            {t('actions.startChat')}
          </button>
        )}

        {showStatusActions && (
          <>
            <button style={{ ...styles.btn, ...styles.btnSuccess }} onClick={onMarkCompleted}>
              ✅ {t('status.completed')}
            </button>
            <button style={{ ...styles.btn, ...styles.btnWarn }} onClick={onMarkStopped}>
              ▣ {t('status.stopped')}
            </button>
          </>
        )}
      </div>

      <div style={styles.right}>
        {isDirty && (
          <span style={styles.unsaved}>{t('actions.unsavedChanges')}</span>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 20px',
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
  },
  left: {
    display: 'flex',
    gap: '8px',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
  },
  btn: {
    padding: '6px 16px',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
    fontFamily: 'var(--vscode-font-family)',
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  btnPrimary: {
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
  },
  btnChat: {
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
  },
  btnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
    pointerEvents: 'none',
  },
  btnSuccess: {
    background: 'var(--vscode-testing-iconPassed, var(--vscode-button-secondaryBackground))',
    color: 'var(--vscode-button-foreground)',
  },
  btnWarn: {
    background: 'var(--vscode-editorWarning-foreground, var(--vscode-button-secondaryBackground))',
    color: 'var(--vscode-editor-background)',
  },
  unsaved: {
    fontSize: '12px',
    color: 'var(--vscode-editorWarning-foreground)',
  },
};
