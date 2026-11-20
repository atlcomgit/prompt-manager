import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExtensionToWebviewMessage } from '../src/types/messages.js';
import type { PromptVoiceRecorderOptions, PromptVoiceRecordingResult } from '../src/services/promptVoice/promptVoiceRecorder.js';
import { PromptVoiceQueueIndicator } from '../src/webview/editor/components/PromptVoiceQueueIndicator.js';

const originalLoad = (Module as any)._load;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type OutputChannelMock = {
  lines: string[];
  appendLine: (value: string) => void;
  show: () => void;
  dispose: () => void;
};

class FakeRecorder {
  private started = false;

  constructor(
    public readonly options: PromptVoiceRecorderOptions,
    private readonly marker: number,
  ) { }

  getElapsedMs(): number {
    return this.marker * 1000;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async pause(): Promise<void> {
    this.started = false;
  }

  async resume(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<PromptVoiceRecordingResult> {
    this.started = false;
    return {
      durationMs: this.marker * 1000,
      samples: new Float32Array([this.marker]),
    };
  }

  async cancel(): Promise<void> {
    this.started = false;
  }

  async dispose(): Promise<void> {
    this.started = false;
  }
}

const createDeferred = <T,>(): Deferred<T> => {
  let resolveValue: (value: T) => void = () => { };
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
};

const flushAsync = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
};

const waitForMessage = async (
  messages: ExtensionToWebviewMessage[],
  predicate: (message: ExtensionToWebviewMessage) => boolean,
): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (messages.some(predicate)) {
      return;
    }
    await flushAsync();
  }
  assert.ok(messages.some(predicate), JSON.stringify(messages, null, 2));
};

const createVsCodeMock = (): unknown => {
  const output: OutputChannelMock = {
    lines: [],
    appendLine(value: string) {
      this.lines.push(value);
    },
    show() { },
    dispose() { },
  };

  class Disposable {
    constructor(private readonly callback: () => void = () => { }) { }

    dispose(): void {
      this.callback();
    }
  }

  return {
    Disposable,
    window: {
      createOutputChannel: () => output,
    },
    workspace: {
      getConfiguration: () => ({
        get: <T,>(_key: string, defaultValue: T) => defaultValue,
      }),
    },
  };
};

const withPromptVoiceService = async <T,>(
  callback: (serviceModule: typeof import('../src/services/promptVoice/promptVoiceService.js')) => Promise<T>,
): Promise<T> => {
  const vscodeMock = createVsCodeMock();
  (Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const serviceModule = await import('../src/services/promptVoice/promptVoiceService.js');
    return await callback(serviceModule);
  } finally {
    (Module as any)._load = originalLoad;
  }
};

/** A paused capture must stay paused when the initial recorder startup settles. */
test('PromptVoiceService can pause before the first audio block and resume on a new capture', {
  skip: process.platform !== 'linux',
}, async t => {
  const devices: Array<{ child: EventEmitter; stdout: EventEmitter }> = [];
  const childProcess = require('node:child_process') as typeof import('node:child_process');
  t.mock.method(childProcess, 'spawn', () => {
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new EventEmitter(),
      kill: () => {
        queueMicrotask(() => child.emit('close', 0, 'SIGINT'));
        return true;
      },
    });
    devices.push({ child, stdout });
    return child;
  });
  await withPromptVoiceService(async ({ PromptVoiceService }) => {
    const messages: ExtensionToWebviewMessage[] = [];
    const service = new PromptVoiceService('/tmp/prompt-voice-test-cache', {
      transcriptionService: { preload: async () => undefined, transcribe: async () => '' },
      postCorrectionService: { correct: async text => text },
    });
    try {
      const started = service.start('panel', 'early-pause', message => messages.push(message));
      await flushAsync();
      assert.equal(devices.length, 1);
      await service.pause('panel', 'early-pause');
      await started;
      assert.deepEqual(messages.map(message => message.type === 'promptVoiceState' ? message.status : null), ['paused']);
      const resumed = service.resume('panel', 'early-pause');
      await flushAsync();
      assert.equal(devices.length, 2);
      devices[1].stdout.emit('data', Buffer.alloc(512));
      await resumed;
      assert.match(JSON.stringify(messages.at(-1)), /"status":"recording"/);
    } finally {
      await service.dispose();
    }
  });
});

