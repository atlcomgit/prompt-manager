/**
 * PromptVoicePostCorrectionService — AI пост-коррекция текста
 * после распознавания речи через Whisper.
 *
 * Использует Copilot Language Model API (vscode.lm) для исправления
 * типичных ошибок транскрипции: неверная пунктуация, слипшиеся слова,
 * фонетические ошибки в русском/английском тексте.
 *
 * Если LM API недоступен или вернул ошибку — возвращает исходный текст
 * без изменений (graceful degradation).
 */

import * as vscode from 'vscode';

/** Системный промпт для LM, задающий роль корректора транскрипции */
const SYSTEM_PROMPT = [
	'Ты — корректор текста, полученного из автоматического распознавания речи (STT/Whisper).',
	'Исправь ошибки распознавания: пунктуацию, регистр, слипшиеся или разорванные слова,',
	'фонетические подмены, пропущенные предлоги и союзы.',
	'Сохрани исходный смысл, стиль и структуру текста.',
	'Не добавляй новых предложений, не перефразируй, не объясняй изменения.',
	'Верни только исправленный текст без кавычек, маркеров и комментариев.',
].join(' ');

/** Таймаут ожидания ответа от LM (мс) */
const LM_TIMEOUT_MS = 15_000;

/** Минимальная длина текста для отправки на коррекцию (символов) */
const MIN_TEXT_LENGTH = 3;

/** Copilot model selector для быстрой бесплатной модели */
const MODEL_SELECTOR: vscode.LanguageModelChatSelector = {
	vendor: 'copilot',
};

export class PromptVoicePostCorrectionService {
	/**
	 * Исправляет ошибки транскрипции через Copilot LM API.
	 * При любой ошибке или недоступности модели возвращает исходный текст.
	 * @param rawText — сырой текст после Whisper
	 * @returns исправленный текст или оригинал при ошибке
	 */
	async correct(rawText: string): Promise<string> {
		const trimmed = rawText.trim();
		// Слишком короткий текст не нуждается в коррекции
		if (trimmed.length < MIN_TEXT_LENGTH) {
			return trimmed;
		}

		// Проверяем включена ли пост-коррекция в настройках
		const enabled = vscode.workspace
			.getConfiguration('promptManager')
			.get<boolean>('voice.aiPostCorrection', true);

		if (!enabled) {
			return trimmed;
		}

		try {
			return await this.requestCorrection(trimmed);
		} catch (err) {
			console.warn('[PromptManager/Voice] AI post-correction failed, using raw text:', err);
			return trimmed;
		}
	}

	/** Отправляет текст на коррекцию в LM и возвращает результат */
	private async requestCorrection(text: string): Promise<string> {
		const [model] = await vscode.lm.selectChatModels(MODEL_SELECTOR);
		if (!model) {
			return text;
		}

		// Формируем запрос к LM
		const messages = [
			vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
			vscode.LanguageModelChatMessage.User(text),
		];

		// CancellationToken с таймаутом для защиты от зависания
		const cts = new vscode.CancellationTokenSource();
		const timer = setTimeout(() => cts.cancel(), LM_TIMEOUT_MS);

		try {
			const response = await model.sendRequest(messages, {}, cts.token);
			let result = '';
			for await (const chunk of response.text) {
				result += chunk;
			}
			const corrected = result.trim();
			// LM может вернуть пустую строку или мусор — fallback на оригинал
			return corrected.length >= MIN_TEXT_LENGTH ? corrected : text;
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
	}
}
