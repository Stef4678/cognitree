import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import type {
	ChildConcept,
	DiscoveryResult,
	TreeNode,
	TreeModel,
} from './types';
import {
	isoTime,
	normalizeComplexity,
	normalizeKey,
	parseSimpleYaml,
	sanitizeFileName,
	slugify,
	toBool,
	toInt,
	yamlStr,
	yamlStrArray,
} from './parser';
import { cachedFrontmatter } from './indexer';

/**
 * Markdown storage layer.
 *
 * Every concept is one note:  CogniTree/<root>/<sanitized name>.md
 * Frontmatter holds the node metadata (parent, domain, complexity,
 * children, connections, path…); the body holds the human-readable
 * description and a `## Connections` section of wikilinks.
 *
 * Trees are loaded lazily from metadataCache frontmatter (no full-file
 * reads even for tens of thousands of nodes); a raw parse is the fallback
 * only when Obsidian hasn't indexed a file yet.
 */
export class ConceptStore {
	private _baseFolder = 'CogniTree';

	constructor(private app: App) {}

	get baseFolder(): string {
		return this._baseFolder;
	}

	setBaseFolder(folder: string): void {
		const f = (folder || 'CogniTree').replace(/^\/+|\/+$/g, '');
		if (f) this._baseFolder = f;
	}

	private treeFolder(rootName: string): string {
		return `${this._baseFolder}/${sanitizeFileName(rootName)}`;
	}

	async ensureBaseFolder(): Promise<void> {
		if (!(await this.app.vault.adapter.exists(this._baseFolder))) {
			await this.app.vault.createFolder(this._baseFolder);
		}
	}

