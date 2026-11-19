import React from 'react';
import type { LimitDisplayMode } from '../../utils/limitDisplay.js';

/** Один выбор для всех квот и индикаторов на странице и в статус-баре. */
export function LimitDisplayToggle({ mode, onChange, disabled = false }: {
    mode: LimitDisplayMode;
    onChange: (mode: LimitDisplayMode) => void;
    disabled?: boolean;
}): React.ReactElement {
    const options: Array<{ value: LimitDisplayMode; title: string }> = [
        { value: 'used', title: 'Использовано' },
        { value: 'remaining', title: 'Осталось' },
    ];
    return (
        <div role="group" aria-label="Как показывать лимиты" style={{
            display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap',
        }}>
            <span style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)', marginRight: 5 }}>
                Лимиты:
            </span>
            <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 6,
                border: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-editor-background)' }}>
                {options.map(option => {
                    const selected = mode === option.value;
                    return (
                        <button type="button" key={option.value} aria-pressed={selected}
                            disabled={disabled}
                            title={disabled ? 'Дождитесь завершения задач и перезагрузите окно VS Code для обновления Extension Host' : undefined}
                            onClick={() => onChange(option.value)}
                            style={{
                                padding: '5px 10px', border: 'none', borderRadius: 4,
                                background: selected ? 'var(--vscode-button-background)' : 'transparent',
                                color: selected ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
                                font: 'inherit', fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer',
                            }}>
                            {option.title}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
