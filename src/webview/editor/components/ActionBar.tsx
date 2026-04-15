import React from 'react';
import { useT } from '../../shared/i18n';
import type { PromptStatus } from '../../../types/prompt';

interface Props {
  onSave: () => void;
  onShowHistory: () => void;
  onStartChat: () => void;
  onOpenChat: () => void;
  onOpenGitFlow?: () => void;
  onMarkCompleted: () => void;
  onMarkStopped: () => void;
  showStatusActions: boolean;
  showGitFlowAction?: boolean;
  hasChatSession: boolean;
  isChatPanelOpen: boolean;
  isSaving: boolean;
  isStartingChat: boolean;
  isGeneratingTitle?: boolean;
  isGeneratingDescription?: boolean;
  hasContent: boolean;
  isPersistedPrompt: boolean;
  status: PromptStatus;
  activeTab?: string;
}

export function resolveChatEntryState(input: Pick<Props, 'status' | 'hasChatSession' | 'isChatPanelOpen' | 'isPersistedPrompt'>): {
  canStartChat: boolean;
  canOpenChat: boolean;
  hasChatEntry: boolean;
  shouldShowOpenChat: boolean;
  shouldShowStartChat: boolean;
} {
  const canStartChat = input.isPersistedPrompt && (
    input.status === 'draft'
    || input.status === 'in-progress'
    || input.status === 'stopped'
    || input.status === 'cancelled'
  );
  const canOpenChat = input.isPersistedPrompt && (
    input.status === 'in-progress'
    || input.status === 'stopped'
    || input.status === 'cancelled'
  );
  const hasChatEntry = canOpenChat && (input.hasChatSession || input.isChatPanelOpen);

  return {
    canStartChat,
    canOpenChat,
    hasChatEntry,
    shouldShowOpenChat: hasChatEntry,
    shouldShowStartChat: canStartChat && !hasChatEntry,
  };
}

export function resolveStartChatDisabledState(
  input: Pick<Props, 'hasContent' | 'isStartingChat' | 'isGeneratingTitle' | 'isGeneratingDescription'>,
): boolean {
  return !input.hasContent
    || input.isStartingChat
    || input.isGeneratingTitle === true
    || input.isGeneratingDescription === true;
}

function splitLeadingIconLabel(label: string): { icon: string; text: string } {
  const trimmedLabel = label.trim();
  const firstSpaceIndex = trimmedLabel.indexOf(' ');
  if (firstSpaceIndex <= 0) {
    return { icon: '', text: trimmedLabel };
  }

  const leadingToken = trimmedLabel.slice(0, firstSpaceIndex).trim();
  const text = trimmedLabel.slice(firstSpaceIndex + 1).trim();
  const hasLetterOrDigit = /[\p{L}\p{N}]/u.test(leadingToken);
  if (!text || hasLetterOrDigit) {
    return { icon: '', text: trimmedLabel };
  }

  return { icon: leadingToken, text };
}

export const ActionBar: React.FC<Props> = ({
  onSave, onShowHistory, onStartChat, onOpenChat, onOpenGitFlow, onMarkCompleted, onMarkStopped, showStatusActions, showGitFlowAction = false, hasChatSession, isChatPanelOpen, isSaving, isStartingChat, isGeneratingTitle = false, isGeneratingDescription = false, hasContent, isPersistedPrompt, status, activeTab,
}) => {
  const t = useT();
  const saveLabel = splitLeadingIconLabel(t('actions.save'));
  const startChatDisabled = resolveStartChatDisabledState({
    hasContent,
    isStartingChat,
    isGeneratingTitle,
    isGeneratingDescription,
  });
  const chatEntryState = resolveChatEntryState({ status, hasChatSession, isChatPanelOpen, isPersistedPrompt });
  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <button
          style={{ ...styles.btn, ...styles.btnPrimary }}
          onClick={onSave}
          disabled={isSaving}
          aria-busy={isSaving}
        >
          <span style={styles.btnLeadSlot} aria-hidden="true">
            {isSaving ? <span style={styles.btnSpinner} /> : saveLabel.icon}
          </span>
          <span>{saveLabel.text}</span>
        </button>

        {activeTab !== 'process' && (
        <button
          style={{ ...styles.btn, ...styles.btnChat }}
          onClick={onShowHistory}
          disabled={isSaving}
          title="История версий"
        >
          🕘 История
        </button>
        )}

        {chatEntryState.shouldShowOpenChat ? (
          <button style={{ ...styles.btn, ...styles.btnChat }} onClick={onOpenChat}>
            {t('actions.openChat')}
          </button>
        ) : chatEntryState.shouldShowStartChat ? (
          <button
            style={{ ...styles.btn, ...styles.btnChat, ...(startChatDisabled ? styles.btnDisabled : {}) }}
            onClick={onStartChat}
            disabled={startChatDisabled}
            aria-disabled={startChatDisabled}
            aria-busy={isStartingChat}
            title={!hasContent ? t('actions.enterText') : t('actions.startChatTooltip')}
          >
            {isStartingChat ? (
              <>
                <span style={styles.btnSpinner} aria-hidden="true" />
                <span>{t('actions.startChat')}</span>
              </>
            ) : t('actions.startChat')}
          </button>
        ) : null}
      </div>

      <div style={styles.right}>
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
        {showGitFlowAction && onOpenGitFlow && (
          <button
            style={{ ...styles.btn, ...styles.btnChat }}
            onClick={onOpenGitFlow}
            disabled={isSaving}
          >
            {t('editor.gitOverlay')}
          </button>
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
    flexWrap: 'wrap',
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
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
  btnLeadSlot: {
    width: '1em',
    minWidth: '1em',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    flexShrink: 0,
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
  btnSpinner: {
    width: '13px',
    height: '13px',
    border: '2px solid color-mix(in srgb, currentColor 35%, transparent)',
    borderTopColor: 'currentColor',
    borderRadius: '50%',
    animation: 'pm-spin 0.8s linear infinite',
    flexShrink: 0,
  },
};
