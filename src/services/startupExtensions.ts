import type { Disposable, Extension } from 'vscode';

type HostExtension = Pick<Extension<unknown>, 'id' | 'isActive' | 'packageJSON'>;
interface HostRegistry {
	readonly all: readonly HostExtension[];
}

/** Leave time for VS Code to activate a provider without holding foreground actions indefinitely. */
const STARTUP_PROVIDER_TIMEOUT_MS = 10_000;

/** Keep restored panels responsive while their own providers finish activating. */
export class StartupExtensions implements Disposable {
	private disposed = false;
	private readonly cancelPending = new Set<() => void>();
	readonly whenReady: () => Promise<boolean>;

	constructor(private readonly registry: HostRegistry, private readonly log: (message: string) => void, extensionId: string) {
		this.whenReady = this.forProviders(extensionId);
	}

	/** Wait for the named startup extensions once. Lazy providers activate through their normal API. */
	forProviders(...extensionIds: string[]): () => Promise<boolean> {
		if (this.disposed) return () => Promise.resolve(false);
		const ready = new Promise<boolean>(resolve => {
			const finish = (value: boolean) => {
				clearInterval(poll);
				clearTimeout(deadline);
				this.cancelPending.delete(cancel);
				resolve(value);
			};
			const cancel = () => finish(false);
			const poll = setInterval(() => {
				if (this.startingProviders(extensionIds).length === 0) finish(true);
			}, 1000);
			const deadline = setTimeout(() => {
				const pending = this.startingProviders(extensionIds);
				if (pending.length > 0) {
					this.log('[startup] Превышено время ожидания: ' + pending.join(', '));
				}
				finish(true);
			}, STARTUP_PROVIDER_TIMEOUT_MS);
			poll.unref?.();
			deadline.unref?.();
			this.cancelPending.add(cancel);
		});
		return () => this.disposed ? Promise.resolve(false) : ready;
	}

	/** Report what is still activating after the startup deadline, so panels can skip unavailable reads. */
	startingProviders(extensionIds: readonly string[]): string[] {
		const required = new Set(extensionIds.map(id => id.toLowerCase()));
		return this.registry.all.filter(extension => {
			if (!required.has(extension.id.toLowerCase()) || extension.isActive) return false;
			const { activationEvents, main, browser } = extension.packageJSON;
			return (main || browser) && Array.isArray(activationEvents)
				&& (activationEvents.includes('*') || activationEvents.includes('onStartupFinished'));
		}).map(extension => extension.id);
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	/** Run local startup tasks after Prompt Manager has returned from activate(). */
	async run<T>(task: () => T | Promise<T>): Promise<T | undefined> {
		if (await this.whenReady() && !this.disposed) {
			return task();
		}
		return undefined;
	}

	dispose(): void {
		this.disposed = true;
		for (const cancel of this.cancelPending) cancel();
	}
}
