import type { ExtensionToWebviewMessage, PromptVoiceDebugDetails } from '../../types/messages.js';
import { createIdleWaveLevels, createSilentWaveLevels } from '../../shared/promptVoice.js';
import { getPromptManagerOutputChannel } from '../../utils/promptManagerOutput.js';
import { PromptVoiceRecorder, type PromptVoiceRecorderOptions, type PromptVoiceRecordingResult } from './promptVoiceRecorder.js';
import { PromptVoicePostCorrectionService, normalizePromptVoicePostCorrectionResult } from './promptVoicePostCorrectionService.js';
import { PromptVoiceTranscriptionService, type PromptVoiceTranscriptionState } from './promptVoiceTranscriptionService.js';

type PostMessage = (message: ExtensionToWebviewMessage) => void;

type PromptVoiceRecordingEntry = {
	sessionId: string;
	postMessage: PostMessage;
	recorder: PromptVoiceRecorderRuntime;
	isStopping: boolean;
	manualConfirmRequested: boolean;
};

type PromptVoiceQueueJob = {
	sequence: number;
	panelKey: string;
	sessionId: string;
	postMessage: PostMessage;
	durationMs: number;
	samples: Float32Array;
	autoRestart: boolean;
	cancelled: boolean;
};

type PromptVoiceConfirmOptions = {
	autoRestart?: boolean;
};

type PromptVoiceCompletedJobResult = {
	job: PromptVoiceQueueJob;
	text: string | null;
};

type PromptVoiceErrorMeta = {
	message: string;
	badge: string;
	hint: string;
};

type PromptVoiceQueueMessage = Extract<ExtensionToWebviewMessage, { type: 'promptVoiceQueueState' }>;
type PromptVoiceQueueStatus = PromptVoiceQueueMessage['status'];

type PromptVoiceRecorderRuntime = {
	getElapsedMs: () => number;
	start: () => Promise<void>;
	pause: () => Promise<void>;
	resume: () => Promise<void>;
	stop: () => Promise<PromptVoiceRecordingResult>;
	cancel: () => Promise<void>;
	dispose: () => Promise<void>;
};

type PromptVoiceTranscriptionRuntime = Pick<PromptVoiceTranscriptionService, 'preload' | 'transcribe'>;

type PromptVoicePostCorrectionRuntime = Pick<PromptVoicePostCorrectionService, 'correct'>;

type PromptVoiceServiceOptions = {
	recorderFactory?: (options: PromptVoiceRecorderOptions) => PromptVoiceRecorderRuntime;
	transcriptionService?: PromptVoiceTranscriptionRuntime;
	postCorrectionService?: PromptVoicePostCorrectionRuntime;
};

const MAX_PARALLEL_PROMPT_VOICE_JOBS = 2;
const PROMPT_VOICE_TRACE_PREFIX = '[prompt-voice][trace]';

const formatTraceValue = (value: string | number | boolean | null | undefined): string => {
	if (value === undefined) {
		return 'undefined';
	}
	if (typeof value === 'string') {
		return JSON.stringify(value);
	}
	return String(value);
};

const formatTraceDetails = (details: PromptVoiceDebugDetails): string => (
	Object.entries(details)
		.filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
		.map(([key, value]) => `${key}=${formatTraceValue(value)}`)
		.join(' ')
);

const normalizeErrorText = (value: unknown): string => {
	if (value instanceof Error) {
		return value.message;
	}
	return String(value || '').trim();
};

