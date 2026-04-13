/**
 * MemoryEmbeddingService — Downloads and manages Transformers.js model,
 * generates vector embeddings for commit summaries, and performs
 * cosine-similarity semantic search.
 *
 * Model: Xenova/all-MiniLM-L6-v2 (384 dimensions, ~30 MB).
 * Downloads in background on activation; not used until ready.
 */

import * as vscode from 'vscode';
import type { EmbeddingModelStatus } from '../types/memory.js';

/** Dimension of the MiniLM-L6-v2 embedding vectors */
export const EMBEDDING_DIMENSIONS = 384;

export class MemoryEmbeddingService {
	private readonly MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
	private status: EmbeddingModelStatus = 'not-downloaded';
	private pipeline: any = null;

	/** Event emitter for status changes */
	private _onStatusChanged = new vscode.EventEmitter<EmbeddingModelStatus>();
	readonly onStatusChanged = this._onStatusChanged.event;

	/**
	 * Start downloading the embedding model in background.
	 * @param cacheDir Directory to store the model files (globalStorageUri)
	 */
	async initialize(cacheDir: string): Promise<void> {
		if (this.status === 'downloading' || this.status === 'ready') { return; }

		this.setStatus('downloading');

		try {
			// Динамический импорт для корректной работы бандлера
			const { pipeline, env } = await import('@huggingface/transformers');

			// Configure cache directory
			env.cacheDir = cacheDir;
			env.allowLocalModels = true;
			env.allowRemoteModels = true;

			// Загрузка pipeline для генерации эмбеддингов (скачивает модель при первом вызове)
			this.pipeline = await pipeline('feature-extraction', this.MODEL_ID, {
				dtype: 'q8',
			});

			this.setStatus('ready');
			console.log('[PromptManager/Memory] Embedding model ready');
		} catch (err) {
			console.error('[PromptManager/Memory] Embedding model initialization failed:', err);
			this.setStatus('failed');
		}
	}

	/** Current model status */
	getStatus(): EmbeddingModelStatus {
		return this.status;
	}

	/** Whether the model is ready to generate embeddings */
	isReady(): boolean {
		return this.status === 'ready' && this.pipeline !== null;
	}

	/**
	 * Generate a vector embedding for the given text.
	 * @returns Float32Array of EMBEDDING_DIMENSIONS length, or null if not ready
	 */
	async generateEmbedding(text: string): Promise<Float32Array | null> {
		if (!this.isReady()) { return null; }

		try {
			const output = await this.pipeline(text, {
				pooling: 'mean',
				normalize: true,
			});
			// output.data is a Float32Array
			return new Float32Array(output.data);
		} catch (err) {
			console.error('[PromptManager/Memory] Embedding generation failed:', err);
			return null;
		}
	}

	/**
	 * Perform semantic search: compare a query embedding against stored embeddings.
	 * @param queryVector The query embedding
	 * @param storedEmbeddings Array of { commitSha, vector } objects
	 * @param topK Maximum number of results
	 * @param threshold Minimum similarity score (0.0 - 1.0)
	 * @returns Sorted array of { commitSha, score }
	 */
	semanticSearch(
		queryVector: Float32Array,
		storedEmbeddings: Array<{ commitSha: string; vector: Float32Array }>,
		topK: number = 10,
		threshold: number = 0.3,
	): Array<{ commitSha: string; score: number }> {
		const results: Array<{ commitSha: string; score: number }> = [];

		for (const entry of storedEmbeddings) {
			const score = this.cosineSimilarity(queryVector, entry.vector);
			if (score >= threshold) {
				results.push({ commitSha: entry.commitSha, score });
			}
		}

		// Sort by score descending, take topK
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, topK);
	}

	/**
	 * Compute cosine similarity between two vectors.
	 * Both vectors must have the same length.
	 */
	private cosineSimilarity(a: Float32Array, b: Float32Array): number {
		let dot = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		const denom = Math.sqrt(normA) * Math.sqrt(normB);
		return denom === 0 ? 0 : dot / denom;
	}

	/** Update and fire status change */
	private setStatus(status: EmbeddingModelStatus): void {
		this.status = status;
		this._onStatusChanged.fire(status);
	}

	/** Clean up resources */
	dispose(): void {
		this.pipeline = null;
		this._onStatusChanged.dispose();
	}
}
