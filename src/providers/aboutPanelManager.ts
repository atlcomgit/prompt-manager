import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { getNonce } from '../utils/nonce.js';

let currentPanel: vscode.WebviewPanel | undefined;

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function addExternalLinkTargets(html: string): string {
	return html.replace(/<a\s+([^>]*?)href=(['"])([^'"]+)\2([^>]*)>/gi, (match, beforeHref, quote, href, afterHref) => {
		if (!/^(https?:|mailto:)/i.test(href) || /\btarget=/i.test(match)) {
			return match;
		}

		return `<a ${beforeHref}href=${quote}${href}${quote}${afterHref} target="_blank" rel="noopener noreferrer">`;
	});
}

function getLabels(locale: string): { about: string; readme: string; description: string; unavailable: string } {
	const isRu = locale.toLowerCase().startsWith('ru');
	return {
		about: isRu ? 'О расширении' : 'About',
		readme: 'README.md',
		description: isRu ? 'Документация расширения из корня проекта' : 'Extension documentation from the project root',
		unavailable: isRu ? 'Не удалось загрузить README.md.' : 'Failed to load README.md.',
	};
}

export class AboutPanelManager {
	private readonly markdown = new MarkdownIt({
		html: true,
		linkify: true,
		typographer: true,
	});

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly version: string,
		private readonly description: string,
	) { }

	async show(): Promise<void> {
		if (currentPanel) {
			currentPanel.title = this.getPanelTitle();
			currentPanel.webview.html = await this.buildHtml(currentPanel.webview);
			currentPanel.reveal(vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'promptManager.about',
			this.getPanelTitle(),
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				enableFindWidget: true,
				retainContextWhenHidden: true,
				localResourceRoots: [this.extensionUri],
			}
		);

		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
		panel.webview.onDidReceiveMessage(async (message: unknown) => {
			if (!message || typeof message !== 'object') {
				return;
			}

			const typedMessage = message as { type?: string; href?: string };
			if (typedMessage.type !== 'openExternal' || !typedMessage.href) {
				return;
			}

			await vscode.env.openExternal(vscode.Uri.parse(typedMessage.href));
		});
		panel.webview.html = await this.buildHtml(panel.webview);

		currentPanel = panel;

		panel.onDidDispose(() => {
			currentPanel = undefined;
		});
	}

	private getPanelTitle(): string {
		return `About ${this.version}`;
	}

	private async buildHtml(webview: vscode.Webview): Promise<string> {
		const locale = vscode.env.language || 'en';
		const labels = getLabels(locale);
		const baseUri = webview.asWebviewUri(this.extensionUri).toString().replace(/\/?$/, '/');
		const nonce = getNonce();

		let contentHtml: string;
		try {
			const readmeUri = vscode.Uri.joinPath(this.extensionUri, 'README.md');
			const bytes = await vscode.workspace.fs.readFile(readmeUri);
			const markdown = Buffer.from(bytes).toString('utf8');
			contentHtml = addExternalLinkTargets(this.markdown.render(markdown));
		} catch {
			contentHtml = `<p>${escapeHtml(labels.unavailable)}</p>`;
		}

		return `<!DOCTYPE html>
<html lang="${escapeHtml(locale.toLowerCase())}">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<base href="${baseUri}" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
	<title>${escapeHtml(this.getPanelTitle())}</title>
	<style>
		:root {
			--pm-bg: var(--vscode-editor-background);
			--pm-fg: var(--vscode-editor-foreground);
			--pm-muted: var(--vscode-descriptionForeground);
			--pm-border: var(--vscode-panel-border);
			--pm-panel: color-mix(in srgb, var(--vscode-sideBar-background) 86%, transparent);
			--pm-link: var(--vscode-textLink-foreground);
			--pm-link-hover: var(--vscode-textLink-activeForeground);
			--pm-code-bg: var(--vscode-textCodeBlock-background);
			--pm-inline-code-bg: color-mix(in srgb, var(--vscode-textCodeBlock-background) 75%, transparent);
			--pm-accent: var(--vscode-button-background);
			--pm-accent-fg: var(--vscode-button-foreground);
		}

		* {
			box-sizing: border-box;
		}

		html, body {
			margin: 0;
			padding: 0;
			background: var(--pm-bg);
			color: var(--pm-fg);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}

		body {
			padding: 24px;
		}

		.layout {
			max-width: 980px;
			margin: 0 auto;
			display: flex;
			flex-direction: column;
			gap: 20px;
		}

		.hero {
			padding: 20px 22px;
			border: 1px solid var(--pm-border);
			border-radius: 14px;
			background:
				linear-gradient(135deg, color-mix(in srgb, var(--pm-accent) 14%, transparent), transparent 55%),
				var(--pm-panel);
		}

		.badges {
			display: flex;
			gap: 8px;
			flex-wrap: wrap;
			margin-bottom: 12px;
		}

		.badge {
			display: inline-flex;
			align-items: center;
			padding: 4px 10px;
			border-radius: 999px;
			border: 1px solid var(--pm-border);
			font-size: 12px;
			line-height: 1.2;
		}

		.badge--accent {
			background: var(--pm-accent);
			color: var(--pm-accent-fg);
			border-color: transparent;
		}

		.hero h1 {
			margin: 0 0 8px;
			font-size: 28px;
			line-height: 1.2;
		}

		.hero p {
			margin: 0;
			color: var(--pm-muted);
			line-height: 1.6;
		}

		.markdown {
			padding: 24px;
			border: 1px solid var(--pm-border);
			border-radius: 14px;
			background: var(--pm-panel);
			overflow: hidden;
		}

		.markdown > :first-child {
			margin-top: 0;
		}

		.markdown > :last-child {
			margin-bottom: 0;
		}

		.markdown h1,
		.markdown h2,
		.markdown h3,
		.markdown h4 {
			line-height: 1.25;
			margin: 1.5em 0 0.6em;
		}

		.markdown p,
		.markdown ul,
		.markdown ol,
		.markdown blockquote,
		.markdown table,
		.markdown pre {
			margin: 0 0 1em;
		}

		.markdown a {
			color: var(--pm-link);
		}

		.markdown a:hover {
			color: var(--pm-link-hover);
		}

		.markdown code {
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 0.95em;
			padding: 0.15em 0.35em;
			border-radius: 4px;
			background: var(--pm-inline-code-bg);
		}

		.markdown pre {
			padding: 14px 16px;
			border-radius: 10px;
			background: var(--pm-code-bg);
			overflow: auto;
		}

		.markdown pre code {
			padding: 0;
			background: transparent;
		}

		.markdown hr {
			border: 0;
			border-top: 1px solid var(--pm-border);
			margin: 24px 0;
		}

		.markdown img {
			max-width: 100%;
			height: auto;
		}

		.markdown table {
			width: 100%;
			border-collapse: collapse;
		}

		.markdown th,
		.markdown td {
			padding: 10px 12px;
			border: 1px solid var(--pm-border);
			text-align: left;
			vertical-align: top;
		}

		.markdown blockquote {
			margin-left: 0;
			padding-left: 16px;
			border-left: 3px solid var(--pm-border);
			color: var(--pm-muted);
		}

		::-webkit-scrollbar {
			width: 10px;
			height: 10px;
		}

		::-webkit-scrollbar-thumb {
			background: var(--vscode-scrollbarSlider-background);
			border-radius: 999px;
		}

		@media (max-width: 720px) {
			body {
				padding: 14px;
			}

			.hero,
			.markdown {
				padding: 16px;
			}
		}
	</style>
</head>
<body>
	<div class="layout">
		<header class="hero">
			<div class="badges">
				<span class="badge badge--accent">${escapeHtml(this.getPanelTitle())}</span>
				<span class="badge">${escapeHtml(labels.readme)}</span>
			</div>
			<h1>${escapeHtml(labels.about)}</h1>
			<p>${escapeHtml(this.description || labels.description)}</p>
		</header>
		<article class="markdown">
			${contentHtml}
		</article>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.addEventListener('click', (event) => {
			const target = event.target;
			if (!(target instanceof Element)) {
				return;
			}

			const link = target.closest('a[href]');
			if (!(link instanceof HTMLAnchorElement)) {
				return;
			}

			const href = link.getAttribute('href') || '';
			if (!/^(https?:|mailto:)/i.test(href)) {
				return;
			}

			event.preventDefault();
			vscode.postMessage({ type: 'openExternal', href });
		});
	</script>
</body>
</html>`;
	}
}