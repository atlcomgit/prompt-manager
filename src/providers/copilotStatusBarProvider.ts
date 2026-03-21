/**
 * Copilot Status Bar Provider — отображает прогрессбар и счётчик
 * использования GitHub Copilot Premium запросов в статусбаре VS Code.
 *
 * Функциональность:
 * - Визуальный прогрессбар с цветовой индикацией (белый → жёлтый → красный)
 * - Счётчик использованных/доступных запросов
 * - QuickPick меню с детальной информацией при клике
 * - Всплывающие подсказки с расширенной статистикой
 * - Поддержка авторизации через GitHub
 * - Реагирование на изменения настроек
 */

import * as vscode from 'vscode';
import type { CopilotUsageData, CopilotUsageService } from '../services/copilotUsageService.js';
import type { CopilotUsagePanelManager } from './copilotUsagePanelManager.js';

/** Пороговые значения для цветовой индикации (в процентах) */
const THRESHOLD_YELLOW = 51;
const THRESHOLD_ORANGE = 76;
const THRESHOLD_RED = 91;

/** Идентификатор команды для клика на статусбар */
const COMMAND_ID = 'promptManager.copilotUsageDetails';

/** Идентификатор команды для авторизации */
const AUTH_COMMAND_ID = 'promptManager.copilotUsageAuth';

/** Символы для отрисовки прогрессбара в статусбаре */
const PROGRESS_FILLED = '█';
const PROGRESS_EMPTY = '░';
const PROGRESS_BAR_LENGTH = 10;
const SPARKLINE_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const STATUSBAR_REFRESH_INTERVAL_MS = 30 * 1000;
const POST_CHAT_REFRESH_DELAY_MS = 5 * 1000;

export class CopilotStatusBarProvider implements vscode.Disposable {
	/** Элемент статусбара */
	private statusBarItem: vscode.StatusBarItem;

