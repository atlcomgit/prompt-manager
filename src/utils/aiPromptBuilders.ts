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
