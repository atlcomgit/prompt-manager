export interface RemoteTextLoaderOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export async function fetchRemoteText(
	url: string,
	options: RemoteTextLoaderOptions = {},
): Promise<string> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs || 0) > 0
		? Math.floor(options.timeoutMs || 0)
		: 10000;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	try {
		const response = await fetchImpl(url, {
			headers: {
				Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1',
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const statusDetails = response.statusText?.trim()
				? `${response.status} ${response.statusText.trim()}`
				: String(response.status);
			throw new Error(`HTTP ${statusDetails}`);
		}

		const text = (await response.text()).replace(/^\uFEFF/, '');
		if (!text.trim()) {
			throw new Error('Пустой ответ сервера');
		}

		return text;
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error(`Превышено время ожидания (${timeoutMs} мс)`);
		}

		throw error instanceof Error ? error : new Error('Неизвестная ошибка загрузки');
	} finally {
		clearTimeout(timeoutId);
	}
}