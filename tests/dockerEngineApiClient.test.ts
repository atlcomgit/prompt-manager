import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';

test('DockerEngineApiClient getContainerStats omits one-shot so Docker keeps precpu stats', async () => {
	const httpModule = require('http') as typeof import('http');
	const originalRequest = httpModule.request;
	const requestedPaths: string[] = [];
	const responseBodies = new Map<string, string>([
		['/version', JSON.stringify({ ApiVersion: '1.50' })],
		['/v1.50/containers/skladno-php/stats?stream=false', JSON.stringify({ read: '2026-05-31T15:16:00.759582214Z' })],
	]);

	(httpModule as typeof import('http') & { request: unknown }).request = ((options: { path?: string } | string, callback: (response: IncomingMessage) => void) => {
		const request = new EventEmitter() as EventEmitter & {
			setTimeout: (timeoutMs: number, listener?: () => void) => void;
			write: (chunk: unknown) => void;
			end: () => void;
			destroy: () => void;
		};
		request.setTimeout = (_timeoutMs: number, _listener?: () => void) => undefined;
		request.write = (_chunk: unknown) => undefined;
		request.destroy = () => undefined;
		request.end = () => {
			const requestPath = typeof options === 'string' ? options : String(options.path || '');
			requestedPaths.push(requestPath);
			const response = new EventEmitter() as IncomingMessage & EventEmitter & { statusCode?: number };
			response.statusCode = 200;
			process.nextTick(() => {
				callback(response);
				response.emit('data', Buffer.from(responseBodies.get(requestPath) || '{}'));
				response.emit('end');
			});
		};
		return request;
	}) as typeof httpModule.request;

	try {
		const { DockerEngineApiClient } = require('../src/services/dockerEngineApiClient.js') as typeof import('../src/services/dockerEngineApiClient.js');
		const client = new DockerEngineApiClient('linux');

		await client.getContainerStats('skladno-php');

		assert.deepEqual(requestedPaths, [
			'/version',
			'/v1.50/containers/skladno-php/stats?stream=false',
		]);
	} finally {
		(httpModule as typeof import('http') & { request: unknown }).request = originalRequest;
	}
});