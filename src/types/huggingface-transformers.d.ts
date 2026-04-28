/** Minimal ambient declarations for Transformers.js runtime APIs used by Prompt Manager. */
declare module '@huggingface/transformers' {
	/** Progress payload emitted while a model is being prepared. */
	export type TransformersProgress = {
		status?: string;
		file?: string;
		progress?: number;
	};

	/** Minimal ONNX WASM backend settings used by the webview runtime. */
	export type TransformersOnnxWasmBackend = {
		numThreads?: number;
		proxy?: boolean;
	};

	/** Minimal environment bag used by extension and webview runtimes. */
	export const env: {
		cacheDir?: string;
		allowLocalModels?: boolean;
		allowRemoteModels?: boolean;
		useBrowserCache?: boolean;
		backends?: {
			onnx?: {
				wasm?: TransformersOnnxWasmBackend;
			};
		};
	};

	/** Minimal pipeline factory used by the project. */
	export function pipeline(
		task: string,
		model: string,
		options?: {
			dtype?: string;
			progress_callback?: (progress: TransformersProgress) => void;
		},
	): Promise<any>;
}