test('PromptVoiceService queues confirmed audio and allows the next recording while transcription runs', async () => {
  await withPromptVoiceService(async ({ PromptVoiceService }) => {
    const messages: ExtensionToWebviewMessage[] = [];
    const recorders: FakeRecorder[] = [];
    const transcribeDeferred = createDeferred<string>();
    const transcribeCalls: number[] = [];

    const service = new PromptVoiceService('/tmp/prompt-voice-test-cache', {
      recorderFactory: (options) => {
        const recorder = new FakeRecorder(options, recorders.length + 1);
        recorders.push(recorder);
        return recorder;
      },
      transcriptionService: {
        preload: async () => undefined,
        transcribe: async (samples) => {
          transcribeCalls.push(samples[0] ?? 0);
          return transcribeDeferred.promise;
        },
      },
      postCorrectionService: {
        correct: async (text) => text,
      },
    });

    await service.start('panel', 'session-1', message => messages.push(message));
    await service.confirm('panel', 'session-1');
    assert.deepEqual(transcribeCalls, [1]);
    assert.ok(messages.some(message => message.type === 'promptVoiceQueueState' && message.status === 'queued'));

    await service.start('panel', 'session-2', message => messages.push(message));
    assert.equal(recorders.length, 2);
    assert.ok(messages.some(message => message.type === 'promptVoiceState' && message.sessionId === 'session-2'));

    transcribeDeferred.resolve('Первый текст');
    await flushAsync();

    assert.ok(messages.some(message => (
      message.type === 'promptVoiceQueueState'
      && message.sessionId === 'session-1'
      && message.status === 'completed'
      && message.text === 'Первый текст'
    )));
  });
});

test('PromptVoiceService processes queued audio in parallel but posts completed text in queue order', async () => {
  await withPromptVoiceService(async ({ PromptVoiceService }) => {
    const messages: ExtensionToWebviewMessage[] = [];
    const recorders: FakeRecorder[] = [];
    const firstTranscription = createDeferred<string>();
    const secondTranscription = createDeferred<string>();
    const transcribeCalls: number[] = [];

    const service = new PromptVoiceService('/tmp/prompt-voice-test-cache', {
      recorderFactory: (options) => {
        const recorder = new FakeRecorder(options, recorders.length + 1);
        recorders.push(recorder);
        return recorder;
      },
      transcriptionService: {
        preload: async () => undefined,
        transcribe: async (samples) => {
          const marker = samples[0] ?? 0;
          transcribeCalls.push(marker);
          return marker === 1 ? firstTranscription.promise : secondTranscription.promise;
        },
      },
      postCorrectionService: {
        correct: async (text) => text,
      },
    });

    await service.start('panel', 'session-1', message => messages.push(message));
    await service.confirm('panel', 'session-1');
    await service.start('panel', 'session-2', message => messages.push(message));
    await service.confirm('panel', 'session-2');

    assert.deepEqual(transcribeCalls, [1, 2]);

    secondTranscription.resolve('Второй текст');
    await flushAsync();
    assert.ok(!messages.some(message => (
      message.type === 'promptVoiceQueueState'
      && message.sessionId === 'session-2'
      && message.status === 'completed'
    )));

    firstTranscription.resolve('Первый текст');
    await waitForMessage(messages, message => (
      message.type === 'promptVoiceQueueState'
      && message.sessionId === 'session-2'
      && message.status === 'completed'
      && message.text === 'Второй текст'
    ));

    const completedMessages = messages.filter((message): message is Extract<ExtensionToWebviewMessage, { type: 'promptVoiceQueueState' }> => (
      message.type === 'promptVoiceQueueState' && message.status === 'completed'
    ));
    assert.deepEqual(
      completedMessages.map(message => message.sessionId),
      ['session-1', 'session-2'],
    );
  });
});


test('PromptVoiceService marks limit-reached recordings for automatic restart in the queue event', async () => {
  await withPromptVoiceService(async ({ PromptVoiceService }) => {
    const messages: ExtensionToWebviewMessage[] = [];
    const recorders: FakeRecorder[] = [];
    const pendingTranscription = createDeferred<string>();

    const service = new PromptVoiceService('/tmp/prompt-voice-test-cache', {
      recorderFactory: (options) => {
        const recorder = new FakeRecorder(options, recorders.length + 1);
        recorders.push(recorder);
        return recorder;
      },
      transcriptionService: {
        preload: async () => undefined,
        transcribe: async () => pendingTranscription.promise,
      },
      postCorrectionService: {
        correct: async (text) => text,
      },
    });

    await service.start('panel', 'session-limit', message => messages.push(message));
    recorders[0].options.onLimitReached?.();
    await flushAsync();

    assert.ok(messages.some(message => (
      message.type === 'promptVoiceQueueState'
      && message.sessionId === 'session-limit'
      && message.status === 'queued'
      && message.autoRestart === true
    )));
  });
});

test('PromptVoiceService does not auto-restart when manual confirm races with the recording limit', async () => {
  await withPromptVoiceService(async ({ PromptVoiceService }) => {
    const messages: ExtensionToWebviewMessage[] = [];
    const recorders: FakeRecorder[] = [];
    const pendingTranscription = createDeferred<string>();

    const service = new PromptVoiceService('/tmp/prompt-voice-test-cache', {
      recorderFactory: (options) => {
        const recorder = new FakeRecorder(options, recorders.length + 1);
        recorders.push(recorder);
        return recorder;
      },
      transcriptionService: {
        preload: async () => undefined,
        transcribe: async () => pendingTranscription.promise,
      },
      postCorrectionService: {
        correct: async (text) => text,
      },
    });

    await service.start('panel', 'session-limit-ok', message => messages.push(message));
    recorders[0].options.onLimitReached?.();
    await service.confirm('panel', 'session-limit-ok');
    await flushAsync();

    assert.ok(messages.some(message => (
      message.type === 'promptVoiceQueueState'
      && message.sessionId === 'session-limit-ok'
      && message.status === 'queued'
      && message.autoRestart === false
    )));
  });
});

