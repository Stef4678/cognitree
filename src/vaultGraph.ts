import type { App, CachedMetadata } from 'obsidian';
import { normalizeKey } from './parser';
import type { VaultTreeCandidate } from './prompts';

/**
 * Reverse growth: reason about the notes the user ALREADY has.
 *
 * Everything here comes from Obsidian's `metadataCache` (names, tags, resolved
 * links) — no file bodies are read, so building the graph is cheap even for a
 * large vault. The graph is then handed to the LLM, which proposes a hierarchy
 * over real note names; the store writes that hierarchy as "reference nodes"
 * that point at the original notes instead of duplicating them.
 */

export interface GraphNote {
	/** Display name (note basename). */
	name: string;
	/** Vault path. */
	path: string;
	/** Tags, normalised to start with '#'. */
	tags: string[];
	/** Resolved outgoing link targets (vault paths). */
	links: string[];
	/** Number of notes linking here (rough centrality). */
	backlinks: number;
}

/** Pure: add backlink counts to raw note metadata. */
export function buildGraph(notes: Omit<GraphNote, 'backlinks'>[]): GraphNote[] {
	const incoming = new Map<string, number>();
	for (const note of notes) {
		for (const target of note.links) {
			if (target === note.path) continue; // self-links are not centrality
			incoming.set(target, (incoming.get(target) ?? 0) + 1);
		}
	}
	return notes.map((note) => ({ ...note, backlinks: incoming.get(note.path) ?? 0 }));
}

/**
 * Pure: notes within `depth` hops of `seedPath` (links count in both
 * directions), nearest first and most-linked first within a hop, capped.
 */
export function neighborhood(
	graph: GraphNote[],
	seedPath: string,
	depth: number,
	limit: number
): GraphNote[] {
	const byPath = new Map(graph.map((note) => [note.path, note]));
	const adjacency = new Map<string, Set<string>>();
	const link = (from: string, to: string) => {
		if (!byPath.has(to)) return; // unresolved links are not neighbours
		const set = adjacency.get(from) ?? new Set<string>();
		set.add(to);
		adjacency.set(from, set);
	};
	for (const note of graph) {
		for (const target of note.links) {
			link(note.path, target);
			link(target, note.path); // undirected: backlinks count too
		}
	}

	const hops = new Map<string, number>([[seedPath, 0]]);
	const found: GraphNote[] = [];
	let frontier: string[] = [seedPath];
	for (let hop = 1; hop <= Math.max(0, depth) && frontier.length > 0; hop++) {
		const next: string[] = [];
		for (const path of frontier) {
			for (const target of adjacency.get(path) ?? []) {
				if (hops.has(target)) continue;
				hops.set(target, hop);
				const note = byPath.get(target);
				if (note) {
					found.push(note);
					next.push(target);
				}
			}
		}
		frontier = next;
	}
	return found
		.sort(
			(a, b) =>
				(hops.get(a.path) ?? 0) - (hops.get(b.path) ?? 0) ||
				b.backlinks - a.backlinks ||
				a.name.localeCompare(b.name)
		)
		.slice(0, Math.max(0, limit));
}

/** Pure: the notes carrying a tag (or one of its sub-tags), most-linked first. */
export function notesWithTag(graph: GraphNote[], tag: string, limit: number): GraphNote[] {
	const wanted = tag.trim().toLowerCase().replace(/^#/, '');
	if (!wanted) return [];
	return graph
		.filter((note) =>
			note.tags.some((t) => {
				const value = t.toLowerCase().replace(/^#/, '');
				return value === wanted || value.startsWith(wanted + '/');
			})
		)
		.sort((a, b) => b.backlinks - a.backlinks || a.name.localeCompare(b.name))
		.slice(0, Math.max(0, limit));
}

/** Pure: tag frequency across the vault (for the tag picker). */
export function topTags(graph: GraphNote[], limit = 20): { tag: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const note of graph) {
		for (const tag of new Set(note.tags)) {
			const key = tag.toLowerCase();
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
		.slice(0, Math.max(0, limit));
}

/** Pure: the note metadata the cartography prompt needs. */
export function toCandidates(notes: GraphNote[]): VaultTreeCandidate[] {
	return notes.map((note) => ({ name: note.name, tags: note.tags, backlinks: note.backlinks }));
}

/** Pure: normalized note name → vault path, used to validate model output. */
export function sourceMap(notes: GraphNote[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const note of notes) {
		const key = normalizeKey(note.name);
		if (key && !map.has(key)) map.set(key, note.path);
	}
	return map;
}

/**
 * Tags of a note from its metadata cache, normalised to `#tag` strings.
 *
 * `frontmatter.tags` is legitimate YAML as a list, a single string or a number,
 * and the frontmatter is typed `any`, so it is narrowed to `unknown` first:
 * spreading a bare string would otherwise produce one tag per character, and
 * spreading `any` would leak that type into everything downstream.
 */
export function noteTags(cache: CachedMetadata | null | undefined): string[] {
	const raw: unknown = cache?.frontmatter?.tags;
	const frontmatterTags: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
	const inlineTags: string[] = (cache?.tags ?? []).map((t) => t.tag);
	return [
		...new Set(
			[...frontmatterTags, ...inlineTags]
				.map((t) => String(t).trim())
				.filter(Boolean)
				.map((t) => (t.startsWith('#') ? t : `#${t}`))
		),
	];
}

/**
 * Read the vault's note graph from `metadataCache` (names, tags, resolved
 * links). The tree folder is excluded so generated notes never feed back in.
 */
export function collectVaultNotes(app: App, opts: { excludeFolder: string }): GraphNote[] {
	const excluded = (opts.excludeFolder || 'CogniTree').split('/').filter(Boolean).join('/');
	const resolved = app.metadataCache.resolvedLinks ?? {};
	const raw: Omit<GraphNote, 'backlinks'>[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (excluded && (file.path === excluded || file.path.startsWith(excluded + '/'))) continue;
		const cache = app.metadataCache.getFileCache(file);
		raw.push({
			name: file.basename,
			path: file.path,
			tags: noteTags(cache),
			links: Object.keys(resolved[file.path] ?? {}),
		});
	}
	return buildGraph(raw);
}
