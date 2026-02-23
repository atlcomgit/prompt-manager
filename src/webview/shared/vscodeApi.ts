/**
 * VS Code API accessor for webviews
 */

interface VsCodeApi {
	postMessage(msg: any): void;
	getState(): any;
	setState(state: any): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
	if (!api) {
		api = acquireVsCodeApi();
	}
	return api;
}
