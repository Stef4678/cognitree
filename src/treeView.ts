import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Setting,
	TFile,
	WorkspaceLeaf,
	type TextComponent,
} from 'obsidian';
import type { ConnectionResult, TreeNode, TreeModel } from './types';
import { PROVIDERS, curatedModelsFor, providerFor } from './types';
import { normalizeKey, titleCase } from './parser';
import { ApiError } from './api';
import type CogniTreePlugin from './main';
import { buildJsonSnapshot, buildOutline, buildTreeSvg, computeDepths } from './exporters';
import { AskModal } from './askModal';
import {
	GRADES,
	type Grade,
	type ReviewData,
	addCards,
	dueCardIds,
	gradeCard,
	removeCard,
	reviewStats,
} from './review';
import {
	collectVaultNotes,
	neighborhood,
	notesWithTag,
	sourceMap,
	toCandidates,
	topTags,
	type GraphNote,
} from './vaultGraph';

export const VIEW_TYPE = 'cognitree-view';

const ROW_H = 38;

interface FlatRow {
	name: string;
	depth: number;
	/** True when the row matched the active filter (highlighted / first-jump target). */
	isMatch?: boolean;
}

/**
 * The main CogniTree panel: a virtualized (windowed) tree of concepts.
 * Only the rows inside the viewport are rendered, so tens of thousands of
 * nodes stay fast. Expansion is incremental — one branch at a time — with
 * live progress feedback.
 */
export class ConceptTreeView extends ItemView {
	private model: TreeModel | null = null;
	private rows: FlatRow[] = [];
	private selected: string | null = null;
	private filter = '';
	private trees: string[] = [];
	private scrollTop = 0;
	private rafPending = false;
	private jumpToFirstMatch = false;
	/** True while a generate/batch/connection action is running (re-entrancy guard). */
	private actionInFlight = false;
	/** Review cards due in the open tree (chipped in the stats row). */
	private dueCount = 0;

	private tooltipEl!: HTMLElement;
	private noMatchEl!: HTMLElement;
	private rowEls = new Map<string, HTMLElement>();

