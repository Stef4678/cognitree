import { Notice, PluginSettingTab, Setting, type TextComponent } from 'obsidian';
import type CogniTreePlugin from './main';
import { PROVIDERS, curatedModelsFor, providerFor } from './types';

/**
 * Plugin settings per the spec:
 *  - API configuration: apiKey, modelEndpoint, maxTokensPerRequest
 *  - Generation: maxChildrenPerLevel, maxDepth, maxNodesPerBatch
 *  - UI: autoExpandDepth, showComplexity, virtualizeRendering
 *  - Performance: cacheExpiryHours
 */
export class CogniTreeSettingTab extends PluginSettingTab {
	constructor(private plugin: CogniTreePlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		containerEl.createEl('h2', { text: 'CogniTree — Settings' });

		// ---------------------------------------------------------- API
		containerEl.createEl('h3', { text: 'API Configuration' });

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Key for your OpenAI-compatible endpoint. Not required for local providers (Ollama, LM Studio).')
			.addText((t) =>
				t
					.setPlaceholder('sk-…')
					.setValue(s.apiKey)
					.onChange(async (v) => {
						s.apiKey = v.trim();
						await this.plugin.saveSettings();
					})
			)
			.then((setting) => {
				(setting.components[0] as unknown as { inputEl: HTMLInputElement }).inputEl.type =
					'password';
			});

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('Preset endpoint for a popular OpenAI-compatible provider. Pick Custom… to use your own endpoint.')
			.addDropdown((dd) => {
				dd.addOption('__custom__', 'Custom…');
				for (const p of PROVIDERS) dd.addOption(p.id, p.name);
				const prov = providerFor(s.modelEndpoint);
				dd.setValue(prov ? prov.id : '__custom__');
				dd.onChange(async (v) => {
					if (v === '__custom__') return; // keep current endpoint as-is
					await this.plugin.applyProvider(v);
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('Model endpoint')
			.setDesc('Base URL of an OpenAI-compatible chat API (set automatically by the provider presets).')
			.addText((t) =>
				t
					.setPlaceholder('https://api.deepseek.com')
					.setValue(s.modelEndpoint)
					.onChange(async (v) => {
						s.modelEndpoint = v.trim();
						await this.plugin.saveSettings();
						this.plugin.treeView?.syncProviderSelect();
						this.plugin.treeView?.syncModelSelect();
					})
			);

		new Setting(containerEl)
			.setName('Model')
			.setDesc(
				'Models for the selected provider (curated + fetched via GET /models). Choose “Custom…” to type any id.'
			)
			.addDropdown((dd) => {
				const curated = curatedModelsFor(s.modelEndpoint);
				const known = [...new Set([...curated, ...(this.plugin.data.models ?? [])])];
				const isKnown = known.includes(s.model);
				for (const m of known) dd.addOption(m, m);
				dd.addOption('__custom__', 'Custom…');
				dd.setValue(isKnown ? s.model : '__custom__');
				dd.onChange(async (v) => {
					if (v === '__custom__') {
						customRow.style.display = 'block';
						if (customInput) customInput.inputEl.focus();
					} else {
						customRow.style.display = 'none';
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
						this.display();
					})
			);

		// Custom model id (visible when “Custom…” is selected)
		let customInput: TextComponent | null = null;
		const knownForCustom = [
			...new Set([...curatedModelsFor(s.modelEndpoint), ...(this.plugin.data.models ?? [])]),
		];
		const isKnownModel = knownForCustom.includes(s.model);
		const customRow = containerEl.createDiv({ cls: 'ct-custom-row' });
		customRow.style.display = isKnownModel ? 'none' : 'block';
		new Setting(customRow)
			.setName('Custom model id')
			.setDesc('Used when “Custom…” is selected above.')
			.addText((t) => {
				customInput = t;
				t
					.setPlaceholder('my-model-id')
					.setValue(isKnownModel ? '' : s.model);
				t.onChange(async (v) => {
					if (v.trim()) {
						s.model = v.trim();
						await this.plugin.saveSettings();
						this.plugin.treeView?.syncModelSelect();
					}
				});
			});

		new Setting(containerEl)
			.setName('Temperature')
			.setDesc('Sampling temperature for generation (0 = deterministic, 1 = creative).')
			.addSlider((sl) =>
				sl
					.setLimits(0, 1, 0.05)
					.setValue(s.temperature)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.temperature = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Streaming responses')
			.setDesc('Show live streaming text during generation. Disable for simpler debugging.')
			.addToggle((t) =>
				t.setValue(s.streaming).onChange(async (v) => {
					s.streaming = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Max tokens per request')
			.setDesc('Token cap for a single generation call. Default: 4000. Raise it if reasoning models keep hitting the limit.')
			.addText((t) =>
				t
					.setPlaceholder('4000')
					.setValue(String(s.maxTokensPerRequest))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (Number.isFinite(n) && n > 0) {
							s.maxTokensPerRequest = n;
							await this.plugin.saveSettings();
						}
					})
			);

		// ------------------------------------------------------- Generation
		containerEl.createEl('h3', { text: 'Generation Settings' });

		new Setting(containerEl)
			.setName('Max children per level')
			.setDesc('Cap on children generated per expansion. Default: 7.')
			.addText((t) =>
				t
					.setPlaceholder('7')
					.setValue(String(s.maxChildrenPerLevel))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (Number.isFinite(n) && n >= 1 && n <= 15) {
							s.maxChildrenPerLevel = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Max depth')
			.setDesc('Deepest level the plugin will auto-expand to. Default: 10.')
			.addText((t) =>
				t
					.setPlaceholder('10')
					.setValue(String(s.maxDepth))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (Number.isFinite(n) && n >= 1 && n <= 50) {
							s.maxDepth = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Max nodes per batch')
			.setDesc('Node budget for a single batch expansion. Default: 100.')
			.addText((t) =>
				t
					.setPlaceholder('100')
					.setValue(String(s.maxNodesPerBatch))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (Number.isFinite(n) && n >= 10 && n <= 500) {
							s.maxNodesPerBatch = n;
							await this.plugin.saveSettings();
						}
					})
			);

		// ------------------------------------------------------------- UI
		containerEl.createEl('h3', { text: 'UI Settings' });

		new Setting(containerEl)
			.setName('Auto-expand depth')
			.setDesc('Levels expanded automatically when a tree opens (no API calls). Default: 1.')
			.addText((t) =>
				t
					.setPlaceholder('1')
					.setValue(String(s.autoExpandDepth))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (Number.isFinite(n) && n >= 0 && n <= 10) {
							s.autoExpandDepth = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Show complexity badges')
			.setDesc('Display Beginner/Intermediate/Advanced indicators in the tree.')
			.addToggle((t) =>
				t.setValue(s.showComplexity).onChange(async (v) => {
					s.showComplexity = v;
					await this.plugin.saveSettings();
					this.plugin.treeView?.render();
				})
			);

		new Setting(containerEl)
			.setName('Virtualize rendering')
			.setDesc('Only render the rows visible in the viewport. Recommended for tens of thousands of nodes.')
			.addToggle((t) =>
				t.setValue(s.virtualizeRendering).onChange(async (v) => {
					s.virtualizeRendering = v;
					await this.plugin.saveSettings();
					this.plugin.treeView?.render();
				})
			);

		// ------------------------------------------------------- Performance
		containerEl.createEl('h3', { text: 'Performance & Storage' });

		new Setting(containerEl)
			.setName('Cache expiry (hours)')
			.setDesc('How long generated results are cached. Set 0 to disable caching. Default: 24.')
			.addText((t) =>
				t
					.setPlaceholder('24')
					.setValue(String(s.cacheExpiryHours))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (Number.isFinite(n) && n >= 0) {
							s.cacheExpiryHours = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Tree folder')
			.setDesc('Vault folder that stores generated concept trees.')
			.addText((t) =>
				t
					.setPlaceholder('CogniTree')
					.setValue(s.treeFolder)
					.onChange(async (v) => {
						s.treeFolder = v.trim() || 'CogniTree';
						await this.plugin.saveSettings();
						this.plugin.indexer?.init(s.treeFolder);
					})
			);

		// ----------------------------------------------------------- Actions
		containerEl.createEl('h3', { text: 'Data' });

		new Setting(containerEl)
			.setName('Clear response cache')
			.setDesc(`Currently ${this.plugin.cache?.size ?? 0} cached generations. Cached results reduce API cost.`)
			.addButton((b) =>
				b
					.setButtonText('Clear cache')
					.onClick(async () => {
						await this.plugin.cache?.clear();
						new Notice('CogniTree cache cleared.');
						this.display();
					})
			);
	}
}
