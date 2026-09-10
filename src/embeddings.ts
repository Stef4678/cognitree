import type { App } from 'obsidian';
import type { PluginSettings } from './types';
import { noteTags } from './vaultGraph';

/**
 * Semantic index: embeddings of the user's vault notes, used to rank
 * "Find connections" candidates and to give the Ask chat vault context beyond
 * the focused branch.
 *
 * Design notes:
 *  - Only notes whose `mtime` (or embedding model) changed are re-embedded, so
 *    the index is incremental and cheap after the first pass.
 *  - Vectors live in the plugin folder (`<plugin>/embeddings.json`), never in
 *    the plugin data file (which would balloon) and never in the vault's notes.
 *  - Everything degrades to the lexical name index when no embedding model is
 *    configured or the endpoint does not support `/embeddings`.
 */

export interface EmbeddingRecord {
	/** Vault mtime of the note when it was embedded. */
	mtime: number;
	/** Display name (note basename) — avoids a vault lookup on search. */
	name: string;
	vector: number[];
}

export interface EmbeddingStore {
	version: number;
	/** Model id the vectors were produced with; a change invalidates the index. */
	model: string;
	records: Record<string, EmbeddingRecord>;
}

export const EMBEDDING_STORE_VERSION = 1;
/** Inputs per `/embeddings` request. */
export const EMBED_BATCH_SIZE = 32;
/** Upper bound on cached vectors (oldest mtimes are pruned first). */
export const MAX_EMBEDDING_RECORDS = 20000;
/**
 * Batches between two persistence passes. Rewriting the whole JSON store after
 * every batch would be O(n²) on a large vault; every 8 batches (256 notes) is
 * a compromise between crash safety and write volume.
 */
export const PERSIST_EVERY_BATCHES = 8;

export function emptyStore(): EmbeddingStore {
	return { version: EMBEDDING_STORE_VERSION, model: '', records: {} };
}

