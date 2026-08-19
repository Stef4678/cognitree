import type { PluginSettings } from './types';
import { hashString } from './parser';

interface CacheEntry {
	key: string;
	value: unknown;
	ts: number;
}

/**
 * LRU-ish response cache persisted to the plugin data file.
 * Identical queries (same kind + prompt + model) return cached results,
 * which reduces API cost and speeds up repeated expansions.
 * Capped at `maxEntries` and pruned by `cacheExpiryHours`.
 */
export class ResponseCache {
	private entries = new Map<string, CacheEntry>();
	private maxEntries = 800;

	constructor(
		private readonly load: () => Promise<unknown>,
		private readonly save: (data: unknown) => Promise<void>,
		private readonly getSettings: () => PluginSettings
	) {}

	async loadFromDisk(): Promise<void> {
		try {
			const data = (await this.load()) as { cache?: Record<string, CacheEntry> } | null;
			if (data && typeof data.cache === 'object' && data.cache) {
				for (const [k, v] of Object.entries(data.cache)) {
					if (v && typeof v === 'object' && 'value' in v) {
						this.entries.set(k, v);
					}
				}
			}
		} catch {
			this.entries.clear();
		}
	}

	async get(kind: string, promptUser: string, model: string): Promise<unknown | null> {
		const hours = Math.max(0, this.getSettings().cacheExpiryHours);
		if (hours === 0) return null; // caching disabled
		const key = this.makeKey(kind, promptUser, model);
		const hit = this.entries.get(key);
		if (!hit) return null;
		if (Date.now() - hit.ts > hours * 3600_000) {
			this.entries.delete(key);
			return null;
		}
		// Bump recency.
		this.entries.delete(key);
		this.entries.set(key, hit);
		return hit.value;
	}

	async set(kind: string, promptUser: string, model: string, value: unknown): Promise<void> {
		if (this.getSettings().cacheExpiryHours === 0) return; // caching disabled
		const key = this.makeKey(kind, promptUser, model);
		this.entries.delete(key);
		this.entries.set(key, { key, value, ts: Date.now() });
		while (this.entries.size > this.maxEntries) {
			// Evict oldest.
			let oldestKey: string | null = null;
			let oldestTs = Infinity;
			for (const [k, e] of this.entries) {
				if (e.ts < oldestTs) {
					oldestTs = e.ts;
					oldestKey = k;
				}
			}
			if (oldestKey !== null) this.entries.delete(oldestKey);
			else break;
		}
		await this.persist();
	}

	async clear(): Promise<void> {
		this.entries.clear();
		await this.persist();
	}

	get size(): number {
		return this.entries.size;
	}

	private makeKey(kind: string, promptUser: string, model: string): string {
		return hashString(`${kind}|${model}|${promptUser}`);
	}

	async persist(): Promise<void> {
		const data = (await this.load()) as Record<string, unknown> | null;
		const merged: Record<string, unknown> = data && typeof data === 'object' ? data : {};
		merged.cache = Object.fromEntries(this.entries.entries());
		await this.save(merged);
	}
}
