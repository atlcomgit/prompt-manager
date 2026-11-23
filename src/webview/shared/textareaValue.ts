/** В значении textarea браузер заменяет каждый CR, LF и CRLF одним LF. */
export function textareaValue(text: string): string {
	return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** При возврате к исходному тексту восстанавливает его сохранённые окончания строк. */
export function textareaDraft(value: string, original: string): string {
	return value === textareaValue(original) ? original : value;
}
