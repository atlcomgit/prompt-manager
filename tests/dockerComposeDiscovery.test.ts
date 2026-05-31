import test from 'node:test';
import assert from 'node:assert/strict';

import {
	normalizeDockerComposeRootPattern,
	shouldIncludeDockerComposeFile,
} from '../src/utils/dockerComposeDiscovery.js';

test('normalizeDockerComposeRootPattern keeps Docker compose discovery at project roots', () => {
	assert.equal(normalizeDockerComposeRootPattern('**/docker-compose.yml'), 'docker-compose.yml');
	assert.equal(normalizeDockerComposeRootPattern('./deploy/compose.yml'), 'compose.yml');
	assert.equal(normalizeDockerComposeRootPattern('*.compose.yaml'), '*.compose.yaml');
});

test('shouldIncludeDockerComposeFile accepts only root compose files outside excluded paths', () => {
	assert.equal(shouldIncludeDockerComposeFile('docker-compose.yml', ['node_modules', 'vendor']), true);
	assert.equal(shouldIncludeDockerComposeFile('apps/api/docker-compose.yml', ['node_modules', 'vendor']), false);
	assert.equal(shouldIncludeDockerComposeFile('vendor/docker-compose.yml', ['vendor']), false);
});
