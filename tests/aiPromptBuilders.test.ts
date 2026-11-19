import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildDescriptionGenerationUserPrompt,
	buildPromptFieldLanguageRule,
	buildQuickNoteChecklistSuggestionSystemPrompt,
	buildQuickNoteChecklistSuggestionUserPrompt,
	buildTitleGenerationUserPrompt,
	normalizeQuickNoteChecklistSuggestion,
	QUICK_NOTE_SUGGESTION_MAX_LENGTH,
} from '../src/utils/aiPromptBuilders.js';

test('buildTitleGenerationUserPrompt builds title request without global context prefix', () => {
	const result = buildTitleGenerationUserPrompt('Напиши SQL миграцию', 'ru');

	assert.equal(result, 'Respond strictly in Russian. VS Code locale: ru. Do not switch to the language of the source prompt unless it is already Russian.\nGenerate a short title for this prompt:\n\nНапиши SQL миграцию');
	assert.equal(result.includes('Global agent context:'), false);
});

test('buildDescriptionGenerationUserPrompt builds description request without global context prefix', () => {
	const result = buildDescriptionGenerationUserPrompt('Опиши поведение новой кнопки', 'ru');

	assert.equal(result, 'Respond strictly in Russian. VS Code locale: ru. Do not switch to the language of the source prompt unless it is already Russian.\nGenerate a short description for this prompt:\n\nОпиши поведение новой кнопки');
	assert.equal(result.includes('Global agent context:'), false);
});

test('prompt field generation builders keep the 2000 character content limit', () => {
	const content = 'a'.repeat(2500);

	assert.equal(buildTitleGenerationUserPrompt(content, 'en'), `Respond strictly in English. VS Code locale: en. Do not switch to the language of the source prompt unless it is already English.\nGenerate a short title for this prompt:\n\n${'a'.repeat(2000)}`);
	assert.equal(buildDescriptionGenerationUserPrompt(content, 'en'), `Respond strictly in English. VS Code locale: en. Do not switch to the language of the source prompt unless it is already English.\nGenerate a short description for this prompt:\n\n${'a'.repeat(2000)}`);
});

test('prompt field generation builders default locale to en when missing', () => {
	assert.equal(
		buildTitleGenerationUserPrompt('hello'),
		'Respond strictly in English. VS Code locale: en. Do not switch to the language of the source prompt unless it is already English.\nGenerate a short title for this prompt:\n\nhello',
	);
	assert.equal(
		buildDescriptionGenerationUserPrompt('hello'),
		'Respond strictly in English. VS Code locale: en. Do not switch to the language of the source prompt unless it is already English.\nGenerate a short description for this prompt:\n\nhello',
	);
});

test('buildPromptFieldLanguageRule uses locale instead of content language', () => {
	assert.equal(
		buildPromptFieldLanguageRule('ru-RU'),
		'Always respond in Russian. Use the VS Code locale (ru-RU) as the source of truth for the response language, not the prompt content language.',
	);
});

/** Запрос пункта чек-листа ограничивает контекст заметки и задаёт язык ответа по локали VS Code. */
test('quick note checklist suggestion prompts limit note context and set response language', () => {
	const system = buildQuickNoteChecklistSuggestionSystemPrompt('ru');
	assert.match(system, /exactly ONE new checklist item/);
	assert.match(system, /Always respond in Russian/);
	const user = buildQuickNoteChecklistSuggestionUserPrompt({
		title: 'Кеш списка',
		description: 'д'.repeat(5000),
		items: [{ text: 'Найти место', done: true }, { text: ' ', done: false }],
		fileNames: ['a.png'],
		previousSuggestions: ['Добавить тест'],
	}, 'ru');
	assert.match(user, /^Respond strictly in Russian/);
	assert.match(user, /Note title: Кеш списка/);
	assert.equal(user.includes('д'.repeat(4000)), true);
	assert.equal(user.includes('д'.repeat(4001)), false);
	assert.match(user, /- \[x\] Найти место/);
	assert.equal(user.includes('- [ ]  '), false);
	assert.match(user, /Attached files:\n- a\.png/);
	assert.match(user, /do not repeat:\n- Добавить тест/);
	const empty = buildQuickNoteChecklistSuggestionUserPrompt({ title: '', description: '', items: [], fileNames: [], previousSuggestions: [] }, 'en');
	assert.match(empty, /Existing checklist items:\n\(none\)/);
});

/** Ответ модели сводится к одной строке пункта; повтор существующего пункта считается непригодным. */
test('normalizeQuickNoteChecklistSuggestion cleans markers and rejects duplicates', () => {
	for (const [raw, expected] of [
		['- [ ] Добавить тест\nПояснение', 'Добавить тест'],
		['1. «Проверить архив»', 'Проверить архив'],
		['```\n* Обновить README\n```', 'Обновить README'],
		['"Сравнить кеш"', 'Сравнить кеш'],
		['', ''],
	] as const) {
		assert.equal(normalizeQuickNoteChecklistSuggestion(raw), expected, raw);
	}
	assert.equal(normalizeQuickNoteChecklistSuggestion('добавить ТЕСТ', ['Добавить тест']), '');
	const long = normalizeQuickNoteChecklistSuggestion(`${'слово '.repeat(60)}`);
	assert.equal(long.length <= QUICK_NOTE_SUGGESTION_MAX_LENGTH + 1, true);
	assert.equal(long.endsWith('…'), true);
});
