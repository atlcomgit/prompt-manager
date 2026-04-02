import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchRemoteText } from '../src/utils/remoteText.js';

test('fetchRemoteText returns remote text payload when response is valid', async () => {
	const result = await fetchRemoteText('https://example.com/general.instructions.md', {
		fetchImpl: async () => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			text: async () => 'Instruction line 1\nInstruction line 2\n',
		}) as Response,
	});

	assert.equal(result, 'Instruction line 1\nInstruction line 2\n');
});

test('fetchRemoteText supports requestImpl transport without using global fetch', async () => {
	let requestCalled = false;
	const result = await fetchRemoteText('https://example.com/general.instructions.md', {
		requestImpl: async (url, options) => {
			requestCalled = true;
			assert.equal(url, 'https://example.com/general.instructions.md');
			assert.equal(options.timeoutMs, 10000);
			assert.match(options.headers.Accept, /text\/plain/);
			assert.match(options.headers['User-Agent'], /prompt-manager/);
			return {
				status: 200,
				statusText: 'OK',
				body: 'Instruction from request transport',
			};
		},
		fetchImpl: async () => {
			assert.fail('fetchImpl should not be used when requestImpl is provided');
		},
	});

	assert.equal(requestCalled, true);
	assert.equal(result, 'Instruction from request transport');
});

test('fetchRemoteText throws a readable error for non-ok HTTP responses', async () => {
	await assert.rejects(
		() => fetchRemoteText('https://example.com/general.instructions.md', {
			fetchImpl: async () => ({
				ok: false,
				status: 404,
				statusText: 'Not Found',
				text: async () => '',
			}) as Response,
		}),
		(error: unknown) => {
			assert.match(String(error), /HTTP 404 Not Found/);
			return true;
		},
	);
});

test('fetchRemoteText throws for empty remote responses', async () => {
	await assert.rejects(
		() => fetchRemoteText('https://example.com/general.instructions.md', {
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				statusText: 'OK',
				text: async () => '   \n\t',
			}) as Response,
		}),
		(error: unknown) => {
			assert.match(String(error), /Пустой ответ сервера/);
			return true;
		},
	);
});

test('fetchRemoteText strips utf-8 bom from remote responses', async () => {
	const result = await fetchRemoteText('https://example.com/general.instructions.md', {
		fetchImpl: async () => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			text: async () => '\uFEFFInstruction line 1',
		}) as Response,
	});

	assert.equal(result, 'Instruction line 1');
});

test('fetchRemoteText throws a timeout error when the request is aborted', async () => {
	await assert.rejects(
		() => fetchRemoteText('https://example.com/general.instructions.md', {
			timeoutMs: 5,
			fetchImpl: async (_input, init) => new Promise((_, reject) => {
				init?.signal?.addEventListener('abort', () => {
					const error = new Error('aborted');
					error.name = 'AbortError';
					reject(error);
				}, { once: true });
			}),
		}),
		(error: unknown) => {
			assert.match(String(error), /Превышено время ожидания/);
			return true;
		},
	);
});