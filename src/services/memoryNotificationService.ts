/**
 * MemoryNotificationService — Notifies the user about memory events
 * (new commit analysed, errors, model download progress) via
 * vscode info messages, status bar, or silent log.
 */

import * as vscode from 'vscode';
import type { MemoryNotificationType } from '../types/memory.js';

export class MemoryNotificationService {
	private statusBarItem: vscode.StatusBarItem;

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			90,
		);
		this.statusBarItem.name = 'Prompt Manager Memory';
	}

	/**
	 * Show a notification about a new analysed commit.
	 */
	notifyCommitAnalysed(sha: string, summary: string): void {
		const type = this.getNotificationType();
		const short = sha.substring(0, 7);
		const msg = `Memory: ${short} — ${summary.substring(0, 100)}`;
		this.notify(msg, type);
	}

	/**
	 * Show an error notification.
	 */
	notifyError(message: string): void {
		const type = this.getNotificationType();
		if (type === 'silent') {
			console.error(`[PromptManager/Memory] ${message}`);
		} else {
			vscode.window.showErrorMessage(`Memory: ${message}`);
		}
	}

	/**
	 * Show a general info notification.
	 */
	notifyInfo(message: string): void {
		this.notify(message, this.getNotificationType());
	}

	/**
	 * Update the status bar with current memory state.
	 */
	updateStatusBar(commitCount: number, isProcessing: boolean): void {
		if (!this.isEnabled()) {
			this.statusBarItem.hide();
			return;
		}

		if (isProcessing) {
			this.statusBarItem.text = '$(sync~spin) Memory...';
			this.statusBarItem.tooltip = 'Project Memory: analysing commit...';
		} else {
			this.statusBarItem.text = `$(database) ${commitCount}`;
			this.statusBarItem.tooltip = `Project Memory: ${commitCount} commits stored`;
		}

		this.statusBarItem.command = 'promptManager.openMemory';
		this.statusBarItem.show();
	}

	/**
	 * Show progress for embedding model download.
	 */
	showModelDownloadProgress(): vscode.Disposable {
		const cts = new vscode.CancellationTokenSource();
		vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Memory: downloading embedding model...',
				cancellable: false,
			},
			async () => {
				// Progress will be resolved externally when model is ready
				return new Promise<void>(resolve => {
					cts.token.onCancellationRequested(() => resolve());
				});
			},
		);
		return { dispose: () => cts.cancel() };
	}

	/** Hide the status bar item */
	hide(): void {
		this.statusBarItem.hide();
	}

	/** Dispose resources */
	dispose(): void {
		this.statusBarItem.dispose();
	}

	// ---- Private ----

	/** Dispatch notification by type */
	private notify(message: string, type: MemoryNotificationType): void {
		switch (type) {
			case 'info':
				vscode.window.showInformationMessage(message);
				break;
			case 'statusbar':
				this.statusBarItem.text = `$(database) ${message.substring(0, 60)}`;
				this.statusBarItem.show();
				// Auto-reset after 5 seconds
				setTimeout(() => this.statusBarItem.hide(), 5000);
				break;
			case 'silent':
				console.log(`[PromptManager/Memory] ${message}`);
				break;
		}
	}

	/** Check if memory feature is enabled */
	private isEnabled(): boolean {
		return vscode.workspace
			.getConfiguration('promptManager')
			.get<boolean>('memory.enabled', true);
	}

	/** Get the configured notification type */
	private getNotificationType(): MemoryNotificationType {
		if (!vscode.workspace.getConfiguration('promptManager').get<boolean>('memory.notifications.enabled', true)) {
			return 'silent';
		}
		return vscode.workspace
			.getConfiguration('promptManager')
			.get<MemoryNotificationType>('memory.notifications.type', 'statusbar');
	}
}
