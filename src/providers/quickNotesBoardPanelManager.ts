/**
 * Страница доски быстрых заметок: отдельная вкладка редактора со стикерами заметок обеих областей.
 * Сообщения обрабатывает общий QuickNotesHostController, поэтому доска и виджет видят одни и те же данные.
 */
import * as vscode from 'vscode';
import type { WebviewToExtensionMessage } from '../types/messages.js';
import { getWebviewHtml } from '../utils/webviewHtml.js';
import { isQuickNotesWebviewMessage, type QuickNotesChannel, type QuickNotesHostController } from './quickNotesHostController.js';

/** Единственная вкладка доски в окне VS Code. */
export class QuickNotesBoardPanelManager implements vscode.Disposable {
	private panel: vscode.WebviewPanel | null = null;
	private controller: QuickNotesHostController | null = null;
	private readonly panelDisposables: vscode.Disposable[] = [];

	/** Создаёт менеджер; корень хранилища рабочей области нужен для превью вложений проекта. */
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly storageDirectoryPath: string,
	) { }

	/** Подключает контроллер заметок; он создаётся после менеджеров панелей. */
	setController(controller: QuickNotesHostController): void {
		this.controller = controller;
	}

	/** Канал открытой страницы доски для рассылки состояния. */
	getChannels(): QuickNotesChannel[] {
		const panel = this.panel;
		return panel ? [{ webview: panel.webview, post: message => this.post(panel, message) }] : [];
	}

	/** Открывает вкладку доски или показывает уже открытую. */
	async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
			return;
		}
		const roots = [
			this.extensionUri,
			vscode.Uri.file(this.storageDirectoryPath),
			...(this.controller?.getFilesRoots() ?? []).map(root => vscode.Uri.file(root)),
		];
		const panel = vscode.window.createWebviewPanel(
			'promptManager.quickNotesBoard',
			'Быстрые заметки',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots },
		);
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar-icon.svg');
		panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, 'dist/webview/quickNotes.js', 'Быстрые заметки', vscode.env.language);
		this.panel = panel;
		this.panelDisposables.push(
			panel.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
				if (this.controller && isQuickNotesWebviewMessage(message)) {
					await this.controller.handleMessage(message, { webview: panel.webview, post: next => this.post(panel, next) });
				}
			}),
			panel.onDidDispose(() => {
				this.panel = null;
				for (const disposable of this.panelDisposables.splice(0)) {
					disposable.dispose();
				}
			}),
		);
	}

	/** Закрывает вкладку при выгрузке расширения. */
	dispose(): void {
		this.panel?.dispose();
		this.panel = null;
	}

	/** Отправляет сообщение странице; закрытая вкладка сообщения не получает. */
	private async post(panel: vscode.WebviewPanel, message: Parameters<QuickNotesChannel['post']>[0]): Promise<void> {
		try {
			await panel.webview.postMessage(message);
		} catch {
			// Вкладка закрывается: позднее состояние не нужно.
		}
	}
}
