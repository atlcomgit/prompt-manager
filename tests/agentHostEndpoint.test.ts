import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentHostEndpoint, selectRelatedAgentHostEndpoint } from '../src/utils/agentHostEndpoint.js';

/** Локальные фикстуры discovery не читают файлы действующего VS Code и не содержат настоящих токенов. */
const metadata = { schemaVersion: 2, pid: 42, connectionToken: 'test-token',
	endpoint: { type: 'tcp', host: '127.0.0.1', port: 12345 } };

/** Публичный адрес и неоднозначный host не должны расширять область управления разрешениями. */
test('Agent Host discovery accepts only well-formed local endpoints', () => {
	assert.equal(parseAgentHostEndpoint(metadata)?.pid, 42);
	for (const value of [null, {}, { ...metadata, schemaVersion: 1 }, { ...metadata, pid: -1 },
		{ ...metadata, connectionToken: '' }, { ...metadata, endpoint: { ...metadata.endpoint, host: 'example.com' } },
		{ ...metadata, endpoint: { ...metadata.endpoint, port: 70000 } },
		{ ...metadata, endpoint: { type: 'socket', path: 'relative.sock' } }]) {
		assert.equal(parseAgentHostEndpoint(value), undefined);
	}
	assert.equal(parseAgentHostEndpoint({ ...metadata, endpoint: { type: 'socket', path: '/run/testing-agent.sock' } })
		?.endpoint.type, 'socket');
});

/** Выбор привязан к текущему процессу tunnel/editor, а не к самому свежему файлу или первому серверу. */
test('Agent Host discovery rejects unrelated and equally related hosts', () => {
	const endpoint = parseAgentHostEndpoint(metadata)!;
	const other = { ...endpoint, pid: 43 };
	assert.equal(selectRelatedAgentHostEndpoint([{ endpoint, parentPid: 8 }], [1, 2]), undefined);
	assert.equal(selectRelatedAgentHostEndpoint([{ endpoint, parentPid: 2 }], [1, 2]), endpoint);
	assert.equal(selectRelatedAgentHostEndpoint([{ endpoint }, { endpoint: other }], [1, 43, 42]), other);
	assert.equal(selectRelatedAgentHostEndpoint([{ endpoint, parentPid: 2 }, { endpoint: other, parentPid: 2 }], [1, 2]), undefined);
});
