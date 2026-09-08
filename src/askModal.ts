import { App, Modal, Notice } from 'obsidian';
import type CogniTreePlugin from './main';
import type { ChatMessage } from './api';
import type { ChildConcept, TreeNode, TreeModel } from './types';
import { buildFollowUpSystem } from './prompts';
import {
	buildBranchDigest,
	parseSuggestedChildren,
	type BranchDigest,
	type SuggestedChild,
} from './ask';
import { normalizeKey, titleCase } from './parser';

/**
 * "Ask about this concept" — a grounded, streaming chat on a single tree
 * node. The system prompt carries a compact digest of the node's branch
 * (see src/ask.ts) so answers stay anchored in the real tree; the chat keeps
 * history so quizzes and follow-ups work. When the model proposes new
 * sub-concepts it ends with a `### Suggested children` list, which this modal
 * renders with an "Add to tree" action that adopts them as real nodes.
 */

interface Preset {
	label: string;
	question: (focus: string) => string;
}

const PRESETS: Preset[] = [
	{
		label: 'Explain',
		question: (focus) =>
			`Explain "${focus}" and this whole branch: where it sits in the tree, what each included node contributes, and how the pieces connect. Start with a 2-3 sentence overview, then a structured walkthrough.`,
	},
	{
		label: 'Quiz me',
		question: (focus) =>
			`Quiz me on the branch around "${focus}". Ask 5 questions, easiest first, giving a short hint if I get stuck. Wait after each question for my answer before continuing.`,
	},
	{
		label: 'Gaps & contradictions',
		question: (focus) =>
			`Critically review the branch around "${focus}": look for missing distinctions, overlaps, contradictions or weak descriptions, then propose concrete fixes I could apply to the notes.`,
	},
	{
		label: 'Next expansion',
		question: (focus) =>
			`Suggest the most valuable new sub-concepts to add directly under "${focus}", with one-line reasons. End with the "Suggested children" list so I can adopt them into the tree.`,
	},
];

/** Element factory — content is always attached via textContent, never parsed as HTML. */
function makeEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	return node;
}

const HEADING_TAGS = { 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const;

/** Match one inline construct: `code`, [[wikilink]], **bold**, *italic*. */
const INLINE_RE =
	/(`[^`\n]+`)|(\[\[[^\]\n]+\]\])|(\*\*[^*\n]+\*\*)|(?<=^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g;

/**
 * Append inline Markdown to `container` as real DOM nodes. Every text
 * fragment reaches the DOM through textContent / createTextNode, so model
 * output can never inject markup.
 */
function renderInline(container: HTMLElement, text: string): void {
	if (!text) return;
	INLINE_RE.lastIndex = 0;
	let last = 0;
	for (let m = INLINE_RE.exec(text); m; m = INLINE_RE.exec(text)) {
		if (m.index > last) {
			container.appendChild(document.createTextNode(text.slice(last, m.index)));
		}
		last = m.index + m[0].length;
		if (m[1]) {
			const code = makeEl('code');
			code.textContent = m[1].slice(1, -1);
			container.appendChild(code);
		} else if (m[2]) {
			const wl = makeEl('span', 'ct-wl');
			wl.textContent = m[2].slice(2, -2).split('|')[0].trim();
			container.appendChild(wl);
		} else if (m[3]) {
			const b = makeEl('strong');
			b.textContent = m[3].slice(2, -2);
			container.appendChild(b);
		} else if (m[4]) {
			const em = makeEl('em');
			em.textContent = m[4];
			container.appendChild(em);
		}
	}
	if (last < text.length) {
		container.appendChild(document.createTextNode(text.slice(last)));
	}
}

/** Render bounded chat Markdown into `root` (headings, lists, code, bold/italic). */
function renderChatMarkdown(root: HTMLElement, markdown: string): void {
	root.empty();
	if (!markdown) return;
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');

	let i = 0;
	while (i < lines.length) {
		const raw = lines[i];
		const t = raw.trim();

		if (!t) {
			i++;
			continue;
		}
		if (/^```/.test(t)) {
			// Fenced code block: collect until the closing fence.
			const buf: string[] = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i].trim())) {
				buf.push(lines[i]);
				i++;
			}
			i++; // skip the closing fence
			const pre = makeEl('pre', 'ct-ask-code');
			const codeEl = makeEl('code');
			codeEl.textContent = buf.join('\n');
			pre.appendChild(codeEl);
			root.appendChild(pre);
			continue;
		}
		const heading = raw.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			const level = Math.min(heading[1].length + 2, 6) as keyof typeof HEADING_TAGS;
			const h = makeEl(HEADING_TAGS[level]);
			renderInline(h, heading[2]);
			root.appendChild(h);
			i++;
			continue;
		}
		const isUl = /^\s*[-*+]\s+/.test(raw);
		const isOl = /^\s*\d+[.)]\s+/.test(raw);
		if (isUl || isOl) {
			const list = makeEl(isUl ? 'ul' : 'ol');
			while (i < lines.length && lines[i].trim()) {
				const line = lines[i].trim();
				const item = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
				if (!item) break;
				const li = makeEl('li');
				renderInline(li, item[1]);
				list.appendChild(li);
				i++;
			}
			root.appendChild(list);
			continue;
		}
		// Paragraph: absorb until a blank line or another block start.
		const para = [raw.trim()];
		i++;
		while (
			i < lines.length &&
			lines[i].trim() &&
			!/^\s*(?:#{1,6}\s|```|[-*+]\s|\d+[.)]\s)/.test(lines[i])
		) {
			para.push(lines[i].trim());
			i++;
		}
		const p = makeEl('p');
		renderInline(p, para.join(' '));
		root.appendChild(p);
	}
}

