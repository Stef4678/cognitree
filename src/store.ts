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
import {
	DEEP_DIVE_HEADING,
	DEEP_DIVE_MARKER,
	extractDeepDive,
	sanitizeDeepDive,
} from './notebody';
import { cachedFrontmatter } from './indexer';
import { ApiError } from './api';
import { REVIEW_DATA_VERSION, newReviewData, type ReviewData } from './review';

/** Options for `ConceptStore.writeNode`. */
export interface WriteNodeOptions {
	/**
	 * Deep-dive Markdown to write (`null` removes the region). Omit to carry
	 * over whatever the note already contains.
	 */
	deepDive?: string | null;
}

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
			// Nodes are keyed by concept name, so two notes claiming the same
			// concept (a "Name (2).md" leftover, a hand-duplicated note, two
			// trees sharing a sanitized folder name) would silently shadow each
			// other. Keep the canonical file and warn instead of losing a note
			// without a trace.
			const existing = nodes.get(node.name);
			if (existing) {
				const keepNew = !matchStem(existing.file, node.name) && matchStem(file.path, node.name);
				console.warn(
					`CogniTree: "${file.path}" duplicates the concept "${node.name}" already loaded from "${existing.file}"` +
						(keepNew ? ' — keeping the canonical filename.' : ' — keeping the first one.')
				);
				if (!keepNew) continue;
			}
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
			deepened: toInt(fm.deepened, 0),
			source: fm.source ? String(fm.source) : undefined,
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
	noteContent(node: TreeNode, deepDive: string | null = null): string {
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
		if (node.source) lines.push(`source: ${yamlStr(node.source)}`);
		if (node.deepened) lines.push(`deepened: ${isoTime(node.deepened)}`);
		lines.push(`created: ${node.created ? isoTime(node.created) : isoTime(Date.now())}`);
		lines.push('---');
		lines.push('');
		lines.push(`# ${node.name}`);
		lines.push('');
		// A reference node points at a note the user already owns.
		if (node.source) {
			lines.push(`> Source note: [[${node.source.replace(/\.md$/, '')}]]`);
			lines.push('');
		}
		lines.push(node.description || '_No description yet._');
		lines.push('');
		if (deepDive) {
			lines.push(DEEP_DIVE_HEADING);
			lines.push(DEEP_DIVE_MARKER);
			lines.push(deepDive.trim());
			lines.push('');
		}
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

	/**
	 * Write a node note (create or overwrite in place).
	 *
	 * The note body is rebuilt from the model, so the generated deep dive is
	 * read back from the existing file and carried over — otherwise every
	 * connection link or child expansion would silently delete it. Pass
	 * `deepDive: null` to remove the region, or a string to replace it.
	 */
	async writeNode(node: TreeNode, opts: WriteNodeOptions = {}): Promise<string> {
		let file = node.file;
		if (!file) file = await this.resolveFileFor(node);
		const existing = this.app.vault.getAbstractFileByPath(file);
		let deepDive = opts.deepDive;
		if (deepDive === undefined && existing instanceof TFile) {
			deepDive = extractDeepDive(await this.app.vault.cachedRead(existing));
		}
		if (deepDive) node.deepened = node.deepened || Date.now();
		else if (deepDive === '') node.deepened = 0; // region gone (hand-deleted): drop a stale flag
		const content = this.noteContent(node, deepDive ?? null);
		if (existing instanceof TFile) {
			// `process` rather than `modify`: it takes the current contents as its
			// starting point, so a save the user makes while we write is not lost.
			await this.app.vault.process(existing, () => content);
		} else {
			await this.ensureTreeFolder(node);
			await this.app.vault.create(file, content);
		}
		node.file = file;
		return file;
	}

	/** The deep-dive Markdown currently stored in a node's note ('' when none). */
	async readDeepDive(node: TreeNode): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(node.file);
		if (!(file instanceof TFile)) return '';
		try {
			return extractDeepDive(await this.app.vault.cachedRead(file));
		} catch {
			return '';
		}
	}

	/** Store (or with `null` remove) a node's generated deep dive. */
	async setDeepDive(node: TreeNode, markdown: string | null): Promise<void> {
		const cleaned = markdown ? sanitizeDeepDive(markdown) : '';
		node.deepened = cleaned ? Date.now() : 0;
		await this.writeNode(node, { deepDive: cleaned });
	}

	private async ensureTreeFolder(node: TreeNode): Promise<void> {
		const folder = this.treeFolder(node.treeRoot);
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}
	}

	private async resolveFileFor(node: TreeNode): Promise<string> {
		return this.uniqueVaultPath(this.treeFolder(node.treeRoot), node.name);
	}

	/**
	 * First free `<folder>/<stem>.md` (stem, stem (2), …). Shared by note
	 * creation and subtree merges so a filename collision never has to skip or
	 * overwrite an existing note.
	 */
	private uniqueVaultPath(folder: string, name: string): string {
		const stem = sanitizeFileName(name);
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

	/**
	 * Persist an LLM hierarchy over the user's EXISTING notes as a new tree.
	 * Children the model mapped to a real note (validated against `sources`)
	 * become reference nodes carrying `source: <vault path>`; everything else is
	 * an ordinary generated node. Nothing in the vault is modified or copied —
	 * the tree only links to the notes the user already owns.
	 */
	async createVaultTree(
		result: DiscoveryResult,
		baseFolder: string,
		sources: Map<string, string>,
		rootSource?: string,
		rootNameOverride?: string
	): Promise<{ root: string; created: TreeNode[]; linked: number; skipped: string[] }> {
		this.setBaseFolder(baseFolder);
		// The name the user typed wins over whatever the model echoed back.
		const rootName = titleTrim(rootNameOverride || result.concept || 'Concept');
		await this.ensureBaseFolder();
		const folder = this.treeFolder(rootName);
		// Never grow into an existing tree folder: that would mix two trees and
		// shadow nodes whose concept names collide.
		if (await this.app.vault.adapter.exists(folder)) {
			throw new ApiError(`A tree named "${rootName}" already exists — choose another name.`);
		}
		await this.app.vault.createFolder(folder);

		const now = Date.now();
		const created: TreeNode[] = [];
		const skipped: string[] = [];
		const seen = new Set<string>([normalizeKey(rootName)]);
		const rootPath = `/${slugify(rootName)}`;
		let linked = 0;

		const rootNode: TreeNode = {
			name: rootName,
			parent: null,
			description: `Tree over existing vault notes, organised around ${rootName}.`,
			complexity: 'Beginner',
			canExpand: true,
			estimatedDepth: 10,
			connections: [],
			children: [],
			path: rootPath,
			created: now,
			file: '',
			deepened: 0,
			source: rootSource,
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
				// Only a name that exists in the candidate list may become a link.
				const wanted = String(child.source ?? '').trim();
				const sourcePath = wanted ? sources.get(normalizeKey(wanted)) : undefined;
				// Use the note's real name for the wikilink, not the model's
				// spelling, so the link lands on the intended note.
				const sourceName = sourcePath
					? (sourcePath.split('/').pop() ?? '').replace(/\.md$/, '')
					: undefined;
				if (sourcePath) linked++;
				const node: TreeNode = {
					name: childName,
					parent: rootName,
					domain: domainName,
					description:
						child.description ||
						(sourceName ? `Points at your note "${sourceName}".` : ''),
					complexity: normalizeComplexity(child.complexity),
					canExpand: toBool(child.can_expand, !sourcePath),
					estimatedDepth: toInt(child.estimated_depth, 4),
					connections: sourceName ? [sourceName] : (child.connections || []).filter(Boolean),
					children: [],
					path: `${rootPath}/${slugify(domainName)}/${slugify(childName)}`,
					created: now,
					file: '',
					deepened: 0,
					source: sourcePath,
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
		return { root: rootName, created, linked, skipped };
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
	 *
	 * A descendant whose *concept* already exists in the target tree is left
	 * where it is (the tree model is keyed by concept name, so moving it would
	 * shadow one of the two) and returned in `skipped`; a mere filename
	 * collision moves under a unique name instead of being skipped. Either way
	 * every rewritten `children` list only references notes that are actually
	 * reachable, so a merge can never strand a note behind a deleted parent.
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

		const targetConcepts = new Set([...target.nodes.keys()].map(normalizeKey));
		const moved: TreeNode[] = [];
		const skipped: string[] = [];
		for (const d of this.collectSubtree(source, sourceName)) {
			if (d === node) continue;
			if (targetConcepts.has(normalizeKey(d.name))) {
				// Already represented in the target tree — keep the source copy.
				skipped.push(d.name);
				continue;
			}
			const rel = d.path.startsWith(node.path)
				? d.path.slice(node.path.length)
				: `/${slugify(d.name)}`;
			const newFile = this.uniqueVaultPath(target.folder, d.name);
			if (!matchStem(newFile, d.name)) {
				console.warn(`CogniTree: merged "${d.name}" as "${newFile}" (filename already in use).`);
			}
			const oldFile = d.file;
			// Carry the generated deep dive across the move (the note body is
			// rebuilt from the model, so it would otherwise be lost).
			const deepDive = await this.readDeepDive(d);
			d.treeRoot = targetNode.treeRoot;
			d.parent = d.parent === node.name ? targetNode.name : d.parent;
			d.path = `${targetNode.path}${rel}`;
			d.file = newFile;
			await this.app.vault.create(newFile, this.noteContent(d, deepDive || null));
			const old = this.app.vault.getAbstractFileByPath(oldFile);
			if (old instanceof TFile) await this.app.fileManager.trashFile(old);
			moved.push(d);
		}

		const movedNames = new Set(moved.map((n) => n.name));

		// A moved note must not list a child that stayed behind.
		for (const m of moved) {
			const kept = m.children.filter((c) => movedNames.has(c) || target.nodes.has(c));
			if (kept.length !== m.children.length) {
				m.children = kept;
				await this.writeNode(m);
			}
		}

		// Absorb source children into the target (dedup by normalized name).
		const have = new Set(targetNode.children.map(normalizeKey));
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

		// Remove source from its parent's children.
		if (node.parent) {
			const p = source.nodes.get(node.parent);
			if (p) {
				p.children = p.children.filter((c) => c !== node.name);
				await this.writeNode(p);
			}
		}

		// Keep the source note when anything was left behind (it is still the
		// parent of the skipped concepts); otherwise it is a pure duplicate.
		node.children = node.children.filter((c) => !movedNames.has(c));
		if (skipped.length > 0) {
			await this.writeNode(node);
		} else {
			const dupFile = this.app.vault.getAbstractFileByPath(node.file);
			if (dupFile instanceof TFile) await this.app.fileManager.trashFile(dupFile);
		}

		return { moved: moved.length, skipped };
	}

	/** Collect a node plus all descendants (recursive, cycle-safe). */
	collectSubtree(model: TreeModel, name: string): TreeNode[] {
		const out: TreeNode[] = [];
		const seen = new Set<string>();
		const visit = (n: string) => {
			if (seen.has(n)) return; // frontmatter cycles must not hang the walk
			seen.add(n);
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
				// Trash (respecting the user's deletion preference) instead of
				// hard-deleting — pairs with the view's Undo button.
				await this.app.fileManager.trashFile(file);
			}
		}
		if (parent) {
			const p = model.nodes.get(parent);
			if (p) {
				p.children = p.children.filter((c) => c !== name);
				await this.writeNode(p);
			}
		}
		// Drop the whole subtree from the in-memory model, not just the root —
		// otherwise the deleted descendants keep inflating the node count.
		for (const node of nodes) model.nodes.delete(node.name);
		return nodes.length;
	}

	/**
	 * Re-attach `childName` to its parent's `children` list and persist the
	 * parent note. Used by the view's Undo, which recreates the deleted notes:
	 * without this the restored subtree stays orphaned and invisible because
	 * the parent note no longer lists it.
	 */
	async relinkChild(model: TreeModel, parentName: string, childName: string): Promise<boolean> {
		const parent = model.nodes.get(parentName);
		if (!parent) return false;
		if (parent.children.some((c) => normalizeKey(c) === normalizeKey(childName))) return false;
		parent.children.push(childName);
		await this.writeNode(parent);
		return true;
	}

	/** Open the backing note in a new tab. */
	async openNote(node: TreeNode): Promise<void> {
		// A reference node points at the note the user already owns.
		const target = node.source || node.file;
		const file = this.app.vault.getAbstractFileByPath(target);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(true).openFile(file);
		} else {
			new Notice(`Note not found: ${target}`);
		}
	}

	// ---------------------------------------------------------------- review store

	/** Hidden review store of a tree (cards + schedule); not a note. */
	private reviewFile(rootName: string): string {
		return `${this.treeFolder(rootName)}/.cognitree-review.json`;
	}

	async loadReview(rootName: string): Promise<ReviewData> {
		try {
			const raw = await this.app.vault.adapter.read(this.reviewFile(rootName));
			const parsed = JSON.parse(raw) as ReviewData;
			if (parsed && parsed.version === REVIEW_DATA_VERSION && parsed.cards && parsed.states) {
				parsed.tree = rootName;
				return parsed;
			}
		} catch {
			/* no review store yet (or unreadable) */
		}
		return newReviewData(rootName);
	}

	async saveReview(data: ReviewData): Promise<void> {
		const folder = this.treeFolder(data.tree);
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}
		await this.app.vault.adapter.write(this.reviewFile(data.tree), JSON.stringify(data, null, 1));
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
		const file = this.uniqueVaultPath(folder, stem);
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
		const created = this.app.vault.getAbstractFileByPath(file);
		return created instanceof TFile ? created : null;
	}
}

function titleTrim(s: string): string {
	const t = String(s ?? '').trim().replace(/\s+/g, ' ');
	return t || 'Concept';
}

/** True when `filePath`'s stem is the canonical `<sanitized name>.md` for `name`. */
function matchStem(filePath: string, name: string): boolean {
	const base = filePath.split('/').pop() ?? '';
	return base.toLowerCase() === `${sanitizeFileName(name)}.md`.toLowerCase();
}
