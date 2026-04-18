/**
 * CustomGroupsManagerModal — модал для CRUD пользовательских групп промптов.
 * Локально хранит черновик списка, сохраняет изменения батчем через replaceCustomGroups.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { PromptCustomGroup } from '../../../types/prompt';
import { useT } from '../../shared/i18n';

interface Props {
  open: boolean;
  groups: PromptCustomGroup[];
  onClose: () => void;
  onSave: (groups: PromptCustomGroup[]) => void;
}

const DEFAULT_COLOR = '#4a9eff';

function makeId(): string {
  // Простой уникальный id (timestamp + random) — достаточно для пользовательских групп
  return `cg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const CustomGroupsManagerModal: React.FC<Props> = ({ open, groups, onClose, onSave }) => {
  const t = useT();
  const [draft, setDraft] = useState<PromptCustomGroup[]>(groups);

  // Синхронизируем локальный черновик при открытии и при смене входных групп
  useEffect(() => {
    if (open) {
      setDraft(groups.map(group => ({ ...group })));
    }
  }, [open, groups]);

  const sortedDraft = useMemo(() => {
    return [...draft].sort((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      return a.name.localeCompare(b.name);
    });
  }, [draft]);

  if (!open) {
    return null;
  }

  const handleAdd = () => {
    const nowIso = new Date().toISOString();
    const maxOrder = draft.reduce((max, group) => Math.max(max, group.order), -1);
    setDraft(prev => [
      ...prev,
      {
        id: makeId(),
        name: '',
        color: DEFAULT_COLOR,
        order: maxOrder + 10,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ]);
  };

  const handleDelete = (id: string) => {
    setDraft(prev => prev.filter(group => group.id !== id));
  };

  const handlePatch = (id: string, patch: Partial<PromptCustomGroup>) => {
    setDraft(prev => prev.map(group => (
      group.id === id
        ? { ...group, ...patch, updatedAt: new Date().toISOString() }
        : group
    )));
  };

  const handleSave = () => {
    const normalized = draft
      .map(group => ({ ...group, name: (group.name || '').trim() }))
      .filter(group => group.name.length > 0);
    onSave(normalized);
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--vscode-editor-background)',
          color: 'var(--vscode-editor-foreground)',
          border: '1px solid var(--vscode-panel-border)',
          borderRadius: 6,
          width: 'min(640px, 100%)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--vscode-panel-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h3 style={{ margin: 0, fontSize: 14 }}>{t('editor.groupsModalTitle')}</h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              color: 'inherit',
              border: 'none',
              cursor: 'pointer',
              fontSize: 16,
            }}
            title={t('editor.groupsClose')}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: 12, overflowY: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 4, fontSize: 12 }}>{t('editor.groupsName')}</th>
                <th style={{ textAlign: 'left', padding: 4, fontSize: 12, width: 80 }}>{t('editor.groupsColor')}</th>
                <th style={{ textAlign: 'left', padding: 4, fontSize: 12, width: 80 }}>{t('editor.groupsOrder')}</th>
                <th style={{ width: 32 }} />
              </tr>
            </thead>
            <tbody>
              {sortedDraft.map(group => (
                <tr key={group.id}>
                  <td style={{ padding: 4 }}>
                    <input
                      type="text"
                      value={group.name}
                      onChange={e => handlePatch(group.id, { name: e.target.value })}
                      style={{
                        width: '100%',
                        background: 'var(--vscode-input-background)',
                        color: 'var(--vscode-input-foreground)',
                        border: '1px solid var(--vscode-input-border)',
                        padding: '4px 6px',
                        boxSizing: 'border-box',
                      }}
                      placeholder={t('editor.groupsName')}
                    />
                  </td>
                  <td style={{ padding: 4 }}>
                    <input
                      type="color"
                      value={group.color || DEFAULT_COLOR}
                      onChange={e => handlePatch(group.id, { color: e.target.value })}
                      style={{ width: '100%', height: 28, border: 'none', background: 'transparent', cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ padding: 4 }}>
                    <input
                      type="number"
                      value={group.order}
                      onChange={e => handlePatch(group.id, { order: Number(e.target.value) || 0 })}
                      style={{
                        width: '100%',
                        background: 'var(--vscode-input-background)',
                        color: 'var(--vscode-input-foreground)',
                        border: '1px solid var(--vscode-input-border)',
                        padding: '4px 6px',
                        boxSizing: 'border-box',
                      }}
                    />
                  </td>
                  <td style={{ padding: 4, textAlign: 'center' }}>
                    <button
                      type="button"
                      onClick={() => handleDelete(group.id)}
                      style={{
                        background: 'transparent',
                        color: 'var(--vscode-errorForeground)',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                      title={t('editor.groupsDelete')}
                    >
                      🗑️
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            onClick={handleAdd}
            style={{
              marginTop: 8,
              padding: '6px 12px',
              background: 'var(--vscode-button-secondaryBackground)',
              color: 'var(--vscode-button-secondaryForeground)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            + {t('editor.groupsAdd')}
          </button>
        </div>

        <div
          style={{
            padding: 12,
            borderTop: '1px solid var(--vscode-panel-border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 12px',
              background: 'var(--vscode-button-secondaryBackground)',
              color: 'var(--vscode-button-secondaryForeground)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {t('editor.groupsClose')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            style={{
              padding: '6px 12px',
              background: 'var(--vscode-button-background)',
              color: 'var(--vscode-button-foreground)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            💾
          </button>
        </div>
      </div>
    </div>
  );
};