const getErrorMeta = (error: unknown): PromptVoiceErrorMeta => {
	const raw = normalizeErrorText(error);
	if (!raw) {
		return {
			message: 'Не удалось распознать речь. Попробуй ещё раз.',
			badge: 'Ошибка распознавания',
			hint: 'Открой Prompt Manager Output, если ошибка повторяется.',
		};
	}

	if (raw.includes('PROMPT_VOICE_OS_UNSUPPORTED')) {
		return {
			message: 'Локальная запись звука пока не поддерживается в этой системе.',
			badge: 'Система не поддерживается',
			hint: 'Сейчас extension-side запись реализована для Linux.',
		};
	}

	if (raw.includes('PROMPT_VOICE_RECORDER_START_FAILED:arecord:audio open error: Device or resource busy')) {
		return {
			message: 'Микрофон уже занят другим приложением.',
			badge: 'Микрофон занят',
			hint: 'Закрой другое приложение, которое сейчас использует микрофон, и попробуй ещё раз.',
		};
	}

	if (raw.includes('PROMPT_VOICE_RECORDER_START_FAILED:arecord:audio open error: No such file or directory')) {
		return {
			message: 'Не удалось найти устройство записи.',
			badge: 'Микрофон не найден',
			hint: 'Проверь настройки аудиовхода в системе.',
		};
	}

	if (
		raw.includes('PROMPT_VOICE_RECORDER_START_FAILED')
		|| raw.includes('spawn arecord ENOENT')
		|| raw.includes('spawn pw-record ENOENT')
	) {
		return {
			message: 'Не удалось открыть локальную запись звука.',
			badge: 'Ошибка записи',
			hint: 'Нужен рабочий системный аудиовход. Для Linux используются `arecord` или `pw-record`.',
		};
	}

	if (raw.includes('PROMPT_VOICE_EMPTY_TRANSCRIPTION')) {
		return {
			message: 'Распознавание завершилось без текста.',
			badge: 'Пустой результат',
			hint: 'Попробуй говорить чуть громче или сделать запись короче.',
		};
	}

	if (raw.includes("Cannot find package '@huggingface/transformers'")) {
		return {
			message: 'Не найден модуль локального распознавания речи.',
			badge: 'Модуль STT не установлен',
			hint: 'Проверь упаковку расширения: пакет @huggingface/transformers должен входить в VSIX.',
		};
	}

	if (raw.includes('fetch failed') || raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
		return {
			message: 'Не удалось загрузить модель распознавания.',
			badge: 'Не загрузилась модель STT',
			hint: 'Проверь сеть и попробуй ещё раз.',
		};
	}

	return {
		message: 'Не удалось распознать речь. Попробуй ещё раз.',
		badge: 'Ошибка распознавания',
		hint: raw,
	};
};

export class PromptVoiceService {
	private readonly activeRecordings = new Map<string, PromptVoiceRecordingEntry>();
	private readonly queue: PromptVoiceQueueJob[] = [];
	private readonly output = getPromptManagerOutputChannel();
	private readonly transcriptionService: PromptVoiceTranscriptionRuntime;
	/** Сервис AI пост-коррекции распознанного текста */
	private readonly postCorrectionService: PromptVoicePostCorrectionRuntime;
	/** Фабрика recorder-а позволяет тестировать очередь без системного микрофона */
	private readonly recorderFactory: (options: PromptVoiceRecorderOptions) => PromptVoiceRecorderRuntime;
	/** Активные фоновые задачи распознавания */
	private readonly activeJobs = new Set<PromptVoiceQueueJob>();
	/** Завершенные результаты, которые ждут своей очереди для вставки в UI */
	private readonly completedJobResults = new Map<number, PromptVoiceCompletedJobResult>();
	private nextJobSequence = 1;
	private nextCompletionSequence = 1;

	constructor(cacheDir: string, options: PromptVoiceServiceOptions = {}) {
		this.transcriptionService = options.transcriptionService ?? new PromptVoiceTranscriptionService(cacheDir);
		this.postCorrectionService = options.postCorrectionService ?? new PromptVoicePostCorrectionService();
		this.recorderFactory = options.recorderFactory ?? ((recorderOptions) => new PromptVoiceRecorder(recorderOptions));
	}