	newInputEl!: HTMLInputElement;
	private treeSelectEl!: HTMLSelectElement;
	private providerSelectEl!: HTMLSelectElement;
	private modelSelectEl!: HTMLSelectElement;
	private searchEl!: HTMLInputElement;
	private statsEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private progressBarEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: CogniTreePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'CogniTree';
	}

	getIcon(): string {
		return 'network';
	}

	async onOpen(): Promise<void> {
		this.buildUI();
		await this.refreshTrees();
		const last = this.plugin.data.lastTree;
		if (last) await this.openTree(last);
		else if (this.trees.length > 0) await this.openTree(this.trees[0]);
		this.updateStats();
	}

	/** Rebuild the header provider dropdown to match current settings. */
	syncProviderSelect(): void {
		if (!this.providerSelectEl) return;
		this.providerSelectEl.empty();
		this.providerSelectEl.createEl('option', { text: 'Custom…', value: '__custom__' });
		for (const p of PROVIDERS) {
			this.providerSelectEl.createEl('option', { text: p.name, value: p.id });
		}
		const prov = providerFor(this.plugin.settings.modelEndpoint);
		this.providerSelectEl.value = prov ? prov.id : '__custom__';
	}

	/** Rebuild the header model dropdown to match current settings/data. */
	syncModelSelect(): void {
		if (!this.modelSelectEl) return;
		const current = this.plugin.settings.model;
		const curated = curatedModelsFor(this.plugin.settings.modelEndpoint);
		const fetched = this.plugin.data.models ?? [];
		const ordered: string[] = [];
		if (!curated.includes(current) && !fetched.includes(current)) ordered.push(current);
		for (const m of curated) if (!ordered.includes(m)) ordered.push(m);
		for (const m of fetched) if (!ordered.includes(m)) ordered.push(m);
		this.modelSelectEl.empty();
		for (const m of ordered) {
			this.modelSelectEl.createEl('option', { text: m, value: m });
		}
		this.modelSelectEl.createEl('option', { text: 'Custom…', value: '__custom__' });
		this.modelSelectEl.value = current;
	}

	async onClose(): Promise<void> {
		if (this.rafPending) cancelAnimationFrame(this.rafTimer);
		if (this.tooltipEl) this.tooltipEl.remove();
	}

	private rafTimer = 0;

	// ------------------------------------------------------------- UI build

	private buildUI(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('ct-root');

		// Brand header
		const header = root.createDiv({ cls: 'ct-header' });
		const brand = header.createDiv({ cls: 'ct-brand' });
		brand.createSpan({ cls: 'ct-logo', text: '◈' });
		const brandText = brand.createDiv({ cls: 'ct-brand-text' });
		brandText.createDiv({ cls: 'ct-brand-title', text: 'CogniTree' });
		brandText.createDiv({ cls: 'ct-brand-sub', text: 'AI knowledge trees' });
		const settingsBtn = header.createEl('button', {
			cls: 'ct-icon-btn',
			text: '⚙',
			attr: { title: 'CogniTree settings', 'aria-label': 'CogniTree settings' },
		});
		settingsBtn.addEventListener('click', () => {
			void this.plugin.openSettings();
		});

		// Header right side: provider + model switchers + settings
		const headerRight = header.createDiv({ cls: 'ct-header-right' });
		this.providerSelectEl = headerRight.createEl('select', {
			cls: 'ct-provider-select',
			attr: { title: 'Provider' },
		});
		this.providerSelectEl.addEventListener('change', () => {
			const v = this.providerSelectEl.value;
			if (v === '__custom__') {
				void this.plugin.openSettings();
				return;
			}
			if (v) void this.plugin.applyProvider(v);
		});
		this.modelSelectEl = headerRight.createEl('select', {
			cls: 'ct-model-select',
			attr: { title: 'Generation model' },
		});
		this.modelSelectEl.addEventListener('change', () => {
			const v = this.modelSelectEl.value;
			if (v === '__custom__') {
				void this.plugin.openSettings();
				return;
			}
			if (v && v !== this.plugin.settings.model) {
				this.plugin.settings.model = v;
				void this.plugin.saveSettings();
				new Notice(`Generation model: ${v}`);
			}
		});
		headerRight.appendChild(settingsBtn);
		this.syncProviderSelect();
		this.syncModelSelect();

		// Hero: gradient-framed concept input
		const hero = root.createDiv({ cls: 'ct-hero' });
		const inputWrap = hero.createDiv({ cls: 'ct-input-wrap' });
		this.newInputEl = inputWrap.createEl('input', {
			cls: 'ct-new-input',
			attr: {
				type: 'text',
				placeholder: 'Start any concept — e.g. democracy',
				spellcheck: 'false',
			},
		});
		const genBtn = hero.createEl('button', {
			cls: 'ct-btn ct-btn-primary ct-gen-btn',
			text: 'Generate',
		});
		genBtn.addEventListener('click', () => void this.discoverNew());
		this.newInputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void this.discoverNew();
		});

		// Tree selector
		const selectRow = root.createDiv({ cls: 'ct-select-row' });
		selectRow.createSpan({ cls: 'ct-select-label', text: 'Tree' });
		this.treeSelectEl = selectRow.createEl('select', { cls: 'ct-tree-select' });
		this.treeSelectEl.addEventListener('change', () => {
			if (this.treeSelectEl.value) void this.openTree(this.treeSelectEl.value);
		});

		// Stats chips
		this.statsEl = root.createDiv({ cls: 'ct-stats' });

		// Toolbar
		const toolbar = root.createDiv({ cls: 'ct-toolbar' });
		this.searchEl = toolbar.createEl('input', {
			cls: 'ct-search',
			attr: { type: 'text', placeholder: 'Filter…' },
		});
		this.searchEl.addEventListener('input', () => {
			const next = this.searchEl.value.trim().toLowerCase();
			const changed = next !== this.filter;
			this.filter = next;
			this.jumpToFirstMatch = changed;
			this.debounceRender();
		});
		const batchBtn = toolbar.createEl('button', {
			cls: 'ct-btn',
			text: '⚡ Batch',
			attr: { title: 'Expand a subtree to a depth (uses a node budget)' },
		});
		batchBtn.addEventListener('click', () => void this.batchExpandSelected());
		const expandAllBtn = toolbar.createEl('button', {
			cls: 'ct-btn',
			text: '⛶ Expand all',
			attr: { title: 'Expand every branch to show the full tree' },
		});
		expandAllBtn.addEventListener('click', () => this.expandAll());
		const collapseBtn = toolbar.createEl('button', {
			cls: 'ct-btn',
			text: '⛁ Collapse',
			attr: { title: 'Collapse all branches' },
		});
		collapseBtn.addEventListener('click', () => this.collapseAll());
		const reindexBtn = toolbar.createEl('button', {
			cls: 'ct-btn',
			text: '♺ Index',
			attr: { title: 'Re-index vault note names for "Find connections"' },
		});
		reindexBtn.addEventListener('click', () => void this.plugin.reindexNotes());
		const reviewBtn = toolbar.createEl('button', {
			cls: 'ct-btn',
			text: '🧠 Review',
			attr: { title: 'Study the cards that are due in this tree' },
		});
		reviewBtn.addEventListener('click', () => this.openReview());
		const refreshBtn = toolbar.createEl('button', {
			cls: 'ct-btn',
			text: '↻',
			attr: { title: 'Reload trees from the vault' },
		});
		refreshBtn.addEventListener('click', () => void this.refreshAll());

		// Scrollable virtualized list + empty state
		this.scrollEl = root.createDiv({ cls: 'ct-scroll' });
		this.scrollEl.setAttribute('tabindex', '0');
		this.scrollEl.addEventListener('keydown', (e) => this.onScrollKeydown(e));
		this.viewportEl = this.scrollEl.createDiv({ cls: 'ct-viewport' });
		this.emptyEl = this.scrollEl.createDiv({ cls: 'ct-empty' });
		this.emptyEl.addClass('ct-hidden');
		this.noMatchEl = this.scrollEl.createDiv({ cls: 'ct-no-match' });
		this.buildEmptyState();
		this.scrollEl.addEventListener('scroll', () => {
			this.scrollTop = this.scrollEl.scrollTop;
			this.hideTooltip();
			this.schedulePaint();
		});

		// Hover preview tooltip (fixed to the viewport, escaped from ct-root's overflow).
		this.tooltipEl = document.body.createDiv({ cls: 'ct-tooltip' });

		// Status bar with progress
		const status = root.createDiv({ cls: 'ct-status' });
		this.statusTextEl = status.createSpan({ cls: 'ct-status-text' });
		this.progressEl = status.createDiv({ cls: 'ct-progress' });
		this.progressBarEl = this.progressEl.createDiv({ cls: 'ct-progress-bar' });
		this.progressEl.addClass('ct-hidden');
	}

	/** Empty-state hero with clickable example concepts. */
	private buildEmptyState(): void {
		this.emptyEl.empty();
		this.emptyEl.createDiv({ cls: 'ct-empty-orb', text: '◈' });
		this.emptyEl.createDiv({ cls: 'ct-empty-title', text: 'Grow a knowledge tree' });
		this.emptyEl.createDiv({
			cls: 'ct-empty-desc',
			text: 'Enter any concept above — or start with one of these — and CogniTree will branch it into a deep, interconnected web of notes.',
		});
		const suggest = this.emptyEl.createDiv({ cls: 'ct-suggest' });
		const examples = [
			'democracy',
			'consciousness',
			'economics',
			'climate change',
			'quantum computing',
			'music theory',
		];
		for (const ex of examples) {
			const chip = suggest.createEl('button', { cls: 'ct-suggest-chip', text: ex });
			chip.addEventListener('click', () => {
				this.newInputEl.value = ex;
				this.newInputEl.focus();
				void this.discoverNew();
			});
		}
		this.emptyEl.createDiv({
			cls: 'ct-empty-hint',
			text: this.needsApiKey()
				? 'Tip: add your API key via ⚙ in the header first.'
				: 'Each branch costs one API call — results are cached.',
		});
	}

	/**
	 * True when the configured endpoint needs a key we don't have. Local
	 * providers (Ollama, LM Studio) are `keyRequired: false`, so they must not
	 * be blocked by the Generate guard.
	 */
	private needsApiKey(): boolean {
		const provider = providerFor(this.plugin.settings.modelEndpoint);
		return provider?.keyRequired !== false && !this.plugin.settings.apiKey.trim();
	}

	/**
	 * Long-running actions (generate / batch / connections) must not overlap:
	 * a double-pressed Generate would issue two API calls and race on note
	 * creation. Returns false when an action is already running.
	 */
	private beginAction(): boolean {
		if (this.actionInFlight) {
			new Notice('CogniTree is already working — wait for the current action to finish.', 4000);
			return false;
		}
		this.actionInFlight = true;
		return true;
	}

	private endAction(): void {
		this.actionInFlight = false;
	}

	private debounceTimer = 0;
	private debounceRender(): void {
		window.clearTimeout(this.debounceTimer);
		this.debounceTimer = window.setTimeout(() => this.render(), 120);
	}

	// ------------------------------------------------------------- trees

	async refreshTrees(): Promise<void> {
		this.trees = await this.plugin.store.listTrees();
		const prev = this.treeSelectEl.value;
		this.treeSelectEl.empty();
		if (this.trees.length === 0) {
			this.treeSelectEl.createEl('option', { text: 'No trees yet', value: '' });
		}
		for (const t of this.trees) {
			this.treeSelectEl.createEl('option', { text: t, value: t });
		}
		if (prev && this.trees.includes(prev)) this.treeSelectEl.value = prev;
		else if (this.model) this.treeSelectEl.value = this.model.root;
	}

	async openTree(rootName: string): Promise<void> {
		this.setStatus(`Loading tree "${rootName}"…`);
		const model = await this.plugin.store.loadTree(rootName);
		if (!model) {
			this.setStatus('');
			new Notice(`No tree named "${rootName}".`);
			return;
		}
		this.model = model;
		this.selected = null;
		this.filter = '';
		if (this.searchEl) this.searchEl.value = '';
		this.treeSelectEl.value = rootName;
		this.plugin.data.lastTree = rootName;
		await this.plugin.saveDataQuiet();
		this.autoExpand(model);
		this.render();
		this.setStatus('');
		void this.refreshDueCount();
	}

	/** Expand existing branches up to autoExpandDepth without API calls. */
	private autoExpand(model: TreeModel): void {
		const depth = this.plugin.settings.autoExpandDepth;
		if (depth <= 0) return;
		const seen = new Set<string>();
		const walk = (name: string, level: number) => {
			if (seen.has(name)) return; // cycle-safe
			seen.add(name);
			const node = model.nodes.get(name);
			if (!node || level > depth) return;
			if (node.children.length > 0) {
				node.expanded = true;
				for (const c of node.children) walk(c, level + 1);
			}
		};
		walk(model.root, 1);
	}

	async refreshAll(): Promise<void> {
		await this.refreshTrees();
		if (this.model) {
			const reloaded = await this.plugin.store.loadTree(this.model.root);
			if (reloaded) {
				// Preserve expanded state by name.
				const expandedBefore = new Set(
					[...(this.model?.nodes.values() ?? [])].filter((n) => n.expanded).map((n) => n.name)
				);
				this.model = reloaded;
				for (const n of this.model.nodes.values()) {
					if (expandedBefore.has(n.name)) n.expanded = true;
				}
			}
		}
		this.render();
	}

	// ------------------------------------------------------------- discovery

	async discoverNew(): Promise<void> {
		const concept = this.newInputEl.value.trim();
		if (!concept) {
			new Notice('Enter a concept first.');
			return;
		}
		await this.refreshTrees();
		const existing = this.trees.find((t) => t.toLowerCase() === concept.toLowerCase());
		if (existing) {
			new Notice(`Tree "${existing}" already exists — opening it.`);
			await this.openTree(existing);
			return;
		}
		if (this.needsApiKey()) {
			new Notice('Set your API key in CogniTree settings first (⚙ in the header).', 6000);
			return;
		}
		if (!this.beginAction()) return;
		this.setBusy(true, `Discovering "${concept}"…`);
		try {
			const result = await this.plugin.generator.discover(concept, (d) =>
				this.setBusy(true, `Discovering "${concept}"… ${d.slice(-40)}`)
			);
			this.setBusy(true, `Writing ${result.total_nodes ?? '…'} nodes to the vault…`);
			const { root, created, skipped } = await this.plugin.store.createDiscoveryTree(
				result,
				this.plugin.settings.treeFolder
			);
			await this.refreshTrees();
			await this.openTree(root);
			new Notice(
				`Created tree "${root}" with ${created.length} nodes` +
					(skipped.length ? ` (${skipped.length} duplicates skipped)` : '') +
					`. Suggested start: ${result.suggested_starting_branch ?? '—'}`,
				6000
			);
		} catch (err) {
			this.handleError(err, `Discovery of "${concept}"`);
		} finally {
			this.setBusy(false);
			this.endAction();
		}
	}

	// ------------------------------------------------------------- expansion

	private async expandNode(name: string): Promise<void> {
		const node = this.model?.nodes.get(name);
		if (!node || !this.model) return;
		if (node.loading) return;
		if (node.children.length > 0) {
			node.expanded = !node.expanded;
			this.render();
			return;
		}
		node.loading = true;
		this.render();
		try {
			const { created, skipped } = await this.plugin.generator.expand(
				node,
				this.model,
				(d) => this.setBusy(true, `Expanding "${name}"… ${d.slice(-40)}`)
			);
			for (const child of created) {
				this.model.nodes.set(child.name, child);
			}
			node.expanded = true;
			new Notice(
				`Expanded "${name}": +${created.length} nodes` +
					(skipped.length ? ` (${skipped.length} duplicates skipped)` : ''),
				4000
			);
		} catch (err) {
			this.handleError(err, `Expansion of "${name}"`);
		} finally {
			node.loading = false;
			this.render();
		}
	}

	private toggleExpand(name: string): void {
		const node = this.model?.nodes.get(name);
		if (!node) return;
		if (node.children.length > 0) {
			node.expanded = !node.expanded;
			this.render();
		}
	}

	private collapseAll(): void {
		if (!this.model) return;
		for (const n of this.model.nodes.values()) n.expanded = false;
		this.model.nodes.get(this.model.root)!.expanded = true;
		this.render();
	}

	/** Expand every branch so the whole tree is visible (UI only — no API calls). */
	private expandAll(): void {
		if (!this.model) return;
		for (const n of this.model.nodes.values()) {
			if (n.children.length > 0) n.expanded = true;
		}
		this.render();
	}

	/** Expand every branch under a node — reveals freshly batch-generated nodes. */
	private expandSubtree(name: string): void {
		if (!this.model) return;
		const seen = new Set<string>();
		const visit = (n: string) => {
			if (seen.has(n)) return; // cycle-safe
			seen.add(n);
			const node = this.model!.nodes.get(n);
			if (!node || node.children.length === 0) return;
			node.expanded = true;
			for (const c of node.children) visit(c);
		};
		visit(name);
	}

	private async batchExpandSelected(): Promise<void> {
		if (!this.model) {
			new Notice('Open a tree first.');
			return;
		}
		const target = this.selected ?? this.model.root;
		const node = this.model.nodes.get(target);
		if (!node) return;
		const modal = new BatchModal(
			this.app,
			{
				depth: Math.min(this.plugin.settings.maxDepth, 5),
				budget: this.plugin.settings.maxNodesPerBatch,
				rootName: this.model.root,
				nodeName: node.name,
			},
			(opts) => {
				modal.close();
				void this.runBatch(node.name, opts.depth, opts.budget);
			}
		);
		modal.open();
	}

	private async runBatch(name: string, depth: number, budget: number): Promise<void> {
		if (!this.model) return;
		if (!this.beginAction()) return;
		this.setBusy(true, `Batch expanding "${name}" to depth ${depth}…`);
		try {
			const { added, errors } = await this.plugin.generator.batch(
				this.model.root,
				depth,
				budget,
				(info) => {
					this.setBusy(true, `${info.label} — ${info.done}/${info.total} requests`);
					this.setProgress(info.done, info.total);
				},
				(d) => this.setBusy(true, `Batch expanding "${name}"… ${d.slice(-40)}`),
				undefined,
				name
			);
			const expandedBefore = new Set(
				[...(this.model.nodes.values())].filter((n) => n.expanded).map((n) => n.name)
			);
			const reloaded = await this.plugin.store.loadTree(this.model.root);
			if (reloaded) {
				this.model = reloaded;
				// Reloading builds a fresh model with every node collapsed; restore
				// the prior expansion state so a batch run doesn't flatten the tree.
				for (const n of this.model.nodes.values()) {
					if (expandedBefore.has(n.name)) n.expanded = true;
				}
			}
			this.expandSubtree(name);
			this.selected = name;
			this.render();
			const msg = `Batch complete: +${added} nodes`;
			new Notice(errors.length ? `${msg}, ${errors.length} errors` : msg, 5000);
			if (errors.length > 0) {
				console.warn('CogniTree batch errors:', errors);
			}
		} catch (err) {
			this.handleError(err, `Batch expansion of "${name}"`);
		} finally {
			this.setBusy(false);
			this.setProgress(0, 0);
			this.endAction();
		}
	}

	// ------------------------------------------------------------- follow-up (Ask)

	/** True when a tree is open — lets palette commands enable/disable. */
	hasTree(): boolean {
		return !!this.model;
	}

	/** Open the grounded Ask chat for a node (default: selection, then root). */
	openAsk(name?: string): void {
		if (!this.model) {
			new Notice('Open a tree first.');
			return;
		}
		const target = name ?? this.selected ?? this.model.root;
		const node = this.model.nodes.get(target);
		if (!node) return;
		new AskModal(this.app, this.plugin, this.model, node).open();
	}

	/** Palette-command entry: ask about the current selection (or tree root). */
	askAboutSelected(): boolean {
		if (!this.model) return false;
		const target = this.selected ?? this.model.root;
		if (!this.model.nodes.has(target)) return false;
		this.openAsk(target);
		return true;
	}

	// ------------------------------------------------------------- connections

	private async findConnections(name: string): Promise<void> {
		const node = this.model?.nodes.get(name);
		if (!node) return;
		if (!this.beginAction()) return;
		this.setBusy(true, `Analyzing connections for "${name}"…`);
		try {
			const result = await this.plugin.generator.connections(node, (d) =>
				this.setBusy(true, `Analyzing connections for "${name}"… ${d.slice(-40)}`)
			);
			if (!result) {
				new Notice('No connection suggestions returned.');
				return;
			}
			new ConnectionsModal(this.app, this.plugin, node, result).open();
		} catch (err) {
			this.handleError(err, `Connection discovery for "${name}"`);
		} finally {
			this.setBusy(false);
			this.endAction();
		}
	}

	// ------------------------------------------------------------- deep dive

	/**
	 * Write (or refresh) one node's deep dive. Regenerating replaces whatever is
	 * in the note's `## Deep dive` region, so an existing one is only replaced
	 * after the caller confirms (`refresh`).
	 */
	private async deepenNode(name: string, refresh = false): Promise<void> {
		const node = this.model?.nodes.get(name);
		if (!node || !this.model) return;
		if (node.loading) return;
		if (node.deepened && refresh) {
			const ok = await confirmDialog(
				this.app,
				`Replace the existing deep dive of "${name}"? Hand edits inside it will be lost.`,
				'Replace'
			);
			if (!ok) return;
		}
		if (!this.beginAction()) return;
		node.loading = true;
		this.setBusy(true, `Writing deep dive for "${name}"…`);
		this.render();
		try {
			const md = await this.plugin.generator.deepen(node, this.model, {
				onDelta: (d) =>
					this.setBusy(true, `Writing deep dive for "${name}"… ${d.slice(-40)}`),
				// Replacing an existing deep dive must ask the model, not replay
				// a cached answer for the same prompt.
				refresh: !!node.deepened,
			});
			if (!md) throw new ApiError('The model returned no content for the deep dive.');
			await this.plugin.store.setDeepDive(node, md);
			new Notice(`Deep dive written for "${name}" (${md.length} chars).`, 4000);
		} catch (err) {
			this.handleError(err, `Deep dive for "${name}"`);
		} finally {
			node.loading = false;
			this.setBusy(false);
			this.endAction();
			this.render();
		}
	}

	/** Drop a node's generated deep dive from its note. */
	private async removeDeepDive(name: string): Promise<void> {
		const node = this.model?.nodes.get(name);
		if (!node) return;
		try {
			await this.plugin.store.setDeepDive(node, null);
			new Notice(`Deep dive removed from "${name}".`, 4000);
			this.render();
		} catch (err) {
			this.handleError(err, `Removing the deep dive of "${name}"`);
		}
	}

	/** Ask for a node budget, then write deep dives across the selected subtree. */
	private deepenSubtreeDialog(): void {
		if (!this.model) {
			new Notice('Open a tree first.');
			return;
		}
		const target = this.selected ?? this.model.root;
		const node = this.model.nodes.get(target);
		if (!node) return;
		const subtree = this.plugin.store.collectSubtree(this.model, target);
		const missing = subtree.filter((n) => !n.deepened).length;
		const modal = new DeepenModal(
			this.app,
			{
				nodeName: node.name,
				subtreeSize: subtree.length,
				missing,
				budget: Math.min(Math.max(missing, 1), this.plugin.settings.maxNodesPerBatch),
			},
			(opts) => {
				modal.close();
				void this.runDeepenBatch(node.name, opts.budget, opts.refresh);
			}
		);
		modal.open();
	}

	private async runDeepenBatch(name: string, budget: number, refresh: boolean): Promise<void> {
		if (!this.model) return;
		if (!this.beginAction()) return;
		this.setBusy(true, `Writing deep dives under "${name}"…`);
		try {
			const { deepened, skipped, errors } = await this.plugin.generator.deepenBatch(
				this.model,
				name,
				{
					budget,
					refresh,
					onProgress: (info) => {
						this.setBusy(true, `${info.label} — ${info.done}/${info.total}`);
						this.setProgress(info.done, info.total);
					},
					onDelta: (d) => this.setBusy(true, `Deep dive under "${name}"… ${d.slice(-40)}`),
				}
			);
			new Notice(
				`Deep dives: ${deepened} written` +
					(skipped ? `, ${skipped} skipped` : '') +
					(errors.length ? `, ${errors.length} failed` : '') +
					'.',
				6000
			);
			if (errors.length > 0) console.warn('CogniTree deep-dive errors:', errors);
			this.render();
		} catch (err) {
			this.handleError(err, `Deep dives under "${name}"`);
		} finally {
			this.setBusy(false);
			this.setProgress(0, 0);
			this.endAction();
			this.render();
		}
	}

	// ------------------------------------------------------------- review (SRS)

	/** Generate cards for one node and merge them into the tree's review store. */
	private async generateCards(name: string): Promise<void> {
		const node = this.model?.nodes.get(name);
		if (!node || !this.model) return;
		if (!this.beginAction()) return;
		this.setBusy(true, `Writing review cards for "${name}"…`);
		try {
			const drafts = await this.plugin.generator.cards(
				node,
				this.model,
				this.plugin.settings.reviewCardsPerNode
			);
			if (drafts.length === 0) throw new ApiError('The model returned no usable cards.');
			const data = await this.plugin.store.loadReview(this.model.root);
			const { added, skipped } = addCards(data, node.name, drafts, Date.now(), true);
			await this.plugin.store.saveReview(data);
			new Notice(
				`Review cards for "${name}": +${added}` +
					(skipped ? ` (${skipped} duplicate skipped)` : '') +
					'.',
				5000
			);
			await this.refreshDueCount();
		} catch (err) {
			this.handleError(err, `Review cards for "${name}"`);
		} finally {
			this.setBusy(false);
			this.endAction();
		}
	}

	/** Generate cards for every node of the selected subtree that has none. */
	private async generateCardsSubtree(): Promise<void> {
		if (!this.model) {
			new Notice('Open a tree first.');
			return;
		}
		const target = this.selected ?? this.model.root;
		const subtree = this.plugin.store.collectSubtree(this.model, target);
		const budget = Math.min(this.plugin.settings.maxNodesPerBatch, subtree.length);
		const ok = await confirmDialog(
			this.app,
			`Generate review cards for up to ${budget} node(s) under "${target}"? One cached API call per node.`,
			'Generate'
		);
		if (!ok) return;
		if (!this.beginAction()) return;
		this.setBusy(true, `Writing review cards under "${target}"…`);
		try {
			const res = await this.plugin.generator.cardsBatch(this.model, target, {
				budget,
				perNode: this.plugin.settings.reviewCardsPerNode,
				onProgress: (info) => {
					this.setBusy(true, `${info.label} — ${info.done}/${info.total}`);
					this.setProgress(info.done, info.total);
				},
			});
			new Notice(
				`Review cards: +${res.added} across ${res.nodes} node(s)` +
					(res.skipped ? `, ${res.skipped} skipped` : '') +
					(res.errors.length ? `, ${res.errors.length} failed` : '') +
					'.',
				6000
			);
			if (res.errors.length > 0) console.warn('CogniTree card errors:', res.errors);
			await this.refreshDueCount();
		} catch (err) {
			this.handleError(err, `Review cards under "${target}"`);
		} finally {
			this.setBusy(false);
			this.setProgress(0, 0);
			this.endAction();
		}
	}

	/** Open a study session over the due cards of the open tree (or one subtree). */
	openReview(scopeNode?: string): void {
		if (!this.model) {
			new Notice('Open a tree first.');
			return;
		}
		void (async () => {
			const model = this.model!;
			const data = await this.plugin.store.loadReview(model.root);
			const stats = reviewStats(data, Date.now());
			if (stats.total === 0) {
				new Notice(
					'No review cards in this tree yet — right-click a node → "Create review cards".',
					6000
				);
				return;
			}
			const scope = scopeNode
				? new Set(this.plugin.store.collectSubtree(model, scopeNode).map((n) => n.name))
				: undefined;
			const scoped = reviewStats(data, Date.now(), scope);
			if (scoped.due === 0) {
				new Notice(
					`Nothing due${scopeNode ? ` under "${scopeNode}"` : ''} — ${scoped.total} card(s) scheduled later.`,
					5000
				);
				return;
			}
			new ReviewModal(this.app, this.plugin, model.root, data, scope, () => {
				void this.refreshDueCount();
			}).open();
		})();
	}

	/** Keep the "due" chip in sync with the review store. */
	private async refreshDueCount(): Promise<void> {
		const root = this.model?.root;
		if (!root) {
			this.dueCount = 0;
			this.updateStats();
			return;
		}
		try {
			const data = await this.plugin.store.loadReview(root);
			if (this.model?.root !== root) return; // another tree was opened meanwhile
			this.dueCount = reviewStats(data, Date.now()).due;
		} catch {
			if (this.model?.root !== root) return;
			this.dueCount = 0;
		}
		this.updateStats();
	}

	// ------------------------------------------------------------- vault cartography

	/** Pick a seed (open note or one of the vault's tags) and grow a tree from it. */
	openVaultTreeDialog(): void {
		const graph = collectVaultNotes(this.app, { excludeFolder: this.plugin.settings.treeFolder });
		if (graph.length === 0) {
			new Notice('No vault notes found outside the tree folder.', 5000);
			return;
		}
		const active = this.app.workspace.getActiveFile();
		new VaultTreeModal(
			this.app,
			{
				activeName: active?.basename ?? null,
				activePath: active?.path ?? null,
				tags: topTags(graph, 20),
				maxNotes: this.plugin.settings.vaultTreeMaxNotes,
			},
			(choice) => void this.runVaultTree(choice, graph)
		).open();
	}

	private async runVaultTree(choice: VaultTreeChoice, graph: GraphNote[]): Promise<void> {
		// Growing into an existing tree folder would silently mix two trees
		// (and shadow duplicate concept names) — check before spending a call.
		if (await this.plugin.store.treeExists(choice.concept)) {
			new Notice(
				`A tree named "${choice.concept}" already exists — pick another name.`,
				8000
			);
			return;
		}
		if (!this.beginAction()) return;
		const label = choice.seedKind === 'tag' ? `#${choice.seed}` : `"${choice.seed}"`;
		this.setBusy(true, `Reading your vault around ${label}…`);
		try {
			const candidates =
				choice.seedKind === 'tag'
					? notesWithTag(graph, choice.seed, choice.maxNotes)
					: neighborhood(graph, choice.seedPath ?? '', 2, choice.maxNotes + 1).filter(
							(n) => n.path !== choice.seedPath
					  );
			if (candidates.length === 0) {
				throw new ApiError(`No notes related to ${label} were found to organise.`);
			}
			this.setBusy(true, `Arranging ${candidates.length} of your notes…`);
			const result = await this.plugin.generator.vaultTree({
				concept: choice.concept,
				seed: choice.seed,
				seedKind: choice.seedKind,
				candidates: toCandidates(candidates.slice(0, choice.maxNotes)),
				onDelta: (d) => this.setBusy(true, `Arranging your notes… ${d.slice(-40)}`),
			});
			this.setBusy(true, `Writing the tree…`);
			const { root, created, linked, skipped } = await this.plugin.store.createVaultTree(
				result,
				this.plugin.settings.treeFolder,
				sourceMap(candidates),
				choice.seedKind === 'note' ? choice.seedPath : undefined,
				choice.concept
			);
			await this.refreshTrees();
			await this.openTree(root);
			new Notice(
				`Tree "${root}": ${created.length} node(s), ${linked} linked to your own notes` +
					(skipped.length ? `, ${skipped.length} duplicates skipped` : '') +
					'.',
				8000
			);
		} catch (err) {
			this.handleError(err, 'Growing a tree from your vault');
		} finally {
			this.setBusy(false);
			this.endAction();
		}
	}

	// ------------------------------------------------------------- selection & menu

	private select(name: string): void {
		this.selected = name;
		this.paint();
	}

	private showContextMenu(e: MouseEvent, name: string): void {
		const node = this.model?.nodes.get(name);
		if (!node) return;
		this.selected = name;
		this.paint();
		const menu = new Menu();
		if (node.children.length > 0) {
			menu.addItem((item) =>
				item
					.setTitle(node.expanded ? 'Collapse' : 'Expand')
					.setIcon(node.expanded ? 'chevrons-down-up' : 'chevrons-up-down')
					.onClick(() => this.toggleExpand(name))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle('Expand with AI')
				.setIcon('sparkles')
				.onClick(() => void this.expandNode(name))
		);
		menu.addItem((item) =>
			item
				.setTitle('Ask about this concept')
				.setIcon('message-circle')
				.onClick(() => this.openAsk(name))
		);
		menu.addItem((item) =>
			item
				.setTitle('Find connections')
				.setIcon('link')
				.onClick(() => void this.findConnections(name))
		);
		menu.addItem((item) =>
			item
				.setTitle('Find connections in subtree')
				.setIcon('link-2')
				.onClick(() => void this.batchConnections(name))
		);
		menu.addItem((item) =>
			item
				.setTitle('Batch expand subtree')
				.setIcon('wand-2')
				.onClick(() => void this.batchExpandSelected())
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(node.deepened ? 'Refresh deep dive' : 'Write deep dive')
				.setIcon('book-open')
				.onClick(() => void this.deepenNode(name, true))
		);
		if (node.deepened) {
			menu.addItem((item) =>
				item
					.setTitle('Remove deep dive')
					.setIcon('eraser')
					.onClick(() => void this.removeDeepDive(name))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle('Deep dive subtree…')
				.setIcon('layers')
				.onClick(() => this.deepenSubtreeDialog())
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Create review cards')
				.setIcon('brain')
				.onClick(() => void this.generateCards(name))
		);
		menu.addItem((item) =>
			item
				.setTitle('Create review cards for subtree')
				.setIcon('layers')
				.onClick(() => void this.generateCardsSubtree())
		);
		menu.addItem((item) =>
			item
				.setTitle('Review this subtree')
				.setIcon('graduation-cap')
				.onClick(() => this.openReview(name))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Copy [[link]]')
				.setIcon('link')
				.onClick(() => this.copyToClipboard(`[[${node.name}]]`, 'Link'))
		);
		menu.addItem((item) =>
			item
				.setTitle('Copy note path')
				.setIcon('file-text')
				.onClick(() => this.copyToClipboard(node.file, 'Path'))
		);
		menu.addItem((item) =>
			item
				.setTitle(node.source ? 'Open source note' : 'Open note')
				.setIcon('book-open')
				.onClick(() => void this.plugin.store.openNote(node))
		);
		menu.addItem((item) =>
			item
				.setTitle('Delete node + descendants')
				.setIcon('trash')
				.onClick(() => void this.confirmDelete(name))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Tree stats & health')
				.setIcon('bar-chart')
				.onClick(() => this.openStats())
		);
		menu.addItem((item) =>
			item
				.setTitle('Find duplicates across trees')
				.setIcon('copy-plus')
				.onClick(() => void this.findDuplicates())
		);
		menu.addItem((item) =>
			item
				.setTitle('Grow a tree from your vault…')
				.setIcon('git-branch-plus')
				.onClick(() => this.openVaultTreeDialog())
		);
		menu.addItem((item) =>
			item
				.setTitle('Export tree…')
				.setIcon('download')
				.onClick(() => this.openExport())
		);
		menu.showAtMouseEvent(e);
	}

	private async confirmDelete(name: string): Promise<void> {
		if (!this.model) return;
		const node = this.model.nodes.get(name);
		if (!node) return;
		const parentName = node.parent;
		const subtreeNodes = this.plugin.store.collectSubtree(this.model, name);
		const count = subtreeNodes.length;
		const references = subtreeNodes.filter((n) => n.source).length;
		new ConfirmModal(
			this.app,
			`Delete "${name}" and ${count - 1} descendant note${count > 2 ? 's' : ''} from the vault?` +
				(references > 0
					? ` ${references} of them only link to notes you own — those source notes are not touched.`
					: ''),
			async () => {
				// Capture the subtree contents so the delete can be undone.
				const snap: { name: string; file: string; content: string }[] = [];
				for (const sub of this.plugin.store.collectSubtree(this.model!, name)) {
					try {
						const fileRef = this.app.vault.getAbstractFileByPath(sub.file);
						if (fileRef instanceof TFile) {
							snap.push({
								name: sub.name,
								file: sub.file,
								content: await this.app.vault.cachedRead(fileRef),
							});
						}
					} catch {
						// Skip notes that can't be read; they can't be restored either.
					}
				}
				const deleted = await this.plugin.store.deleteSubtree(this.model!, name);
				if (this.selected === name) this.selected = null;
				this.render();
				// Notice.addButton exists at runtime (Obsidian ≥ 1.1) but is missing
				// from the pinned obsidian typings, so it is reached through a cast.
				(
					new Notice(`Deleted ${deleted} note${deleted > 1 ? 's' : ''}.`, 6000) as unknown as {
						addButton(b: { text: string; onClick: () => void }): void;
					}
				).addButton({
					text: 'Undo',
					onClick: () => void this.restoreSubtree(name, parentName, snap),
				});
			}
		).open();
	}

	/** Recreate notes captured before a subtree deletion (the view's Undo). */
	private async restoreSubtree(
		name: string,
		parentName: string | null,
		snap: { name: string; file: string; content: string }[]
	): Promise<void> {
		try {
			let restored = 0;
			for (const s of snap) {
				const existing = this.app.vault.getAbstractFileByPath(s.file);
				if (existing instanceof TFile) continue;
				await this.app.vault.create(s.file, s.content);
				restored++;
			}
			if (restored > 0) {
				// deleteSubtree dropped the node from its parent's `children`, so
				// without re-linking it the restored notes would exist on disk but
				// stay unreachable (and invisible) in the tree.
				if (parentName && this.model) {
					await this.plugin.store.relinkChild(this.model, parentName, name);
				}
				await this.refreshAll();
			}
			new Notice(`Restored ${restored} note${restored === 1 ? '' : 's'}.`, 5000);
		} catch (err) {
			this.handleError(err, `Undo delete of "${name}"`);
		}
	}

	// ------------------------------------------------------------- rendering

	private flatten(): void {
		const out: FlatRow[] = [];
		if (!this.model) {
			this.rows = out;
			return;
		}
		if (this.filter) {
			// Filtered view: emit matching nodes AND their ancestor chain, so the
			// hierarchy stays readable even when matches are deep in the tree.
			const include = new Set<string>();
			const collected = new Set<string>();
			const collect = (name: string, path: string[]) => {
				if (collected.has(name)) return; // cycle-safe
				collected.add(name);
				const node = this.model!.nodes.get(name);
				if (!node) return;
				if (node.name.toLowerCase().includes(this.filter)) {
					for (const a of path) include.add(a);
					include.add(name);
				}
				for (const c of node.children) collect(c, [...path, name]);
			};
			collect(this.model.root, []);
			const emitted = new Set<string>();
			const emit = (name: string, depth: number) => {
				if (emitted.has(name)) return; // cycle-safe
				emitted.add(name);
				const node = this.model!.nodes.get(name);
				if (!node || !include.has(name)) return;
				out.push({
					name,
					depth,
					isMatch: node.name.toLowerCase().includes(this.filter),
				});
				for (const c of node.children) emit(c, depth + 1);
			};
			emit(this.model.root, 0);
		} else {
			const visited = new Set<string>();
			const visit = (name: string, depth: number) => {
				if (visited.has(name)) return; // cycle-safe
				visited.add(name);
				const node = this.model!.nodes.get(name);
				if (!node) return;
				out.push({ name, depth });
				if (node.expanded && node.children.length > 0) {
					for (const c of node.children) visit(c, depth + 1);
				}
			};
			visit(this.model.root, 0);
		}
		this.rows = out;
	}

	render(): void {
		if (!this.model) {
			this.emptyEl.toggleClass('ct-hidden', false);
			this.viewportEl.toggleClass('ct-hidden', true);
			this.noMatchEl.toggleClass('ct-visible', false);
			this.rows = [];
			this.updateStats();
			return;
		}
		this.emptyEl.toggleClass('ct-hidden', true);
		this.viewportEl.toggleClass('ct-hidden', false);
		this.flatten();
		// New filter query: jump straight to the first matching row.
		if (this.jumpToFirstMatch) {
			this.jumpToFirstMatch = false;
			const fm = this.rows.findIndex((r) => r.isMatch);
			if (fm >= 0) {
				this.scrollTop = fm * ROW_H;
				this.scrollEl.scrollTop = this.scrollTop;
			}
		}
		// "No matches" hint instead of a blank area.
		const showNoMatch = this.filter.length > 0 && this.rows.length === 0;
		this.noMatchEl.toggleClass('ct-visible', showNoMatch);
		if (showNoMatch) {
			this.noMatchEl.empty();
			this.noMatchEl.createEl('b', { text: 'No matching nodes' });
			this.noMatchEl.createSpan({ text: `No concept in this tree contains "${this.filter}".` });
		}
		this.updateStats();
		const total = this.rows.length;
		this.viewportEl.style.height = `${total * ROW_H}px`;
		this.paint();
	}

	/** Refresh only the stats chips (e.g. after a manual reindex). */
	refreshStats(): void {
		this.updateStats();
	}

	private updateStats(): void {
		if (!this.statsEl) return;
		this.statsEl.empty();
		let nodes = 0;
		let maxDepth = 0;
		if (this.model) {
			nodes = this.model.nodes.size;
			// Real BFS depth (root = 1) — the stored `path` contains the domain
			// slug, so splitting it overstates the tree.
			for (const d of computeDepths(this.model).values()) {
				if (d + 1 > maxDepth) maxDepth = d + 1;
			}
		}
		const chip = (label: string, value?: string, dot = false) => {
			const c = this.statsEl.createSpan({ cls: 'ct-chip' });
			if (dot) c.createSpan({ cls: 'ct-chip-dot' });
			if (value) c.createEl('b', { text: value });
			c.createSpan({ text: label });
		};
		if (this.model) {
			chip('nodes', String(nodes), true);
			chip('depth', String(maxDepth));
			chip(this.trees.length === 1 ? 'tree' : 'trees', String(this.trees.length));
			chip('notes indexed', String(this.plugin.indexer.noteCount));
			if (this.plugin.semantic?.enabled) chip('vectors', String(this.plugin.semantic.size));
			if (this.dueCount > 0) chip('cards due', String(this.dueCount), true);
		} else {
			chip(this.trees.length === 1 ? 'tree' : 'trees', String(this.trees.length));
			chip('notes indexed', String(this.plugin.indexer.noteCount));
			if (this.plugin.semantic?.enabled) chip('vectors', String(this.plugin.semantic.size));
		}
	}

	private schedulePaint(): void {
		if (this.rafPending) return;
		this.rafPending = true;
		this.rafTimer = window.requestAnimationFrame(() => {
			this.rafPending = false;
			this.paint();
		});
	}

	private paint(): void {
		const virtualize = this.plugin.settings.virtualizeRendering;
		const total = this.rows.length;
		let start = 0;
		let end = total;
		if (virtualize) {
			const vh = this.scrollEl.clientHeight || 400;
			start = Math.max(0, Math.floor(this.scrollTop / ROW_H) - 8);
			end = Math.min(total, Math.ceil((this.scrollTop + vh) / ROW_H) + 8);
		}
		const frag = createFragment();
		this.rowEls.clear();
		for (let i = start; i < end; i++) {
			frag.appendChild(this.buildRow(i));
		}
		this.viewportEl.empty();
		this.viewportEl.appendChild(frag);
	}

	private buildRow(idx: number): HTMLElement {
		const { name, depth } = this.rows[idx];
		const node = this.model!.nodes.get(name);
		const row = createDiv({
			cls:
				'ct-row' +
				(this.selected === name ? ' ct-selected' : '') +
				(node?.loading ? ' ct-loading' : ''),
		});
		row.style.top = `${idx * ROW_H}px`;
		row.style.paddingLeft = `${10 + depth * 16}px`;
		this.rowEls.set(name, row);

		const hasKids = !!node && node.children.length > 0;
		const caret = row.createSpan({
			cls:
				'ct-caret' +
				(hasKids ? '' : ' ct-caret-empty') +
				(node?.expanded ? ' ct-caret-open' : ''),
			text: hasKids ? '▸' : '•',
		});
		caret.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleExpand(name);
		});

		const icon = row.createSpan({
			cls: 'ct-icon' + (node?.canExpand ? '' : ' ct-icon-leaf'),
			text: node?.canExpand ? '◈' : '•',
		});
		icon.title = node?.canExpand ? 'Expandable' : 'Leaf';

		const nameEl = row.createSpan({ cls: 'ct-name' });
		const rowMatch = this.rows[idx].isMatch;
		if (rowMatch && this.filter) {
			const li = name.toLowerCase();
			const fi = li.indexOf(this.filter);
			if (fi >= 0) {
				nameEl.createSpan({ text: name.slice(0, fi) });
				nameEl.createSpan({ cls: 'ct-hl', text: name.slice(fi, fi + this.filter.length) });
				nameEl.createSpan({ text: name.slice(fi + this.filter.length) });
			} else {
				nameEl.setText(name);
			}
		} else {
			nameEl.setText(name);
		}
		nameEl.addEventListener('dblclick', () => {
			if (node) void this.plugin.store.openNote(node);
		});

		if (node) {
			if (this.plugin.settings.showComplexity) {
				row.createSpan({
					cls: `ct-badge ct-cx ct-cx-${node.complexity.toLowerCase()}`,
					text: node.complexity[0],
					attr: { title: node.complexity },
				});
			}
			if (node.children.length > 0) {
				row.createSpan({
					cls: 'ct-badge ct-kids',
					text: String(node.children.length),
					attr: { title: `${node.children.length} children` },
				});
			} else if (node.canExpand) {
				row.createSpan({ cls: 'ct-badge ct-hint', text: '∞' , attr: { title: `Can expand ~${node.estimatedDepth} levels deeper` }});
			}
			if (node.deepened) {
				row.createSpan({
					cls: 'ct-badge ct-deep',
					text: '💡',
					attr: { title: 'Has a generated deep dive' },
				});
			}
			if (node.source) {
				row.createSpan({
					cls: 'ct-badge ct-ref',
					text: '🔗',
					attr: { title: `Links to your note: ${node.source}` },
				});
			}
			if (node.loading) {
				row.createSpan({ cls: 'ct-spinner' });
			}

			const actions = row.createDiv({ cls: 'ct-actions' });
			const bExpand = actions.createEl('button', {
				cls: 'ct-btn',
				text: node.children.length > 0 ? (node.expanded ? 'Collapse' : 'Expand') : 'Expand',
				attr: { title: 'Generate children with AI' },
			});
			bExpand.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.expandNode(name);
			});
			const bAsk = actions.createEl('button', {
				cls: 'ct-btn',
				text: '💬',
				attr: { title: 'Ask about this concept (grounded chat)' },
			});
			bAsk.addEventListener('click', (e) => {
				e.stopPropagation();
				this.openAsk(name);
			});
			const bLink = actions.createEl('button', {
				cls: 'ct-btn',
				text: '🔗',
				attr: { title: 'Find connections to vault notes' },
			});
			bLink.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.findConnections(name);
			});
			const bDeep = actions.createEl('button', {
				cls: 'ct-btn',
				text: '💡',
				attr: {
					title: node.deepened
						? 'Refresh this note’s deep dive'
						: 'Write a deep dive into this note',
				},
			});
			bDeep.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.deepenNode(name, !!node.deepened);
			});
			const bOpen = actions.createEl('button', {
				cls: 'ct-btn',
				text: 'Open',
				attr: { title: 'Open the note' },
			});
			bOpen.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.plugin.store.openNote(node);
			});
		}

		if (node) {
			// Hover tooltips fire on mouse movement, not mouseenter: keyboard
			// selection repaints rows under a still cursor, and mouseenter on the
			// rebuilt element would override the keyboard-driven preview.
			let lx = -100;
			let ly = -100;
			row.addEventListener('mousemove', (e) => {
				if (Math.abs(e.clientX - lx) < 3 && Math.abs(e.clientY - ly) < 3) return;
				lx = e.clientX;
				ly = e.clientY;
				this.showTooltip(node, row);
			});
			row.addEventListener('mouseleave', () => this.hideTooltip());
		}
		row.addEventListener('click', () => {
			this.select(name);
			this.scrollEl.focus();
		});
		row.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.showContextMenu(e, name);
		});
		return row;
	}

	// ------------------------------------------------------------- status

	private setBusy(on: boolean, text?: string): void {
		if (on && text) this.setStatus(text);
		this.progressEl.toggleClass('ct-hidden', !on);
		if (!on) this.progressBarEl.style.removeProperty('width');
	}

	private setProgress(done: number, total: number): void {
		const pct = total > 0 ? Math.round((done / total) * 100) : 0;
		this.progressBarEl.style.width = `${Math.max(2, pct)}%`;
	}

	private setStatus(text: string): void {
		this.statusTextEl.setText(text);
	}

	private handleError(err: unknown, context: string): void {
		if (err instanceof ApiError) {
			new Notice(`${context} failed: ${err.message}`, 8000);
		} else {
			console.error(err);
			new Notice(`${context} failed: ${(err as Error).message ?? err}`, 8000);
		}
	}

	// ------------------------------------------------------------- hover tooltip

	private showTooltip(node: TreeNode, anchor: HTMLElement): void {
		if (!node || !node.description) {
			this.hideTooltip();
			return;
		}
		const tip = this.tooltipEl;
		tip.empty();
		tip.createDiv({ cls: 'ct-tooltip-name', text: node.name });
		const text =
			node.description.length > 300
				? node.description.slice(0, 300) + '…'
				: node.description;
		tip.createDiv({ cls: 'ct-tooltip-desc', text: text });
		tip.toggleClass('ct-visible', true);
		const rect = anchor.getBoundingClientRect();
		const tw = tip.offsetWidth;
		const th = tip.offsetHeight;
		let left = rect.left;
		if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
		if (left < 8) left = 8;
		let top = rect.top - th - 6;
		if (top < 8) top = rect.bottom + 6;
		tip.style.left = `${left}px`;
		tip.style.top = `${top}px`;
	}

	private hideTooltip(): void {
		if (this.tooltipEl) this.tooltipEl.toggleClass('ct-visible', false);
	}

	// ------------------------------------------------------------- keyboard nav

	private onScrollKeydown(e: KeyboardEvent): void {
		if (this.rows.length === 0 || !this.model) return;
		const idx = this.rows.findIndex((r) => r.name === this.selected);
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				this.moveSelection(idx + 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				this.moveSelection(idx < 0 ? this.rows.length - 1 : idx - 1);
				break;
			case 'ArrowRight':
				e.preventDefault();
				this.keyExpand(idx, true);
				break;
			case 'ArrowLeft':
				e.preventDefault();
				this.keyExpand(idx, false);
				break;
			case 'Enter':
				e.preventDefault();
				this.keyToggle(idx);
				break;
		}
	}

	private moveSelection(idx: number): void {
		if (idx < 0 || idx >= this.rows.length) return;
		const name = this.rows[idx].name;
		this.selected = name;
		const top = idx * ROW_H;
		const bottom = top + ROW_H;
		const vh = this.scrollEl.clientHeight || 400;
		if (top < this.scrollTop) this.scrollTop = top;
		else if (bottom > this.scrollTop + vh) this.scrollTop = bottom - vh;
		this.scrollEl.scrollTop = this.scrollTop;
		this.scrollEl.focus();
		this.select(name);
		// Keyboard preview: show the tooltip for the newly selected row.
		this.showSelectedTooltip();
	}

	/** Show the hover-style preview for the currently keyboard-selected row. */
	private showSelectedTooltip(): void {
		const name = this.selected;
		if (!name) {
			this.hideTooltip();
			return;
		}
		const node = this.model?.nodes.get(name);
		const el = this.rowEls.get(name);
		if (node && el) this.showTooltip(node, el);
		else this.hideTooltip();
	}

	private keyExpand(idx: number, open: boolean): void {
		if (idx < 0 || idx >= this.rows.length) return;
		const node = this.model?.nodes.get(this.rows[idx].name);
		if (!node || node.children.length === 0) return;
		if (open && !node.expanded) {
			node.expanded = true;
			this.render();
			this.showSelectedTooltip();
		} else if (!open && node.expanded) {
			node.expanded = false;
			this.render();
			this.showSelectedTooltip();
		}
	}

	private keyToggle(idx: number): void {
		if (idx < 0 || idx >= this.rows.length) return;
		const node = this.model?.nodes.get(this.rows[idx].name);
		if (!node || node.children.length === 0) return;
		node.expanded = !node.expanded;
		this.render();
		this.showSelectedTooltip();
	}

	// ------------------------------------------------------------- clipboard

	private copyToClipboard(text: string, label: string): void {
		// Obsidian runs on Electron, where the async Clipboard API is always
		// available; the deprecated execCommand fallback is intentionally not used.
		void navigator.clipboard.writeText(text).then(
			() => new Notice(`${label} copied.`),
			() => new Notice(`Could not copy ${label}.`, 4000)
		);
	}

	// ------------------------------------------------------------- batch connections

	/** Run "Find connections" over a whole subtree, auto-linking high-priority hits. */
	private async batchConnections(name: string): Promise<void> {
		if (!this.model) return;
		const subtree = this.plugin.store.collectSubtree(this.model, name);
		if (subtree.length === 0) return;
		if (!this.beginAction()) return;
		this.setBusy(true, `Finding connections across ${subtree.length} node${subtree.length > 1 ? 's' : ''}…`);
		let done = 0;
		let linked = 0;
		try {
			for (const node of subtree) {
				done++;
				this.setBusy(
					true,
					`Connections ${done}/${subtree.length} — "${node.name}"`
				);
				try {
					const result = await this.plugin.generator.connections(node, (d) =>
						this.setBusy(true, `Connections ${done}/${subtree.length} — ${d.slice(-40)}`)
					);
					if (!result) continue;
					for (const s of result.connections ?? []) {
						if ((s.priority ?? 'medium').toLowerCase() !== 'high') continue;
						if (this.app.metadataCache.getFirstLinkpathDest(s.name, '') !== null) {
							const added = await this.plugin.store.addConnectionLink(node, s.name);
							if (added) linked++;
						}
					}
				} catch (err) {
					console.warn(`Connections for "${node.name}" failed:`, err);
				}
			}
		} finally {
			this.setStatus('');
			this.setBusy(false);
			this.endAction();
		}
		new Notice(
			`Batch connections: ${linked} link${linked === 1 ? '' : 's'} added across ${subtree.length} node${subtree.length === 1 ? '' : 's'}.`,
			6000
		);
	}

	// ------------------------------------------------------------- stats & duplicates & export

	private openStats(): void {
		if (!this.model) return;
		new StatsModal(this.app, this.model).open();
	}

	private openExport(): void {
		if (!this.model) return;
		new ExportModal(this.app, this.plugin, this.model).open();
	}

	private async findDuplicates(): Promise<void> {
		if (this.trees.length < 2) {
			new Notice('Create at least two trees to check for duplicates.');
			return;
		}
		this.setBusy(true, 'Scanning trees for duplicate concepts…');
		try {
			const byKey = new Map<string, { tree: string; name: string }[]>();
			for (const t of this.trees) {
				const model = await this.plugin.store.loadTree(t);
				if (!model) continue;
				for (const n of model.nodes.values()) {
					const k = normalizeKey(n.name);
					const arr = byKey.get(k);
					if (arr) arr.push({ tree: t, name: n.name });
					else byKey.set(k, [{ tree: t, name: n.name }]);
				}
			}
			const dups = [...byKey.values()].filter((a) => a.length > 1);
			if (dups.length === 0) {
				new Notice('No duplicate concepts found across trees.');
				return;
			}
			new DuplicatesModal(
				this.app,
				this.plugin,
				dups,
				() => void this.refreshAll()
			).open();
		} catch (err) {
			this.handleError(err, 'Duplicate scan');
		} finally {
			this.setBusy(false);
		}
	}
}

