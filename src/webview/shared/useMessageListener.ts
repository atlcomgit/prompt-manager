/**
 * Shared hook: listen for messages from extension
 */

import { useEffect } from 'react';

export function useMessageListener(handler: (msg: any) => void): void {
	useEffect(() => {
		const listener = (event: MessageEvent) => {
			handler(event.data);
		};
		window.addEventListener('message', listener);
		return () => window.removeEventListener('message', listener);
	}, [handler]);
}
