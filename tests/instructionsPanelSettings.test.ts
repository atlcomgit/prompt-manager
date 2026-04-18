import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DEFAULT_CODEMAP_SETTINGS } from '../src/codemap/codeMapConfig.js';
import { InstructionsPanel } from '../src/webview/memory/components/InstructionsPanel.js';

const translations: Record<string, string> = {
	'memory.instructions.enabled.help': 'Включает систему codemap-инструкций, которая готовит карту кода по веткам для чатов.',
	'memory.instructions.autoUpdate.help': 'Автоматически обновляет отслеживаемые codemap-инструкции в фоне, когда срабатывают подходящие триггеры.',
	'memory.instructions.includeFileTree.help': 'Добавляет в сохранённые codemap-инструкции необязательный блок со структурой файлов. По умолчанию лучше держать выключенным, чтобы инструкция оставалась компактнее.',
	'memory.instructions.notificationsEnabled.help': 'Показывает статусы, когда задания обновления codemap запускаются, завершаются или падают с ошибкой.',
	'memory.instructions.trackedBranches.help': 'По одной ветке на строку. Для этих веток в фоне поддерживаются базовые инструкции, которые служат опорой для остальных веток.',
	'memory.instructions.instructionMaxChars.help': 'Задаёт целевой максимальный размер одной сохранённой codemap-инструкции.',
	'memory.instructions.blockMaxChars.help': 'Ограничивает размер одного сгенерированного описания блока внутри инструкции.',
	'memory.instructions.maxVersions.help': 'Хранит не больше этого количества сохранённых версий для каждой уникальной инструкции codemap.',
	'memory.instructions.aiModel.help': 'Выбирает семейство моделей Copilot, которое используется в AI-запросах при генерации codemap.',
	'memory.instructions.blockDescriptionMode.help': 'Управляет тем, насколько короткими или подробными будут описания блоков в инструкции.',
	'memory.instructions.updatePriority.help': 'Определяет приоритет фоновой очереди для заданий обновления codemap.',
	'memory.instructions.aiDelayMs.help': 'Добавляет паузу между AI-задачами codemap, чтобы снизить плотность запросов.',
	'memory.instructions.startupDelayMs.help': 'Задаёт паузу после активации расширения перед первым автоматическим обновлением codemap.',
	'memory.instructions.includeFileTree': 'Добавлять дерево файлов',
};

function t(key: string): string {
	return translations[key] || key;
}

test('InstructionsPanel renders helper descriptions for settings without previous explanations', () => {
	const markup = renderToStaticMarkup(React.createElement(InstructionsPanel, {
		instructions: [],
		selectedInstructionId: null,
		detail: null,
		statistics: null,
		activity: null,
		settings: { ...DEFAULT_CODEMAP_SETTINGS, aiModel: 'gpt-5.4' },
		availableModels: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
		onSelectInstruction: () => { },
		onRefreshInstructions: () => { },
		onRefreshWorkspace: () => { },
		onRefreshInstruction: () => { },
		onRefreshStatistics: () => { },
		onRefreshActivity: () => { },
		onRefreshSettings: () => { },
		onSaveSettings: () => { },
		onDeleteInstruction: () => { },
		onDeleteObsolete: () => { },
		isRefreshing: false,
		t,
		initialActiveTab: 'settings',
	}));

	for (const description of Object.values(translations)) {
		assert.ok(markup.includes(description), `Expected description to be rendered: ${description}`);
	}
});