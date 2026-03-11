import type { CSSProperties } from 'react';

const baseButton: CSSProperties = {
	padding: '6px 16px',
	border: 'none',
	borderRadius: '4px',
	cursor: 'pointer',
	fontSize: '13px',
	fontFamily: 'var(--vscode-font-family)',
	fontWeight: 500,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: '6px',
	lineHeight: 1.4,
	minHeight: '30px',
	transition: 'background-color 120ms ease, color 120ms ease, opacity 120ms ease',
};

export const memoryButtonStyles = {
	base: baseButton,
	primary: {
		...baseButton,
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
	},
	secondary: {
		...baseButton,
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
	},
	danger: {
		...baseButton,
		background: 'var(--vscode-editorWarning-foreground, var(--vscode-button-secondaryBackground))',
		color: 'var(--vscode-editor-background)',
	},
	link: {
		...baseButton,
		background: 'transparent',
		color: 'var(--vscode-textLink-foreground)',
		padding: '6px 12px',
	},
	tab: {
		...baseButton,
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		whiteSpace: 'nowrap' as const,
	},
	tabActive: {
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
	},
	disabled: {
		opacity: 0.6,
		cursor: 'not-allowed',
		pointerEvents: 'none' as const,
	},
};