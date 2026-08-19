import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import { ApiClient, ApiError, type ChatMessage } from './api';
import { ResponseCache } from './cache';
import type { VaultIndexer } from './indexer';
import { extractJSON, hashString, normalizeComplexity, normalizeKey, titleCase } from './parser';
import {
	buildBatchPrompt,
	buildConnectionPrompt,
	buildDiscoveryPrompt,
	buildExpansionPrompt,
} from './prompts';
import type { ConceptStore } from './store';
import type {
	BatchResult,
	ChildConcept,
	ConnectionResult,
	DiscoveryResult,
	ExpansionResult,
	PluginSettings,
	ProgressCallback,
	ProgressInfo,
	TreeNode,
	TreeModel,
} from './types';

/**
 * Orchestrates the four prompt workflows:
 *  1. discover()   – brand-new root concept (Discovery prompt)
 *  2. expand()     – drill into one branch (Expansion prompt)
 *  3. connections()– relate a node to existing vault notes (Connection prompt)
 *  4. batch()      – generate a full subtree to a depth (Batch prompt / repeated expansions)
 *
 * All LLM calls go through the response cache, so identical queries are cheap.
 */
export class ConceptGenerator {
	readonly api: ApiClient;
	private cache: ResponseCache;

	constructor(
		private app: App,
		private store: ConceptStore,
		private indexer: VaultIndexer,
		private getSettings: () => PluginSettings,
		cache: ResponseCache
	) {
		this.api = new ApiClient(getSettings());
		this.cache = cache;
	}

	// ---------------------------------------------------------------- helpers

	private settings(): PluginSettings {
		return this.getSettings();
	}

	private async runPrompt(
		kind: string,
		system: string,
		user: string,
		onDelta?: (d: string) => void
	): Promise<string> {
		const s = this.settings();
		const cached = await this.cache.get(kind, user, s.model);
		if (cached !== null && typeof cached === 'string') {
			return cached;
		}
		const messages: ChatMessage[] = [
			{ role: 'system', content: system },
			{ role: 'user', content: user },
		];
		const text = await this.api.chat(messages, {
			maxTokens: s.maxTokensPerRequest,
			temperature: s.temperature,
			streaming: s.streaming,
			onDelta,
		});
		await this.cache.set(kind, user, s.model, text);
		return text;
	}

	private parse<T>(raw: string, kind: string): T {
		const parsed = extractJSON<T>(raw);
		if (!parsed) {
			throw new ApiError(
				`The model did not return valid JSON for ${kind}. Raw response (first 300 chars): ${raw.slice(0, 300)}`
			);
		}
		return parsed;
	}

	private progress(
		cb: ProgressCallback | undefined,
		done: number,
		total: number,
		label: string
	): void {
		if (cb) cb({ done, total, label } satisfies ProgressInfo);
	}

	// ---------------------------------------------------------------- 1. Discovery

	async discover(concept: string, onDelta?: (d: string) => void): Promise<DiscoveryResult> {
		const prompt = buildDiscoveryPrompt(concept);
		const raw = await this.runPrompt('discover', prompt.system, prompt.user, onDelta);
		const result = this.parse<DiscoveryResult>(raw, 'discovery');
		result.concept = result.concept || concept;
		result.domains = (result.domains || []).filter((d) => d && d.name && d.children?.length);
		if (result.domains.length === 0) {
			throw new ApiError('Discovery returned no usable domains. Try rephrasing the concept.');
		}
		return result;
	}

	// ---------------------------------------------------------------- 2. Expansion

	async expand(
		node: TreeNode,
		model: TreeModel,
		onDelta?: (d: string) => void
	): Promise<{ created: TreeNode[]; skipped: string[] }> {
		const parentName = node.parent
			? model.nodes.get(node.parent)?.name ?? node.parent
			: model.root;
		const existingSiblings = node.children.map((c) => model.nodes.get(c)?.name ?? c);
		const prompt = buildExpansionPrompt({
			child: node.name,
			parent: parentName,
			domain: node.domain,
			existingSiblings,
			maxChildren: this.settings().maxChildrenPerLevel,
		});
		const raw = await this.runPrompt('expand', prompt.system, prompt.user, onDelta);
		const result = this.parse<ExpansionResult>(raw, 'expansion');
		const children: ChildConcept[] = (result.children || [])
			.filter((c) => c && normalizeKey(c.name || ''))
			.map((c) => ({
				name: titleCase(c.name),
				description: c.description || '',
				connections: (c.connections || []).filter(Boolean),
				complexity: normalizeComplexity(c.complexity),
				can_expand: c.can_expand !== false,
				estimated_depth: c.estimated_depth,
			}));
		if (children.length === 0) {
			throw new ApiError(`Expansion of "${node.name}" returned no children.`);
		}
		return this.store.addChildren(
			node,
			children,
			this.settings().treeFolder,
			model.nodes,
			result.domain
		);
	}

	// ---------------------------------------------------------------- 3. Connections

	async connections(
		node: TreeNode,
		onDelta?: (d: string) => void
	): Promise<ConnectionResult | null> {
		const candidates = this.indexer.search(node.name, 120).filter((c) => c !== node.name);
		const prompt = buildConnectionPrompt({ concept: node.name, candidates });
		const raw = await this.runPrompt(
			`conn|${hashString(candidates.join('|'))}`,
			prompt.system,
			prompt.user,
			onDelta
		);
		const result = this.parse<ConnectionResult>(raw, 'connection discovery');
		result.concept = result.concept || node.name;
		result.connections = (result.connections || []).filter((c) => c && c.name);
		result.suggested_connections_to_create = (result.suggested_connections_to_create || []).filter(
			Boolean
		);
		return result;
	}

