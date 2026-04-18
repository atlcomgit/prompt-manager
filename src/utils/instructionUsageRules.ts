export function getInstructionUsageRules(locale: string): string[] {
	const isRussianLocale = locale.toLowerCase().startsWith('ru');
	return isRussianLocale
		? [
			'Используй его как фоновую карту кода при работе в чате.',
			'НЕ анализируй весь файл целиком.',
			'Используй только релевантные части.',
			'НЕ перечитывай файл повторно.',
			'Если нет явной необходимости — игнорируй codemap.',
			'По возможности используй grep по файлу.',
			'Не зацикливайся на этом файле и обращайся к нему точечно.',
			'Не держи в памяти целиком данный файл.',
		]
		: [
			'Use it as background code-map context while working in chat.',
			'DO NOT analyze the whole file end to end.',
			'Use only the relevant parts.',
			'DO NOT reread the file repeatedly.',
			'Ignore codemap when there is no clear need for it.',
			'Use grep against the file when practical.',
			'Do not get stuck on this file; consult it only where it helps.',
			'Do not keep the entire file in memory.',
		];
}