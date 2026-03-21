/**
 * Быстрая генерация названия промпта из его текстового содержимого без AI.
 *
 * Алгоритм:
 * 1. Убирает YAML frontmatter (---...---)
 * 2. Убирает HTML-комментарии (<!-- ... -->)
 * 3. Ищет первый markdown-заголовок (# Title) — берёт его текст
 * 4. Если заголовка нет — находит первую значимую строку (не пустую, не кодовый блок, не разделитель)
 * 5. Из строки извлекает первое предложение (до точки/!/?)
 * 6. Очищает markdown-разметку (**, *, `, [](), <>, #)
 * 7. Обрезает до maxLength символов по границе слова
 */

/** Максимальная длина сгенерированного названия */
const DEFAULT_MAX_LENGTH = 60;

/**
 * Генерирует осмысленное название из текста промпта.
 * Возвращает пустую строку, если извлечь название не удалось.
 */
export function generateSmartTitle(content: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
	if (!content || !content.trim()) {
		return '';
	}

	let text = content;

	// 1. Убираем YAML frontmatter (--- ... ---)
	text = stripYamlFrontmatter(text);

	// 2. Убираем HTML-комментарии
	text = stripHtmlComments(text);

	// 3. Пробуем извлечь первый markdown-заголовок
	const heading = extractFirstHeading(text);
	if (heading) {
		return finalizeTitle(heading, maxLength);
	}

	// 4. Находим первую значимую строку
	const meaningfulLine = extractFirstMeaningfulLine(text);
	if (!meaningfulLine) {
		return '';
	}

	// 5. Извлекаем первое предложение из строки
	const sentence = extractFirstSentence(meaningfulLine);

	return finalizeTitle(sentence, maxLength);
}

/** Убирает YAML frontmatter в начале текста */
function stripYamlFrontmatter(text: string): string {
	const match = text.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
	return match ? text.slice(match[0].length) : text;
}

/** Убирает HTML-комментарии */
function stripHtmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** Извлекает текст первого markdown-заголовка (# Title / ## Title / etc.) */
function extractFirstHeading(text: string): string | null {
	const lines = text.split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		const match = trimmed.match(/^#{1,6}\s+(.+)$/);
		if (match) {
			const headingText = match[1].trim();
			if (headingText) {
				return headingText;
			}
		}
	}
	return null;
}

/**
 * Находит первую значимую строку текста.
 * Пропускает пустые строки, кодовые блоки (```), горизонтальные разделители (---/***),
 * строки-ссылки ([ref]: url) и строки, состоящие только из спецсимволов.
 */
function extractFirstMeaningfulLine(text: string): string | null {
	const lines = text.split('\n');
	let inCodeBlock = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Переключение кодовых блоков
		if (trimmed.startsWith('```')) {
			inCodeBlock = !inCodeBlock;
			continue;
		}
		if (inCodeBlock) {
			continue;
		}

		// Пропускаем пустые строки
		if (!trimmed) {
			continue;
		}

		// Пропускаем горизонтальные разделители (---, ***, ___)
		if (/^[-*_]{3,}\s*$/.test(trimmed)) {
			continue;
		}

		// Пропускаем строки-ссылки [ref]: url
		if (/^\[.+\]:\s/.test(trimmed)) {
			continue;
		}

		// Пропускаем строки только из спецсимволов (=== и тому подобное)
		if (/^[=\-~#*_`<>|+\s]+$/.test(trimmed)) {
			continue;
		}

		return trimmed;
	}

	return null;
}

/**
 * Извлекает первое предложение из строки.
 * Делит по знакам конца предложения (. ! ?) за которыми идёт пробел или конец строки.
 * Если предложение не найдено — возвращает всю строку.
 */
function extractFirstSentence(line: string): string {
	// Ищем конец предложения: точка/!/? за которым пробел, конец строки, или кавычка
	const match = line.match(/^(.+?[.!?])(?:\s|$|["»'"])/);
	if (match) {
		const sentence = match[1].trim();
		// Предложение должно содержать хотя бы 2 слова, иначе берём всю строку
		if (sentence.split(/\s+/).length >= 2) {
			return sentence;
		}
	}
	return line;
}

/** Очищает markdown-разметку из текста */
function cleanMarkdown(text: string): string {
	let clean = text;
	// Убираем markdown-ссылки [text](url) → text
	clean = clean.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
	// Убираем inline-изображения ![alt](url)
	clean = clean.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
	// Убираем жирное и курсивное выделение (**text**, __text__, *text*, _text_)
	clean = clean.replace(/(\*\*|__)(.*?)\1/g, '$2');
	clean = clean.replace(/(\*|_)(.*?)\1/g, '$2');
	// Убираем inline-код `code`
	clean = clean.replace(/`([^`]+)`/g, '$1');
	// Убираем HTML-теги
	clean = clean.replace(/<[^>]+>/g, '');
	// Убираем markdown-заголовочные символы в начале (#)
	clean = clean.replace(/^#{1,6}\s+/, '');
	// Убираем markdown-списки (- item, * item, + item, 1. item)
	clean = clean.replace(/^[\s]*[-*+]\s+/, '');
	clean = clean.replace(/^[\s]*\d+\.\s+/, '');
	// Убираем лишние пробелы
	clean = clean.replace(/\s+/g, ' ').trim();
	return clean;
}

/**
 * Финализация: очистка markdown, обрезка до maxLength по границе слова,
 * капитализация первой буквы.
 */
function finalizeTitle(raw: string, maxLength: number): string {
	const cleaned = cleanMarkdown(raw);
	if (!cleaned) {
		return '';
	}

	let title = cleaned;

	// Обрезаем по границе слова, если длиннее maxLength
	if (title.length > maxLength) {
		title = truncateAtWordBoundary(title, maxLength);
	}

	// Убираем trailing пунктуацию (точки, запятые, двоеточия, дефисы)
	title = title.replace(/[.,;:\-–—]+$/, '').trim();

	// Капитализация первой буквы
	if (title.length > 0) {
		title = title[0].toUpperCase() + title.slice(1);
	}

	return title;
}

/** Обрезает текст до maxLength символов по границе слова */
function truncateAtWordBoundary(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	// Ищем последний пробел в пределах maxLength
	const truncated = text.slice(0, maxLength);
	const lastSpace = truncated.lastIndexOf(' ');
	if (lastSpace > maxLength * 0.4) {
		return truncated.slice(0, lastSpace);
	}
	// Если слово слишком длинное — режем по maxLength
	return truncated;
}
