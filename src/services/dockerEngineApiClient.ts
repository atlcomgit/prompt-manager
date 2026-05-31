import * as http from 'http';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'http';
import type { DockerDaemonInfo } from '../types/docker.js';

/** Docker API errors include the daemon response message and HTTP status. */
export class DockerEngineApiError extends Error {
	constructor(
		message: string,
		readonly statusCode?: number,
	) {
		super(message);
		this.name = 'DockerEngineApiError';
	}
}

/** Small subset of Docker `/version` response used for API negotiation. */
export interface DockerEngineVersionResponse {
	ApiVersion?: string;
	Version?: string;
	Os?: string;
	Arch?: string;
}

/** Small subset of Docker container list items returned by `/containers/json`. */
export interface DockerEngineContainerListItem {
	Id: string;
	Names?: string[];
	Image?: string;
	ImageID?: string;
	Command?: string;
	Created?: number | string;
	Ports?: DockerEngineContainerPort[];
	Labels?: Record<string, string>;
	State?: string;
	Status?: string;
	Mounts?: DockerEngineContainerMount[];
}

/** Port shape returned by Docker list and inspect endpoints. */
export interface DockerEngineContainerPort {
	IP?: string;
	PrivatePort?: number;
	PublicPort?: number;
	Type?: string;
}

/** Mount shape returned by Docker list and inspect endpoints. */
export interface DockerEngineContainerMount {
	Type?: string;
	Name?: string;
	Source?: string;
	Destination?: string;
	Mode?: string;
	RW?: boolean;
}

/** Small subset of Docker inspect data used by the dashboard. */
export interface DockerEngineContainerInspect {
	Id: string;
	Name?: string;
	Created?: string;
	Path?: string;
	Args?: string[];
	Image?: string;
	Config?: {
		Image?: string;
		Labels?: Record<string, string>;
		Cmd?: string[];
		Entrypoint?: string[] | string;
	};
	State?: {
		Status?: string;
		Running?: boolean;
		Paused?: boolean;
		Restarting?: boolean;
		Dead?: boolean;
		ExitCode?: number;
		Error?: string;
		StartedAt?: string;
		FinishedAt?: string;
		Health?: {
			Status?: string;
		};
	};
	NetworkSettings?: {
		Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
	};
	Mounts?: DockerEngineContainerMount[];
}

/** Small subset of Docker stats output used for resource calculations. */
export interface DockerEngineContainerStats {
	read?: string;
	preread?: string;
	cpu_stats?: {
		online_cpus?: number;
		system_cpu_usage?: number;
		cpu_usage?: {
			total_usage?: number;
			percpu_usage?: number[];
		};
	};
	precpu_stats?: {
		online_cpus?: number;
		system_cpu_usage?: number;
		cpu_usage?: {
			total_usage?: number;
			percpu_usage?: number[];
		};
	};
	memory_stats?: {
		usage?: number;
		limit?: number;
		stats?: {
			cache?: number;
			inactive_file?: number;
		};
	};
	networks?: Record<string, {
		rx_bytes?: number;
		tx_bytes?: number;
	}>;
}

/** Docker event payload used to detect lifecycle changes without polling only. */
export interface DockerEngineEventMessage {
	Type?: string;
	Action?: string;
	time?: number;
	timeNano?: number;
	Actor?: {
		ID?: string;
		Attributes?: Record<string, string>;
	};
}

/** Disposable stream handle returned by Docker event subscriptions. */
export interface DockerEngineEventSubscription {
	dispose(): void;
}

/** Request controls for low-level Docker Engine calls. */
interface DockerEngineRequestOptions {
	body?: unknown;
	query?: Record<string, string | number | boolean | undefined>;
	skipVersionPrefix?: boolean;
	maxBufferBytes?: number;
}

/** Docker socket endpoint normalized for Node HTTP requests and diagnostics. */
interface DockerEngineSocketEndpoint {
	socketPath: string;
	displayName: string;
}

const DEFAULT_DOCKER_HTTP_TIMEOUT_MS = 10000;
const DEFAULT_DOCKER_LOG_BUFFER_BYTES = 1024 * 1024;

/** Talks to the local Docker daemon through the Engine HTTP API. */
export class DockerEngineApiClient {
	private apiPrefix: string | null = null;

	constructor(
		private readonly platform: NodeJS.Platform = process.platform,
	) { }

	/** Returns Docker daemon metadata and performs API version negotiation. */
	async getDaemonInfo(): Promise<DockerDaemonInfo> {
		const version = await this.getVersion();
		const endpoint = this.resolveSocketEndpoint();
		return {
			platform: this.platform,
			apiVersion: this.normalizeApiVersion(version.ApiVersion),
			serverVersion: String(version.Version || ''),
			endpoint: endpoint.displayName,
			osType: version.Os,
			architecture: version.Arch,
		};
	}

