/**
 * Minimal in-memory stand-in for the parts of the Obsidian runtime that
 * `ConceptStore` / `ConceptGenerator` touch. `npm test` bundles
 * `tests/store.test.ts` with `--alias:obsidian=./tests/stub-obsidian.ts`, so
 * the real plugin code runs unchanged against a fake vault — no Obsidian
 * install, no network, no filesystem.
 */

export class Notice {
	constructor(public message: string, public timeout?: number) {}
	addButton(_button: { text: string; onClick: () => void }): this {
		return this;
	}
}

export class TFile {
	path: string;
	basename: string;
	constructor(path: string) {
		this.path = path;
		this.basename = path.split('/').pop()!.replace(/\.md$/, '');
	}
}

export class TFolder {
	constructor(public path: string) {}
}

/** Never called by the tests: any chat completion is stubbed out instead. */
export async function requestUrl(_params?: unknown): Promise<never> {
	throw new Error('network access is disabled in tests');
}

export class Menu {}
export class Modal {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class ItemView {}
export class MarkdownView {}
export class Component {}
export class Events {}

/** In-memory vault + adapter + fileManager. */
export class FakeVault {
	files = new Map<string, string>();
	folders = new Set<string>();

	adapter = {
		exists: async (p: string) => this.folders.has(p) || this.files.has(p),
		read: async (p: string): Promise<string> => {
			const value = this.files.get(p);
			if (value === undefined) throw new Error(`File not found: ${p}`);
			return value;
		},
		write: async (p: string, content: string): Promise<void> => {
			this.files.set(p, content);
		},
		remove: async (p: string): Promise<void> => {
			this.files.delete(p);
		},
		list: async (p: string) => {
			const prefix = p ? p + '/' : '';
			const files: string[] = [];
			const folders: string[] = [];
			for (const f of this.files.keys()) {
				if (!f.startsWith(prefix)) continue;
				const rest = f.slice(prefix.length);
				if (rest.includes('/')) {
					const dir = prefix + rest.split('/')[0];
					if (!folders.includes(dir)) folders.push(dir);
				} else files.push(f);
			}
			for (const d of this.folders) {
				if (!d.startsWith(prefix)) continue;
				const rest = d.slice(prefix.length);
				if (rest && !rest.includes('/') && !folders.includes(d)) folders.push(d);
			}
			return { files, folders };
		},
	};

	createFolder = async (p: string): Promise<void> => {
		this.folders.add(p);
	};

	create = async (p: string, content: string): Promise<TFile> => {
		if (this.files.has(p)) throw new Error(`File already exists: ${p}`);
		this.files.set(p, content);
		return new TFile(p);
	};

	modify = async (f: TFile, content: string): Promise<void> => {
		this.files.set(f.path, content);
	};

	cachedRead = async (f: TFile): Promise<string> => this.files.get(f.path) ?? '';

	getAbstractFileByPath = (p: string): TFile | TFolder | null => {
		if (this.files.has(p)) return new TFile(p);
		if (this.folders.has(p)) return new TFolder(p);
		return null;
	};

	getMarkdownFiles = (): TFile[] =>
		[...this.files.keys()].filter((p) => p.endsWith('.md')).map((p) => new TFile(p));
}

class FakeFileManager {
	constructor(private vault: FakeVault) {}
	trashFile = async (f: TFile): Promise<void> => {
		this.vault.files.delete(f.path);
	};
}

/**
 * A fake `App`. `metadataCache.getFileCache` returns null on purpose: the
 * store then falls back to parsing the raw frontmatter of every note, which is
 * the same code path used for notes Obsidian hasn't indexed yet.
 */
export function makeApp(): any {
	const vault = new FakeVault();
	const app: any = {
		vault,
		fileManager: new FakeFileManager(vault),
		workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
		metadataCache: {
			getFileCache: () => null,
			getFirstLinkpathDest: () => null,
			on: () => ({}),
			offref: () => undefined,
		},
	};
	return app;
}
