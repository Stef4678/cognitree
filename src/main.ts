import { MarkdownView, Notice, Plugin } from 'obsidian';
import { ResponseCache } from './cache';
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
	treeView: ConceptTreeView | null = null;

	async onload(): Promise<void> {
		await this.loadAll();

		this.store = new ConceptStore(this.app);
		this.store.setBaseFolder(this.settings.treeFolder);
		this.indexer = new VaultIndexer(this.app);
		this.indexer.init(this.settings.treeFolder);
		this.cache = new ResponseCache(
			() => Promise.resolve(this.data),
			() => this.saveData(this.data),
			() => this.settings
		);
		await this.cache.loadFromDisk();
		this.generator = new ConceptGenerator(
			this.app,
			this.store,
			this.indexer,
			() => this.settings,
			this.cache
		);

		// View
		this.registerView(VIEW_TYPE, (leaf) => {
			this.treeView = new ConceptTreeView(leaf, this);
			return this.treeView;
		});

		// Ribbon
		this.addRibbonIcon('network', 'Open CogniTree', () => {
			void this.activateView();
		});

		// Commands
		this.addCommand({
			id: 'open-cognitree',
			name: 'Open CogniTree panel',
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
			name: 'Refresh CogniTree from vault',
			callback: () => void this.treeView?.refreshAll(),
		});
		this.addCommand({
			id: 'reindex-vault-notes',
			name: 'Reindex vault notes',
			callback: () => void this.reindexNotes(),
		});

		this.addSettingTab(new CogniTreeSettingTab(this));

		// Re-open persisted view after layout is ready (only if the user used it before).
		this.app.workspace.onLayoutReady(() => {
			if (this.data.lastTree && this.app.workspace.getLeavesOfType(VIEW_TYPE).length === 0) {
				void this.activateView(false);
			}
		});
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
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

	// ------------------------------------------------------------------ view

	async activateView(focus = true): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			if (focus) this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE, active: focus });
		if (focus) this.app.workspace.revealLeaf(leaf);
	}

	async openSettings(): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(this.app as any).setting.open();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(this.app as any).setting.openTabById('cognitree');
	}
}