test('PromptVoiceService honors early OK intent while limit stop is pending', async () => {
  await withPromptVoiceService(async ({ PromptVoiceService }) => {
    const messages: ExtensionToWebviewMessage[] = [];
    const recorders: FakeRecorder[] = [];
    const pendingTranscription = createDeferred<string>();
    const stopDeferred = createDeferred<PromptVoiceRecordingResult>();

    class SlowStopRecorder extends FakeRecorder {
      async stop(): Promise<PromptVoiceRecordingResult> {
        return stopDeferred.promise;
      }
    }

    const service = new PromptVoiceService('/tmp/prompt-voice-test-cache', {
      recorderFactory: (options) => {
        const recorder = new SlowStopRecorder(options, recorders.length + 1);
        recorders.push(recorder);
        return recorder;
      },
      transcriptionService: {
        preload: async () => undefined,
        transcribe: async () => pendingTranscription.promise,
      },
      postCorrectionService: {
        correct: async (text) => text,
      },
    });

    await service.start('panel', 'session-limit-intent', message => messages.push(message));
    recorders[0].options.onLimitReached?.();
    await flushAsync();
    service.markManualConfirmIntent('panel', 'session-limit-intent');
    stopDeferred.resolve({
      durationMs: 1000,
      samples: new Float32Array([1]),
    });

    await waitForMessage(messages, message => (
      message.type === 'promptVoiceQueueState'
      && message.sessionId === 'session-limit-intent'
      && message.status === 'queued'
    ));

    assert.ok(messages.some(message => (
      message.type === 'promptVoiceQueueState'
      && message.sessionId === 'session-limit-intent'
      && message.status === 'queued'
      && message.autoRestart === false
    )));
  });
});

test('PromptVoiceService keeps raw text when a later queued correction asks for proofreading text again', async () => {
  await withPromptVoiceService(async ({ PromptVoiceService }) => {
    const messages: ExtensionToWebviewMessage[] = [];
    const recorders: FakeRecorder[] = [];
    const firstTranscription = createDeferred<string>();
    let transcribeCallCount = 0;
    let correctionCallCount = 0;

    const service = new PromptVoiceService('/tmp/prompt-voice-test-cache', {
      recorderFactory: (options) => {
        const recorder = new FakeRecorder(options, recorders.length + 1);
        recorders.push(recorder);
        return recorder;
      },
      transcriptionService: {
        preload: async () => undefined,
        transcribe: async () => {
          transcribeCallCount += 1;
          if (transcribeCallCount === 1) {
            return firstTranscription.promise;
          }
          return 'Второй распознанный текст';
        },
      },
      postCorrectionService: {
        correct: async (text) => {
          correctionCallCount += 1;
          return correctionCallCount === 2
            ? 'Пожалуйста, предоставьте текст для корректуры.'
            : text;
        },
      },
    });

    await service.start('panel', 'session-1', message => messages.push(message));
    await service.confirm('panel', 'session-1');
    await service.start('panel', 'session-2', message => messages.push(message));
    await service.confirm('panel', 'session-2');
    assert.equal(transcribeCallCount, 2);

    firstTranscription.resolve('Первый распознанный текст');

    await waitForMessage(messages, message => (
      message.type === 'promptVoiceQueueState'
      && message.sessionId === 'session-2'
      && message.status === 'completed'
      && message.text === 'Второй распознанный текст'
    ));
    assert.ok(!messages.some(message => (
      message.type === 'promptVoiceQueueState'
      && message.sessionId === 'session-2'
      && message.text === 'Пожалуйста, предоставьте текст для корректуры.'
    )));
  });
});

test('PromptVoiceQueueIndicator renders compact progress for queued recognition', () => {
  const markup = renderToStaticMarkup(React.createElement(PromptVoiceQueueIndicator, {
    items: [{
      sessionId: 'voice-1',
      target: 'prompt',
      status: 'processing',
      elapsedMs: 42000,
      elapsedLabel: '00:42',
      message: 'Распознавание речи',
      progressPercent: 42,
      errorBadge: '',
      errorHint: '',
      autoRestart: false,
    }],
    onDismiss: () => undefined,
    t: (key: string) => key,
  }));

  assert.match(markup, /data-pm-prompt-voice-queue="true"/);
  assert.match(markup, /Распознавание речи/);
  assert.match(markup, /00:42/);
  assert.match(markup, /width:42%/);
});