	/** Writes webview-side voice events into the shared Prompt Manager output. */
	logWebviewTrace(
		panelKey: string,
		sessionId: string | undefined,
		event: string,
		status: string | undefined,
		details: PromptVoiceDebugDetails | undefined,
	): void {
		this.trace(`webview.${event}`, panelKey, sessionId, {
			status: status ?? null,
			...(details ?? {}),
		});
	}

	async start(panelKey: string, sessionId: string, postMessage: PostMessage): Promise<void> {
		this.trace('host.start.request', panelKey, sessionId);
		await this.cancelActiveRecording(panelKey);

		const recorder = this.recorderFactory({
			output: this.output,
			onLevel: (level, elapsedMs, levels) => {
				const recording = this.activeRecordings.get(panelKey);
				if (!recording || recording.sessionId !== sessionId || recording.isStopping) {
					return;
				}

				recording.postMessage({
					type: 'promptVoiceState',
					sessionId,
					status: 'recording',
					elapsedMs,
					level,
					levels,
				});
			},
			onLimitReached: () => {
				this.trace('host.limit.reached', panelKey, sessionId);
				void this.confirm(panelKey, sessionId, { autoRestart: true });
			},
			onError: (error) => {
				this.trace('host.recorder.error', panelKey, sessionId, { error: normalizeErrorText(error) });
				const recording = this.getRecording(panelKey, sessionId);
				if (!recording) {
					return;
				}
				recording.isStopping = false;
				this.postError(recording.postMessage, sessionId, error);
			},
		});

		this.activeRecordings.set(panelKey, {
			sessionId,
			postMessage,
			recorder,
			isStopping: false,
			manualConfirmRequested: false,
		});
		this.trace('host.start.active-set', panelKey, sessionId);

		try {
			void this.transcriptionService.preload().catch((error) => {
				this.logError(error);
			});
			await recorder.start();
			const recording = this.activeRecordings.get(panelKey);
			if (!recording || recording.sessionId !== sessionId) {
				this.trace('host.start.ready-ignored', panelKey, sessionId);
				return;
			}

			this.trace('host.start.ready', panelKey, sessionId);
			recording.postMessage({
				type: 'promptVoiceState',
				sessionId,
				status: 'recording',
				elapsedMs: 0,
				level: 0.08,
				levels: createIdleWaveLevels(),
			});
		} catch (error) {
			this.trace('host.start.error', panelKey, sessionId, { error: normalizeErrorText(error) });
			await recorder.dispose().catch(() => null);
			const recording = this.activeRecordings.get(panelKey);
			if (recording?.sessionId === sessionId) {
				this.activeRecordings.delete(panelKey);
			}
			this.postError(postMessage, sessionId, error);
		}
	}

	async pause(panelKey: string, sessionId: string): Promise<void> {
		const recording = this.getRecording(panelKey, sessionId);
		if (!recording || recording.isStopping) {
			this.trace('host.pause.skip', panelKey, sessionId, { reason: recording ? 'stopping' : 'missing' });
			return;
		}

		try {
			this.trace('host.pause.request', panelKey, sessionId);
			await recording.recorder.pause();
			recording.postMessage({
				type: 'promptVoiceState',
				sessionId,
				status: 'paused',
				elapsedMs: recording.recorder.getElapsedMs(),
				levels: createSilentWaveLevels(),
			});
		} catch (error) {
			this.postError(recording.postMessage, sessionId, error);
		}
	}

	async resume(panelKey: string, sessionId: string): Promise<void> {
		const recording = this.getRecording(panelKey, sessionId);
		if (!recording || recording.isStopping) {
			this.trace('host.resume.skip', panelKey, sessionId, { reason: recording ? 'stopping' : 'missing' });
			return;
		}

		try {
			this.trace('host.resume.request', panelKey, sessionId);
			await recording.recorder.resume();
			recording.postMessage({
				type: 'promptVoiceState',
				sessionId,
				status: 'recording',
				elapsedMs: recording.recorder.getElapsedMs(),
				level: 0.08,
				levels: createIdleWaveLevels(),
			});
		} catch (error) {
			this.postError(recording.postMessage, sessionId, error);
		}
	}

