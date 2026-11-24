import { randomUUID } from 'node:crypto';

/** A Global update reloads the client configuration. Wait for the caller's token before reading other keys. */
export async function refreshUserSettingsSnapshot(
	key: string,
	read: (key: string) => unknown,
	write: (key: string, value: string) => Promise<void>,
	timeoutMessage: string,
): Promise<void> {
	const token = randomUUID();
	await write(key, token);
	const deadline = performance.now() + 1500;
	while (read(key) !== token) {
		if (performance.now() >= deadline) throw new Error(timeoutMessage);
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}
