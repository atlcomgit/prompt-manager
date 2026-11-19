import React from 'react';

/** Область прокрутки на всю высоту вкладки. */
const scrollViewport: React.CSSProperties = {
    height: '100vh',
    width: '100%',
    overflowY: 'auto',
    overflowX: 'hidden',
    overscrollBehaviorY: 'contain',
};

/** Колонка содержимого страницы с ограниченной шириной. */
const content: React.CSSProperties = {
    padding: '16px 22px 30px',
    width: '100%',
    maxWidth: 960,
    margin: '0 auto',
    boxSizing: 'border-box',
    fontFamily: 'var(--vscode-font-family)',
    color: 'var(--vscode-foreground)',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
};

/** Отдельный скролл страницы: общий HTML Webview запрещает прокрутку body/#root; tests/accountsPageLayout.test.tsx. */
export function AccountsPageFrame({ children }: { children: React.ReactNode }): React.ReactElement {
    return (
        <main className="pm-accounts-scroll" style={scrollViewport}>
            <div className="pm-accounts-content" style={content}>
                {children}
            </div>
        </main>
    );
}
