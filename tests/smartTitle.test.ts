import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSmartTitle } from '../src/utils/smartTitle.js';

describe('generateSmartTitle', () => {
	it('returns empty string for empty/whitespace input', () => {
		assert.equal(generateSmartTitle(''), '');
		assert.equal(generateSmartTitle('   '), '');
		assert.equal(generateSmartTitle('\n\n'), '');
	});

	it('extracts markdown heading', () => {
		assert.equal(generateSmartTitle('# My Prompt Title\n\nSome content'), 'My Prompt Title');
		assert.equal(generateSmartTitle('## Second Level Heading\n\nContent'), 'Second Level Heading');
	});

	it('strips YAML frontmatter and extracts heading after it', () => {
		const text = `---
title: Instructions for Agent
---

# Instructions for Agent

Do something useful.`;
		assert.equal(generateSmartTitle(text), 'Instructions for Agent');
	});

	it('strips HTML comments before extracting', () => {
		const text = `<!-- Draft -->
# Real Title

Content here.`;
		assert.equal(generateSmartTitle(text), 'Real Title');
	});

	it('extracts first meaningful line when no heading exists', () => {
		assert.equal(generateSmartTitle('Ты - опытный разработчик'), 'Ты - опытный разработчик');
	});

	it('extracts first sentence from long line', () => {
		const text = 'Настрой CI/CD для проекта. Используй GitHub Actions для автоматизации сборки и деплоя.';
		assert.equal(generateSmartTitle(text), 'Настрой CI/CD для проекта');
	});

	it('skips empty lines and code blocks', () => {
		const text = `

\`\`\`bash
echo hello
\`\`\`

Полезная первая строка`;
		assert.equal(generateSmartTitle(text), 'Полезная первая строка');
	});

	it('skips horizontal rules', () => {
		const text = `---
---

***

Actual content here`;
		assert.equal(generateSmartTitle(text), 'Actual content here');
	});

	it('cleans markdown formatting (bold, italic, links, code)', () => {
		assert.equal(generateSmartTitle('**Жирный текст** для работы'), 'Жирный текст для работы');
		assert.equal(generateSmartTitle('Используй [React](https://react.dev) для UI'), 'Используй React для UI');
		assert.equal(generateSmartTitle('Запусти `npm install` для начала'), 'Запусти npm install для начала');
	});

	it('truncates to maxLength at word boundary', () => {
		const longText = 'Реализуй полную систему авторизации с поддержкой двухфакторной аутентификации и восстановления пароля через email';
		const title = generateSmartTitle(longText, 60);
		assert.ok(title.length <= 60, `Title length ${title.length} exceeds 60`);
		// Не должен обрезать посреди слова
		assert.ok(!title.endsWith('-'), 'Should not end with hyphen');
	});

	it('capitalizes first letter', () => {
		assert.equal(generateSmartTitle('маленький текст'), 'Маленький текст');
	});

	it('removes trailing punctuation', () => {
		assert.equal(generateSmartTitle('Заголовок с точкой.'), 'Заголовок с точкой');
		assert.equal(generateSmartTitle('Заголовок с запятой,'), 'Заголовок с запятой');
	});

	it('handles markdown list items as first content', () => {
		const text = `
- Первый пункт списка
- Второй пункт`;
		assert.equal(generateSmartTitle(text), 'Первый пункт списка');
	});

	it('skips reference links [ref]: url', () => {
		const text = `[logo]: https://example.com/logo.png
[site]: https://example.com

Real content follows`;
		assert.equal(generateSmartTitle(text), 'Real content follows');
	});

	it('handles real-world prompt text (Russian)', () => {
		const text = `Ты - опытный разработчик, который выполняет задачи, связанные с проектами, указанными в соответствующих разделах. Ты должен анализировать проекты и выполнять задачи, следуя указанным условиям и рекомендациям.`;
		const title = generateSmartTitle(text);
		// Должно извлечь первое предложение
		assert.ok(title.length <= 60, `Title length ${title.length} exceeds 60`);
		assert.ok(title.length > 10, 'Title should be meaningful');
	});

	it('handles YAML frontmatter followed by content without heading', () => {
		const text = `---
scope: chat
---

Ты должен анализировать проекты и выполнять задачи, следуя указанным условиям и рекомендациям.`;
		const title = generateSmartTitle(text);
		assert.ok(title.startsWith('Ты должен анализировать проекты'));
	});

	it('uses custom maxLength', () => {
		const text = 'Очень длинное название которое нужно обрезать до указанной длины';
		const title = generateSmartTitle(text, 30);
		assert.ok(title.length <= 30, `Title length ${title.length} exceeds 30`);
	});

	it('handles text starting with markdown list marker', () => {
		const text = '- Настроить линтер в проекте';
		assert.equal(generateSmartTitle(text), 'Настроить линтер в проекте');
	});

	it('handles numbered list as first content', () => {
		const text = '1. Создать сервис авторизации';
		assert.equal(generateSmartTitle(text), 'Создать сервис авторизации');
	});
});
