import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

test('Prompt Manager startup and restored editor tab activation events are enabled', () => {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    assert.equal(manifest.publisher + '.' + manifest.name, 'alek-fiend.copilot-prompt-manager');
    assert.deepEqual(manifest.activationEvents, ['onStartupFinished', 'onWebviewPanel:promptManager.editor']);
    assert.ok(manifest.contributes.views['prompt-manager']
        .some((view: { id: string }) => view.id === 'promptManager.sidebar'));
    assert.ok(manifest.contributes.commands
        .some((command: { command: string }) => command.command === 'promptManager.openPrompt'));
});
