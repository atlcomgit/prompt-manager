import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChatMemoryInstruction } from '../src/utils/chatMemoryInstructionBuilder.js';

test('buildChatMemoryInstruction includes focused usage rules in purpose section', () => {
	const output = buildChatMemoryInstruction({
		locale: 'ru',
		generatedAt: '2026-03-14T00:00:00.000Z',
		prompt: {
			id: 'demo-prompt',
			promptUuid: 'uuid-1',
			title: 'Demo',
			taskNumber: '',
			projects: [],
			branch: '',
		},
		rawMemoryContext: '## Контекст проектной памяти\n\n### Карта файлов проекта\n\n```text\n└── 🗁 demo\n```',
	});

	assert.match(output, /НЕ анализируй весь файл целиком\./);
	assert.match(output, /НЕ перечитывай файл повторно\./);
	assert.match(output, /Если нет явной необходимости — игнорируй codemap\./);
	assert.match(output, /По возможности используй grep по файлу\./);
	assert.match(output, /Не держи в памяти целиком данный файл\./);
});