/** Cosine similarity; 0 when either vector is empty or degenerate. */
export function cosine(a: number[], b: number[]): number {
	if (!a?.length || !b?.length || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ScoredKey {
	key: string;
	score: number;
}

/** Rank stored vectors against a query vector, best first. */
export function rankBySimilarity(
	query: number[],
	records: Record<string, { vector: number[] }>,
	limit: number
): ScoredKey[] {
	const scored: ScoredKey[] = [];
	for (const [key, record] of Object.entries(records)) {
		const score = cosine(query, record.vector);
		if (score > 0) scored.push({ key, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, Math.max(0, limit));
}

/** The text that represents one note: title + tags + the head of its body. */
export function vectorText(name: string, tags: string[], body: string, maxChars = 400): string {
	const clean = body
		.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
		.replace(/[#>*_`[\]()]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, maxChars);
	const tagPart = tags.filter(Boolean).slice(0, 8).join(' ');
	return [name, tagPart, clean].filter(Boolean).join(' — ');
}

/** Notes that still need embedding (new, edited or produced by another model). */
export function pendingFiles<
	T extends { path: string; stat: { mtime: number } }
>(files: T[], store: EmbeddingStore, model: string): T[] {
	const stale = store.model !== model;
	const out: T[] = [];
	for (const file of files) {
		const record = store.records[file.path];
		if (!stale && record && record.mtime >= file.stat.mtime) continue;
		out.push(file);
	}
	return out;
}

/** Drop records for files that no longer exist, then cap the store by mtime. */
export function pruneStore(store: EmbeddingStore, livePaths: Set<string>): number {
	let removed = 0;
	for (const key of Object.keys(store.records)) {
		if (!livePaths.has(key)) {
			delete store.records[key];
			removed++;
		}
	}
	const entries = Object.entries(store.records);
	if (entries.length > MAX_EMBEDDING_RECORDS) {
		entries.sort((a, b) => a[1].mtime - b[1].mtime);
		for (const [key] of entries.slice(0, entries.length - MAX_EMBEDDING_RECORDS)) {
			delete store.records[key];
			removed++;
		}
	}
	return removed;
}

export interface EmbedProgress {
	done: number;
	total: number;
	label: string;
}

export interface IndexResult {
	embedded: number;
	pruned: number;
	failed: number;
	total: number;
	/** True when the run stopped because the per-run budget was reached. */
	truncated: boolean;
}

/**
 * Obsidian-facing part of the semantic index: reads note text through the
 * vault, batches embedding requests and persists the store.
 */
export class SemanticIndex {
	private store: EmbeddingStore = emptyStore();

	constructor(
		private app: App,
		private getSettings: () => PluginSettings,
		private cachePath: string,
		/** Embedding call, injected so this module stays free of the API client. */
		private embedFn: (model: string, texts: string[]) => Promise<number[][]>
	) {}

	get enabled(): boolean {
		return !!this.getSettings().embeddingModel.trim();
	}

	get size(): number {
		return Object.keys(this.store.records).length;
	}

	get model(): string {
		return this.store.model;
	}

	async load(): Promise<void> {
		try {
			const raw = await this.app.vault.adapter.read(this.cachePath);
			const parsed = JSON.parse(raw) as EmbeddingStore;
			if (parsed && parsed.version === EMBEDDING_STORE_VERSION && parsed.records) {
				this.store = parsed;
			}
		} catch {
			this.store = emptyStore(); // no cache yet (or unreadable)
		}
	}

	private async persist(): Promise<void> {
		try {
			await this.app.vault.adapter.write(this.cachePath, JSON.stringify(this.store));
		} catch (err) {
			console.warn('CogniTree: could not persist the semantic index', err);
		}
	}

	/** Embed (or re-embed) vault notes, newest changes first, within `budget`. */
	async indexNotes(opts: {
		excludeFolder: string;
		budget: number;
		onProgress?: (p: EmbedProgress) => void;
		signal?: AbortSignal;
	}): Promise<IndexResult> {
		const model = this.getSettings().embeddingModel.trim();
		if (!model) throw new Error('No embedding model configured.');
		if (this.store.model !== model) {
			// Vectors from another model are not comparable — start over.
			this.store = { version: EMBEDDING_STORE_VERSION, model, records: {} };
		}
		this.store.model = model;

		const excluded = (opts.excludeFolder || 'CogniTree').split('/').filter(Boolean).join('/');
		const live = this.app.vault
			.getMarkdownFiles()
			.filter((f) => !excluded || !(f.path === excluded || f.path.startsWith(excluded + '/')));
		const pruned = pruneStore(this.store, new Set(live.map((f) => f.path)));

		const pending = pendingFiles(live, this.store, model);
		const budget = Math.max(0, opts.budget);
		const batch = pending.slice(0, budget);
		const result: IndexResult = {
			embedded: 0,
			pruned,
			failed: 0,
			total: pending.length,
			truncated: pending.length > batch.length,
		};
		if (batch.length === 0) {
			await this.persist();
			return result;
		}

		let done = 0;
		let batches = 0;
		for (let i = 0; i < batch.length; i += EMBED_BATCH_SIZE) {
			if (opts.signal?.aborted) break;
			const chunk = batch.slice(i, i + EMBED_BATCH_SIZE);
			opts.onProgress?.({
				done,
				total: batch.length,
				label: `Embedding ${done}/${batch.length} notes…`,
			});
			try {
				const texts = await Promise.all(
					chunk.map(async (file) => {
						// Shared with the vault graph so tag handling (string vs list
						// frontmatter, leading '#') can only be right in one place.
						const tags = noteTags(this.app.metadataCache.getFileCache(file));
						const body = await this.app.vault.cachedRead(file);
						return vectorText(file.basename, tags, body);
					})
				);
				const vectors = await this.embedFn(model, texts);
				for (let k = 0; k < chunk.length; k++) {
					const vector = vectors[k];
					if (!vector?.length) {
						result.failed++;
						continue;
					}
					this.store.records[chunk[k].path] = {
						mtime: chunk[k].stat.mtime,
						name: chunk[k].basename,
						vector,
					};
					result.embedded++;
				}
			} catch (err) {
				result.failed += chunk.length;
				console.warn('CogniTree: embedding batch failed', err);
			}
			done += chunk.length;
			batches++;
			// Persist periodically so a long run (or a closed app) keeps its work.
			if (batches % PERSIST_EVERY_BATCHES === 0) await this.persist();
		}
		await this.persist();
		opts.onProgress?.({ done, total: batch.length, label: 'Semantic index updated.' });
		return result;
	}

	/** Notes most similar to `text`, excluding the tree folder's own notes. */
	async search(
		text: string,
		limit = 20
	): Promise<{ path: string; name: string; score: number }[]> {
		const model = this.getSettings().embeddingModel.trim();
		const query = text.trim();
		if (!model || !query || this.size === 0) return [];
		const [vector] = await this.embedFn(model, [query.slice(0, 2000)]);
		if (!vector?.length) return [];
		return rankBySimilarity(vector, this.store.records, limit)
			.map((hit) => {
				const record = this.store.records[hit.key];
				return { path: hit.key, name: record?.name ?? hit.key, score: hit.score };
			})
			.filter((hit) => !!hit.name);
	}

	async clear(): Promise<void> {
		this.store = emptyStore();
		await this.persist();
	}
}
