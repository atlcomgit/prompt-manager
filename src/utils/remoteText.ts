import * as http from 'http';
import * as https from 'https';
import type { IncomingHttpHeaders } from 'http';

interface RemoteTextResponse {
	status: number;
	statusText?: string;
	body: string;
	headers?: IncomingHttpHeaders;
}

interface RemoteTextRequestOptions {
	headers: Record<string, string>;
	timeoutMs: number;
}

export interface RemoteTextLoaderOptions {
	fetchImpl?: typeof fetch;
	requestImpl?: (url: string, options: RemoteTextRequestOptions) => Promise<RemoteTextResponse>;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const REQUEST_HEADERS = {
	Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.1',
	'User-Agent': 'prompt-manager/remote-text-loader',
};

class RemoteTextTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Превышено время ожидания (${timeoutMs} мс)`);
		this.name = 'RemoteTextTimeoutError';
	}
}

function normalizeTimeoutMs(timeoutMs?: number): number {
	return Number.isFinite(timeoutMs) && (timeoutMs || 0) > 0
		? Math.floor(timeoutMs || 0)
		: DEFAULT_TIMEOUT_MS;
}

async function requestRemoteTextWithFetch(
	url: string,
	options: RemoteTextRequestOptions,
	fetchImpl: typeof fetch,
): Promise<RemoteTextResponse> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, options.timeoutMs);

	try {
		const response = await fetchImpl(url, {
			headers: options.headers,
			signal: controller.signal,
		});

		return {
			status: response.status,
			statusText: response.statusText,
			body: await response.text(),
		};
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new RemoteTextTimeoutError(options.timeoutMs);
		}

		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function requestRemoteTextWithNode(
	url: string,
	options: RemoteTextRequestOptions,
	redirectCount: number = 0,
): Promise<RemoteTextResponse> {
	if (redirectCount > MAX_REDIRECTS) {
		throw new Error('Слишком много перенаправлений при загрузке инструкции');
	}

	const targetUrl = new URL(url);
	const requestModule = targetUrl.protocol === 'http:' ? http : https;

	return new Promise<RemoteTextResponse>((resolve, reject) => {
		const request = requestModule.request(targetUrl, {
			method: 'GET',
			headers: options.headers,
		}, (response) => {
			const status = response.statusCode ?? 0;
			const locationHeader = response.headers.location;
			const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;

			if (location && REDIRECT_STATUS_CODES.has(status)) {
				response.resume();
				void requestRemoteTextWithNode(new URL(location, targetUrl).toString(), options, redirectCount + 1)
					.then(resolve, reject);
				return;
			}

			let body = '';
			response.setEncoding('utf8');
			response.on('data', (chunk: string) => {
				body += chunk;
			});
			response.on('end', () => {
				resolve({
					status,
					statusText: response.statusMessage,
					body,
					headers: response.headers,
				});
			});
		});

		request.setTimeout(options.timeoutMs, () => {
			request.destroy(new RemoteTextTimeoutError(options.timeoutMs));
		});

		request.on('error', reject);
		request.end();
	});
}

export async function fetchRemoteText(
	url: string,
	options: RemoteTextLoaderOptions = {},
): Promise<string> {
	const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
	const requestOptions: RemoteTextRequestOptions = {
		headers: REQUEST_HEADERS,
		timeoutMs,
	};

	try {
		const response = options.requestImpl
			? await options.requestImpl(url, requestOptions)
			: options.fetchImpl
				? await requestRemoteTextWithFetch(url, requestOptions, options.fetchImpl)
				: await requestRemoteTextWithNode(url, requestOptions);

		if (response.status < 200 || response.status >= 300) {
			const statusDetails = response.statusText?.trim()
				? `${response.status} ${response.statusText.trim()}`
				: String(response.status);
			throw new Error(`HTTP ${statusDetails}`);
		}

		const text = response.body.replace(/^\uFEFF/, '');
		if (!text.trim()) {
			throw new Error('Пустой ответ сервера');
		}

		return text;
	} catch (error) {
		if (error instanceof RemoteTextTimeoutError) {
			throw error;
		}

		throw error instanceof Error ? error : new Error('Неизвестная ошибка загрузки');
	}
}