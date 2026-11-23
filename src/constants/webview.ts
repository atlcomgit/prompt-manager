/**
 * Совместимая метка host/webview: изменения вкладок и оформления не меняют контракт работающего host.
 * Меняется вместе с полями состояния и сообщениями: иначе host без перезагрузки окна молча отбросит новые данные,
 * например выбранный режим плана, а с новой меткой предложит перезагрузить окно.
 */
export const EDITOR_WEBVIEW_ASSET_VERSION = 'editor-webview-2026-11-24-bash-run-history';

/** Срок вставки на хосте и резервное ожидание на случай потери ответа webview. */
export const DASHBOARD_QUICK_COMMAND_TIMEOUT_MS = 10_000;
export const DASHBOARD_QUICK_COMMAND_REPLY_TIMEOUT_MS = DASHBOARD_QUICK_COMMAND_TIMEOUT_MS + 3000;
