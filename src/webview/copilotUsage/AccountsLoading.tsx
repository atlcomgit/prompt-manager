import React from 'react';

/**
 * Начальный индикатор загрузки по центру вкладки «Аккаунты»; при ошибке показывает её текст и кнопку «Повторить».
 * Анимация отключается при prefers-reduced-motion. Проверка — tests/accountsLoading.test.tsx.
 */
export function AccountsLoading({ error, onRetry }: {
    error?: string | null;
    onRetry?: () => void;
}): React.ReactElement {
    return (
        <div className="pm-accounts-loading" role="status" aria-live="polite" aria-busy={!error}>
            <style>{"\n.pm-accounts-loading {\n    position: fixed; inset: 0; min-height: 100%;\n    display: flex; align-items: center; justify-content: center;\n    background: var(--vscode-editor-background); color: var(--vscode-foreground); z-index: 1;\n}\n.pm-accounts-loading-content {\n    display: flex; flex-direction: column; align-items: center; gap: 14px;\n    padding: 24px; text-align: center; font-family: var(--vscode-font-family);\n}\n.pm-accounts-loading-spinner {\n    width: 46px; height: 46px;\n    border: 3px solid var(--vscode-panel-border);\n    border-top-color: var(--vscode-focusBorder);\n    border-right-color: var(--vscode-focusBorder);\n    border-radius: 50%;\n    animation: pm-accounts-spin 850ms linear infinite;\n}\n.pm-accounts-loading-title { font-size: 15px; font-weight: 600; }\n.pm-accounts-loading-caption { font-size: 12px; color: var(--vscode-descriptionForeground); max-width: 340px; }\n.pm-accounts-loading-retry {\n    background: var(--vscode-button-background); color: var(--vscode-button-foreground);\n    border: 0; border-radius: 5px; padding: 7px 14px; cursor: pointer; font: inherit;\n}\n.pm-accounts-loading-retry:hover { background: var(--vscode-button-hoverBackground); }\n@keyframes pm-accounts-spin { to { transform: rotate(360deg); } }\n@media (prefers-reduced-motion: reduce) { .pm-accounts-loading-spinner { animation: none; } }\n"}</style>
            <div className="pm-accounts-loading-content">
                {!error ? <span className="pm-accounts-loading-spinner" aria-hidden="true" /> : null}
                <span className="pm-accounts-loading-title">
                    {error ? 'Не удалось загрузить аккаунты' : 'Загружаем аккаунты…'}
                </span>
                {error ? (
                    <>
                        <span className="pm-accounts-loading-caption">{error}</span>
                        {onRetry ? <button className="pm-accounts-loading-retry" type="button" onClick={onRetry}>Повторить</button> : null}
                    </>
                ) : (
                    <span className="pm-accounts-loading-caption">Получаем подключения и доступные лимиты</span>
                )}
            </div>
        </div>
    );
}
