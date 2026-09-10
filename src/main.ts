import { MarkdownView, Notice, Plugin } from 'obsidian';
import { ResponseCache } from './cache';
import { SemanticIndex } from './embeddings';
import { ConceptGenerator } from './generator';
import { VaultIndexer } from './indexer';
import { CogniTreeSettingTab } from './settings';
import { ConceptStore } from './store';
import { ConceptTreeView, VIEW_TYPE } from './treeView';
import { DEFAULT_SETTINGS, PROVIDERS, type PluginSettings } from './types';

/** Persisted plugin data (settings live here too; cache shares the file). */
interface PluginData {
	settings?: Partial<PluginSettings>;
	lastTree?: string;
	/** Model ids fetched from the endpoint (GET /models). */
	models?: string[];
	cache?: Record<string, unknown>;
}

export default class CogniTreePlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	data: PluginData = {};
	store!: ConceptStore;
	indexer!: VaultIndexer;
	generator!: ConceptGenerator;
	cache!: ResponseCache;
	semantic!: SemanticIndex;

	/** Live reference to the open tree view (no instance stored on the plugin). */
	get treeView(): ConceptTreeView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		return leaves.length > 0 ? (leaves[0].view as ConceptTreeView) : null;
	}

	/**
	 * In-flight `activateView` call. A leaf only reports its view type once
	 * `setViewState` has resolved, so without this a second trigger during that
	 * window (a double-clicked ribbon icon, a hotkey, the startup auto-open)
	 * opens a second, identical tab in the sidebar.
	 */
	private activation: Promise<void> | null = null;

	async onload(): Promise<void> {
		await this.loadAll();

		this.store = new ConceptStore(this.app);
		this.store.setBaseFolder(this.settings.treeFolder);
		this.indexer = new VaultIndexer(this.app);
		this.indexer.init(this.settings.treeFolder);
		// metadataCache listeners are attached outside the plugin lifecycle, so
		// detach them explicitly on unload.
		this.register(() => this.indexer.dispose());
		this.cache = new ResponseCache(
			() => Promise.resolve(this.data),
			() => this.saveData(this.data),
			() => this.settings
		);
		await this.cache.loadFromDisk();
		// Embedding vectors live next to the plugin, not in the data file.
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		this.semantic = new SemanticIndex(
			this.app,
			() => this.settings,
			`${pluginDir}/embeddings.json`,
			(model, texts) => this.generator.api.embed(model, texts)
		);
		await this.semantic.load();
		this.generator = new ConceptGenerator(
			this.app,
			this.store,
			this.indexer,
			() => this.settings,
			this.cache,
			this.semantic
		);

		// View — return the view directly; never store it on the plugin
		// (a stored instance keeps the leaf alive and leaks memory).
		this.registerView(VIEW_TYPE, (leaf) => new ConceptTreeView(leaf, this));

		// Ribbon
		this.addRibbonIcon('network', 'Open CogniTree', () => {
			void this.activateView();
		});

		// Commands
		this.addCommand({
			id: 'open-panel',
			name: 'Open panel',
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: 'create-tree-from-selection',
			name: 'Create concept tree from selection',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const selection = view?.editor.getSelection().trim();
				if (!selection) return false;
				if (!checking) {
					void this.activateView().then(() => {
						const input = this.treeView?.newInputEl;
						if (input) {
							input.value = selection;
							input.focus();
						}
					});
				}
				return true;
			},
		});
		this.addCommand({
			id: 'refresh-trees',
			name: 'Refresh from vault',
			callback: () => void this.treeView?.refreshAll(),
		});
		this.addCommand({
			id: 'reindex-vault-notes',
			name: 'Reindex vault notes',
			callback: () => void this.reindexNotes(),
		});
		this.addCommand({
			id: 'reindex-semantic',
			name: 'Build semantic index (embeddings)',
			callback: () => void this.reindexSemantic(),
		});
		this.addCommand({
			id: 'review-due-cards',
			name: 'Review due cards',
			checkCallback: (checking) => {
				const view = this.treeView;
				if (!view || !view.hasTree()) return false;
				if (!checking) view.openReview();
				return true;
			},
		});
		this.addCommand({
			id: 'grow-tree-from-vault',
			name: 'Grow a tree from existing vault notes',
			callback: () => void this.activateView().then(() => this.treeView?.openVaultTreeDialog()),
		});
		this.addCommand({
			id: 'close-extra-panels',
			// The UI already shows "CogniTree:" before the command name.
			name: 'Close extra panels',
			// Only offered when there is actually something to clean up.
			checkCallback: (checking) => {
				if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length < 2) return false;
				if (!checking) {
					new Notice(`Closed ${this.closeExtraPanels()} extra CogniTree panel(s).`);
				}
				return true;
			},
		});
		this.addCommand({
			id: 'ask-about-selected',
			name: 'Ask about selected concept',
			checkCallback: (checking) => {
				const view = this.treeView;
				if (!view || !view.hasTree()) return false;
				if (!checking) view.askAboutSelected();
				return true;
			},
		});

		this.addSettingTab(new CogniTreeSettingTab(this));

		// Re-open persisted view after layout is ready (only if the user used it before),
		// but only once the layout has actually finished restoring — checking too
		// early is the other way this view ends up open twice (Obsidian restores
		// the sidebar tab itself, then this code added a second one).
		this.app.workspace.onLayoutReady(() => {
			if (!this.data.lastTree) return;
			window.setTimeout(() => {
				if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length === 0) {
					void this.activateView(false);
				}
			}, 300);
		});
	}

	// ------------------------------------------------------------------ data

	async loadAll(): Promise<void> {
		const data = (await this.loadData()) as PluginData | null;
		this.data = data && typeof data === 'object' ? data : {};
		this.settings = { ...DEFAULT_SETTINGS, ...(this.data.settings ?? {}) };
	}

	async saveSettings(): Promise<void> {
		this.data.settings = this.settings;
		await this.saveDataQuiet();
	}

	/** Persist data without touching the cache's copy semantics. */
	async saveDataQuiet(): Promise<void> {
		await this.saveData(this.data);
	}

	/** Fetch the endpoint's model list and cache it in plugin data. */
	async refreshModels(): Promise<string[]> {
		const ids = await this.generator.api.listModels();
		if (ids.length > 0) {
			this.data.models = ids;
			await this.saveDataQuiet();
		}
		this.treeView?.syncModelSelect();
		return ids;
	}

	/** Switch to a preset provider: set endpoint (+ default model if needed). */
	async applyProvider(id: string): Promise<void> {
		const p = PROVIDERS.find((x) => x.id === id);
		if (!p) return;
		this.settings.modelEndpoint = p.endpoint;
		if (!p.models.includes(this.settings.model)) {
			this.settings.model = p.defaultModel;
		}
		await this.saveSettings();
		this.treeView?.syncProviderSelect();
		this.treeView?.syncModelSelect();
	}

	/** Manually rebuild the vault-note index that powers "Find connections". */
	async reindexNotes(): Promise<void> {
		this.indexer.rebuild();
		new Notice(`Indexed ${this.indexer.noteCount} vault notes.`);
		this.treeView?.refreshStats();
	}

	/**
	 * Embed new/changed vault notes so connection matching and Ask grounding can
	 * use semantic similarity. Incremental and budgeted — re-run to continue.
	 */
	async reindexSemantic(): Promise<number> {
		if (!this.semantic.enabled) {
			new Notice(
				'Set an embedding model in CogniTree settings first (Semantic index).',
				6000
			);
			return 0;
		}
		const notice = new Notice('Building the semantic index…', 0);
		try {
			const res = await this.semantic.indexNotes({
				excludeFolder: this.settings.treeFolder,
				budget: this.settings.embeddingMaxNotes,
				onProgress: (p) => notice.setMessage(p.label),
			});
			notice.hide();
			new Notice(
				`Semantic index: ${res.embedded} note(s) embedded` +
					(res.truncated ? ' (budget reached — run again to continue)' : '') +
					(res.failed ? `, ${res.failed} failed` : '') +
					`. ${this.semantic.size} vector(s) cached.`,
				8000
			);
			this.treeView?.refreshStats();
			return res.embedded;
		} catch (err) {
			notice.hide();
			ConceptGenerator.notice(err);
			return 0;
		}
	}

	// ------------------------------------------------------------------ view

	async activateView(focus = true): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			if (focus) this.app.workspace.setActiveLeaf(existing[0], { focus: true });
			return;
		}
		// Wait for a leaf that is already being created instead of adding another.
		if (this.activation) {
			await this.activation;
			if (focus) {
				const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
				if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
			}
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		this.activation = leaf.setViewState({ type: VIEW_TYPE, active: focus });
		try {
			await this.activation;
		} finally {
			this.activation = null;
		}
		if (focus) this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/**
	 * Detach every CogniTree panel except the first and return how many were
	 * closed. Useful when an older version already saved duplicate tabs into the
	 * workspace layout — Obsidian will keep restoring those until they are closed.
	 */
	closeExtraPanels(): number {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		for (const leaf of leaves.slice(1)) leaf.detach();
		return Math.max(0, leaves.length - 1);
	}

	async openSettings(): Promise<void> {
		// `app.setting` is not part of the public typings; access it through a
		// narrow structural cast so no `any` or eslint-disable is needed.
		const setting = (
			this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }
		).setting;
		setting.open();
		setting.openTabById('cognitree');
	}
}