	/** Early OK intent suppresses limit auto-restart before recorder.stop finishes. */
	markManualConfirmIntent(panelKey: string, sessionId: string): void {
		const recording = this.getRecording(panelKey, sessionId);
		if (!recording) {
			this.trace('host.manual-intent.miss', panelKey, sessionId);
			return;
		}

		recording.manualConfirmRequested = true;
		this.trace('host.manual-intent.marked', panelKey, sessionId);
	}

	async confirm(panelKey: string, sessionId: string, options: PromptVoiceConfirmOptions = {}): Promise<void> {
		const recording = this.getRecording(panelKey, sessionId);
		if (!recording) {
			this.trace('host.confirm.miss', panelKey, sessionId, { optionAutoRestart: Boolean(options.autoRestart) });
			return;
		}
		this.trace('host.confirm.request', panelKey, sessionId, {
			optionAutoRestart: Boolean(options.autoRestart),
			isStopping: recording.isStopping,
			manualConfirmRequested: recording.manualConfirmRequested,
		});

		if (!options.autoRestart) {
			recording.manualConfirmRequested = true;
		}

		if (recording.isStopping) {
			this.trace('host.confirm.skip-already-stopping', panelKey, sessionId, {
				optionAutoRestart: Boolean(options.autoRestart),
				manualConfirmRequested: recording.manualConfirmRequested,
			});
			return;
		}

		recording.isStopping = true;

		try {
			this.trace('host.confirm.stop.begin', panelKey, sessionId, {
				optionAutoRestart: Boolean(options.autoRestart),
				manualConfirmRequested: recording.manualConfirmRequested,
			});
			const result = await recording.recorder.stop();
			const shouldAutoRestart = Boolean(options.autoRestart) && !recording.manualConfirmRequested;
			this.trace('host.confirm.stop.done', panelKey, sessionId, {
				optionAutoRestart: Boolean(options.autoRestart),
				manualConfirmRequested: recording.manualConfirmRequested,
				finalAutoRestart: shouldAutoRestart,
				durationMs: result.durationMs,
				sampleCount: result.samples.length,
			});
			this.activeRecordings.delete(panelKey);
			await recording.recorder.dispose().catch(() => null);
			this.enqueueJob({
				sequence: this.nextJobSequence++,
				panelKey,
				sessionId,
				postMessage: recording.postMessage,
				durationMs: result.durationMs,
				samples: result.samples,
				autoRestart: shouldAutoRestart,
				cancelled: false,
			});
		} catch (error) {
			this.trace('host.confirm.error', panelKey, sessionId, { error: normalizeErrorText(error) });
			if (this.activeRecordings.get(panelKey)?.sessionId === sessionId) {
				this.activeRecordings.delete(panelKey);
			}
			await recording.recorder.dispose().catch(() => null);
			this.postError(recording.postMessage, sessionId, error);
		}
	}

	async cancel(panelKey: string, sessionId?: string): Promise<void> {
		if (sessionId) {
			await this.cancelActiveRecording(panelKey, sessionId);
			return;
		}

		await this.cancelActiveRecording(panelKey);
		this.cancelPanelJobs(panelKey);
	}

	async dispose(): Promise<void> {
		const panelKeys = Array.from(this.activeRecordings.keys());
		for (const panelKey of panelKeys) {
			await this.cancel(panelKey);
		}

		for (const job of this.queue) {
			job.cancelled = true;
			this.recordCompletedJob(job, null);
		}
		this.queue.length = 0;
		for (const job of this.activeJobs) {
			job.cancelled = true;
			this.recordCompletedJob(job, null);
		}
	}

