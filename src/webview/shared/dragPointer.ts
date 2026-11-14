/** Идентифицирует устройство, начавшее перенос раздела или виджета. */
export interface DragPointerIdentity {
	pointerId: number;
	pointerType: string;
}

/** Сопоставляет события жеста; смену mouse pointerId проверяет promptDashboardComponent.test.tsx. */
export function isDragPointer(
	drag: DragPointerIdentity,
	event: Pick<PointerEvent, 'pointerId' | 'pointerType' | 'isPrimary'>,
): boolean {
	if (drag.pointerType !== event.pointerType) {
		return false;
	}
	// У мыши отслеживаем основной указатель независимо от его числового идентификатора.
	// Для касаний и пера допускаем только тот указатель, который начал жест.
	return drag.pointerType === 'mouse'
		? event.isPrimary
		: drag.pointerId === event.pointerId;
}

/** Подключает поток движения и завершение жеста; регрессии — promptDashboardComponent.test.tsx. */
export function subscribeDragPointerEvents(
	target: EventTarget,
	drag: DragPointerIdentity,
	handlers: {
		move: (event: MouseEvent) => void;
		finish: (event: PointerEvent) => void;
		cancel: () => void;
	},
): () => void {
	// В некоторых средах mouse-нажатие сопровождается pen-движениями с отдельным pointerId.
	// Совместимый mousemove нужен только для несовпавшего pointer-события; обычная мышь может его не присылать.
	let useCompatibilityMouseMove = true;
	/** Передаёт исходный указатель и отмечает необходимость совместимого движения без двойной обработки. */
	const handleMove = (event: Event) => {
		const matchesPointer = isDragPointer(drag, event as PointerEvent);
		useCompatibilityMouseMove = !matchesPointer;
		if (matchesPointer) {
			handlers.move(event as MouseEvent);
		}
	};
	/** Дополняет жест мыши совместимым движением, когда pointer-событие пришло от другого устройства. */
	const handleCompatibilityMove = (event: Event) => {
		if (useCompatibilityMouseMove) {
			handlers.move(event as MouseEvent);
		}
	};
	/** Завершает жест по отпусканию его исходного устройства. */
	const handleFinish = (event: Event) => {
		if (isDragPointer(drag, event as PointerEvent)) {
			handlers.finish(event as PointerEvent);
		}
	};
	/** Отменяет жест только по отмене его исходного устройства. */
	const handleCancel = (event: Event) => {
		if (isDragPointer(drag, event as PointerEvent)) {
			handlers.cancel();
		}
	};
	target.addEventListener('pointermove', handleMove, { passive: false });
	if (drag.pointerType === 'mouse') {
		target.addEventListener('mousemove', handleCompatibilityMove, { passive: false });
	}
	target.addEventListener('pointerup', handleFinish, { passive: false });
	target.addEventListener('pointercancel', handleCancel, { passive: false });
	// Одна функция очистки используется при завершении, отмене, новом жесте и размонтировании.
	return () => {
		target.removeEventListener('pointermove', handleMove);
		target.removeEventListener('mousemove', handleCompatibilityMove);
		target.removeEventListener('pointerup', handleFinish);
		target.removeEventListener('pointercancel', handleCancel);
	};
}

