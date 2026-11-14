import type { CSSProperties } from 'react';

/** Одинаковые эффекты переноса разделов формы и виджетов дашборда. */
export const sectionDragStyles = {
	/** Обёртка оставляет место для индикатора и плавно изменяет вид переносимой карточки. */
	wrapper: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		minWidth: 0,
		transition: 'opacity 0.18s ease, transform 0.18s ease',
	},
	/** Переносимая карточка остаётся на месте до отпускания указателя. */
	dragging: {
		opacity: 0.5,
		transform: 'scale(0.985)',
	},
	/** Полоса вставки находится в потоке над или под целевой карточкой. */
	indicator: {
		height: '4px',
		borderRadius: '999px',
		background: 'linear-gradient(90deg, var(--vscode-focusBorder, #3794ff), '
			+ 'color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 40%, transparent))',
		boxShadow: '0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 24%, transparent)',
	},
	/** Компактная ручка отделяет перенос от остальных действий заголовка. */
	handle: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: '20px',
		height: '20px',
		padding: 0,
		border: 'none',
		borderRadius: '4px',
		background: 'transparent',
		color: 'color-mix(in srgb, var(--vscode-foreground) 86%, var(--vscode-descriptionForeground))',
		cursor: 'grab',
		touchAction: 'none',
		userSelect: 'none',
		flexShrink: 0,
	},
	/** Активная ручка использует тот же цвет, что полоса вставки. */
	handleDragging: {
		cursor: 'grabbing',
		color: 'var(--vscode-focusBorder, #3794ff)',
		background: 'transparent',
	},
} satisfies Record<string, CSSProperties>;
