import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDescriptionGenerationUserPrompt, buildPromptFieldLanguageRule, buildTitleGenerationUserPrompt } from '../src/utils/aiPromptBuilders.js';

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
