import {
	Notice,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	type SettingDefinitionRender,
	type TextComponent,
} from 'obsidian';
import type CogniTreePlugin from './main';
import { PROVIDERS, curatedModelsFor, providerFor } from './types';

/**
 * Plugin settings per the spec:
 *  - API configuration: apiKey, modelEndpoint, maxTokensPerRequest
 *  - Generation: maxChildrenPerLevel, maxDepth, maxNodesPerBatch
 *  - UI: autoExpandDepth, showComplexity, virtualizeRendering
 *  - Performance: cacheExpiryHours
 *
 * Declarative settings (Obsidian docs "Migrate to declarative settings",
 * Path A): the tab renders entirely from `getSettingDefinitions()`, which
 * also powers Obsidian's settings search. Requires Obsidian >= 1.13
 * (see manifest.json minAppVersion); the legacy `display()` override is
 * intentionally not used.
 */
export class CogniTreeSettingTab extends PluginSettingTab {
	constructor(private plugin: CogniTreePlugin) {
		super(plugin.app, plugin);
	}

	/** Declarative definitions — rendered by Obsidian >= 1.13. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const def = (
			name: string,
			desc: string,
			build: (setting: Setting) => void
		): SettingDefinitionRender => ({
			name,
			desc,
			render: (setting) => build(setting),
		});
		return [
			{
				type: 'group',
				heading: 'Configuration',
				items: [
					def('API key', 'Key for your OpenAI-compatible endpoint. Not required for local providers (Ollama, LM Studio).', (s) => this.buildApiKeyRow(s)),
					def('Provider', 'Preset endpoint for a popular OpenAI-compatible provider. Pick Custom… to use your own endpoint.', (s) => this.buildProviderRow(s)),
					def('Model endpoint', 'Base URL of an OpenAI-compatible chat API (set automatically by the provider presets).', (s) => this.buildEndpointRow(s)),
					def('Model', 'Models for the selected provider (curated + fetched via GET /models). Choose “Custom…” to type any id.', (s) => this.buildModelRow(s)),
					def('Temperature', 'Sampling temperature for generation (0 = deterministic, 1 = creative).', (s) => this.buildTemperatureRow(s)),
					def('Streaming responses', 'Show live streaming text during generation. Disable for simpler debugging.', (s) => this.buildStreamingRow(s)),
					def('Max tokens per request', 'Token cap for a single generation call. Default: 4000. Raise it if reasoning models keep hitting the limit.', (s) => this.buildMaxTokensRow(s)),
				],
			},
			{
				type: 'group',
				heading: 'Generation',
				items: [
					def('Max children per level', 'Cap on children generated per expansion. Default: 7.', (s) => this.buildMaxChildrenRow(s)),
					def('Max depth', 'Deepest level the plugin will auto-expand to. Default: 10.', (s) => this.buildMaxDepthRow(s)),
					def('Max nodes per batch', 'Node budget for a single batch expansion. Default: 100.', (s) => this.buildMaxNodesRow(s)),
				],
			},
			{
				type: 'group',
				heading: 'UI',
				items: [
					def('Auto-expand depth', 'Levels expanded automatically when a tree opens (no API calls). Default: 1.', (s) => this.buildAutoExpandRow(s)),
					def('Show complexity badges', 'Display Beginner/Intermediate/Advanced indicators in the tree.', (s) => this.buildComplexityRow(s)),
					def('Virtualize rendering', 'Only render the rows visible in the viewport. Recommended for tens of thousands of nodes.', (s) => this.buildVirtualizeRow(s)),
				],
			},
			{
				type: 'group',
				heading: 'Performance & Storage',
				items: [
					def('Cache expiry (hours)', 'How long generated results are cached. Set 0 to disable caching. Default: 24.', (s) => this.buildCacheExpiryRow(s)),
					def('Tree folder', 'Vault folder that stores generated concept trees.', (s) => this.buildTreeFolderRow(s)),
				],
			},
			{
				type: 'group',
				heading: 'Data',
				items: [
					def('Clear response cache', `Currently ${this.plugin.cache?.size ?? 0} cached generations. Cached results reduce API cost.`, (s) => this.buildClearCacheRow(s)),
				],
			},
		];
	}

	// -------------------------------------------------------------- builders

	private buildApiKeyRow(setting: Setting): void {
		setting
			.setName('API key')
			.setDesc('Key for your OpenAI-compatible endpoint. Not required for local providers (Ollama, LM Studio).')
			.addText((t) =>
				t
					.setPlaceholder('sk-…')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (v) => {
						this.plugin.settings.apiKey = v.trim();
						await this.plugin.saveSettings();
					})
			)
			.then((s) => {
				(s.components[0] as unknown as { inputEl: HTMLInputElement }).inputEl.type =
					'password';
			});
	}

	private buildProviderRow(setting: Setting): void {
		setting
			.setName('Provider')
			.setDesc('Preset endpoint for a popular OpenAI-compatible provider. Pick Custom… to use your own endpoint.')
			.addDropdown((dd) => {
				dd.addOption('__custom__', 'Custom…');
				for (const p of PROVIDERS) dd.addOption(p.id, p.name);
				const prov = providerFor(this.plugin.settings.modelEndpoint);
				dd.setValue(prov ? prov.id : '__custom__');
				dd.onChange(async (v) => {
					if (v === '__custom__') return; // keep current endpoint as-is
					await this.plugin.applyProvider(v);
					this.update();
				});
			});
	}

	private buildEndpointRow(setting: Setting): void {
		setting
			.setName('Model endpoint')
			.setDesc('Base URL of an OpenAI-compatible chat API (set automatically by the provider presets).')
			.addText((t) =>
				t
					.setPlaceholder('https://api.deepseek.com')
					.setValue(this.plugin.settings.modelEndpoint)
					.onChange(async (v) => {
						this.plugin.settings.modelEndpoint = v.trim();
						await this.plugin.saveSettings();
						this.plugin.treeView?.syncProviderSelect();
						this.plugin.treeView?.syncModelSelect();
					})
			);
	}

	private buildModelRow(setting: Setting): void {
		const s = this.plugin.settings;
		let customInput: TextComponent | null = null;
		const known = [
			...new Set([...curatedModelsFor(s.modelEndpoint), ...(this.plugin.data.models ?? [])]),
		];
		const isKnown = known.includes(s.model);
		// The custom-model row is appended right below the model setting.
		const container = setting.settingEl.parentElement ?? setting.settingEl;

		setting
			.setName('Model')
			.setDesc(
				'Models for the selected provider (curated + fetched via GET /models). Choose “Custom…” to type any id.'
			)
			.addDropdown((dd) => {
				for (const m of known) dd.addOption(m, m);
				dd.addOption('__custom__', 'Custom…');
				dd.setValue(isKnown ? s.model : '__custom__');
				dd.onChange(async (v) => {
					if (v === '__custom__') {
						customRow.toggleClass('ct-hidden', false);
						if (customInput) customInput.inputEl.focus();
					} else {
						customRow.toggleClass('ct-hidden', true);
						s.model = v;
						await this.plugin.saveSettings();
						this.plugin.treeView?.syncModelSelect();
					}
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon('refresh-cw')
					.setTooltip('Refresh model list from the endpoint')
					.onClick(async () => {
						const ids = await this.plugin.refreshModels();
						new Notice(
							ids.length > 0
								? `Found ${ids.length} models on this endpoint.`
								: 'Could not fetch models — the endpoint may not expose GET /models (e.g. Ollama). Custom ids still work.'
						);
						this.update();
					})
			);

		// Custom model id (visible when “Custom…” is selected)
		const customRow = container.createDiv({ cls: 'ct-custom-row' });
		customRow.toggleClass('ct-hidden', isKnown);
		new Setting(customRow)
			.setName('Custom model id')
			.setDesc('Used when “Custom…” is selected above.')
			.addText((t) => {
				customInput = t;
				t
					.setPlaceholder('my-model-id')
					.setValue(isKnown ? '' : s.model);
				t.onChange(async (v) => {
					if (v.trim()) {
						s.model = v.trim();
						await this.plugin.saveSettings();
						this.plugin.treeView?.syncModelSelect();
					}
				});
			});
	}

	private buildTemperatureRow(setting: Setting): void {
		setting
			.setName('Temperature')
			.setDesc('Sampling temperature for generation (0 = deterministic, 1 = creative).')
			.addSlider((sl) =>
				sl
					.setLimits(0, 1, 0.05)
					.setValue(this.plugin.settings.temperature)
					.onChange(async (v) => {
						this.plugin.settings.temperature = v;
						await this.plugin.saveSettings();
					})
			);
	}

	private buildStreamingRow(setting: Setting): void {
		setting
			.setName('Streaming responses')
			.setDesc('Show live streaming text during generation. Disable for simpler debugging.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.streaming).onChange(async (v) => {
					this.plugin.settings.streaming = v;
					await this.plugin.saveSettings();
				})
			);
	}

	/** Numeric text rows with parse + range validation (shared by several settings). */
	private buildNumberRow(
		setting: Setting,
		name: string,
		desc: string,
		placeholder: string,
		min: number,
		max: number,
		get: () => number,
		set: (n: number) => void
	): void {
		setting
			.setName(name)
			.setDesc(desc)
			.addText((t) =>
				t
					.setPlaceholder(placeholder)
					.setValue(String(get()))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (Number.isFinite(n) && n >= min && n <= max) {
							set(n);
							await this.plugin.saveSettings();
						}
					})
			);
	}

	private buildMaxTokensRow(setting: Setting): void {
		this.buildNumberRow(
			setting,
			'Max tokens per request',
			'Token cap for a single generation call. Default: 4000. Raise it if reasoning models keep hitting the limit.',
			'4000',
			1,
			Number.MAX_SAFE_INTEGER,
			() => this.plugin.settings.maxTokensPerRequest,
			(n) => (this.plugin.settings.maxTokensPerRequest = n)
		);
	}

	private buildMaxChildrenRow(setting: Setting): void {
		this.buildNumberRow(
			setting,
			'Max children per level',
			'Cap on children generated per expansion. Default: 7.',
			'7',
			1,
			15,
			() => this.plugin.settings.maxChildrenPerLevel,
			(n) => (this.plugin.settings.maxChildrenPerLevel = n)
		);
	}

	private buildMaxDepthRow(setting: Setting): void {
		this.buildNumberRow(
			setting,
			'Max depth',
			'Deepest level the plugin will auto-expand to. Default: 10.',
			'10',
			1,
			50,
			() => this.plugin.settings.maxDepth,
			(n) => (this.plugin.settings.maxDepth = n)
		);
	}

	private buildMaxNodesRow(setting: Setting): void {
		this.buildNumberRow(
			setting,
			'Max nodes per batch',
			'Node budget for a single batch expansion. Default: 100.',
			'100',
			10,
			500,
			() => this.plugin.settings.maxNodesPerBatch,
			(n) => (this.plugin.settings.maxNodesPerBatch = n)
		);
	}

	private buildAutoExpandRow(setting: Setting): void {
		this.buildNumberRow(
			setting,
			'Auto-expand depth',
			'Levels expanded automatically when a tree opens (no API calls). Default: 1.',
			'1',
			0,
			10,
			() => this.plugin.settings.autoExpandDepth,
			(n) => (this.plugin.settings.autoExpandDepth = n)
		);
	}

	private buildComplexityRow(setting: Setting): void {
		setting
			.setName('Show complexity badges')
			.setDesc('Display Beginner/Intermediate/Advanced indicators in the tree.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showComplexity).onChange(async (v) => {
					this.plugin.settings.showComplexity = v;
					await this.plugin.saveSettings();
					this.plugin.treeView?.render();
				})
			);
	}

	private buildVirtualizeRow(setting: Setting): void {
		setting
			.setName('Virtualize rendering')
			.setDesc('Only render the rows visible in the viewport. Recommended for tens of thousands of nodes.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.virtualizeRendering).onChange(async (v) => {
					this.plugin.settings.virtualizeRendering = v;
					await this.plugin.saveSettings();
					this.plugin.treeView?.render();
				})
			);
	}

	private buildCacheExpiryRow(setting: Setting): void {
		this.buildNumberRow(
			setting,
			'Cache expiry (hours)',
			'How long generated results are cached. Set 0 to disable caching. Default: 24.',
			'24',
			0,
			Number.MAX_SAFE_INTEGER,
			() => this.plugin.settings.cacheExpiryHours,
			(n) => (this.plugin.settings.cacheExpiryHours = n)
		);
	}

	private buildTreeFolderRow(setting: Setting): void {
		setting
			.setName('Tree folder')
			.setDesc('Vault folder that stores generated concept trees.')
			.addText((t) =>
				t
					.setPlaceholder('CogniTree')
					.setValue(this.plugin.settings.treeFolder)
					.onChange(async (v) => {
						this.plugin.settings.treeFolder = v.trim() || 'CogniTree';
						await this.plugin.saveSettings();
						this.plugin.indexer?.init(this.plugin.settings.treeFolder);
					})
			);
	}

	private buildClearCacheRow(setting: Setting): void {
		setting
			.setName('Clear response cache')
			.setDesc(`Currently ${this.plugin.cache?.size ?? 0} cached generations. Cached results reduce API cost.`)
			.addButton((b) =>
				b
					.setButtonText('Clear cache')
					.onClick(async () => {
						await this.plugin.cache?.clear();
						new Notice('CogniTree cache cleared.');
						this.update();
					})
			);
	}
}
