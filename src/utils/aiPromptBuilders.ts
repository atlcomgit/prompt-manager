import type { QuickNoteChecklistSuggestionInput } from '../types/quickNotes.js';

const PROMPT_CONTENT_LIMIT = 2000;

function trimPromptContent(content: string): string {
	return content.substring(0, PROMPT_CONTENT_LIMIT);
}

function normalizeLocale(locale?: string): string {
	return (locale || 'en').trim() || 'en';
}

function getBaseLocale(locale?: string): string {
	return normalizeLocale(locale).split(/[-_]/)[0]?.toLowerCase() || 'en';
}

function getLocaleLanguageName(locale?: string): string {
	const baseLocale = getBaseLocale(locale);
	switch (baseLocale) {
		case 'ru':
			return 'Russian';
		case 'en':
			return 'English';
		case 'zh':
			return 'Chinese';
		case 'ja':
			return 'Japanese';
		case 'ko':
			return 'Korean';
		case 'de':
			return 'German';
		case 'fr':
			return 'French';
		case 'es':
			return 'Spanish';
		case 'pt':
			return 'Portuguese';
		case 'it':
			return 'Italian';
		case 'uk':
			return 'Ukrainian';
		case 'pl':
			return 'Polish';
		case 'tr':
			return 'Turkish';
		default:
			return `the language for locale "${normalizeLocale(locale)}"`;
	}
}

function buildLocaleInstruction(locale?: string): string {
	const normalizedLocale = normalizeLocale(locale);
	const languageName = getLocaleLanguageName(locale);
	return `Respond strictly in ${languageName}. VS Code locale: ${normalizedLocale}. Do not switch to the language of the source prompt unless it is already ${languageName}.`;
}

export function buildPromptFieldLanguageRule(locale?: string): string {
	const normalizedLocale = normalizeLocale(locale);
	const languageName = getLocaleLanguageName(locale);
	return `Always respond in ${languageName}. Use the VS Code locale (${normalizedLocale}) as the source of truth for the response language, not the prompt content language.`;
}

export function buildTitleGenerationUserPrompt(content: string, locale?: string): string {
	return `${buildLocaleInstruction(locale)}\nGenerate a short title for this prompt:\n\n${trimPromptContent(content)}`;
}

export function buildDescriptionGenerationUserPrompt(content: string, locale?: string): string {
	return `${buildLocaleInstruction(locale)}\nGenerate a short description for this prompt:\n\n${trimPromptContent(content)}`;
}

/** Ограничения контекста запроса пункта чек-листа: описание, пункты, имена файлов и прежние варианты. */
const QUICK_NOTE_SUGGESTION_LIMITS = { description: 4000, items: 60, files: 30, previous: 10, itemText: 300 } as const;

/** Максимальная длина предложенного пункта после нормализации ответа модели. */
export const QUICK_NOTE_SUGGESTION_MAX_LENGTH = 200;

/** Системная инструкция: ровно один новый пункт без пояснений; тесты — tests/aiPromptBuilders.test.ts. */
export function buildQuickNoteChecklistSuggestionSystemPrompt(locale?: string): string {
	return [
		'You help maintain a short checklist inside a quick note in a developer tool.',
		'Suggest exactly ONE new checklist item that is the most useful next step for this note.',
		'The item must not repeat or rephrase existing items or previously suggested variants.',
		'Respond with ONLY the item text: one line, imperative mood, no numbering, no checkbox, no quotes, no explanations.',
		`Keep it shorter than ${QUICK_NOTE_SUGGESTION_MAX_LENGTH} characters.`,
		buildPromptFieldLanguageRule(locale),
	].join(' ');
}

/** Текст запроса с ограниченным контекстом заметки; тесты — tests/aiPromptBuilders.test.ts. */
export function buildQuickNoteChecklistSuggestionUserPrompt(input: QuickNoteChecklistSuggestionInput, locale?: string): string {
	const limits = QUICK_NOTE_SUGGESTION_LIMITS;
	const clip = (value: string, limit: number) => value.trim().slice(0, limit);
	const items = input.items.filter(item => item.text.trim()).slice(0, limits.items)
		.map(item => `- [${item.done ? 'x' : ' '}] ${clip(item.text, limits.itemText)}`);
	const files = input.fileNames.filter(Boolean).slice(0, limits.files).map(name => `- ${clip(name, limits.itemText)}`);
	const previous = input.previousSuggestions.filter(Boolean).slice(-limits.previous)
		.map(text => `- ${clip(text, limits.itemText)}`);
	return [
		buildLocaleInstruction(locale),
		`Note title: ${clip(input.title, limits.itemText) || '(empty)'}`,
		`Note description:\n${clip(input.description, limits.description) || '(empty)'}`,
		`Existing checklist items:\n${items.join('\n') || '(none)'}`,
		`Attached files:\n${files.join('\n') || '(none)'}`,
		`Already suggested, do not repeat:\n${previous.join('\n') || '(none)'}`,
		'Suggest one new checklist item.',
	].join('\n\n');
}

/**
 * Оставляет одну строку пункта без маркеров списка, отметок, нумерации и кавычек.
 * Пустая строка означает, что ответ непригоден, в том числе при повторе существующего пункта.
 */
export function normalizeQuickNoteChecklistSuggestion(raw: string, existingTexts: readonly string[] = []): string {
	const line = String(raw || '')
		.replace(/```[a-z]*\n?/gi, '')
		.split(/\r?\n/)
		.map(value => value.trim())
		.find(Boolean) || '';
	let text = line
		.replace(/^(?:[-*•]\s+)?(?:\[[ xX]\]\s*)?/, '')
		.replace(/^\d+[.)]\s+/, '')
		.replace(/^["'«“`]+|["'»”`]+$/g, '')
		.trim();
	if (text.length > QUICK_NOTE_SUGGESTION_MAX_LENGTH) {
		const cut = text.slice(0, QUICK_NOTE_SUGGESTION_MAX_LENGTH);
		const space = cut.lastIndexOf(' ');
		text = `${(space > QUICK_NOTE_SUGGESTION_MAX_LENGTH / 2 ? cut.slice(0, space) : cut).trim()}…`;
	}
	const key = text.toLocaleLowerCase();
	return text && !existingTexts.some(existing => existing.trim().toLocaleLowerCase() === key) ? text : '';
}