	// ---------------------------------------------------------------- 4. Batch

	/**
	 * Batch expansion to a target depth using repeated Expansion prompts with
	 * bounded concurrency, level by level (BFS). `budget` caps the total
	 * number of generated nodes (the Batch prompt itself is used only as an
	 * optional fast first pass; per-node Expansion prompts are the scalable
	 * path for tens of thousands of nodes).
	 */
	async batch(
		rootName: string,
		depth: number,
		budget: number,
		onProgress?: ProgressCallback,
		onDelta?: (d: string) => void,
		signal?: AbortSignal,
		startNode?: string
	): Promise<{ added: number; errors: string[] }> {
		const model = await this.store.loadTree(rootName);
		if (!model) throw new ApiError(`Tree "${rootName}" not found.`);
		if (startNode && !model.nodes.has(startNode)) {
			throw new ApiError(`Node "${startNode}" not found in tree "${rootName}".`);
		}

		const cap = Math.max(1, Math.min(budget, this.settings().maxNodesPerBatch));
		const targetDepth = Math.max(1, Math.min(depth, this.settings().maxDepth));
		const errors: string[] = [];
		let added = 0;
		let jobsRun = 0;
		let jobsTotal = 0;

		// Frontier of (node, level) pairs to expand at the current depth.
		let frontier: { name: string; level: number }[] = [
			{ name: startNode ?? model.root, level: 1 },
		];
		const visited = new Set<string>();

		const CONCURRENCY = 3;

		while (frontier.length > 0 && added + visited.size < cap) {
			if (signal?.aborted) break;

			// Pick jobs at this level that still need expansion.
			const jobs: { name: string; level: number }[] = [];
			const next: { name: string; level: number }[] = [];
			for (const item of frontier) {
				if (visited.has(item.name)) continue;
				visited.add(item.name);
				const node = model.nodes.get(item.name);
				if (!node) continue;
				if (item.level < targetDepth && node.canExpand) {
					jobs.push(item);
				}
				// Descend into already-expanded children regardless.
				if (item.level < targetDepth) {
					for (const c of node.children) {
						next.push({ name: c, level: item.level + 1 });
					}
				}
			}
			if (jobs.length === 0) {
				frontier = next;
				continue;
			}

			jobsTotal += jobs.length;
			this.progress(onProgress, jobsRun, jobsTotal, `Expanding ${jobs.length} node(s) at this level…`);

			let idx = 0;
			const worker = async () => {
				while (idx < jobs.length && !signal?.aborted) {
					const job = jobs[idx++];
					try {
						const node = model.nodes.get(job.name)!;
						this.progress(onProgress, jobsRun, jobsTotal, `Expanding "${job.name}" (level ${job.level})…`);
						const { created } = await this.expand(node, model, onDelta);
						added += created.length;
						for (const child of created) {
							model.nodes.set(child.name, child);
							next.push({ name: child.name, level: job.level + 1 });
						}
					} catch (err) {
						errors.push(`${job.name}: ${(err as Error).message}`);
					} finally {
						jobsRun++;
						this.progress(onProgress, jobsRun, jobsTotal, `Expanded "${job.name}"`);
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

			frontier = next;
		}

		return { added, errors };
	}

	/** Use the Batch Generation prompt for a fast first pass (root → depth). */
	async batchFirstPass(
		rootName: string,
		depth: number,
		maxNodes: number,
		onDelta?: (d: string) => void
	): Promise<{ added: number; skipped: number }> {
		const s = this.settings();
		const prompt = buildBatchPrompt({
			root: rootName,
			depth: Math.max(1, Math.min(depth, 3)),
			maxNodes: Math.max(1, Math.min(maxNodes, s.maxNodesPerBatch)),
		});
		const raw = await this.runPrompt('batch', prompt.system, prompt.user, onDelta);
		const result = this.parse<BatchResult>(raw, 'batch');
		const nodes = (result.nodes || []).filter((n) => n && n.name && n.path);

		const model = await this.store.loadTree(rootName);
		if (!model) throw new ApiError(`Tree "${rootName}" not found.`);

		// Group batch nodes by their first path segment under the root.
		let added = 0;
		let skipped = 0;
		const parent = model.nodes.get(model.root)!;
		const children: ChildConcept[] = nodes
			.filter((n) => {
				const segs = (n.path || '').split('/').filter(Boolean);
				return segs.length >= 2;
			})
			.map((n) => ({
				name: titleCase(n.name),
				description: n.description || '',
				connections: (n.connections || []).filter(Boolean),
			}));
		const { created, skipped: sk } = await this.store.addChildren(
			parent,
			children,
			s.treeFolder,
			model.nodes
		);
		added += created.length;
		skipped += sk.length;
		return { added, skipped };
	}

	static notice(err: unknown): void {
		if (err instanceof ApiError || err instanceof Error) {
			new Notice(err.message, 8000);
		} else {
			new Notice('CogniTree: unexpected error', 8000);
		}
	}
}
