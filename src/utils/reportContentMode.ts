export type ReportContentMode = 'text' | 'html' | 'markdown';

const HTML_ALLOWED_TAGS = new Set([
	'a', 'article', 'aside', 'b', 'blockquote', 'body', 'br', 'caption', 'code', 'col', 'colgroup', 'dd',
	'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head',
	'header', 'hr', 'html', 'i', 'img', 'li', 'main', 'meta', 'nav', 'ol', 'p', 'pre', 's', 'section', 'span',
	'strong', 'style', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'u', 'ul',
]);

const HTML_SELF_CLOSING_TAGS = new Set(['br', 'hr', 'img', 'meta', 'col']);

const MARKDOWN_HEADING_RE = /(^|\n)#{1,6}\s+\S/;
const MARKDOWN_LIST_RE = /(^|\n)(?:[-*+]\s+\S|\d+\.\s+\S)/;
const MARKDOWN_BLOCKQUOTE_RE = /(^|\n)>\s+\S/;
const MARKDOWN_FENCED_CODE_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/;
const MARKDOWN_LINK_RE = /\[[^\]\n]+\]\((?:[^()\s]+|<[^>]+>)(?:\s+['"][^'"]+['"])?\)/;
const MARKDOWN_TABLE_RE = /(^|\n)\|.+\|\s*\n\|(?:\s*:?-{3,}:?\s*\|)+/;
const MARKDOWN_TASK_LIST_RE = /(^|\n)-\s+\[[ xX]\]\s+\S/;
const MARKDOWN_INLINE_CODE_RE = /(^|[^`])`[^`\n]+`(?=$|[^`])/;
const MARKDOWN_EMPHASIS_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|(^|[\s([{:])\*[^*\n]+\*(?=$|[\s).,!?\]};:])|(^|[\s([{:])_[^_\n]+_(?=$|[\s).,!?\]};:]))/m;

function normalizeReportContent(value: string): string {
	return value
		.replace(/\r\n?/g, '\n')
		.replace(/[\u2028\u2029]/g, '\n')
		.trim();
}

export function looksLikeExplicitHtml(value: string): boolean {
	const normalized = normalizeReportContent(value);
	if (!normalized || !normalized.includes('<') || !normalized.includes('>')) {
		return false;
	}

	if (/<!doctype\s+html\b|<!--|<(?:html|head|body)\b/i.test(normalized)) {
		return true;
	}

	const matches = Array.from(normalized.matchAll(/<\s*(\/)?\s*([a-z][\w:-]*)\b([^<>]*)>/gi));
	if (matches.length === 0) {
		return false;
	}

	const openingCounts = new Map<string, number>();
	const closingCounts = new Map<string, number>();
	let matchedAllowedTag = false;

	for (const match of matches) {
		const isClosing = Boolean(match[1]);
		const tagName = String(match[2] || '').toLowerCase();
		const rawAttributes = String(match[3] || '');
		const rawTag = String(match[0] || '');

		if (!HTML_ALLOWED_TAGS.has(tagName)) {
			continue;
		}

		matchedAllowedTag = true;

		if (isClosing) {
			closingCounts.set(tagName, (closingCounts.get(tagName) || 0) + 1);
			continue;
		}

		openingCounts.set(tagName, (openingCounts.get(tagName) || 0) + 1);

		if (HTML_SELF_CLOSING_TAGS.has(tagName)) {
			return true;
		}

		if (/\s(?:href|src|class|id|style|target|rel|colspan|rowspan)\s*=\s*/i.test(rawAttributes)) {
			return true;
		}

		if (/\/>\s*$/.test(rawTag)) {
			return true;
		}
	}

	if (!matchedAllowedTag) {
		return false;
	}

	for (const [tagName, openCount] of openingCounts.entries()) {
		const closeCount = closingCounts.get(tagName) || 0;
		if (openCount > 0 && closeCount > 0) {
			return true;
		}
	}

	const distinctAllowedTags = new Set([...openingCounts.keys(), ...closingCounts.keys()]);
	return distinctAllowedTags.size >= 2;
}

export function looksLikeMarkdown(value: string): boolean {
	const normalized = normalizeReportContent(value);
	if (!normalized || looksLikeExplicitHtml(normalized)) {
		return false;
	}

	let score = 0;

	if (MARKDOWN_FENCED_CODE_RE.test(normalized)) {
		score += 3;
	}
	if (MARKDOWN_TABLE_RE.test(normalized)) {
		score += 3;
	}
	if (MARKDOWN_HEADING_RE.test(normalized)) {
		score += 2;
	}
	if (MARKDOWN_LIST_RE.test(normalized)) {
		score += 2;
	}
	if (MARKDOWN_BLOCKQUOTE_RE.test(normalized)) {
		score += 2;
	}
	if (MARKDOWN_LINK_RE.test(normalized)) {
		score += 2;
	}
	if (MARKDOWN_TASK_LIST_RE.test(normalized)) {
		score += 2;
	}
	if (MARKDOWN_INLINE_CODE_RE.test(normalized)) {
		score += 1;
	}
	if (MARKDOWN_EMPHASIS_RE.test(normalized)) {
		score += 1;
	}

	return score >= 2;
}

export function detectReportContentMode(value: string): ReportContentMode {
	const normalized = normalizeReportContent(value);
	if (!normalized) {
		return 'text';
	}

	if (looksLikeExplicitHtml(normalized)) {
		return 'html';
	}

	if (looksLikeMarkdown(normalized)) {
		return 'markdown';
	}

	return 'text';
}