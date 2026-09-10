import type { App, EventRef, TFile, MetadataCache } from 'obsidian';
import { normalizeKey } from './parser';

/**
 * Background index of vault note names (+ tags), built from Obsidian's
 * metadataCache so we never read files ourselves. Powers the "Find
 * Connections" feature: given a concept, return the most related note names
 * to pass to the Connection Discovery prompt. The tree folder is excluded so
 * sibling tree notes don't drown out real vault notes.
 */
export class VaultIndexer {
	private index = new Map<string, string>(); // normalized name -> note name (display)
	private excludedFolder = 'CogniTree';
	private rebuildTimer: number | null = null;
	private refs: EventRef[] = [];
	private subscribed = false;
	private ready = false;

	constructor(private app: App) {}

	/**
	 * Configure the index and subscribe to metadataCache events. Safe to call
	 * repeatedly: the subscription is created once (the settings tab calls
	 * this whenever the tree folder changes).
	 */
	init(excludedFolder: string): void {
		this.excludedFolder = excludedFolder;
		this.rebuild();
		if (this.subscribed) return;
		const debounced = () => this.scheduleRebuild();
		this.refs = [
			this.app.metadataCache.on('changed', debounced),
			this.app.metadataCache.on('deleted', debounced),
			this.app.metadataCache.on('resolved', debounced),
		];
		this.subscribed = true;
		this.ready = true;
	}

	/** Point the index at a new excluded folder without blocking on a rebuild. */
	setExcludedFolder(folder: string): void {
		this.excludedFolder = folder;
		this.scheduleRebuild();
	}

	/** Detach the metadataCache listeners (called when the plugin unloads). */
	dispose(): void {
		for (const ref of this.refs) this.app.metadataCache.offref(ref);
		this.refs = [];
		this.subscribed = false;
		if (this.rebuildTimer !== null) {
			window.clearTimeout(this.rebuildTimer);
			this.rebuildTimer = null;
		}
	}

	private scheduleRebuild(): void {
		if (this.rebuildTimer !== null) window.clearTimeout(this.rebuildTimer);
		this.rebuildTimer = window.setTimeout(() => {
			this.rebuildTimer = null;
			this.rebuild();
		}, 1500);
	}

	rebuild(): void {
		const excluded = (this.excludedFolder || 'CogniTree')
			.split('/')
			.filter(Boolean)
			.join('/');
		this.index.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (excluded && (file.path === excluded || file.path.startsWith(excluded + '/'))) {
				continue;
			}
			const stem = file.basename;
			const key = normalizeKey(stem);
			if (key && !this.index.has(key)) this.index.set(key, stem);
		}
	}

	/** Ranked candidate note names for a concept (token overlap + prefix). */
	search(concept: string, limit = 120): string[] {
		const tokens = new Set(normalizeKey(concept).split(/[^a-z0-9]+/).filter(Boolean));
		const scored: { name: string; score: number }[] = [];

		for (const [key, name] of this.index) {
			let score = 0;
			if (key === normalizeKey(concept)) score += 100;
			else if (key.includes(normalizeKey(concept))) score += 30;
			else if (normalizeKey(concept).includes(key) && key.length >= 3) score += 12;

			for (const t of tokens) {
				if (key.includes(t)) score += 5;
			}
			if (score > 0) scored.push({ name, score });
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map((s) => s.name);
	}

	get noteCount(): number {
		return this.index.size;
	}

	get isReady(): boolean {
		return this.ready;
	}
}

/** Accessor helper for metadataCache frontmatter. */
export function cachedFrontmatter(metadataCache: MetadataCache, file: TFile): Record<string, unknown> | null {
	return metadataCache.getFileCache(file)?.frontmatter ?? null;
}