	/** Подписки на события */
	private disposables: vscode.Disposable[] = [];
	private postChatRefreshTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly usageService: CopilotUsageService,
		private readonly panelManager: CopilotUsagePanelManager,
	) {
		// Создаём элемент статусбара (справа, с приоритетом между языком и кодировкой)
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			50,
		);

		// Регистрируем команду для отображения деталей (QuickPick)
		this.disposables.push(
			vscode.commands.registerCommand(COMMAND_ID, () => this.showDetailsQuickPick()),
		);

		// Регистрируем команду для авторизации
		this.disposables.push(
			vscode.commands.registerCommand(AUTH_COMMAND_ID, () => this.handleAuthentication()),
		);

		// Подписываемся на обновления данных об использовании
		this.disposables.push(
			this.usageService.onDidChangeUsage((data) => this.updateStatusBar(data)),
		);

		// Показываем состояние переключения аккаунта в статусбаре
		this.disposables.push(
			this.usageService.onDidChangeAccountSwitchState((isSwitching) => {
				if (isSwitching) {
					this.statusBarItem.text = '$(loading~spin) Смена аккаунта...';
					this.statusBarItem.tooltip = 'Переключение аккаунта Copilot Chat...';
					this.statusBarItem.command = undefined;
					this.statusBarItem.color = undefined;
					this.statusBarItem.backgroundColor = undefined;
				} else {
					const cached = this.usageService.getCachedData();
					if (cached) {
						this.updateStatusBar(cached);
					}
				}
			}),
		);

		// Подписываемся на изменения настроек
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('promptManager.copilotStatusBar')) {
					this.handleSettingsChange();
				}
				if (e.affectsConfiguration('promptManager.copilotPremiumRequestsLimit')) {
					void this.usageService.fetchUsage(true);
				}
			}),
		);

		this.disposables.push(
			vscode.window.onDidChangeWindowState((state) => {
				if (state.focused) {
					void this.usageService.fetchUsage(false);
				}
			}),
		);

		// Инициализируем отображение
		this.initialize();
	}

	/**
	 * Инициализирует статусбар.
	 * Проверяет настройки и загружает начальные данные.
	 */
	private initialize(): void {
		// Проверяем, включён ли статусбар в настройках
		if (!this.isEnabled()) {
			this.statusBarItem.hide();
			return;
		}

		// Используем кэшированные данные для немедленного отображения
		const cached = this.usageService.getCachedData();
		if (cached) {
			this.updateStatusBar(cached);
		} else {
			this.showLoadingState();
		}

		// Запрашиваем свежие данные в фоне
		void this.usageService.fetchUsage().then((data) => {
			this.updateStatusBar(data);
		});

		// Запускаем автообновление
		this.usageService.startAutoRefresh({ intervalMs: STATUSBAR_REFRESH_INTERVAL_MS, forceRefresh: false });

		// Показываем элемент
		this.statusBarItem.show();
	}

	/**
	 * Проверяет, включён ли прогрессбар в настройках.
	 */
	private isEnabled(): boolean {
		const config = vscode.workspace.getConfiguration('promptManager');
		return config.get<boolean>('copilotStatusBar.enabled', true);
	}

	/**
	 * Отображает состояние загрузки в статусбаре.
	 */
	private showLoadingState(): void {
		this.statusBarItem.text = '$(loading~spin) Copilot...';
		this.statusBarItem.tooltip = 'Загрузка данных об использовании Copilot Premium...';
		this.statusBarItem.command = undefined;
	}

	/**
	 * Обновляет отображение статусбара на основе данных об использовании.
	 * @param data — актуальные данные об использовании
	 */
	private updateStatusBar(data: CopilotUsageData): void {
		if (!this.isEnabled()) {
			this.statusBarItem.hide();
			return;
		}

		// Для неавторизованных пользователей
		if (!data.authenticated) {
			this.statusBarItem.text = '$(copilot) Авторизуйтесь';
			this.statusBarItem.tooltip = 'Авторизуйтесь для просмотра статистики Copilot Premium';
			this.statusBarItem.command = AUTH_COMMAND_ID;
			this.statusBarItem.color = undefined;
			this.statusBarItem.backgroundColor = undefined;
			this.statusBarItem.show();
			return;
		}

		// Вычисляем процент использования
		const percent = data.limit > 0 ? (data.used / data.limit) * 100 : 0;
		const percentText = this.formatPercent(percent);

		// Определяем цвет на основе процента
		const color = this.getColor(percent);

		// Строим прогрессбар
		const progressBar = this.buildProgressBar(percent);

		// Формируем текст с иконкой, прогрессбаром и счётчиком
		// this.statusBarItem.text = `$(copilot) ${progressBar} ${data.used}/${data.limit}`;
		this.statusBarItem.text = `${progressBar} ${percentText} • ${data.used}/${data.limit}`;
		this.statusBarItem.color = color;
		this.statusBarItem.command = COMMAND_ID;

		// Формируем подробный тултип
		this.statusBarItem.tooltip = this.buildTooltip(data, percent, percentText);
		// Подсветка фона при критических значениях
		if (percent >= THRESHOLD_RED) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
		} else if (percent >= THRESHOLD_ORANGE) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else if (percent >= THRESHOLD_YELLOW) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else {
			this.statusBarItem.backgroundColor = undefined;
		}

		this.statusBarItem.show();
	}

	/**
	 * Определяет цвет на основе процента использования.
	 * @param percent — процент использования (0-100+)
	 * @returns Цвет или undefined (для стандартного белого)
	 */
	private getColor(percent: number): string | vscode.ThemeColor | undefined {
		if (percent >= THRESHOLD_RED) {
			return new vscode.ThemeColor('errorForeground');
		}
		if (percent >= THRESHOLD_ORANGE) {
			return new vscode.ThemeColor('charts.orange');
		}
		if (percent >= THRESHOLD_YELLOW) {
			return new vscode.ThemeColor('editorWarning.foreground');
		}
		return undefined; // Стандартный белый цвет
	}

	private formatPercent(percent: number): string {
		const normalized = Number.isFinite(percent) ? Math.max(0, percent) : 0;
		return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(normalized)}%`;
	}

	/**
	 * Строит визуальный прогрессбар из символов.
	 * @param percent — процент заполнения (0-100+)
	 * @returns Строка прогрессбара
	 */
	private buildProgressBar(percent: number): string {
		const normalized = Number.isFinite(percent) ? Math.max(0, percent) : 0;
		const filled = Math.max(0, Math.min(PROGRESS_BAR_LENGTH, Math.floor(normalized / 10)));
		const empty = PROGRESS_BAR_LENGTH - filled;
		const bar = PROGRESS_FILLED.repeat(filled) + PROGRESS_EMPTY.repeat(empty);
		return `[${bar}]`;
	}

	private buildSparkline(data: CopilotUsageData): string {
		const points = data.snapshots.slice(-5);
		if (points.length === 0) {
			return '▁';
		}
		const maxUsed = Math.max(1, ...points.map(point => point.used));
		return points
			.map((point) => {
				const ratio = point.used / maxUsed;
				const index = Math.min(SPARKLINE_CHARS.length - 1, Math.max(0, Math.round(ratio * (SPARKLINE_CHARS.length - 1))));
				return SPARKLINE_CHARS[index];
			})
			.join('');
	}

	/**
	 * Формирует подробную всплывающую подсказку.
	 * @param data — данные об использовании
	 * @param percent — процент использования
	 * @returns Markdown-строка для тултипа
	 */
	private buildTooltip(data: CopilotUsageData, percent: number, percentText: string): vscode.MarkdownString {
		const md = new vscode.MarkdownString('', true);
		md.isTrusted = true;
		md.supportThemeIcons = true;

		const periodStart = new Date(data.periodStart).toLocaleDateString('ru-RU');
		const periodEnd = new Date(data.periodEnd).toLocaleDateString('ru-RU');
		const lastUpdated = new Date(data.lastUpdated).toLocaleString('ru-RU');

		// Визуальный прогрессбар для тултипа (шире, чем в статусбаре)
		const tooltipBarLength = 20;
		const filled = Math.min(tooltipBarLength, Math.round((percent / 100) * tooltipBarLength));
		const empty = tooltipBarLength - filled;
		const tooltipBar = '█'.repeat(filled) + '░'.repeat(empty);

		md.appendMarkdown(`### $(copilot) Copilot Premium запросы — ${percentText}\n\n`);
		md.appendMarkdown(`**${data.used}** / **${data.limit}** запросов (${percentText})\n\n`);
		md.appendMarkdown(`\`${tooltipBar}\`\n\n`);
		md.appendMarkdown(`---\n\n`);
		md.appendMarkdown(`$(calendar) **Период:** ${periodStart} — ${periodEnd}\n\n`);
		md.appendMarkdown(`$(graph) **Среднее в день:** ${data.avgPerDay} запросов\n\n`);
		md.appendMarkdown(`$(info) **Подписка:** ${data.planType}\n\n`);
		md.appendMarkdown(`$(sync) **Обновлено:** ${lastUpdated}\n\n`);
		md.appendMarkdown(`---\n\n`);
		md.appendMarkdown(`$(gear) [Настройки](command:workbench.action.openSettings?%5B%22promptManager.copilot%22%5D) · `);
		md.appendMarkdown(`$(refresh) [Обновить](command:${COMMAND_ID})`);

		return md;
	}

	/**
	 * Показывает QuickPick меню с подробной информацией при клике на статусбар.
	 */
	private async showDetailsQuickPick(): Promise<void> {
		const data = await this.usageService.fetchUsage(false);
		if (!data.authenticated) {
			await this.handleAuthentication();
			return;
		}
		await this.panelManager.show();
	}

	/**
	 * Обрабатывает процесс авторизации.
	 * Предлагает пользователю авторизоваться через GitHub.
	 */
	private async handleAuthentication(): Promise<void> {
		const answer = await vscode.window.showInformationMessage(
			'Авторизуйтесь через GitHub для просмотра статистики Copilot Premium запросов.',
			'Авторизоваться',
			'Отмена',
		);

		if (answer === 'Авторизоваться') {
			const success = await this.usageService.authenticate();
			if (success) {
				vscode.window.showInformationMessage('Авторизация успешна. Данные Copilot загружены.');
			} else {
				vscode.window.showWarningMessage('Не удалось авторизоваться. Попробуйте ещё раз.');
			}
		}
	}

	/**
	 * Обрабатывает изменения настроек отображения.
	 */
	private handleSettingsChange(): void {
		if (this.isEnabled()) {
			const cached = this.usageService.getCachedData();
			if (cached) {
				this.updateStatusBar(cached);
			} else {
				this.showLoadingState();
				void this.usageService.fetchUsage();
			}
			this.usageService.startAutoRefresh({ intervalMs: STATUSBAR_REFRESH_INTERVAL_MS, forceRefresh: false });
			this.statusBarItem.show();
		} else {
			this.statusBarItem.hide();
			this.usageService.stopAutoRefresh();
		}
	}

	/**
	 * Вызывается после старта чата: через 5 секунд делает принудительное обновление,
	 * затем перезапускает автообновление с интервалом 30 секунд.
	 */
	notifyChatStarted(): void {
		if (this.postChatRefreshTimer) {
			clearTimeout(this.postChatRefreshTimer);
			this.postChatRefreshTimer = undefined;
		}

		this.postChatRefreshTimer = setTimeout(() => {
			void (async () => {
				try {
					const data = await this.usageService.fetchUsage(true);
					this.updateStatusBar(data);
					this.usageService.startAutoRefresh({
						intervalMs: STATUSBAR_REFRESH_INTERVAL_MS,
						forceRefresh: false,
					});
				} catch {
					// do nothing, keep extension resilient
				}
			})();
		}, POST_CHAT_REFRESH_DELAY_MS);
	}

	/**
	 * Освобождает ресурсы провайдера.
	 */
	dispose(): void {
		if (this.postChatRefreshTimer) {
			clearTimeout(this.postChatRefreshTimer);
			this.postChatRefreshTimer = undefined;
		}
		this.statusBarItem.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}
}