	/** Checks whether the Docker daemon responds on the local Engine API socket. */
	async ping(): Promise<boolean> {
		const buffer = await this.requestBuffer('GET', '/_ping', { skipVersionPrefix: true });
		return buffer.toString('utf-8').trim().toUpperCase() === 'OK';
	}

	/** Reads Docker version data without a version prefix. */
	async getVersion(): Promise<DockerEngineVersionResponse> {
		return this.requestJson<DockerEngineVersionResponse>('GET', '/version', { skipVersionPrefix: true });
	}

	/** Lists all containers so stopped compose containers remain visible. */
	async listContainers(): Promise<DockerEngineContainerListItem[]> {
		return this.requestJson<DockerEngineContainerListItem[]>('GET', '/containers/json', {
			query: { all: true },
		});
	}

	/** Reads inspect details for one container. */
	async inspectContainer(id: string): Promise<DockerEngineContainerInspect> {
		return this.requestJson<DockerEngineContainerInspect>('GET', `/containers/${encodeURIComponent(id)}/json`);
	}

	/** Reads one resource sample for a running container. */
	async getContainerStats(id: string): Promise<DockerEngineContainerStats> {
		return this.requestJson<DockerEngineContainerStats>('GET', `/containers/${encodeURIComponent(id)}/stats`, {
			query: { stream: false, 'one-shot': true },
		});
	}

	/** Reads recent container logs as text for editor tabs and output channels. */
	async getContainerLogs(id: string, tail = 500): Promise<string> {
		const buffer = await this.requestBuffer('GET', `/containers/${encodeURIComponent(id)}/logs`, {
			query: { stdout: true, stderr: true, timestamps: true, tail: String(tail) },
			maxBufferBytes: DEFAULT_DOCKER_LOG_BUFFER_BYTES,
		});
		return decodeDockerRawStream(buffer);
	}

	/** Restarts a running or stopped container through the Engine API. */
	async restartContainer(id: string): Promise<void> {
		await this.requestBuffer('POST', `/containers/${encodeURIComponent(id)}/restart`, { query: { t: 10 } });
	}

	/** Starts a stopped container through the Engine API. */
	async startContainer(id: string): Promise<void> {
		await this.requestBuffer('POST', `/containers/${encodeURIComponent(id)}/start`);
	}

	/** Stops a running container through the Engine API. */
	async stopContainer(id: string): Promise<void> {
		await this.requestBuffer('POST', `/containers/${encodeURIComponent(id)}/stop`, { query: { t: 10 } });
	}

	/** Removes a stopped container through the Engine API. */
	async removeContainer(id: string): Promise<void> {
		await this.requestBuffer('DELETE', `/containers/${encodeURIComponent(id)}`, { query: { force: false, v: false } });
	}

