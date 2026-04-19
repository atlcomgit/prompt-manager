import type { CSSProperties } from 'react';

// Базовая кнопка — плоский дизайн без теней и градиентов.
const baseButton: CSSProperties = {
	padding: '7px 16px',
	border: '1px solid transparent',
	borderRadius: '8px',
	cursor: 'pointer',
	fontSize: '12px',
	fontFamily: 'var(--vscode-font-family)',
	fontWeight: 600,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: '6px',
	lineHeight: 1.4,
	minHeight: '32px',
	letterSpacing: '0.01em',
	transition: 'background-color 160ms ease, color 160ms ease, opacity 160ms ease, border-color 160ms ease',
};

export const memoryButtonStyles = {
	base: baseButton,
	// Основная кнопка с плоским акцентным фоном.
	primary: {
		...baseButton,
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
	},
	// Вторичная кнопка с полупрозрачной рамкой.
	secondary: {
		...baseButton,
		background: 'transparent',
		color: 'var(--vscode-foreground)',
		borderColor: 'color-mix(in srgb, var(--vscode-foreground) 14%, transparent)',
	},
	// Кнопка предупреждения с мягким красным фоном.
	danger: {
		...baseButton,
		background: 'color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent)',
		color: 'var(--vscode-errorForeground)',
		borderColor: 'color-mix(in srgb, var(--vscode-errorForeground) 20%, transparent)',
	},
	// Текстовая кнопка-ссылка без фона.
	link: {
		...baseButton,
		background: 'transparent',
		color: 'var(--vscode-textLink-foreground)',
		padding: '6px 10px',
		borderColor: 'transparent',
	},
	// Неактивная вкладка.
	tab: {
		...baseButton,
		background: 'transparent',
		color: 'var(--vscode-descriptionForeground)',
		borderColor: 'color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		whiteSpace: 'nowrap' as const,
	},
	// Активная вкладка с подсветкой.
	tabActive: {
		background: 'color-mix(in srgb, var(--vscode-button-background) 12%, transparent)',
		color: 'var(--vscode-foreground)',
		borderColor: 'var(--vscode-button-background)',
	},
	// Заблокированная кнопка.
	disabled: {
		opacity: 0.4,
		cursor: 'not-allowed',
		pointerEvents: 'none' as const,
	},
};