interface VaultTreeOptions {
	activeName: string | null;
	activePath: string | null;
	tags: { tag: string; count: number }[];
	maxNotes: number;
}

interface VaultTreeChoice {
	seedKind: 'note' | 'tag';
	seed: string;
	seedPath?: string;
	concept: string;
	maxNotes: number;
}

/** Seed picker for "Grow a tree from your vault". */
class VaultTreeModal extends Modal {
	private choice: { label: string; kind: 'note' | 'tag'; value: string; path?: string };
	private concept: string;
	private maxNotes: number;

	constructor(app: App, private opts: VaultTreeOptions, private onSubmit: (c: VaultTreeChoice) => void) {
		super(app);
		this.maxNotes = opts.maxNotes;
		this.choice = {
			label: opts.activeName ?? '',
			kind: 'note',
			value: opts.activeName ?? '',
			path: opts.activePath ?? undefined,
		};
		this.concept = this.conceptFor(this.choice);
	}

	private conceptFor(source: { kind: 'note' | 'tag'; value: string }): string {
		return titleCase(source.value.replace(/[-_]+/g, ' '));
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'Grow a tree from your vault' });
		contentEl.createEl('p', {
			cls: 'ct-modal-hint',
			text: 'CogniTree reads note names, tags and links from the metadata cache — no note contents — and arranges them into a tree. Your existing notes are linked, never copied or modified.',
		});

		const sources: { label: string; kind: 'note' | 'tag'; value: string; path?: string }[] = [];
		if (this.opts.activeName && this.opts.activePath) {
			sources.push({
				label: `Current note: ${this.opts.activeName}`,
				kind: 'note',
				value: this.opts.activeName,
				path: this.opts.activePath,
			});
		}
		for (const tag of this.opts.tags) {
			sources.push({
				label: `Tag ${tag.tag} — ${tag.count} note(s)`,
				kind: 'tag',
				value: tag.tag.replace(/^#/, ''),
			});
		}
		if (sources.length === 0) {
			contentEl.createEl('p', {
				cls: 'ct-muted',
				text: 'No seed available: open a note, or tag some notes in your vault first.',
			});
			return;
		}
		this.choice = sources[0];
		this.concept = this.conceptFor(this.choice);

		let conceptInput: TextComponent | null = null;
		new Setting(contentEl)
			.setName('Source')
			.setDesc(
				'A note grows a tree around its link neighbourhood; a tag grows one over the notes carrying it.'
			)
			.addDropdown((dd) => {
				sources.forEach((source, i) => {
					dd.addOption(String(i), source.label);
				});
				dd.setValue('0');
				dd.onChange((value) => {
					this.choice = sources[Number(value)] ?? sources[0];
					this.concept = this.conceptFor(this.choice);
					conceptInput?.setValue(this.concept);
				});
			});
		new Setting(contentEl)
			.setName('Tree name')
			.setDesc('Name of the tree and of its folder.')
			.addText((t) => {
				conceptInput = t;
				t.setValue(this.concept).onChange((v) => (this.concept = v));
			});
		new Setting(contentEl)
			.setName('Notes to consider')
			.setDesc('Upper bound on how many of your notes are offered to the model.')
			.addText((t) =>
				t.setValue(String(this.maxNotes)).onChange((v) => {
					const n = parseInt(v, 10);
					if (Number.isFinite(n) && n > 0) this.maxNotes = n;
				})
			);

		const btnRow = contentEl.createDiv({ cls: 'ct-modal-buttons' });
		const run = btnRow.createEl('button', { cls: 'mod-cta', text: 'Grow tree' });
		run.addEventListener('click', () => {
			this.onSubmit({
				seedKind: this.choice.kind,
				seed: this.choice.value,
				seedPath: this.choice.path,
				concept: this.concept.trim() || this.choice.value,
				maxNotes: this.maxNotes,
			});
			this.close();
		});
		const cancel = btnRow.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

interface ReviewSessionStats {
	again: number;
	hard: number;
	good: number;
	easy: number;
	reviewed: number;
}

/**
 * Study session over a tree's due cards: question → reveal → grade, with
 * keyboard shortcuts (Space reveals, 1-4 grade). Grades are written to the
 * review store as they are given, so closing the modal never loses progress.
 */
class ReviewModal extends Modal {
	private queue: string[] = [];
	private index = 0;
	private revealed = false;
	private stats: ReviewSessionStats = { again: 0, hard: 0, good: 0, easy: 0, reviewed: 0 };

	constructor(
		app: App,
		private plugin: CogniTreePlugin,
		private treeName: string,
		private data: ReviewData,
		/** Node names the session is limited to (undefined = whole tree). */
		private sessionScope?: Set<string>,
		private onFinish?: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('ct-review-modal');
		this.queue = dueCardIds(this.data, Date.now(), 30, this.sessionScope);
		this.contentEl.setAttribute('tabindex', '0');
		this.contentEl.addEventListener('keydown', (e) => {
			if (e.key === ' ') {
				e.preventDefault();
				if (!this.revealed) {
					this.revealed = true;
					this.render();
				}
				return;
			}
			if (this.revealed && ['1', '2', '3', '4'].includes(e.key)) {
				e.preventDefault();
				this.grade(GRADES[Number(e.key) - 1]);
			}
		});
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ct-review');
		if (this.index >= this.queue.length) {
			this.renderDone();
			return;
		}
		const card = this.data.cards[this.queue[this.index]];
		if (!card) {
			this.index++;
			this.render();
			return;
		}
		const stats = reviewStats(this.data, Date.now(), this.sessionScope);

		const head = contentEl.createDiv({ cls: 'ct-review-head' });
		head.createSpan({ cls: 'ct-review-progress', text: `${this.index + 1} / ${this.queue.length}` });
		head.createSpan({ cls: 'ct-review-tree', text: `Tree “${this.treeName}”` });
		head.createSpan({
			cls: 'ct-muted',
			text: `${stats.due} due · ${stats.fresh} new · ${stats.mature} mature · ${stats.total} total`,
		});

		contentEl.createDiv({ cls: 'ct-review-node', text: card.node });
		const q = contentEl.createDiv({ cls: 'ct-review-question' });
		q.createSpan({ cls: 'ct-review-kind', text: card.kind });
		q.createSpan({ text: card.question });

		if (!this.revealed) {
			const show = contentEl.createEl('button', {
				cls: 'ct-btn ct-btn-primary ct-review-show',
				text: 'Show answer (Space)',
			});
			show.addEventListener('click', () => {
				this.revealed = true;
				this.render();
			});
		} else {
			contentEl.createDiv({ cls: 'ct-review-answer', text: card.answer });
			const row = contentEl.createDiv({ cls: 'ct-review-grades' });
			GRADES.forEach((grade, i) => {
				const b = row.createEl('button', {
					cls: `ct-btn ct-grade ct-grade-${grade}`,
					text: `${i + 1} · ${grade}`,
				});
				b.addEventListener('click', () => this.grade(grade));
			});
		}

		const foot = contentEl.createDiv({ cls: 'ct-review-foot' });
		const skip = foot.createEl('button', { cls: 'ct-btn', text: 'Skip' });
		skip.addEventListener('click', () => {
			this.index++;
			this.revealed = false;
			this.render();
		});
		const del = foot.createEl('button', { cls: 'ct-btn', text: 'Delete card' });
		del.addEventListener('click', () => {
			removeCard(this.data, card.id);
			void this.plugin.store.saveReview(this.data);
			this.queue.splice(this.index, 1);
			this.revealed = false;
			new Notice('Card deleted.', 3000);
			this.render();
		});
		const stop = foot.createEl('button', { cls: 'ct-btn', text: 'End session' });
		stop.addEventListener('click', () => this.close());

		this.contentEl.focus();
	}

	private grade(grade: Grade): void {
		const id = this.queue[this.index];
		const card = this.data.cards[id];
		if (!card) return;
		this.data.states[id] = gradeCard(this.data.states[id], grade, id, Date.now());
		this.stats[grade]++;
		this.stats.reviewed++;
		void this.plugin.store.saveReview(this.data);
		this.index++;
		this.revealed = false;
		this.render();
	}

	private renderDone(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Session complete' });
		const s = this.stats;
		contentEl.createDiv({
			cls: 'ct-review-summary',
			text:
				s.reviewed === 0
					? 'No cards reviewed.'
					: `${s.reviewed} card(s): ${s.again} again · ${s.hard} hard · ${s.good} good · ${s.easy} easy`,
		});
		const stats = reviewStats(this.data, Date.now(), this.sessionScope);
		contentEl.createDiv({
			cls: 'ct-muted',
			text: `${stats.due} still due · ${stats.fresh} new · ${stats.learning} learning · ${stats.mature} mature`,
		});
		const close = contentEl.createEl('button', { cls: 'ct-btn ct-btn-primary', text: 'Close' });
		close.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
		this.onFinish?.();
	}
}

// ================================================================ modals

interface BatchOptions {
	depth: number;
	budget: number;
	rootName: string;
	nodeName: string;
}

class BatchModal extends Modal {
	constructor(
		app: App,
		private opts: BatchOptions,
		private onSubmit: (o: { depth: number; budget: number }) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: `Batch expand "${this.opts.nodeName}"` });
		contentEl.createEl('p', {
			cls: 'ct-modal-hint',
			text: `Tree: ${this.opts.rootName} · Each expansion costs one API call. Generates incrementally, one branch at a time.`,
		});
		let depth = this.opts.depth;
		let budget = this.opts.budget;

		new Setting(contentEl)
			.setName('Depth')
			.setDesc('Levels deep to expand (respects max depth setting).')
			.addSlider((sl) =>
				sl
					.setLimits(1, 10, 1)
					.setValue(depth)
					.onChange((v) => (depth = v))
			);
		new Setting(contentEl)
			.setName('Node budget')
			.setDesc('Total nodes to generate (respects max nodes per batch).')
			.addText((t) =>
				t
					.setValue(String(budget))
					.onChange((v) => {
						const n = parseInt(v, 10);
						if (Number.isFinite(n) && n > 0) budget = n;
					})
			);

		const btnRow = contentEl.createDiv({ cls: 'ct-modal-buttons' });
		const run = btnRow.createEl('button', { cls: 'mod-cta', text: 'Start' });
		run.addEventListener('click', () => this.onSubmit({ depth, budget }));
		const cancel = btnRow.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConfirmModal extends Modal {
	private decided = false;

	constructor(
		app: App,
		private message: string,
		private onConfirm: () => void | Promise<void>,
		private confirmText = 'Delete',
		private onDecline?: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: this.message });
		const btnRow = contentEl.createDiv({ cls: 'ct-modal-buttons' });
		const yes = btnRow.createEl('button', { cls: 'mod-warning', text: this.confirmText });
		yes.addEventListener('click', () => {
			this.decided = true;
			this.close();
			void this.onConfirm();
		});
		const no = btnRow.createEl('button', { text: 'Cancel' });
		no.addEventListener('click', () => this.close());
	}

	onClose(): void {
		if (!this.decided) this.onDecline?.();
		this.contentEl.empty();
	}
}

