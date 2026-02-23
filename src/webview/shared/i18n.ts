/**
 * i18n hook for webview components.
 * Locale is injected via window.__LOCALE__ in the webview HTML.
 */

import { useMemo } from 'react';
import { translate } from '../../i18n/translations.js';

declare global {
	interface Window {
		__LOCALE__?: string;
	}
}

export function getLocale(): string {
	return window.__LOCALE__ || 'en';
}

/** React hook: returns t(key) translation function */
export function useT(): (key: string) => string {
	const locale = getLocale();
	return useMemo(() => (key: string) => translate(locale, key), [locale]);
}
