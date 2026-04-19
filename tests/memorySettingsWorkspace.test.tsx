import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DEFAULT_CODEMAP_SETTINGS } from '../src/codemap/codeMapConfig.js';
import { DEFAULT_MEMORY_SETTINGS } from '../src/types/memory.js';
import { MemorySettingsWorkspace } from '../src/webview/memory/components/MemorySettingsWorkspace.js';

const translations: Record<string, string> = {
	'memory.loading': 'Загрузка...',
	'memory.saveSettings': 'Сохранить настройки',
	'memory.refresh': 'Обновить',
	'memory.settings.workspaceTitle': 'Единые настройки памяти',
	'memory.settings.workspaceDescription': 'Соберите рядом настройки истории памяти и codemap-инструкций.',
	'memory.settings.workspaceTabs': 'Вкладки настроек',
	'memory.settings.tab.history': 'История',
	'memory.settings.tab.instructions': 'Инструкции',
	'memory.settingsGeneral': 'Основные',
	'memory.settingsData': 'Хранение',
	'memory.settingsNotifications': 'Уведомления',
	'memory.settingsEmbeddings': 'Эмбеддинги и граф',
	'memory.enabled': 'Память включена',
	'memory.enabledDescription': 'История проекта сохраняется и анализируется.',
	'memory.aiModel': 'AI-модель',
	'memory.aiModelDescription': 'Модель для анализа памяти.',
	'memory.analysisDepth': 'Глубина анализа',
	'memory.analysisDepthDescription': 'Определяет детализацию анализа.',
	'memory.diffLimit': 'Макс. символов diff',
	'memory.diffLimitDescription': 'Ограничивает объём diff.',
	'memory.httpPort': 'HTTP-порт',
	'memory.httpPortDescription': 'Порт локального hook-сервера.',
	'memory.httpPortHint': '(0 = случайный)',
	'memory.maxRecords': 'Макс. записей',
	'memory.maxRecordsDescription': 'Ограничивает общий объём памяти.',
	'memory.retentionDays': 'Хранение (дней)',
	'memory.retentionDaysDescription': 'Срок хранения данных памяти.',
	'memory.shortTermLimit': 'Лимит краткосрочной памяти',
	'memory.shortTermLimitDescription': 'Сколько последних коммитов держать под рукой.',
	'memory.historyAnalysisLimit': 'Лимит анализа истории',
	'memory.historyAnalysisLimitDescription': 'Максимум коммитов на один запуск.',
	'memory.backgroundPriority': 'Фоновый приоритет',
	'memory.backgroundPriorityDescription': 'Снижает нагрузку фонового анализа.',
	'memory.autoCleanup': 'Автоочистка',
	'memory.autoCleanupDescription': 'Очищает устаревшие данные памяти.',
	'memory.notificationsEnabled': 'Уведомления включены',
	'memory.notificationsEnabledDescription': 'Показывает статусы операций памяти.',
	'memory.notificationType': 'Тип уведомлений',
	'memory.notificationTypeDescription': 'Где показывать обновления.',
	'memory.embeddingsEnabled': 'Семантический поиск включён',
	'memory.embeddingsEnabledDescription': 'Создаёт эмбеддинги для поиска по смыслу.',
	'memory.knowledgeGraphEnabled': 'Граф знаний включён',
	'memory.knowledgeGraphEnabledDescription': 'Строит граф связей проекта.',
	'memory.instructions.enabled.help': 'Включает систему codemap-инструкций.',
	'memory.instructions.autoUpdate': 'Автоматические обновления',
	'memory.instructions.autoUpdate.help': 'Автоматически обновляет codemap.',
	'memory.instructions.includeFileTree': 'Добавлять дерево файлов',
	'memory.instructions.includeFileTree.help': 'Добавляет дерево файлов в инструкцию.',
	'memory.instructions.notificationsEnabled.help': 'Показывает статусы фоновых заданий.',
	'memory.instructions.trackedBranches': 'Отслеживаемые ветки',
	'memory.instructions.trackedBranches.help': 'По одной ветке на строку.',
	'memory.instructions.excludedPaths': 'Исключённые папки / пути',
	'memory.instructions.excludedPaths.help': 'По одному значению на строку.',
	'memory.instructions.limits': 'Лимиты',
	'memory.instructions.instructionMaxChars': 'Макс. символов инструкции',
	'memory.instructions.instructionMaxChars.help': 'Целевой размер инструкции.',
	'memory.instructions.blockMaxChars': 'Макс. символов блока',
	'memory.instructions.blockMaxChars.help': 'Лимит размера одного блока.',
	'memory.instructions.maxVersions': 'Версий на инструкцию',
	'memory.instructions.maxVersions.help': 'Сколько версий хранить.',
	'memory.instructions.batching': 'AI-батчинг',
	'memory.instructions.batchingSummary': 'Лимиты на размер AI-запросов и состав батчей.',
	'memory.instructions.batchContextMaxChars': 'Макс. символов AI-контекста батча',
	'memory.instructions.batchContextMaxChars.help': 'Ограничивает общий размер AI-контекста.',
	'memory.instructions.areaBatchMaxItems': 'Областей в AI-батче',
	'memory.instructions.areaBatchMaxItems.help': 'Сколько областей можно отправить вместе.',
	'memory.instructions.symbolBatchMaxItems': 'Символов в AI-батче',
	'memory.instructions.symbolBatchMaxItems.help': 'Сколько символов можно описать за запрос.',
	'memory.instructions.symbolBatchMaxFiles': 'Файлов в батче символов',
	'memory.instructions.symbolBatchMaxFiles.help': 'Сколько файлов можно смешивать в одном батче.',
	'memory.instructions.recommendation.conservative': 'Осторожно.',
	'memory.instructions.recommendation.balanced': 'Рекомендуется.',
	'memory.instructions.recommendation.aggressive': 'Агрессивно.',
	'memory.instructions.unit.chars': 'симв.',
	'memory.instructions.unit.areas': 'областей',
	'memory.instructions.unit.symbols': 'символов',
	'memory.instructions.unit.files': 'файлов',
	'memory.instructions.ai': 'AI и расписание',
	'memory.instructions.aiModel.help': 'Выбирает семейство моделей Copilot.',
	'memory.instructions.blockDescriptionMode': 'Режим описания блока',
	'memory.instructions.blockDescriptionMode.help': 'Насколько подробны описания блоков.',
	'memory.instructions.updatePriority': 'Приоритет обновления',
	'memory.instructions.updatePriority.help': 'Приоритет фоновой очереди.',
	'memory.instructions.aiDelayMs': 'Задержка AI, мс',
	'memory.instructions.aiDelayMs.help': 'Пауза между AI-задачами.',
	'memory.instructions.startupDelayMs': 'Задержка старта, мс',
	'memory.instructions.startupDelayMs.help': 'Пауза перед первым автообновлением.',
};

