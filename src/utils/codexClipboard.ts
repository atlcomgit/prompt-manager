// Codex 26.1021 converts a single paste of >= 5000 UTF-16 code units to a text attachment.
// Keep each clipboard event below that threshold; the complete composer may be longer.
const CODEX_PASTE_ATTACHMENT_THRESHOLD = 5000;
const CODEX_PASTE_CHUNK_SIZE = 4000;

/** Splits without trimming text or separating a surrogate pair / CRLF across clipboard writes. */
export function splitCodexPasteText(text: string): string[] {
	if (text.length < CODEX_PASTE_ATTACHMENT_THRESHOLD) {
		return [text];
	}
	const chunks: string[] = [];
	for (let start = 0; start < text.length;) {
		let end = Math.min(start + CODEX_PASTE_CHUNK_SIZE, text.length);
		const lastCodeUnit = text.charCodeAt(end - 1);
		if (end < text.length && (
			(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff)
			|| (text[end - 1] === '\r' && text[end] === '\n')
		)) {
			end -= 1;
		}
		chunks.push(text.slice(start, end));
		start = end;
	}
	return chunks;
}
