import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import type { Uri } from 'vscode';

/** Коды ошибок провайдера файлов VS Code различают отсутствие документа и отказ в доступе. */
class FileSystemError extends Error {
	constructor(readonly code: string) { super(code); }
}

/** Открывает и обновляет панель About в файловой системе с учётом регистра имён. */
test('About renders both the packaged and source README and reports read failures', async t => {
	const root = 'file:///extension/';
	const files = new Map<string, string>();
	const webview = {
		html: '', cspSource: 'test:', asWebviewUri: (uri: Uri) => uri, onDidReceiveMessage() {},
	};
	const fs = {
		async readFile(uri: URL) {
			const content = files.get(uri.href);
			if (content === undefined) throw new FileSystemError('FileNotFound');
			return Buffer.from(content);
		},
	};
	const vscode = {
		env: { language: 'ru' }, ViewColumn: { One: 1 }, FileSystemError,
		Uri: { joinPath: (base: URL, ...parts: string[]) => new URL(parts.join('/'), base) },
		window: { createWebviewPanel: () => ({ webview, onDidDispose() {}, reveal() {} }) },
		workspace: { fs },
	};
	// Подменяем только VS Code API, чтобы проверить рабочий метод show() вместе с Markdown-рендерером.
	const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
	const load = loader._load;
	t.mock.method(loader, '_load', function (id: string, ...args: unknown[]) {
		return id === 'vscode' ? vscode : load.call(loader, id, ...args);
	});
	const { AboutPanelManager } = await import('../src/providers/aboutPanelManager.js');
	const manager = new AboutPanelManager(new URL(root) as unknown as Uri, '1.0.0', '');
	for (const filename of ['readme.md', 'README.md']) {
		files.set(root + filename, '# Документация');
		await manager.show();
		assert.match(webview.html, /<h1>Документация<\/h1>/);
		files.clear();
	}

	// Если документа действительно нет, панель выводит локализованное сообщение об ошибке.
	await manager.show();
	assert.match(webview.html, /Не удалось загрузить README\.md\./);
});
