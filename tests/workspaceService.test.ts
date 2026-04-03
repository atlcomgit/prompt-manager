import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import Module from 'node:module';
import * as os from 'os';
import * as path from 'path';

const originalLoad = (Module as any)._load;

type UpdateCall = {
	section: string;
	key: string;
	value: unknown;
	target: unknown;
};

type MockState = {
	workspaceRoot: string;
	chatInstructionsFilesLocations: unknown;
	updateCalls: UpdateCall[];
};

const mockState: MockState = {
	workspaceRoot: '',
	chatInstructionsFilesLocations: undefined,
	updateCalls: [],
};

function createVsCodeMock() {
	return {
		ConfigurationTarget: {
			Global: 'global',
			Workspace: 'workspace',
		},
		FileType: {
			File: 1,
			Directory: 2,
		},
		Uri: {
			file: (fsPath: string) => ({ fsPath }),
			joinPath: (base: { fsPath: string }, ...pathsToJoin: string[]) => ({
				fsPath: path.join(base.fsPath, ...pathsToJoin),
			}),
		},
		workspace: {
			workspaceFolders: [
				{
					name: 'workspace',
					uri: {
						get fsPath() {
							return mockState.workspaceRoot;
						},
					},
				},
			],
			fs: {
				createDirectory: async (uri: { fsPath: string }) => {
					fs.mkdirSync(uri.fsPath, { recursive: true });
				},
				readFile: async (uri: { fsPath: string }) => {
					const data = fs.readFileSync(uri.fsPath);
					return new Uint8Array(data);
				},
				writeFile: async (uri: { fsPath: string }, content: Uint8Array) => {
					fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
					fs.writeFileSync(uri.fsPath, Buffer.from(content));
				},
				delete: async (uri: { fsPath: string }) => {
					fs.rmSync(uri.fsPath, { force: true });
				},
			},
			getConfiguration: (section?: string) => {
				const configSection = section || '';
				return {
					get: (key: string, defaultValue?: unknown) => {
						if (configSection === 'chat' && key === 'instructionsFilesLocations') {
							return mockState.chatInstructionsFilesLocations;
						}
						return defaultValue;
					},
					update: async (key: string, value: unknown, target: unknown) => {
						mockState.updateCalls.push({
							section: configSection,
							key,
							value,
							target,
						});
						if (configSection === 'chat' && key === 'instructionsFilesLocations') {
							mockState.chatInstructionsFilesLocations = value;
						}
					},
				};
			},
		},
	};
}

const vscodeMock = createVsCodeMock();

async function importWorkspaceService() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return vscodeMock;
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/services/workspaceService.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

test('WorkspaceService syncGlobalAgentInstructionsFile writes only the project instruction file and removes legacy copies', async () => {
	mockState.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-workspace-service-'));
	mockState.chatInstructionsFilesLocations = { existing: true };
	mockState.updateCalls = [];

	const projectFile = path.join(mockState.workspaceRoot, '.github', 'instructions', 'prompt-manager.instructions.md');
	const hiddenFile = path.join(mockState.workspaceRoot, '.vscode', 'prompt-manager', 'chat-memory', 'ai.instructions.md');
	const legacyFile = path.join(mockState.workspaceRoot, '.vscode', 'prompt-manager', 'ai.instructions.md');
	const { WorkspaceService } = await importWorkspaceService();
	const service = new WorkspaceService();

	try {
		fs.mkdirSync(path.dirname(hiddenFile), { recursive: true });
		fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
		fs.writeFileSync(hiddenFile, 'old hidden content', 'utf-8');
		fs.writeFileSync(legacyFile, 'old legacy content', 'utf-8');

		await service.syncGlobalAgentInstructionsFile('Always answer in Russian.');

		assert.equal(
			fs.readFileSync(projectFile, 'utf-8'),
			"---\napplyTo: '**'\n---\n\n# Prompt Manager Agent Instructions\n\nAlways answer in Russian.\n",
		);
		assert.equal(fs.existsSync(hiddenFile), false);
		assert.equal(fs.existsSync(legacyFile), false);
		assert.deepEqual(mockState.updateCalls, []);
	} finally {
		service.dispose();
		fs.rmSync(mockState.workspaceRoot, { recursive: true, force: true });
	}
});

test('WorkspaceService ensureProjectInstructionsFolderRegistered adds .github/instructions to chat instructions locations', async () => {
	mockState.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-workspace-service-'));
	mockState.chatInstructionsFilesLocations = { '.vscode/prompt-manager/chat-memory': true };
	mockState.updateCalls = [];

	const { WorkspaceService } = await importWorkspaceService();
	const service = new WorkspaceService();

	try {
		await service.ensureProjectInstructionsFolderRegistered();

		assert.deepEqual(mockState.chatInstructionsFilesLocations, {
			'.vscode/prompt-manager/chat-memory': true,
			'.github/instructions': true,
		});
		assert.deepEqual(mockState.updateCalls, [
			{
				section: 'chat',
				key: 'instructionsFilesLocations',
				value: {
					'.vscode/prompt-manager/chat-memory': true,
					'.github/instructions': true,
				},
				target: 'workspace',
			},
		]);
	} finally {
		service.dispose();
		fs.rmSync(mockState.workspaceRoot, { recursive: true, force: true });
	}
});

test('WorkspaceService ensureProjectInstructionsFolderRegistered keeps chat settings unchanged when folder is already registered', async () => {
	mockState.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-workspace-service-'));
	mockState.chatInstructionsFilesLocations = [path.join(mockState.workspaceRoot, '.github', 'instructions')];
	mockState.updateCalls = [];

	const { WorkspaceService } = await importWorkspaceService();
	const service = new WorkspaceService();

	try {
		await service.ensureProjectInstructionsFolderRegistered();

		assert.deepEqual(mockState.chatInstructionsFilesLocations, [path.join(mockState.workspaceRoot, '.github', 'instructions')]);
		assert.deepEqual(mockState.updateCalls, []);
	} finally {
		service.dispose();
		fs.rmSync(mockState.workspaceRoot, { recursive: true, force: true });
	}
});