	private enqueueJob(job: PromptVoiceQueueJob): void {
		this.queue.push(job);
		this.trace('host.queue.enqueue', job.panelKey, job.sessionId, {
			sequence: job.sequence,
			autoRestart: job.autoRestart,
			durationMs: job.durationMs,
		});
		this.postQueueState(job, 'queued', {
			message: 'В очереди распознавания',
			progress: 0,
			autoRestart: job.autoRestart,
		});
		this.pumpQueue();
	}

	private pumpQueue(): void {
		while (this.activeJobs.size < MAX_PARALLEL_PROMPT_VOICE_JOBS && this.queue.length > 0) {
			const job = this.queue.shift();
			if (!job) {
				continue;
			}
			if (job.cancelled) {
				this.recordCompletedJob(job, null);
				continue;
			}

			this.activeJobs.add(job);
			this.trace('host.queue.start-job', job.panelKey, job.sessionId, { sequence: job.sequence });
			void this.processJob(job).finally(() => {
				this.activeJobs.delete(job);
				this.trace('host.queue.finish-job', job.panelKey, job.sessionId, { sequence: job.sequence });
				this.pumpQueue();
			});
		}
	}

	private async processJob(job: PromptVoiceQueueJob): Promise<void> {
		try {
			const text = await this.transcriptionService.transcribe(job.samples, (state) => {
				this.postTranscriptionState(job, state);
			});
			if (job.cancelled) {
				this.recordCompletedJob(job, null);
				return;
			}

			if (!text.trim()) {
				throw new Error('PROMPT_VOICE_EMPTY_TRANSCRIPTION');
			}

			this.postQueueState(job, 'correcting', {
				message: 'AI коррекция',
				progress: null,
			});
			const correctedText = normalizePromptVoicePostCorrectionResult(text, await this.postCorrectionService.correct(text));
			if (job.cancelled) {
				this.recordCompletedJob(job, null);
				return;
			}

			this.recordCompletedJob(job, correctedText);
		} catch (error) {
			if (job.cancelled) {
				this.recordCompletedJob(job, null);
				return;
			}
			this.logError(error);
			const meta = getErrorMeta(error);
			this.postQueueState(job, 'error', {
				message: meta.message,
				progress: null,
				errorBadge: meta.badge,
				errorHint: meta.hint,
			});
			this.recordCompletedJob(job, null);
		}
	}

	private recordCompletedJob(job: PromptVoiceQueueJob, text: string | null): void {
		if (job.sequence < this.nextCompletionSequence || this.completedJobResults.has(job.sequence)) {
			this.trace('host.queue.record-completed.skip', job.panelKey, job.sessionId, {
				sequence: job.sequence,
				hasText: Boolean(text),
			});
			return;
		}

		this.trace('host.queue.record-completed', job.panelKey, job.sessionId, {
			sequence: job.sequence,
			hasText: Boolean(text),
		});
		this.completedJobResults.set(job.sequence, { job, text });
		this.flushCompletedJobsInOrder();
	}

	private flushCompletedJobsInOrder(): void {
		while (this.completedJobResults.has(this.nextCompletionSequence)) {
			const result = this.completedJobResults.get(this.nextCompletionSequence);
			this.completedJobResults.delete(this.nextCompletionSequence);
			this.nextCompletionSequence += 1;

			if (!result || result.job.cancelled || !result.text) {
				continue;
			}

			this.postQueueState(result.job, 'completed', {
				message: 'Готово',
				progress: 100,
				text: result.text,
			});
		}
	}

	private postTranscriptionState(job: PromptVoiceQueueJob, state: PromptVoiceTranscriptionState): void {
		this.postQueueState(job, state.stage, {
			message: state.message,
			progress: typeof state.progress === 'number' ? state.progress : null,
		});
	}

