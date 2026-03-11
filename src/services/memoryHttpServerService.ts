/**
 * MemoryHttpServerService — Local HTTP server for receiving commit data from git hooks.
 * Binds to 127.0.0.1 only for security. Uses token-based authentication.
 * Supports fixed port (from settings) or random port allocation.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import type { HookCommitPayload } from '../types/memory.js';

/** Maximum request body size (2MB) */
const MAX_BODY_SIZE = 2 * 1024 * 1024;

export class MemoryHttpServerService {
	/** HTTP server instance */
	private server: http.Server | null = null;
	/** Current listening port */
	private port = 0;
	/** Authentication token for this session */
	private token: string = '';
	/** Event emitter for commit received events */
	private readonly _onCommitReceived = new vscode.EventEmitter<HookCommitPayload>();
	/** Fired when a valid commit payload is received from the git hook */
	public readonly onCommitReceived = this._onCommitReceived.event;

	/**
	 * Start the HTTP server.
	 * @returns The port and token used
	 */
	async start(): Promise<{ port: number; token: string }> {
		// Generate secure token
		this.token = crypto.randomBytes(32).toString('hex');

		// Read configured port (0 = random)
		const configPort = vscode.workspace
			.getConfiguration('promptManager.memory')
			.get<number>('httpPort', 0);

		return new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) => this.handleRequest(req, res));

			this.server.on('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'EADDRINUSE' && configPort > 0) {
					// Fixed port is occupied — notify the user
					vscode.window.showErrorMessage(
						`Prompt Manager Memory: порт ${configPort} занят. Укажите другой порт в настройке promptManager.memory.httpPort или используйте 0 для автоматического выбора.`,
					);
					reject(err);
				} else if (err.code === 'EADDRINUSE') {
					// Random port collision — retry with port 0
					this.server?.listen(0, '127.0.0.1');
				} else {
					reject(err);
				}
			});

			this.server.on('listening', () => {
				const addr = this.server?.address();
				if (addr && typeof addr === 'object') {
					this.port = addr.port;
				}
				resolve({ port: this.port, token: this.token });
			});

			this.server.listen(configPort || 0, '127.0.0.1');
		});
	}

	/** Stop the HTTP server */
	async stop(): Promise<void> {
		return new Promise((resolve) => {
			if (this.server) {
				this.server.close(() => {
					this.server = null;
					this.port = 0;
					resolve();
				});
			} else {
				resolve();
			}
		});
	}

	/** Get current listening port */
	getPort(): number {
		return this.port;
	}

	/** Get current authentication token */
	getToken(): string {
		return this.token;
	}

	/**
	 * Handle incoming HTTP request.
	 * Only accepts POST /commit with valid Authorization header.
	 */
	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		// Only allow POST /commit
		if (req.method !== 'POST' || req.url !== '/commit') {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found' }));
			return;
		}

		// Validate authorization token
		const authHeader = req.headers['authorization'] || '';
		if (authHeader !== `Bearer ${this.token}`) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Unauthorized' }));
			return;
		}

		// Read and parse body
		let body = '';
		let bodySize = 0;

		req.on('data', (chunk: Buffer) => {
			bodySize += chunk.length;
			if (bodySize > MAX_BODY_SIZE) {
				res.writeHead(413, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Payload too large' }));
				req.destroy();
				return;
			}
			body += chunk.toString();
		});

		req.on('end', () => {
			try {
				const payload = this.validatePayload(JSON.parse(body));
				if (!payload) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Invalid payload' }));
					return;
				}

				// Emit the event for processing
				this._onCommitReceived.fire(payload);

				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'ok' }));
			} catch {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid JSON' }));
			}
		});

		req.on('error', () => {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Internal error' }));
		});
	}

	/**
	 * Validate and sanitize the incoming commit payload.
	 * Returns null if the payload is invalid.
	 */
	private validatePayload(data: unknown): HookCommitPayload | null {
		if (!data || typeof data !== 'object') { return null; }
		const obj = data as Record<string, unknown>;

		// Required string fields
		const sha = typeof obj['sha'] === 'string' ? obj['sha'].trim() : '';
		const author = typeof obj['author'] === 'string' ? obj['author'].trim() : '';
		const email = typeof obj['email'] === 'string' ? obj['email'].trim() : '';
		const date = typeof obj['date'] === 'string' ? obj['date'].trim() : '';
		const branch = typeof obj['branch'] === 'string' ? obj['branch'].trim() : '';
		const repository = typeof obj['repository'] === 'string' ? obj['repository'].trim() : '';
		const message = typeof obj['message'] === 'string' ? obj['message'] : '';
		const diff = typeof obj['diff'] === 'string' ? obj['diff'] : '';
		const parentSha = typeof obj['parentSha'] === 'string' ? obj['parentSha'].trim() : '';

		// SHA is required
		if (!sha || !/^[0-9a-f]{4,40}$/i.test(sha)) { return null; }
		if (!author || !date) { return null; }

		// Validate files array
		let files: HookCommitPayload['files'] = [];
		if (Array.isArray(obj['files'])) {
			files = (obj['files'] as Array<Record<string, unknown>>)
				.filter(f => typeof f === 'object' && f !== null
					&& typeof f['status'] === 'string'
					&& typeof f['path'] === 'string')
				.map(f => ({
					status: String(f['status']),
					path: String(f['path']),
					oldPath: typeof f['oldPath'] === 'string' ? f['oldPath'] : undefined,
				}));
		}

		return { sha, author, email, date, branch, repository, parentSha, message, diff, files };
	}

	/** Dispose resources */
	dispose(): void {
		this._onCommitReceived.dispose();
		void this.stop();
	}
}