/** Yes/no dialog; resolves `true` only when the confirm button is pressed. */
function confirmDialog(app: App, message: string, confirmText = 'OK'): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		new ConfirmModal(
			app,
			message,
			() => finish(true),
			confirmText,
			() => finish(false)
		).open();
	});
}

interface DeepenOptions {
	nodeName: string;
	subtreeSize: number;
	missing: number;
	budget: number;
}

/** Budget picker for "Deep dive subtree". */
class DeepenModal extends Modal {
	constructor(
		app: App,
		private opts: DeepenOptions,
		private onSubmit: (o: { budget: number; refresh: boolean }) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: `Deep dive "${this.opts.nodeName}"` });
		contentEl.createEl('p', {
			cls: 'ct-modal-hint',
			text: `Subtree: ${this.opts.subtreeSize} note(s), ${this.opts.missing} without a deep dive. Each one costs a single API call and is cached.`,
		});
		let budget = this.opts.budget;
		let refresh = false;

		new Setting(contentEl)
			.setName('Note budget')
			.setDesc('Maximum number of notes to write in this run.')
			.addText((t) =>
				t.setValue(String(budget)).onChange((v) => {
					const n = parseInt(v, 10);
					if (Number.isFinite(n) && n > 0) budget = n;
				})
			);
		new Setting(contentEl)
			.setName('Refresh existing')
			.setDesc('Also rewrite notes that already have a deep dive.')
			.addToggle((t) => t.setValue(false).onChange((v) => (refresh = v)));

		const btnRow = contentEl.createDiv({ cls: 'ct-modal-buttons' });
		const run = btnRow.createEl('button', { cls: 'mod-cta', text: 'Start' });
		run.addEventListener('click', () => this.onSubmit({ budget, refresh }));
		const cancel = btnRow.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConnectionsModal extends Modal {
	constructor(
		app: App,
		private plugin: CogniTreePlugin,
		private node: TreeNode,
		private result: ConnectionResult
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ct-conn-modal');
		contentEl.createEl('h3', { text: `Connections for "${this.node.name}"` });

		const list = contentEl.createDiv({ cls: 'ct-conn-list' });
		const suggs = this.result.connections ?? [];
		if (suggs.length === 0) {
			list.createEl('p', { cls: 'ct-muted', text: 'No existing vault notes matched strongly.' });
		}
		for (const s of suggs) {
			const row = list.createDiv({ cls: 'ct-conn-row' });
			const left = row.createDiv({ cls: 'ct-conn-left' });
			left.createDiv({
				cls: `ct-priority ct-p-${(s.priority ?? 'medium').toLowerCase()}`,
				text: s.priority ?? 'Medium',
			});
			left.createDiv({ cls: 'ct-conn-name', text: s.name });
			left.createDiv({
				cls: 'ct-muted',
				text: `${s.relationship_type ?? 'related-to'} — ${s.description ?? ''}`,
			});
			const exists = this.plugin.app.metadataCache.getFirstLinkpathDest(s.name, '') !== null;
			const btn = row.createEl('button', {
				cls: 'ct-btn',
				text: exists ? 'Link' : 'Create + link',
			});
			btn.addEventListener('click', () => {
				void this.handleSuggestion(s.name, exists);
			});
		}

		const toCreate = this.result.suggested_connections_to_create ?? [];
		if (toCreate.length > 0) {
			contentEl.createEl('h4', { text: 'Suggested concepts to create' });
			const createList = contentEl.createDiv({ cls: 'ct-conn-list' });
			for (const c of toCreate) {
				const row = createList.createDiv({ cls: 'ct-conn-row' });
				row.createDiv({ cls: 'ct-conn-name', text: c });
				const btn = row.createEl('button', { cls: 'ct-btn', text: 'Create note' });
				btn.addEventListener('click', () => {
					void this.createConcept(c);
				});
			}
		}

		const close = contentEl.createEl('button', {
			cls: 'ct-btn ct-btn-block',
			text: 'Close',
		});
		close.addEventListener('click', () => this.close());
	}

	private async handleSuggestion(name: string, exists: boolean): Promise<void> {
		try {
			if (!exists) {
				await this.plugin.store.createOrphanNote(
					name,
					this.plugin.settings.treeFolder,
					this.node.treeRoot,
					this.node.name
				);
				new Notice(`Created note "${name}".`);
			}
			const linked = await this.plugin.store.addConnectionLink(this.node, name);
			if (linked) {
				new Notice(`Linked "${this.node.name}" → "${name}".`);
			} else {
				new Notice(`Already linked to "${name}".`);
			}
		} catch (err) {
			new Notice(`Failed: ${(err as Error).message}`, 6000);
		}
	}

	private async createConcept(name: string): Promise<void> {
		try {
			const file = await this.plugin.store.createOrphanNote(
				name,
				this.plugin.settings.treeFolder,
				this.node.treeRoot,
				this.node.name
			);
			new Notice(`Created note "${name}".`);
			if (file) {
				await this.plugin.app.workspace.getLeaf(true).openFile(file);
			}
		} catch (err) {
			new Notice(`Failed: ${(err as Error).message}`, 6000);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Feature 8 — per-tree stats, depth distribution, complexity and health checks. */
class StatsModal extends Modal {
	constructor(app: App, private model: TreeModel) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ct-stats-modal');
		contentEl.createEl('h3', { text: `Tree stats — "${this.model.root}"` });

		const m = this.model;
		const depths = computeDepths(m);
		let nodes = 0;
		let leaves = 0;
		let expandable = 0;
		let maxDepth = 0;
		const byDepth = new Map<number, number>();
		const byCx = new Map<string, number>();
		const orphans: string[] = [];
		const dangling: string[] = [];

		for (const n of m.nodes.values()) {
			nodes++;
			const d = (depths.get(n.name) ?? 0) + 1;
			byDepth.set(d, (byDepth.get(d) ?? 0) + 1);
			if (d > maxDepth) maxDepth = d;
			if (n.children.length === 0) leaves++;
			if (n.canExpand) expandable++;
			byCx.set(n.complexity, (byCx.get(n.complexity) ?? 0) + 1);
			if (n.parent && !m.nodes.has(n.parent)) orphans.push(n.name);
			for (const c of n.children) {
				if (!m.nodes.has(c)) dangling.push(`${n.name} → ${c}`);
			}
		}

		const row = (label: string, value: string | number) => {
			const r = contentEl.createDiv({ cls: 'ct-stats-row' });
			r.createSpan({ cls: 'ct-stats-label', text: label });
			r.createEl('b', { text: String(value) });
		};
		row('Total nodes', nodes);
		row('Max depth', maxDepth);
		row('Leaves', leaves);
		row('Expandable leaves', expandable);

		contentEl.createEl('h4', { text: 'Nodes per depth' });
		for (let d = 1; d <= maxDepth; d++) {
			row(`Depth ${d}`, byDepth.get(d) ?? 0);
		}

		contentEl.createEl('h4', { text: 'Complexity' });
		for (const [cx, count] of [...byCx.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			row(cx, count);
		}

		contentEl.createEl('h4', { text: 'Health' });
		if (orphans.length === 0 && dangling.length === 0) {
			contentEl.createEl('p', { cls: 'ct-muted', text: 'No issues found.' });
		} else {
			if (orphans.length > 0) {
				contentEl.createEl('p', {
					cls: 'ct-muted',
					text: `${orphans.length} node(s) reference a parent that is missing:`,
				});
				for (const o of orphans) contentEl.createEl('p', { cls: 'ct-stats-issue', text: `• ${o}` });
			}
			if (dangling.length > 0) {
				contentEl.createEl('p', {
					cls: 'ct-muted',
					text: `${dangling.length} dangling child reference(s):`,
				});
				for (const dc of dangling.slice(0, 20)) {
					contentEl.createEl('p', { cls: 'ct-stats-issue', text: `• ${dc}` });
				}
			}
		}

		const close = contentEl.createEl('button', { cls: 'ct-btn ct-btn-block', text: 'Close' });
		close.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Feature 6 — export the current tree as Markdown outline, JSON or SVG. */
class ExportModal extends Modal {
	constructor(
		app: App,
		private plugin: CogniTreePlugin,
		private model: TreeModel
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ct-export-modal');
		contentEl.createEl('h3', { text: `Export "${this.model.root}"` });
		contentEl.createEl('p', {
			cls: 'ct-modal-hint',
			text: 'Files are written to the vault root — kept out of the tree folder so they are never parsed as nodes.',
		});

		const writeVaultFile = async (path: string, content: string) => {
			const existing = this.plugin.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.plugin.app.vault.modify(existing, content);
			} else {
				await this.plugin.app.vault.create(path, content);
			}
		};
		const add = (label: string, file: string, build: () => string) => {
			const btn = contentEl.createEl('button', {
				cls: 'ct-btn ct-btn-block',
				text: `Export as ${label}`,
			});
			btn.addEventListener('click', () => {
				void (async () => {
					try {
						const path = `${this.model.root} ${file}`;
						await writeVaultFile(path, build());
						new Notice(`Exported to "${path}".`);
						this.close();
					} catch (err) {
						new Notice(`Export failed: ${(err as Error).message}`, 6000);
					}
				})();
			});
		};
		add('Markdown outline', 'outline.md', () => buildOutline(this.model));
		add('JSON snapshot', 'tree.json', () => buildJsonSnapshot(this.model));
		add('SVG graph', 'tree.svg', () => buildTreeSvg(this.model));

		const close = contentEl.createEl('button', { cls: 'ct-btn ct-btn-block', text: 'Close' });
		close.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Feature 9 — duplicate concepts across trees, with link / merge actions. */
class DuplicatesModal extends Modal {
	constructor(
		app: App,
		private plugin: CogniTreePlugin,
		private groups: { tree: string; name: string }[][],
		private onChanged: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ct-dup-modal');
		contentEl.createEl('h3', { text: 'Duplicate concepts across trees' });
		contentEl.createEl('p', {
			cls: 'ct-modal-hint',
			text: `${this.groups.length} concept(s) appear in more than one tree.`,
		});

		const list = contentEl.createDiv({ cls: 'ct-conn-list' });
		for (const group of this.groups) {
			const [first, second] = group;
			const row = list.createDiv({ cls: 'ct-conn-row' });
			const left = row.createDiv({ cls: 'ct-conn-left' });
			left.createDiv({ cls: 'ct-conn-name', text: first.name });
			left.createDiv({ cls: 'ct-muted', text: group.map((g) => g.tree).join(', ') });

			const actions = row.createDiv({ cls: 'ct-dup-actions' });
			const linkBtn = actions.createEl('button', { cls: 'ct-btn', text: 'Link' });
			linkBtn.title = `Link "${first.tree}" ↔ "${second.tree}"`;
			linkBtn.addEventListener('click', () => void this.link(first, second));
			if (group.length === 2) {
				const m1 = actions.createEl('button', {
					cls: 'ct-btn',
					text: `Merge ${second.tree} → ${first.tree}`,
				});
				m1.title = 'Move this subtree into the other tree and delete the duplicate';
				m1.addEventListener('click', () => void this.merge(second, first));
				const m2 = actions.createEl('button', {
					cls: 'ct-btn',
					text: `Merge ${first.tree} → ${second.tree}`,
				});
				m2.title = 'Move this subtree into the other tree and delete the duplicate';
				m2.addEventListener('click', () => void this.merge(first, second));
			}
		}

		const close = contentEl.createEl('button', { cls: 'ct-btn ct-btn-block', text: 'Close' });
		close.addEventListener('click', () => this.close());
	}

	private async link(
		a: { tree: string; name: string },
		b: { tree: string; name: string }
	): Promise<void> {
		const ta = await this.plugin.store.loadTree(a.tree);
		const tb = await this.plugin.store.loadTree(b.tree);
		if (!ta || !tb) return;
		const na = ta.nodes.get(a.name);
		const nb = tb.nodes.get(b.name);
		if (!na || !nb) return;
		let linked = 0;
		if (await this.plugin.store.addConnectionLink(na, nb.name)) linked++;
		if (await this.plugin.store.addConnectionLink(nb, na.name)) linked++;
		new Notice(`Linked ${linked} direction${linked === 1 ? '' : 's'}.`);
		this.onChanged();
	}

	private async merge(
		src: { tree: string; name: string },
		tgt: { tree: string; name: string }
	): Promise<void> {
		const s = await this.plugin.store.loadTree(src.tree);
		const t = await this.plugin.store.loadTree(tgt.tree);
		if (!s || !t) return;
		const res = await this.plugin.store.mergeSubtree(s, src.name, t, tgt.name);
		new Notice(
			`Merged "${src.name}" into "${tgt.tree}": ${res.moved} node${res.moved === 1 ? '' : 's'} moved` +
				(res.skipped.length > 0 ? `, ${res.skipped.length} skipped` : '') +
				'.',
			6000
		);
		this.onChanged();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