	/** All tree root names currently stored under the base folder. */
	async listTrees(): Promise<string[]> {
		if (!(await this.app.vault.adapter.exists(this._baseFolder))) return [];
		try {
			const listed = await this.app.vault.adapter.list(this._baseFolder);
			return listed.folders
				.map((f) => f.split('/').pop() ?? '')
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b));
		} catch {
			return [];
		}
	}

	async treeExists(rootName: string): Promise<boolean> {
		return this.app.vault.adapter.exists(this.treeFolder(rootName));
	}

	/** Load a whole tree from vault notes (frontmatter via metadataCache). */
	async loadTree(rootName: string): Promise<TreeModel | null> {
		const folder = this.treeFolder(rootName);
		if (!(await this.app.vault.adapter.exists(folder))) return null;

		const nodes = new Map<string, TreeNode>();
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(folder + '/'));

		for (const file of files) {
			// Prefer the metadataCache (cheap); fall back to a raw parse for
			// notes Obsidian hasn't indexed yet (e.g. just written by us).
			let fm = cachedFrontmatter(this.app.metadataCache, file);
			if (!fm) {
				fm = await this.readRawFrontmatter(file);
			}
			const name =
				(typeof fm.concept === 'string' && fm.concept.trim()) ||
				(typeof fm.name === 'string' && fm.name.trim()) ||
				file.basename;
			const node = this.frontmatterToNode(name, fm, file.path);
			nodes.set(node.name, node);
		}

		if (nodes.size === 0) return null;
		let root = nodes.has(rootName) ? rootName : '';
		if (!root) {
			const parentless = [...nodes.values()].find((n) => n.parent === null);
			if (parentless) root = parentless.name;
		}
		if (!root) return null;
		return { root, folder, nodes, updatedAt: Date.now() };
	}

	private async readRawFrontmatter(file: TFile): Promise<Record<string, unknown>> {
		try {
			const content = await this.app.vault.cachedRead(file);
			const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
			if (!m) return {};
			return parseSimpleYaml(m[1]);
		} catch {
			return {};
		}
	}

	private frontmatterToNode(name: string, fm: Record<string, unknown>, filePath: string): TreeNode {
		const base = this._baseFolder;
		const rest = filePath.startsWith(base + '/') ? filePath.slice(base.length + 1) : filePath;
		const treeRoot = String(fm.tree ?? rest.split('/')[0] ?? '');
		return {
			name,
			parent: fm.parent ? String(fm.parent) : null,
			domain: fm.domain ? String(fm.domain) : undefined,
			description: fm.description ? String(fm.description) : '',
			complexity: normalizeComplexity(fm.complexity),
			canExpand: toBool(fm.can_expand, true),
			estimatedDepth: toInt(fm.estimated_depth, 3),
			connections: this.strArray(fm.connections),
			children: this.strArray(fm.children),
			path: fm.path ? String(fm.path) : `/${slugify(name)}`,
			created: toInt(fm.created, 0),
			file: filePath,
			treeRoot,
			expanded: false,
			loading: false,
		};
	}

	private strArray(v: unknown): string[] {
		if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
		if (typeof v === 'string' && v.trim()) return [v.trim()];
		return [];
	}

	/** Build a note's full markdown content. */
	noteContent(node: TreeNode): string {
		const lines: string[] = [];
		lines.push('---');
		lines.push(`concept: ${yamlStr(node.name)}`);
		lines.push(`tree: ${yamlStr(node.treeRoot)}`);
		if (node.parent) lines.push(`parent: ${yamlStr(node.parent)}`);
		if (node.domain) lines.push(`domain: ${yamlStr(node.domain)}`);
		lines.push(`description: ${yamlStr(node.description)}`);
		lines.push(`complexity: ${yamlStr(node.complexity)}`);
		lines.push(`can_expand: ${node.canExpand}`);
		lines.push(`estimated_depth: ${node.estimatedDepth}`);
		lines.push(`connections: ${yamlStrArray(node.connections)}`);
		lines.push(`children: ${yamlStrArray(node.children)}`);
		lines.push(`path: ${yamlStr(node.path)}`);
		lines.push(`created: ${node.created ? isoTime(node.created) : isoTime(Date.now())}`);
		lines.push('---');
		lines.push('');
		lines.push(`# ${node.name}`);
		lines.push('');
		lines.push(node.description || '_No description yet._');
		lines.push('');
		lines.push('## Connections');
		if (node.connections.length > 0) {
			for (const c of node.connections) lines.push(`- [[${c}]]`);
		} else {
			lines.push('_Use "Find connections" to link this concept to the rest of your vault._');
		}
		lines.push('');
		lines.push('## Meta');
		if (node.parent) lines.push(`- **Parent**: [[${node.parent}]]`);
		if (node.domain) lines.push(`- **Domain**: ${node.domain}`);
		lines.push(`- **Complexity**: ${node.complexity}`);
		lines.push(`- **Expandable**: ${node.canExpand ? 'Yes' : 'No'}`);
		lines.push(`- **Estimated depth**: ${node.estimatedDepth}`);
		lines.push('');
		return lines.join('\n');
	}

	/** Write a node note (create or overwrite in place). */
	async writeNode(node: TreeNode): Promise<string> {
		let file = node.file;
		if (!file) file = await this.resolveFileFor(node);
		const content = this.noteContent(node);
		const existing = this.app.vault.getAbstractFileByPath(file);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.ensureTreeFolder(node);
			await this.app.vault.create(file, content);
		}
		node.file = file;
		return file;
	}

	private async ensureTreeFolder(node: TreeNode): Promise<void> {
		const folder = this.treeFolder(node.treeRoot);
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}
	}

	private async resolveFileFor(node: TreeNode): Promise<string> {
		const folder = this.treeFolder(node.treeRoot);
		const stem = sanitizeFileName(node.name);
		let file = `${folder}/${stem}.md`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(file) instanceof TFile && n < 1000) {
			file = `${folder}/${stem} (${n}).md`;
			n++;
		}
		return file;
	}

	/**
	 * Persist a DiscoveryResult as a new tree: root note + domain children.
	 * Returns the actual root display name, created nodes and skipped dupes.
	 */
	async createDiscoveryTree(
		result: DiscoveryResult,
		baseFolder: string
	): Promise<{ root: string; created: TreeNode[]; skipped: string[] }> {
		this.setBaseFolder(baseFolder);
		const rootName = titleTrim(result.concept || 'Concept');
		await this.ensureBaseFolder();
		const folder = this.treeFolder(rootName);
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}

		const now = Date.now();
		const created: TreeNode[] = [];
		const skipped: string[] = [];
		const seen = new Set<string>([normalizeKey(rootName)]);
		const rootPath = `/${slugify(rootName)}`;

		const rootNode: TreeNode = {
			name: rootName,
			parent: null,
			description: `Root concept of the ${rootName} knowledge tree.`,
			complexity: 'Beginner',
			canExpand: true,
			estimatedDepth: 10,
			connections: [],
			children: [],
			path: rootPath,
			created: now,
			file: '',
			treeRoot: rootName,
			expanded: false,
			loading: false,
		};

		for (const domain of result.domains || []) {
			const domainName = titleTrim(domain.name || 'Domain');
			for (const child of domain.children || []) {
				const childName = titleTrim(child.name || '');
				if (!childName) continue;
				const key = normalizeKey(childName);
				if (seen.has(key)) {
					skipped.push(childName);
					continue;
				}
				seen.add(key);
				const node: TreeNode = {
					name: childName,
					parent: rootName,
					domain: domainName,
					description: child.description || '',
					complexity: normalizeComplexity(child.complexity),
					canExpand: toBool(child.can_expand, true),
					estimatedDepth: toInt(child.estimated_depth, 4),
					connections: (child.connections || []).filter(Boolean),
					children: [],
					path: `${rootPath}/${slugify(domainName)}/${slugify(childName)}`,
					created: now,
					file: '',
					treeRoot: rootName,
					expanded: false,
					loading: false,
				};
				rootNode.children.push(childName);
				created.push(node);
			}
		}

		rootNode.file = await this.writeNode(rootNode);
		for (const node of created) {
			node.file = await this.writeNode(node);
		}
		await this.writeNode(rootNode); // final children list
		return { root: rootName, created, skipped };
	}

	/** Add children to an existing parent node; returns created + skipped names. */
	async addChildren(
		parent: TreeNode,
		children: ChildConcept[],
		baseFolder: string,
		knownNames: Map<string, TreeNode>,
		domainOverride?: string
	): Promise<{ created: TreeNode[]; skipped: string[] }> {
		this.setBaseFolder(baseFolder);
		const now = Date.now();
		const created: TreeNode[] = [];
		const skipped: string[] = [];
		const seen = new Set<string>([
			normalizeKey(parent.name),
			...parent.children.map(normalizeKey),
			...[ ...knownNames.keys() ].map(normalizeKey),
		]);

		for (const child of children || []) {
			const childName = titleTrim(child.name || '');
			if (!childName) continue;
			const key = normalizeKey(childName);
			if (seen.has(key)) {
				skipped.push(childName);
				continue;
			}
			seen.add(key);
			const node: TreeNode = {
				name: childName,
				parent: parent.name,
				domain: domainOverride ?? parent.domain,
				description: child.description || '',
				complexity: normalizeComplexity(child.complexity),
				canExpand: toBool(child.can_expand, true),
				estimatedDepth: toInt(child.estimated_depth, 3),
				connections: (child.connections || []).filter(Boolean),
				children: [],
				path: `${parent.path}/${slugify(childName)}`,
				created: now,
				file: '',
				treeRoot: parent.treeRoot,
				expanded: false,
				loading: false,
			};
			parent.children.push(childName);
			created.push(node);
		}

		for (const node of created) {
			node.file = await this.writeNode(node);
		}
		await this.writeNode(parent);
		return { created, skipped };
	}

	/** Append a wikilink to a node note's Connections section. Returns false if already linked. */
	async addConnectionLink(node: TreeNode, linkName: string): Promise<boolean> {
		if (node.connections.some((c) => normalizeKey(c) === normalizeKey(linkName))) {
			return false;
		}
		node.connections.push(linkName);
		await this.writeNode(node);
		return true;
	}

	/**
	 * Merge the duplicate `source` subtree into `target` (in `targetModel`):
	 * descendant notes move into the target tree re-parented under `target`,
	 * and `source`'s children are absorbed into `target`'s children (deduped).
	 * The source root's note is deleted. Skips descendants whose filename
	 * would collide with an existing target-tree note (avoids overwrites).
	 */
	async mergeSubtree(
		source: TreeModel,
		sourceName: string,
		target: TreeModel,
		targetName: string
	): Promise<{ moved: number; skipped: string[] }> {
		const node = source.nodes.get(sourceName);
		const targetNode = target.nodes.get(targetName);
		if (!node || !targetNode) return { moved: 0, skipped: [`"${sourceName}" not found`] };

		const moved: TreeNode[] = [];
		const skipped: string[] = [];
		for (const d of this.collectSubtree(source, sourceName)) {
			if (d === node) continue;
			const rel = d.path.startsWith(node.path)
				? d.path.slice(node.path.length)
				: `/${slugify(d.name)}`;
			const newFile = `${target.folder}/${sanitizeFileName(d.name)}.md`;
			if (this.app.vault.getAbstractFileByPath(newFile) instanceof TFile) {
				skipped.push(d.name);
				continue;
			}
			const oldFile = d.file;
			d.treeRoot = targetNode.treeRoot;
			d.parent = d.parent === node.name ? targetNode.name : d.parent;
			d.path = `${targetNode.path}${rel}`;
			d.file = newFile;
			await this.app.vault.create(newFile, this.noteContent(d));
			const old = this.app.vault.getAbstractFileByPath(oldFile);
			if (old instanceof TFile) await this.app.vault.delete(old);
			moved.push(d);
		}

		// Absorb source children into the target (dedup by normalized name).
		const have = new Set(targetNode.children.map(normalizeKey));
		const movedNames = new Set(moved.map((n) => n.name));
		for (const c of node.children) {
			const k = normalizeKey(c);
			if (have.has(k)) continue;
			// Only keep children whose note now actually lives in the target tree.
			if (movedNames.has(c) || target.nodes.has(c)) {
				targetNode.children.push(c);
				have.add(k);
			}
		}
		await this.writeNode(targetNode);

		// Remove source from its parent's children and delete the duplicate note.
		if (node.parent) {
			const p = source.nodes.get(node.parent);
			if (p) {
				p.children = p.children.filter((c) => c !== node.name);
				await this.writeNode(p);
			}
		}
		const dupFile = this.app.vault.getAbstractFileByPath(node.file);
		if (dupFile instanceof TFile) await this.app.vault.delete(dupFile);

		return { moved: moved.length, skipped };
	}

	/** Collect a node plus all descendants (recursive). */
	collectSubtree(model: TreeModel, name: string): TreeNode[] {
		const out: TreeNode[] = [];
		const visit = (n: string) => {
			const node = model.nodes.get(n);
			if (!node) return;
			out.push(node);
			for (const c of node.children) visit(c);
		};
		visit(name);
		return out;
	}

	/** Delete a node and its descendants from the vault; returns deleted count. */
	async deleteSubtree(model: TreeModel, name: string): Promise<number> {
		const nodes = this.collectSubtree(model, name);
		const parent = model.nodes.get(name)?.parent;
		for (const node of nodes) {
			const file = this.app.vault.getAbstractFileByPath(node.file);
			if (file instanceof TFile) {
				await this.app.vault.delete(file, true);
			}
		}
		if (parent) {
			const p = model.nodes.get(parent);
			if (p) {
				p.children = p.children.filter((c) => c !== name);
				await this.writeNode(p);
			}
		}
		model.nodes.delete(name);
		return nodes.length;
	}

	/** Open the backing note in a new tab. */
	async openNote(node: TreeNode): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(node.file);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(true).openFile(file);
		} else {
			new Notice(`Note not found: ${node.file}`);
		}
	}

	/** Write a brand-new note for a concept that doesn't exist yet (from connection suggestions). */
	async createOrphanNote(
		conceptName: string,
		baseFolder: string,
		treeRoot?: string,
		parentConcept?: string
	): Promise<TFile | null> {
		this.setBaseFolder(baseFolder);
		await this.ensureBaseFolder();
		const folder = treeRoot ? this.treeFolder(treeRoot) : this._baseFolder;
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}
		const stem = sanitizeFileName(conceptName);
		let file = `${folder}/${stem}.md`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(file) instanceof TFile && n < 1000) {
			file = `${folder}/${stem} (${n}).md`;
			n++;
		}
		const node: TreeNode = {
			name: conceptName,
			parent: parentConcept ?? null,
			domain: undefined,
			description: 'Created from a CogniTree connection suggestion.',
			complexity: 'Beginner',
			canExpand: true,
			estimatedDepth: 3,
			connections: parentConcept ? [parentConcept] : [],
			children: [],
			path: `/${slugify(conceptName)}`,
			created: Date.now(),
			file,
			treeRoot: treeRoot ?? conceptName,
			expanded: false,
			loading: false,
		};
		const content = this.noteContent(node);
		await this.app.vault.create(file, content);
		return this.app.vault.getAbstractFileByPath(file) as TFile;
	}
}

function titleTrim(s: string): string {
	const t = String(s ?? '').trim().replace(/\s+/g, ' ');
	return t || 'Concept';
}