	/** Opens a Docker container event stream and parses JSON-line events. */
	async streamContainerEvents(listener: (event: DockerEngineEventMessage) => void): Promise<DockerEngineEventSubscription> {
		const requestPath = await this.buildRequestPath('/events', {
			query: { filters: JSON.stringify({ type: ['container'] }) },
		});
		const endpoint = this.resolveSocketEndpoint();
		const requestOptions: RequestOptions = {
			method: 'GET',
			path: requestPath,
			socketPath: endpoint.socketPath,
			headers: { Accept: 'application/json' },
		};

		return new Promise<DockerEngineEventSubscription>((resolve, reject) => {
			let settled = false;
			const request = http.request(requestOptions);
			request.setTimeout(DEFAULT_DOCKER_HTTP_TIMEOUT_MS, () => {
				request.destroy(new DockerEngineApiError('Docker event stream timeout.'));
			});
			request.once('error', (error) => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			});
			request.once('response', (response) => {
				if ((response.statusCode || 0) >= 400) {
					void collectResponseBuffer(response, DEFAULT_DOCKER_LOG_BUFFER_BYTES).then((buffer) => {
						const message = resolveDockerErrorMessage(buffer, response.statusCode || 0);
						if (!settled) {
							settled = true;
							reject(new DockerEngineApiError(message, response.statusCode));
						}
					});
					return;
				}

				let pendingText = '';
				response.on('data', (chunk: Buffer) => {
					pendingText += chunk.toString('utf-8');
					const lines = pendingText.split('\n');
					pendingText = lines.pop() || '';
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) {
							continue;
						}
						try {
							listener(JSON.parse(trimmed) as DockerEngineEventMessage);
						} catch {
							// Ignore malformed event chunks and keep the stream alive.
						}
					}
				});

				if (!settled) {
					settled = true;
					resolve({
						dispose: () => {
							response.destroy();
							request.destroy();
						},
					});
				}
			});
			request.end();
		});
	}

	/** Builds and sends one JSON request to Docker Engine. */
	private async requestJson<T>(method: string, path: string, options: DockerEngineRequestOptions = {}): Promise<T> {
		const buffer = await this.requestBuffer(method, path, options);
		if (buffer.length === 0) {
			return undefined as T;
		}
		return JSON.parse(buffer.toString('utf-8')) as T;
	}

	/** Builds and sends one raw-buffer request to Docker Engine. */
	private async requestBuffer(method: string, path: string, options: DockerEngineRequestOptions = {}): Promise<Buffer> {
		const requestPath = await this.buildRequestPath(path, options);
		const endpoint = this.resolveSocketEndpoint();
		const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf-8');
		const requestOptions: RequestOptions = {
			method,
			path: requestPath,
			socketPath: endpoint.socketPath,
			headers: {
				Accept: 'application/json',
				...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
			},
		};

		return new Promise<Buffer>((resolve, reject) => {
			const request = http.request(requestOptions, (response) => {
				collectResponseBuffer(response, options.maxBufferBytes).then((buffer) => {
					const statusCode = response.statusCode || 0;
					if (statusCode >= 400) {
						reject(new DockerEngineApiError(resolveDockerErrorMessage(buffer, statusCode), statusCode));
						return;
					}
					resolve(buffer);
				}).catch(reject);
			});
			request.setTimeout(DEFAULT_DOCKER_HTTP_TIMEOUT_MS, () => {
				request.destroy(new DockerEngineApiError(`Docker request timed out: ${method} ${path}`));
			});
			request.once('error', reject);
			if (payload) {
				request.write(payload);
			}
			request.end();
		});
	}

	/** Adds the negotiated API version prefix and query string to one request path. */
	private async buildRequestPath(path: string, options: DockerEngineRequestOptions = {}): Promise<string> {
		const prefix = options.skipVersionPrefix ? '' : await this.resolveApiPrefix();
		const searchParams = new URLSearchParams();
		for (const [key, value] of Object.entries(options.query || {})) {
			if (value === undefined) {
				continue;
			}
			searchParams.set(key, String(value));
		}
		const query = searchParams.toString();
		return `${prefix}${path}${query ? `?${query}` : ''}`;
	}

	/** Returns the cached API prefix or negotiates it via `/version`. */
	private async resolveApiPrefix(): Promise<string> {
		if (this.apiPrefix !== null) {
			return this.apiPrefix;
		}

		const version = await this.getVersion();
		const apiVersion = this.normalizeApiVersion(version.ApiVersion);
		this.apiPrefix = apiVersion ? `/v${apiVersion}` : '';
		return this.apiPrefix;
	}

	/** Keeps Docker API version values safe for URL prefixing. */
	private normalizeApiVersion(value: string | undefined): string {
		const normalized = String(value || '').trim();
		return /^\d+\.\d+$/.test(normalized) ? normalized : '';
	}

	/** Resolves the local Docker daemon socket for the current OS. */
	private resolveSocketEndpoint(): DockerEngineSocketEndpoint {
		if (this.platform === 'win32') {
			return {
				socketPath: '\\\\.\\pipe\\docker_engine',
				displayName: 'npipe:////./pipe/docker_engine',
			};
		}

		return {
			socketPath: '/var/run/docker.sock',
			displayName: 'unix:///var/run/docker.sock',
		};
	}
}

/** Collects one HTTP response with a hard memory cap. */
function collectResponseBuffer(response: IncomingMessage, maxBufferBytes = 4 * 1024 * 1024): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		response.on('data', (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes > maxBufferBytes) {
				reject(new DockerEngineApiError('Docker response exceeded the configured buffer limit.'));
				response.destroy();
				return;
			}
			chunks.push(chunk);
		});
		response.once('error', reject);
		response.once('end', () => resolve(Buffer.concat(chunks)));
	});
}

/** Extracts Docker daemon error messages from JSON or plain-text responses. */
function resolveDockerErrorMessage(buffer: Buffer, statusCode: number): string {
	const raw = buffer.toString('utf-8').trim();
	if (!raw) {
		return `Docker Engine API request failed with HTTP ${statusCode}.`;
	}

	try {
		const parsed = JSON.parse(raw) as { message?: string };
		return parsed.message || raw;
	} catch {
		return raw;
	}
}

/** Decodes Docker raw logs, including multiplexed stdout/stderr frames. */
function decodeDockerRawStream(buffer: Buffer): string {
	const chunks: Buffer[] = [];
	let offset = 0;
	while (offset + 8 <= buffer.length) {
		const streamType = buffer[offset];
		const frameSize = buffer.readUInt32BE(offset + 4);
		const frameStart = offset + 8;
		const frameEnd = frameStart + frameSize;
		if ((streamType !== 1 && streamType !== 2) || frameSize <= 0 || frameEnd > buffer.length) {
			break;
		}
		chunks.push(buffer.subarray(frameStart, frameEnd));
		offset = frameEnd;
	}

	return chunks.length > 0
		? Buffer.concat(chunks).toString('utf-8')
		: buffer.toString('utf-8');
}