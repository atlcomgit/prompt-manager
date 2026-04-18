import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DEFAULT_MEMORY_SETTINGS } from '../src/types/memory.js';
import { SettingsPanel } from '../src/webview/memory/components/SettingsPanel.js';

const translations: Record<string, string> = {
	'memory.loading': 'Загрузка...',
	'memory.saveSettings': 'Сохранить настройки',
	'memory.refresh': 'Обновить',
	'memory.settingsGeneral': 'Основные',
	'memory.settingsData': 'Управление данными',
	'memory.settingsNotifications': 'Уведомления',
	'memory.settingsEmbeddings': 'Эмбеддинги и граф',
	'memory.enabled': 'Память включена',
	'memory.enabledDescription': 'Включает память проекта: анализ коммитов, поиск по истории и фоновые процессы синхронизации.',
	'memory.aiModel': 'AI-модель',
	'memory.aiModelDescription': 'Определяет модель Copilot, которая анализирует diff и формирует выводы для памяти.',
	'memory.analysisDepth': 'Глубина анализа',
	'memory.analysisDepthDescription': 'Управляет детализацией анализа: minimal быстрее, deep добавляет более глубокие выводы и граф.',
	'memory.diffLimit': 'Макс. символов diff',
	'memory.diffLimitDescription': 'Ограничивает объём diff, который отправляется в AI при анализе одного коммита.',
	'memory.httpPort': 'HTTP-порт',
	'memory.httpPortDescription': 'Фиксирует порт локального hook-сервера. Значение 0 позволяет выбрать свободный порт автоматически.',
	'memory.httpPortHint': '(0 = случайный)',
	'memory.maxRecords': 'Макс. записей',
	'memory.maxRecordsDescription': 'Ограничивает общий объём записей памяти в базе, после чего старые данные начинают вытесняться.',
	'memory.retentionDays': 'Хранение (дней)',
	'memory.retentionDaysDescription': 'Определяет, сколько дней хранить данные памяти до очистки устаревших записей.',
	'memory.shortTermLimit': 'Лимит краткосрочной памяти',
	'memory.shortTermLimitDescription': 'Задаёт, сколько последних коммитов держать под рукой для быстрых сводок и контекста.',
	'memory.historyAnalysisLimit': 'Лимит анализа истории',
	'memory.historyAnalysisLimitDescription': 'Определяет максимум коммитов, которые обрабатываются за один ручной запуск анализа истории.',
	'memory.autoCleanup': 'Автоочистка',
	'memory.autoCleanupDescription': 'Запускает периодическую очистку, чтобы контролировать размер базы и удалять устаревшие данные.',
	'memory.notificationsEnabled': 'Уведомления включены',
	'memory.notificationsEnabledDescription': 'Показывает прогресс и статусы фоновых операций, связанных с памятью проекта.',
	'memory.notificationType': 'Тип уведомлений',
	'memory.notificationTypeDescription': 'Выбирает, где показывать обновления: во всплывающем окне, в статус-баре или только в логе.',
	'memory.embeddingsEnabled': 'Семантический поиск включён',
	'memory.embeddingsEnabledDescription': 'Создаёт векторные эмбеддинги, чтобы находить коммиты по смыслу, а не только по словам.',
	'memory.knowledgeGraphEnabled': 'Граф знаний включён',
	'memory.knowledgeGraphEnabledDescription': 'Извлекает связи между файлами и слоями, чтобы строить граф знаний проекта.',
};

function t(key: string): string {
	return translations[key] || key;
}

test('SettingsPanel renders helper descriptions for all memory settings', () => {
	const markup = renderToStaticMarkup(React.createElement(SettingsPanel, {
		settings: { ...DEFAULT_MEMORY_SETTINGS, aiModel: 'gpt-5.4' },
		availableModels: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
		onSave: () => { },
		onRefresh: () => { },
		t,
	}));

	for (const description of Object.values(translations).filter(value => value.includes(' ') && value.endsWith('.'))) {
		assert.ok(markup.includes(description), `Expected description to be rendered: ${description}`);
	}
});