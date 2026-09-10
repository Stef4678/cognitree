import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import { ApiClient, ApiError, type ChatMessage } from './api';
import { ResponseCache } from './cache';
import type { VaultIndexer } from './indexer';
import { extractJSON, hashString, normalizeComplexity, normalizeKey, titleCase } from './parser';
import {
	buildConnectionPrompt,
	buildDeepenPrompt,
	buildDiscoveryPrompt,
	buildExpansionPrompt,
	buildReviewCardsPrompt,
	buildVaultTreePrompt,
} from './prompts';
import { buildBranchDigest } from './ask';
import { sanitizeDeepDive } from './notebody';
import { addCards, type CardDraft } from './review';
import type { SemanticIndex } from './embeddings';
import type { ConceptStore } from './store';
import type {
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
import type { VaultTreeCandidate } from './prompts';

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
		cache: ResponseCache,
		/** Optional semantic index; when absent, matching stays lexical. */
		private semantic?: SemanticIndex
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
		onDelta?: (d: string) => void,
		opts: { noCache?: boolean } = {}
	): Promise<string> {
		const s = this.settings();
		// A "refresh" action must really ask the model: serving the cached text
		// would make it look like nothing happened.
		if (!opts.noCache) {
			const cached = await this.cache.get(kind, user, s.model);
			if (cached !== null && typeof cached === 'string') {
				return cached;
			}
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
		// `extractJSON` only accepts JSON objects; guard here too so a stray
		// array can never masquerade as a successful parse.
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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
		const candidates = await this.connectionCandidates(node);
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

	/**
	 * Candidate notes for the connection prompt: the lexical name index merged
	 * with semantically similar notes from the embedding index. Falls back to
	 * the lexical list whenever embeddings are off, empty or failing.
	 */
	private async connectionCandidates(node: TreeNode): Promise<string[]> {
		const lexical = this.indexer.search(node.name, 120).filter((c) => c !== node.name);
		const semantic = this.semantic;
		if (!semantic?.enabled || semantic.size === 0) return lexical;
		try {
			const hits = await semantic.search(`${node.name} ${node.description || ''}`.trim(), 40);
			const merged: string[] = [];
			for (const hit of hits) {
				if (hit.name && hit.name !== node.name && !merged.includes(hit.name)) merged.push(hit.name);
			}
			for (const name of lexical) if (!merged.includes(name)) merged.push(name);
			return merged.slice(0, 120);
		} catch (err) {
			console.warn('CogniTree: semantic candidate search failed — using the lexical index', err);
			return lexical;
		}
	}

	// ---------------------------------------------------------------- 4. Batch

	/**
	 * Batch expansion to a target depth using repeated Expansion prompts with
	 * bounded concurrency, level by level (BFS). `depth` is the number of levels
	 * generated below the start node (1 = expand the start node only).
	 * `budget` caps the total number of generated nodes and is checked before
	 * every expansion, not just between levels; because up to CONCURRENCY
	 * expansions can already be in flight, the final count may exceed it by at
	 * most CONCURRENCY × maxChildrenPerLevel.
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

		// Frontier of (node, level) pairs to expand. The start node sits at
		// level 0, so a node at level L is expanded when L < targetDepth and
		// targetDepth is exactly the number of generated levels.
		let frontier: { name: string; level: number }[] = [
			{ name: startNode ?? model.root, level: 0 },
		];
		const visited = new Set<string>();

		const CONCURRENCY = 3;

		while (frontier.length > 0 && added < cap) {
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
				if (item.level + 1 < targetDepth) {
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
				while (idx < jobs.length && !signal?.aborted && added < cap) {
					const job = jobs[idx++];
					try {
						const node = model.nodes.get(job.name)!;
						this.progress(onProgress, jobsRun, jobsTotal, `Expanding "${job.name}" (level ${job.level + 1})…`);
						const { created } = await this.expand(node, model, onDelta);
						added += created.length;
						for (const child of created) {
							model.nodes.set(child.name, child);
							// Only queue the next level when it is still within
							// the requested depth.
							if (job.level + 1 < targetDepth) {
								next.push({ name: child.name, level: job.level + 1 });
							}
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

	// ---------------------------------------------------------------- 5. Deep dive

	/** Sibling names of a node inside its tree (extra context for the prompt). */
	private siblingNames(node: TreeNode, model: TreeModel): string[] {
		const parent = node.parent ? model.nodes.get(node.parent) : null;
		if (!parent) return [];
		return parent.children.filter((c) => c !== node.name);
	}

	/** Generate the deep-dive Markdown for one node (cached like every prompt). */
	async deepen(
		node: TreeNode,
		model: TreeModel,
		opts: { instruction?: string; refresh?: boolean; onDelta?: (d: string) => void } = {}
	): Promise<string> {
		const s = this.settings();
		const digest = buildBranchDigest(model, node.name, s.askContextMaxNodes, s.askContextMaxChars);
		const prompt = buildDeepenPrompt({
			concept: node.name,
			description: node.description,
			domain: node.domain,
			complexity: node.complexity,
			parent: node.parent,
			children: node.children,
			siblings: this.siblingNames(node, model),
			connections: node.connections.slice(0, 12),
			digest: digest.text,
			instruction: opts.instruction,
		});
		const raw = await this.runPrompt('deepen', prompt.system, prompt.user, opts.onDelta, {
			noCache: !!opts.refresh,
		});
		return sanitizeDeepDive(raw);
	}

	/**
	 * Write deep dives across a subtree (BFS order, bounded concurrency).
	 * `budget` caps how many notes are written in one run; nodes that already
	 * have a deep dive are counted as skipped unless `refresh` is set.
	 */
	async deepenBatch(
		model: TreeModel,
		startName: string,
		opts: {
			budget: number;
			refresh?: boolean;
			onProgress?: ProgressCallback;
			onDelta?: (d: string) => void;
			signal?: AbortSignal;
		}
	): Promise<{ deepened: number; skipped: number; errors: string[] }> {
		if (!model.nodes.has(startName)) {
			throw new ApiError(`Node "${startName}" not found in tree "${model.root}".`);
		}

		// BFS the subtree so shallow, high-value nodes are written first.
		const budget = Math.max(1, opts.budget);
		const queue: string[] = [startName];
		const seen = new Set<string>();
		const targets: TreeNode[] = [];
		let skipped = 0;
		while (queue.length > 0) {
			const name = queue.shift()!;
			if (seen.has(name)) continue;
			seen.add(name);
			const node = model.nodes.get(name);
			if (!node) continue;
			if (!node.deepened || opts.refresh) {
				if (targets.length < budget) targets.push(node);
				else skipped++;
			} else {
				skipped++;
			}
			for (const c of node.children) if (!seen.has(c)) queue.push(c);
		}

		const errors: string[] = [];
		let deepened = 0;
		let done = 0;
		this.progress(opts.onProgress, 0, targets.length, `Writing ${targets.length} deep dive(s)…`);
		await this.runBounded(
			targets,
			3,
			async (node) => {
				try {
					this.progress(opts.onProgress, done, targets.length, `Deep dive: "${node.name}"…`);
					const md = await this.deepen(node, model, {
						onDelta: opts.onDelta,
						refresh: opts.refresh,
					});
					if (!md) throw new ApiError('the model returned no content');
					await this.store.setDeepDive(node, md);
					deepened++;
				} catch (err) {
					errors.push(`${node.name}: ${(err as Error).message}`);
				} finally {
					done++;
					this.progress(opts.onProgress, done, targets.length, `Deep dive: "${node.name}"`);
				}
			},
			opts.signal
		);
		return { deepened, skipped, errors };
	}

	/** Run `worker` over `items` with at most `limit` calls in flight. */
	private async runBounded<T>(
		items: T[],
		limit: number,
		worker: (item: T) => Promise<void>,
		signal?: AbortSignal
	): Promise<void> {
		let idx = 0;
		const run = async () => {
			while (idx < items.length && !signal?.aborted) {
				const item = items[idx++];
				await worker(item);
			}
		};
		await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
	}

	// ---------------------------------------------------------------- 7. Review cards

	/** Generate Q/A cards for one node (JSON prompt, validated and trimmed). */
	async cards(
		node: TreeNode,
		model: TreeModel,
		count: number,
		opts: { noCache?: boolean } = {}
	): Promise<CardDraft[]> {
		const s = this.settings();
		const digest = buildBranchDigest(model, node.name, s.askContextMaxNodes, s.askContextMaxChars);
		const deepDive = await this.store.readDeepDive(node);
		const context = [
			digest.text,
			deepDive ? `Note body (deep dive):\n${deepDive.slice(0, 3000)}` : '',
		]
			.filter(Boolean)
			.join('\n\n');
		const prompt = buildReviewCardsPrompt({
			concept: node.name,
			description: node.description,
			context,
			count,
		});
		const raw = await this.runPrompt('cards', prompt.system, prompt.user, undefined, {
			noCache: !!opts.noCache,
		});
		const parsed = this.parse<{ cards?: CardDraft[] }>(raw, 'review cards');
		return (parsed.cards ?? [])
			.filter((c) => c && String(c.question ?? '').trim() && String(c.answer ?? '').trim())
			.map((c) => ({
				question: String(c.question).trim(),
				answer: String(c.answer).trim(),
				kind: String(c.kind ?? 'recall').trim() || 'recall',
			}))
			.slice(0, Math.max(1, count));
	}

	/**
	 * Generate cards across a subtree (BFS, bounded concurrency). The review
	 * store is saved after every node, so an interrupted run keeps its work.
	 */
	async cardsBatch(
		model: TreeModel,
		startName: string,
		opts: {
			budget: number;
			perNode: number;
			refresh?: boolean;
			onProgress?: ProgressCallback;
		}
	): Promise<{ added: number; skipped: number; nodes: number; errors: string[] }> {
		if (!model.nodes.has(startName)) {
			throw new ApiError(`Node "${startName}" not found in tree "${model.root}".`);
		}
		const data = await this.store.loadReview(model.root);
		const withCards = new Set(Object.values(data.cards).map((c) => c.node));

		const budget = Math.max(1, opts.budget);
		const queue: string[] = [startName];
		const seen = new Set<string>();
		const targets: TreeNode[] = [];
		while (queue.length > 0) {
			const name = queue.shift()!;
			if (seen.has(name)) continue;
			seen.add(name);
			const node = model.nodes.get(name);
			if (!node) continue;
			if (!withCards.has(name) || opts.refresh) {
				if (targets.length < budget) targets.push(node);
			}
			for (const c of node.children) if (!seen.has(c)) queue.push(c);
		}

		const errors: string[] = [];
		let added = 0;
		let skipped = 0;
		let nodes = 0;
		let done = 0;
		this.progress(opts.onProgress, 0, targets.length, `Writing cards for ${targets.length} node(s)…`);
		await this.runBounded(targets, 3, async (node) => {
			try {
				this.progress(opts.onProgress, done, targets.length, `Cards: "${node.name}"…`);
				const drafts = await this.cards(node, model, opts.perNode, { noCache: !!opts.refresh });
				if (drafts.length > 0) {
					const res = addCards(data, node.name, drafts, Date.now(), opts.refresh);
					added += res.added;
					skipped += res.skipped;
					nodes++;
					await this.store.saveReview(data);
				}
			} catch (err) {
				errors.push(`${node.name}: ${(err as Error).message}`);
			} finally {
				done++;
				this.progress(opts.onProgress, done, targets.length, `Cards: "${node.name}"`);
			}
		});
		return { added, skipped, nodes, errors };
	}

	// ---------------------------------------------------------------- 8. Vault cartography

	/**
	 * Ask the model to arrange EXISTING vault notes into a hierarchy. The
	 * `source` values it returns are validated by the caller against the real
	 * note list, so a hallucinated name can never produce a broken reference.
	 */
	async vaultTree(opts: {
		concept: string;
		seed: string;
		seedKind: 'note' | 'tag';
		candidates: VaultTreeCandidate[];
		instruction?: string;
		onDelta?: (d: string) => void;
	}): Promise<DiscoveryResult> {
		const prompt = buildVaultTreePrompt({
			concept: opts.concept,
			seed: opts.seed,
			seedKind: opts.seedKind,
			candidates: opts.candidates,
			instruction: opts.instruction,
		});
		const raw = await this.runPrompt('vault-tree', prompt.system, prompt.user, opts.onDelta);
		const result = this.parse<DiscoveryResult>(raw, 'vault cartography');
		result.concept = result.concept || opts.concept;
		result.domains = (result.domains || []).filter((d) => d && d.name && d.children?.length);
		if (result.domains.length === 0) {
			throw new ApiError(
				'The model did not return a usable hierarchy for these notes. Try another seed.'
			);
		}
		return result;
	}

	// ---------------------------------------------------------------- 9. Follow-up chat

	/**
	 * Non-cached chat completion for the "Ask about this concept" flow.
	 * Follow-up answers depend on the live tree and the conversation history,
	 * so they bypass the response cache (cached generation prompts still hit it).
	 *
	 * The Ask chat starts with a >= 8000-token budget even when the global
	 * `maxTokensPerRequest` is smaller: critique questions over a long branch
	 * digest regularly exhaust a 4000-token budget while the model is still
	 * reasoning, which used to trigger a silent second round-trip and double
	 * the wait. A single, larger call finishes sooner than two calls.
	 */
	async followUpChat(
		messages: ChatMessage[],
		onDelta?: (d: string) => void,
		onRetry?: (nextMaxTokens: number) => void
	): Promise<string> {
		const s = this.settings();
		return this.api.chat(messages, {
			maxTokens: Math.max(s.maxTokensPerRequest, 8000),
			temperature: s.temperature,
			streaming: s.streaming,
			onDelta,
			onRetry,
		});
	}

	static notice(err: unknown): void {
		if (err instanceof ApiError || err instanceof Error) {
			new Notice(err.message, 8000);
		} else {
			new Notice('CogniTree: unexpected error', 8000);
		}
	}
}
