import MarkdownIt from 'markdown-it';

/** Renderer только для чтения: HTML, переходы и загрузка изображений исключены. */
const renderer = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
renderer.renderer.rules.link_open = () => '<span class="pm-hover-link">';
renderer.renderer.rules.link_close = () => '</span>';
renderer.renderer.rules.image = (tokens, index) => renderer.utils.escapeHtml(tokens[index].content);

/** Форматирует полный текст без обрезания; проверки безопасности: promptHoverPreview.test.ts. */
export function renderPromptHoverMarkdown(content: string): string {
	return renderer.render(content);
}