export class AskModal extends Modal {
	private model: TreeModel;
	private node: TreeNode;
	private plugin: CogniTreePlugin;

	private messages: ChatMessage[] = [];
	private digest: BranchDigest = { text: '', nodeCount: 0, omitted: 0 };
	private digestCacheKey = '';
	private alive = true;
	private busy = false;

	private logEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendEl!: HTMLButtonElement;
	private adoptEl!: HTMLElement;
	private contextBodyEl!: HTMLElement;
	private contextBtnEl!: HTMLButtonElement;

	constructor(
		app: App,
		plugin: CogniTreePlugin,
		model: TreeModel,
		node: TreeNode,
		private initialQuestion?: string
	) {
		super(app);
		this.plugin = plugin;
		this.model = model;
		this.node = node;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ct-ask-modal');

		contentEl.createEl('h3', { text: `Ask about "${this.node.name}"` });
		const meta = contentEl.createDiv({ cls: 'ct-ask-meta' });
		meta.setText(
			`Tree "${this.model.root}" · grounded in a digest of this branch + linked notes · one API call per question (not cached). Answers arrive in one pass when the model finishes — critique-style questions can take ~1 min.`
		);

		// Presets (one-click questions).
		const presetsEl = contentEl.createDiv({ cls: 'ct-ask-presets' });
		for (const p of PRESETS) {
			const chip = presetsEl.createEl('button', {
				cls: 'ct-btn ct-ask-chip',
				text: p.label,
				attr: { title: p.question(this.node.name) },
			});
			chip.addEventListener('click', () => {
				if (this.busy) return;
				this.inputEl.value = p.question(this.node.name);
				void this.ask(this.inputEl.value);
			});
		}

		// Transcript.
		this.logEl = contentEl.createDiv({ cls: 'ct-ask-log' });

		this.statusEl = contentEl.createDiv({ cls: 'ct-ask-status' });
		this.statusEl.addClass('ct-hidden');

		// Suggested-children adoption box (filled after an answer).
		this.adoptEl = contentEl.createDiv({ cls: 'ct-ask-adopt' });
		this.adoptEl.addClass('ct-hidden');

		// Context toggle.
		const ctxRow = contentEl.createDiv({ cls: 'ct-ask-ctx-row' });
		this.contextBtnEl = ctxRow.createEl('button', {
			cls: 'ct-btn',
			text: 'Show grounding context',
		});
		this.contextBtnEl.addEventListener('click', () => this.toggleContext());
		this.contextBodyEl = ctxRow.createDiv({ cls: 'ct-ask-context' });
		this.contextBodyEl.addClass('ct-hidden');
		this.contextBodyEl.createDiv({ cls: 'ct-ask-context-pre' });

		// Composer.
		this.inputEl = contentEl.createEl('textarea', {
			cls: 'ct-ask-input',
			attr: { rows: '2', placeholder: 'Ask about this concept — Enter sends, Shift+Enter for a new line' },
		});
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				void this.ask(this.inputEl.value);
			}
		});
		const actRow = contentEl.createDiv({ cls: 'ct-ask-actions' });
		this.sendEl = actRow.createEl('button', {
			cls: 'ct-btn ct-btn-primary',
			text: 'Send',
		});
		this.sendEl.addEventListener('click', () => void this.ask(this.inputEl.value));
		const reset = actRow.createEl('button', { cls: 'ct-btn', text: 'New chat' });
		reset.addEventListener('click', () => {
			if (!this.busy) this.resetChat();
		});

		this.refreshDigest();
		if (this.initialQuestion) {
			this.inputEl.value = this.initialQuestion;
			this.inputEl.focus();
		} else {
			this.inputEl.focus();
		}
	}

	onClose(): void {
		this.alive = false;
		this.contentEl.empty();
	}

	// ------------------------------------------------------------- grounding

	private refreshDigest(): void {
		const key = `${this.model.updatedAt}:${this.model.root}:${this.node.name}:${this.node.children.join('¦')}`;
		if (this.digestCacheKey === key) return;
		const s = this.plugin.settings;
		this.digest = buildBranchDigest(
			this.model,
			this.node.name,
			s.askContextMaxNodes,
			s.askContextMaxChars
		);
		this.digestCacheKey = key;
		const pre = this.contextBodyEl.querySelector('.ct-ask-context-pre');
		if (pre) pre.setText(this.digest.text || '(No branch context available.)');
		this.contextBtnEl.setText(
			this.digest.text
				? `Show grounding context (${this.digest.nodeCount} node${this.digest.nodeCount === 1 ? '' : 's'}${
						this.digest.omitted > 0 ? `, ${this.digest.omitted} omitted` : ''
				  })`
				: 'Show grounding context'
		);
	}

	private seedSystem(): void {
		this.refreshDigest();
		const system: ChatMessage = {
			role: 'system',
			content: buildFollowUpSystem(this.digest.text, this.node.name),
		};
		if (this.messages[0]?.role === 'system') this.messages[0] = system;
		else this.messages.unshift(system);
	}

	private resetChat(): void {
		this.messages = [];
		this.logEl.empty();
		this.hideAdopt();
		this.inputEl.value = '';
		this.setStatus(false);
		this.setBusyUi(false);
		this.inputEl.focus();
	}

	// ------------------------------------------------------------- chat flow

	private async ask(questionRaw: string): Promise<void> {
		const question = questionRaw.trim();
		if (!question || this.busy) return;
		this.seedSystem();

		this.pushUserBubble(question);
		this.messages.push({ role: 'user', content: question });
		this.hideAdopt();
		this.setBusyUi(true);

		// The request is buffered by Obsidian requestUrl, so nothing paints
		// until the model finishes — a live seconds counter keeps the wait
		// honest instead of looking frozen.
		const started = Date.now();
		let statusLabel = 'Thinking';
		let ticker = 0;
		const paintStatus = () => {
			if (!this.alive) return;
			const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
			this.setStatus(true, `${statusLabel}… ${secs}s`);
		};
		this.setStatus(true, 'Thinking…');
		ticker = window.setInterval(paintStatus, 1000);

		// Assistant bubble that streams into itself.
		const { bubble, body } = this.newAssistantBubble();
		let acc = '';
		let pending = false;
		let timer = 0;
		const paint = () => {
			timer = 0;
			pending = false;
			if (!this.alive) return;
			renderChatMarkdown(body, acc);
		};
		const schedule = () => {
			if (pending) return;
			pending = true;
			timer = window.setTimeout(paint, 60);
		};

		try {
			const final = await this.plugin.generator.followUpChat(
				this.messages,
				(d) => {
					if (!this.alive) return;
					acc += d;
					schedule();
				},
				(next) => {
					// Reasoning models occasionally spend the whole budget
					// before emitting content; say so instead of going silent.
					statusLabel = 'Reasoning used its budget — retrying with more tokens';
					paintStatus();
				}
			);
			if (timer) window.clearTimeout(timer);
			acc = final;
			if (this.alive) {
				paint();
				bubble.removeClass('ct-ask-streaming');
			}
			bubble.dataset.answer = final;
			this.messages.push({ role: 'assistant', content: final });
			// Keep the conversation bounded: system + last 20 messages.
			while (this.messages.length > 21) this.messages.splice(1, 2);
			if (this.alive) this.showSuggestions(parseSuggestedChildren(final));
		} catch (err) {
			if (timer) window.clearTimeout(timer);
			if (!this.alive) return;
			bubble.removeClass('ct-ask-streaming');
			const msg = err instanceof Error ? err.message : String(err);
			body.setText(`⚠ ${msg}`);
			body.addClass('ct-ask-error');
			new Notice(`Ask failed: ${msg}`, 8000);
		} finally {
			window.clearInterval(ticker);
			this.setStatus(false);
			this.setBusyUi(false);
			if (this.alive) this.inputEl.focus();
		}
	}

	private pushUserBubble(question: string): void {
		const row = this.logEl.createDiv({ cls: 'ct-ask-msg ct-ask-msg-user' });
		row.setText(question);
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	private newAssistantBubble(): { bubble: HTMLElement; body: HTMLElement } {
		const streaming = this.plugin.settings.streaming;
		const bubble = this.logEl.createDiv({
			cls: 'ct-ask-msg ct-ask-msg-ai' + (streaming ? ' ct-ask-streaming' : ''),
		});
		const head = bubble.createDiv({ cls: 'ct-ask-msg-head' });
		head.createSpan({ cls: 'ct-ask-msg-model', text: this.plugin.settings.model });
		const copy = head.createEl('button', { cls: 'ct-btn ct-ask-copy', text: 'Copy' });
		copy.addEventListener('click', () => {
			// Each bubble copies only its own finished answer.
			const text = bubble.dataset.answer;
			if (!text) {
				new Notice('This answer has no finished text yet.', 4000);
				return;
			}
			void navigator.clipboard.writeText(text).then(
				() => new Notice('Answer copied.'),
				() => new Notice('Could not copy the answer.', 4000)
			);
		});
		const body = bubble.createDiv({ cls: 'ct-ask-msg-body' });
		this.logEl.scrollTop = this.logEl.scrollHeight;
		return { bubble, body };
	}

	private setBusyUi(on: boolean): void {
		this.busy = on;
		this.sendEl.disabled = on;
		this.inputEl.disabled = on;
		this.inputEl.placeholder = on
			? 'Working…'
			: 'Ask about this concept — Enter sends, Shift+Enter for a new line';
	}

	private setStatus(on: boolean, text?: string): void {
		if (on && text) this.statusEl.setText(text);
		this.statusEl.toggleClass('ct-hidden', !on);
	}

	// ------------------------------------------------------------- suggestions

	private hideAdopt(): void {
		this.adoptEl.empty();
		this.adoptEl.addClass('ct-hidden');
	}

	private showSuggestions(suggested: SuggestedChild[]): void {
		if (suggested.length === 0) return;
		this.adoptEl.empty();
		this.adoptEl.removeClass('ct-hidden');

		// Skip anything that already exists under this node or in the tree.
		const known = new Set(
			[this.node.name, ...this.node.children, ...[...this.model.nodes.keys()]].map(normalizeKey)
		);
		const fresh = suggested.filter((s) => !known.has(normalizeKey(s.name)));

		this.adoptEl.createDiv({ cls: 'ct-ask-adopt-title', text: 'Suggested children' });
		const list = this.adoptEl.createDiv({ cls: 'ct-ask-adopt-list' });
		const shown = fresh.length > 0 ? fresh : suggested;
		for (const s of shown) {
			const item = list.createDiv({ cls: 'ct-ask-adopt-item' });
			item.createEl('b', { text: titleCase(s.name) });
			if (s.description) {
				item.createSpan({ text: ` — ${s.description}` });
			}
		}
		if (fresh.length === 0) {
			this.adoptEl.createEl('p', {
				cls: 'ct-muted',
				text: 'All suggested concepts already exist in this tree — nothing to add.',
			});
			return;
		}
		const addBtn = this.adoptEl.createEl('button', {
			cls: 'ct-btn ct-btn-primary',
			text: `Add ${fresh.length} to tree`,
		});
		addBtn.addEventListener('click', () => void this.adopt(fresh));
	}

	/** Adopt suggested children as real nodes under the focus concept. */
	private async adopt(children: SuggestedChild[]): Promise<void> {
		try {
			const folder = this.plugin.settings.treeFolder;
			// Work against a fresh tree so concurrent edits are never clobbered.
			const freshModel = await this.plugin.store.loadTree(this.node.treeRoot);
			if (!freshModel) {
				new Notice('Tree not found — has it been deleted?', 6000);
				return;
			}
			const parent = freshModel.nodes.get(this.node.name) ?? freshModel.nodes.get(freshModel.root);
			if (!parent) return;
			const depthGuess = Math.max(1, (parent.estimatedDepth ?? 3) - 1);
			const mapped: ChildConcept[] = children.map((c) => ({
				name: titleCase(c.name),
				description: c.description,
				complexity: parent.complexity,
				can_expand: true,
				estimated_depth: depthGuess,
			}));
			const { created, skipped } = await this.plugin.store.addChildren(
				parent,
				mapped,
				folder,
				freshModel.nodes
			);
			// The chat should now reason about the grown branch.
			const reloaded = await this.plugin.store.loadTree(this.node.treeRoot);
			if (reloaded) {
				this.model = reloaded;
				this.node = reloaded.nodes.get(this.node.name) ?? parent;
				this.digestCacheKey = '';
			}
			this.seedSystem();
			await this.plugin.treeView?.refreshAll();
			this.hideAdopt();
			const note = `Added ${created.length} new node${created.length === 1 ? '' : 's'} under "${parent.name}".`;
			new Notice(
				created.length > 0
					? note + (skipped.length ? ` (${skipped.length} skipped — already present)` : '')
					: `Nothing added — ${skipped.length} already present.`,
				6000
			);
		} catch (err) {
			new Notice(`Could not add suggested children: ${(err as Error).message}`, 8000);
		}
	}

	// ------------------------------------------------------------- context toggle

	private toggleContext(): void {
		const visible = !this.contextBodyEl.hasClass('ct-hidden');
		this.contextBodyEl.toggleClass('ct-hidden', visible);
		this.contextBtnEl.setText(visible ? 'Show grounding context' : 'Hide grounding context');
	}
}