function t(key: string): string {
	return translations[key] || key;
}

test('MemorySettingsWorkspace renders history settings tab inside unified settings page', () => {
	const markup = renderToStaticMarkup(React.createElement(MemorySettingsWorkspace, {
		activeTab: 'history',
		onTabChange: () => { },
		memorySettings: { ...DEFAULT_MEMORY_SETTINGS, aiModel: 'gpt-5.4' },
		codeMapSettings: { ...DEFAULT_CODEMAP_SETTINGS, aiModel: 'gpt-5.4' },
		availableModels: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
		onSaveMemorySettings: () => { },
		onRefreshMemorySettings: () => { },
		onSaveInstructionSettings: () => { },
		onRefreshInstructionSettings: () => { },
		t,
	}));

	assert.ok(markup.includes('Единые настройки памяти'));
	assert.ok(markup.includes('История'));
	assert.ok(markup.includes('AI-модель'));
	assert.ok(markup.includes('Семантический поиск включён'));
});

test('MemorySettingsWorkspace renders instruction settings tab inside unified settings page', () => {
	const markup = renderToStaticMarkup(React.createElement(MemorySettingsWorkspace, {
		activeTab: 'instructions',
		onTabChange: () => { },
		memorySettings: { ...DEFAULT_MEMORY_SETTINGS, aiModel: 'gpt-5.4' },
		codeMapSettings: { ...DEFAULT_CODEMAP_SETTINGS, aiModel: 'gpt-5.4' },
		availableModels: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
		onSaveMemorySettings: () => { },
		onRefreshMemorySettings: () => { },
		onSaveInstructionSettings: () => { },
		onRefreshInstructionSettings: () => { },
		t,
	}));

	assert.ok(markup.includes('Единые настройки памяти'));
	assert.ok(markup.includes('Инструкции'));
	assert.ok(markup.includes('Отслеживаемые ветки'));
	assert.ok(markup.includes('Автоматически обновляет codemap.'));
});