	private async cancelActiveRecording(panelKey: string, sessionId?: string): Promise<void> {
		const recording = this.activeRecordings.get(panelKey);
		if (!recording) {
			this.trace('host.cancel-active.skip', panelKey, sessionId, { reason: 'missing' });
			return;
		}
		if (sessionId && recording.sessionId !== sessionId) {
			this.trace('host.cancel-active.skip', panelKey, sessionId, {
				reason: 'session-mismatch',
				activeSessionId: recording.sessionId,
			});
			return;
		}

		this.trace('host.cancel-active.request', panelKey, recording.sessionId, { requestedSessionId: sessionId ?? null });
		this.activeRecordings.delete(panelKey);
		await recording.recorder.cancel().catch(() => null);
		recording.postMessage({
			type: 'promptVoiceState',
			sessionId: recording.sessionId,
			status: 'cancelled',
		});
	}

	private cancelPanelJobs(panelKey: string): void {
		for (let index = this.queue.length - 1; index >= 0; index -= 1) {
			if (this.queue[index].panelKey !== panelKey) {
				continue;
			}
			this.queue[index].cancelled = true;
			this.recordCompletedJob(this.queue[index], null);
			this.queue.splice(index, 1);
		}

		for (const job of this.activeJobs) {
			if (job.panelKey === panelKey) {
				job.cancelled = true;
				this.recordCompletedJob(job, null);
			}
		}
	}

	private getRecording(panelKey: string, sessionId: string): PromptVoiceRecordingEntry | null {
		const recording = this.activeRecordings.get(panelKey);
		if (!recording || recording.sessionId !== sessionId) {
			return null;
		}
		return recording;
	}

	private postQueueState(
		job: PromptVoiceQueueJob,
		status: PromptVoiceQueueStatus,
		patch: Omit<PromptVoiceQueueMessage, 'type' | 'sessionId' | 'status' | 'elapsedMs'> = {},
	): void {
		if (job.cancelled) {
			this.trace('host.queue.post-state.skip-cancelled', job.panelKey, job.sessionId, { queueStatus: status });
			return;
		}

		if (status === 'queued' || status === 'completed' || status === 'error' || status === 'correcting') {
			this.trace('host.queue.post-state', job.panelKey, job.sessionId, {
				queueStatus: status,
				autoRestart: patch.autoRestart ?? null,
				progress: patch.progress ?? null,
				hasText: Boolean(patch.text),
			});
		}

		job.postMessage({
			type: 'promptVoiceQueueState',
			sessionId: job.sessionId,
			status,
			elapsedMs: job.durationMs,
			...patch,
		});
	}

	private postError(postMessage: PostMessage, sessionId: string, error: unknown): void {
		this.logError(error);
		const meta = getErrorMeta(error);
		postMessage({
			type: 'promptVoiceState',
			sessionId,
			status: 'error',
			message: meta.message,
			errorBadge: meta.badge,
			errorHint: meta.hint,
		});
	}

	private logError(error: unknown): void {
		const raw = normalizeErrorText(error);
		if (raw) {
			this.output.appendLine(`[prompt-voice] ${raw}`);
		}
	}

	private trace(
		event: string,
		panelKey: string,
		sessionId?: string,
		details: PromptVoiceDebugDetails = {},
	): void {
		const recording = this.activeRecordings.get(panelKey);
		const traceDetails: PromptVoiceDebugDetails = {
			panelKey,
			sessionId: sessionId ?? null,
			activeSessionId: recording?.sessionId ?? null,
			activeIsStopping: recording?.isStopping ?? null,
			activeManualConfirm: recording?.manualConfirmRequested ?? null,
			queueLength: this.queue.length,
			activeJobs: this.activeJobs.size,
			nextJobSequence: this.nextJobSequence,
			nextCompletionSequence: this.nextCompletionSequence,
			...details,
		};
		this.output.appendLine(`${PROMPT_VOICE_TRACE_PREFIX} ${new Date().toISOString()} event=${event} ${formatTraceDetails(traceDetails)}`);
	}
}
