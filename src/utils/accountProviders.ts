/** Какие блоки страницы «Аккаунты» доступны: установлены ли расширения Codex, Claude Code и Copilot. */
export interface AccountProviderAvailability {
    codex: boolean;
    claude: boolean;
    copilot: boolean;
}

/**
 * Проверяет фактически установленные расширения на текущем VS Code Extension Host:
 * Codex — `openai.chatgpt`, Claude Code — `anthropic.claude-code`, Copilot — `github.copilot-chat` или `github.copilot`.
 * Проверка — tests/claudeAccounts.test.ts.
 */
export function resolveAccountProviderAvailability(getExtension: (id: string) => unknown): AccountProviderAvailability {
    return {
        codex: Boolean(getExtension('openai.chatgpt')),
        claude: Boolean(getExtension('anthropic.claude-code')),
        copilot: Boolean(getExtension('github.copilot-chat') || getExtension('github.copilot')),
    };
}
