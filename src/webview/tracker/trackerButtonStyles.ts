import type { CSSProperties } from 'react';

const trackerBaseButtonStyle: CSSProperties = {
	padding: '6px 12px',
	border: 'none',
	borderRadius: '2px',
	appearance: 'none',
	backgroundImage: 'none',
	cursor: 'pointer',
	fontSize: '12px',
	fontFamily: 'var(--vscode-font-family)',
	fontWeight: 600,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: '6px',
	lineHeight: 1.35,
	minHeight: '30px',
	boxSizing: 'border-box',
};

const trackerPrimaryButtonStyle: CSSProperties = {
	...trackerBaseButtonStyle,
	background: 'var(--vscode-button-background)',
	backgroundColor: 'var(--vscode-button-background)',
	color: 'var(--vscode-button-foreground)',
	WebkitTextFillColor: 'var(--vscode-button-foreground)',
};

const trackerSecondaryButtonStyle: CSSProperties = {
	...trackerBaseButtonStyle,
	background: 'var(--vscode-button-background)',
	backgroundColor: 'var(--vscode-button-background)',
	color: 'var(--vscode-button-foreground)',
	WebkitTextFillColor: 'var(--vscode-button-foreground)',
};

export const trackerButtonStyles = {
	base: trackerBaseButtonStyle,
	primary: trackerPrimaryButtonStyle,
	secondary: trackerSecondaryButtonStyle,
};