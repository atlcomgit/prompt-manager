import test from 'node:test';
import assert from 'node:assert/strict';

import {
	matchesDockerComposeRootPattern,
	normalizeDockerComposeRootPattern,
	shouldIncludeDockerComposeFile,
} from '../src/utils/dockerComposeDiscovery.js';

test('normalizeDockerComposeRootPattern keeps Docker compose discovery at project roots', () => {
	assert.equal(normalizeDockerComposeRootPattern('**/docker-compose.yml'), 'docker-compose.yml');
	assert.equal(normalizeDockerComposeRootPattern('./deploy/compose.yml'), 'compose.yml');
	assert.equal(normalizeDockerComposeRootPattern('*.compose.yaml'), '*.compose.yaml');
});

/** Проверяет стандартные конструкции glob и экранирование специальных символов VS Code. */
test('matchesDockerComposeRootPattern supports VS Code root glob syntax', () => {
	for (const [fileName, pattern, expected] of [
		['compose.yml', 'compose.{yml,yaml}', true],
		['compose.yaml', 'compose.{yml,yaml}', true],
		['compose.json', 'compose.{yml,yaml}', false],
		['a.compose.yml', '?.compose.yml', true],
		['ab.compose.yml', '?.compose.yml', false],
		['compose.2.yml', 'compose.[0-9].yml', true],
		['compose.x.yml', 'compose.[!0-9].yml', true],
		['compose.2.yml', 'compose.[!0-9].yml', false],
		['compose.[dev].yml', 'compose.[[]dev[]].yml', true],
		['dev.compose.yaml', '{compose,{dev,prod}.compose}.{yml,yaml}', true],
		['nested/compose.yml', '*.yml', false],
		['compose.yml', '[z-a]*.yml', false],
	] as const) {
		assert.equal(matchesDockerComposeRootPattern(fileName, pattern), expected, `${pattern}: ${fileName}`);
	}
});

test('shouldIncludeDockerComposeFile accepts only root compose files outside excluded paths', () => {
	assert.equal(shouldIncludeDockerComposeFile('docker-compose.yml', ['node_modules', 'vendor']), true);
	assert.equal(shouldIncludeDockerComposeFile('apps/api/docker-compose.yml', ['node_modules', 'vendor']), false);
	assert.equal(shouldIncludeDockerComposeFile('vendor/docker-compose.yml', ['vendor']), false);
});
