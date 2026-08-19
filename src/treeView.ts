import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Setting,
	TFile,
	WorkspaceLeaf,
} from 'obsidian';
import type { ConnectionResult, TreeNode, TreeModel } from './types';
import { PROVIDERS, curatedModelsFor, providerFor } from './types';
import { normalizeKey } from './parser';
import { ApiError } from './api';
import type CogniTreePlugin from './main';
import { buildJsonSnapshot, buildOutline, buildTreeSvg } from './exporters';

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
		this.emptyEl.style.display = 'none';
		this.noMatchEl = this.scrollEl.createDiv({ cls: 'ct-no-match' });
		this.noMatchEl.style.display = 'none';
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
		this.progressEl.style.display = 'none';
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
			text: this.plugin.settings.apiKey
				? 'Each branch costs one API call — results are cached.'
				: 'Tip: add your API key via ⚙ in the header first.',
		});
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
	}

	/** Expand existing branches up to autoExpandDepth without API calls. */
	private autoExpand(model: TreeModel): void {
		const depth = this.plugin.settings.autoExpandDepth;
		if (depth <= 0) return;
		const walk = (name: string, level: number) => {
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
		if (!this.plugin.settings.apiKey) {
			new Notice('Set your API key in CogniTree settings first (⚙ in the header).', 6000);
			return;
		}
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
				this.model!.nodes.set(child.name, child);
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
		const visit = (n: string) => {
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
			async (opts) => {
				modal.close();
				await this.runBatch(node.name, opts.depth, opts.budget);
			}
		);
		modal.open();
	}

	private async runBatch(name: string, depth: number, budget: number): Promise<void> {
		if (!this.model) return;
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
		}
	}

	// ------------------------------------------------------------- connections

	private async findConnections(name: string): Promise<void> {
		const node = this.model?.nodes.get(name);
		if (!node) return;
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
				.setTitle('Open note')
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
		const count = this.plugin.store.collectSubtree(this.model, name).length;
		new ConfirmModal(
			this.app,
			`Delete "${name}" and ${count - 1} descendant note${count > 2 ? 's' : ''} from the vault?`,
			async () => {
				// Capture the subtree contents so the delete can be undone.
				const snap: { name: string; file: string; content: string }[] = [];
				const files = new Map<string, string>();
				const pathOf = new Map<string, string>();
				const visit = (n: string) => {
					const node = this.model!.nodes.get(n);
					if (!node) return;
					files.set(node.file, node.name);
					pathOf.set(node.name, node.file);
					for (const c of node.children) visit(c);
				};
				visit(name);
				for (const [file, fname] of files) {
					try {
						const fileRef = this.app.vault.getAbstractFileByPath(file);
						if (fileRef instanceof TFile) {
							snap.push({ name: fname, file, content: await this.app.vault.cachedRead(fileRef) });
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
					onClick: () => void this.restoreSubtree(name, snap, pathOf),
				});
			}
		).open();
	}

	/** Recreate notes captured before a subtree deletion. */
	private async restoreSubtree(
		name: string,
		snap: { name: string; file: string; content: string }[],
		pathOf: Map<string, string>
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
			const collect = (name: string, path: string[]) => {
				const node = this.model!.nodes.get(name);
				if (!node) return;
				if (node.name.toLowerCase().includes(this.filter)) {
					for (const a of path) include.add(a);
					include.add(name);
				}
				for (const c of node.children) collect(c, [...path, name]);
			};
			collect(this.model.root, []);
			const emit = (name: string, depth: number) => {
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
			const visit = (name: string, depth: number) => {
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
			this.emptyEl.style.display = 'flex';
			this.viewportEl.style.display = 'none';
			this.noMatchEl.style.display = 'none';
			this.rows = [];
			this.updateStats();
			return;
		}
		this.emptyEl.style.display = 'none';
		this.viewportEl.style.display = 'block';
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
		this.noMatchEl.style.display =
			this.filter && this.rows.length === 0 ? 'flex' : 'none';
		if (this.filter && this.rows.length === 0) {
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
			for (const n of this.model.nodes.values()) {
				const d = n.path.split('/').filter(Boolean).length;
				if (d > maxDepth) maxDepth = d;
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
		} else {
			chip(this.trees.length === 1 ? 'tree' : 'trees', String(this.trees.length));
			chip('notes indexed', String(this.plugin.indexer.noteCount));
		}
	}

	private schedulePaint(): void {
		if (this.rafPending) return;
		this.rafPending = true;
		this.rafTimer = requestAnimationFrame(() => {
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
		const frag = document.createDocumentFragment();
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
			const bLink = actions.createEl('button', {
				cls: 'ct-btn',
				text: '🔗',
				attr: { title: 'Find connections to vault notes' },
			});
			bLink.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.findConnections(name);
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
		this.progressEl.style.display = on ? 'block' : 'none';
		if (!on) this.progressBarEl.style.width = '0%';
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
		tip.style.display = 'block';
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
		if (this.tooltipEl) this.tooltipEl.style.display = 'none';
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
		const done = () => new Notice(`${label} copied.`);
		if (navigator.clipboard && navigator.clipboard.writeText) {
			void navigator.clipboard.writeText(text).then(done, () => this.legacyCopy(text, done));
		} else {
			this.legacyCopy(text, done);
		}
	}

	private legacyCopy(text: string, done: () => void): void {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		try {
			document.execCommand('copy');
		} catch {
			// Clipboard unavailable — the notice still fires.
		}
		ta.remove();
		done();
	}

	// ------------------------------------------------------------- batch connections

	/** Run "Find connections" over a whole subtree, auto-linking high-priority hits. */
	private async batchConnections(name: string): Promise<void> {
		if (!this.model) return;
		const subtree = this.plugin.store.collectSubtree(this.model, name);
		if (subtree.length === 0) return;
		this.setBusy(true, `Finding connections across ${subtree.length} node${subtree.length > 1 ? 's' : ''}…`);
		let done = 0;
		let linked = 0;
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
		this.setStatus('');
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
					.setDynamicTooltip()
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
	constructor(
		app: App,
		private message: string,
		private onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: this.message });
		const btnRow = contentEl.createDiv({ cls: 'ct-modal-buttons' });
		const yes = btnRow.createEl('button', { cls: 'mod-warning', text: 'Delete' });
		yes.addEventListener('click', () => {
			this.close();
			void this.onConfirm();
		});
		const no = btnRow.createEl('button', { text: 'Cancel' });
		no.addEventListener('click', () => this.close());
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
			const d = n.path.split('/').filter(Boolean).length;
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
