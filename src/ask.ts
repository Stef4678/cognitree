import type { TreeModel } from './types';
import { normalizeKey } from './parser';

/**
 * Pure helpers for the "Ask about this concept" follow-up chat
 * (no Obsidian runtime — unit-testable).
 *
 *  - buildBranchDigest(): squeeze a node + its descendants (plus nearby
 *    context) into a compact, bounded grounding block for the LLM.
 *  - parseSuggestedChildren(): read the optional "### Suggested children"
 *    bullet list the model is asked to emit when it proposes new nodes,
 *    so the user can adopt them straight into the tree.
 */

export interface BranchDigest {
	/** The full grounding text (empty when the node is not in the model). */
	text: string;
	/** Nodes included in the digest (focus + descendants + nearby context). */
	nodeCount: number;
	/** Descendants left out because of the node/character budget. */
	omitted: number;
}

/**
 * Build a compact branch digest around `focusName`:
 * the focus node with its tree position, its descendants BFS-ordered, and —
 * for leaf nodes — the parent's other children so the model still has
 * somewhere to anchor its answer. Bounded by `maxNodes` and `maxChars`
 * so huge branches can never blow the context window.
 */
export function buildBranchDigest(
	model: TreeModel,
	focusName: string,
	maxNodes = 60,
	maxChars = 10000
): BranchDigest {
	const focus = model.nodes.get(focusName);
	if (!focus) return { text: '', nodeCount: 0, omitted: 0 };

	const out: string[] = [];

	// Focus line with its position in the tree (root ▸ … ▸ focus).
	const chain: string[] = [];
	let cursor: typeof focus | null = focus;
	while (cursor) {
		chain.unshift(cursor.name);
		cursor = cursor.parent ? (model.nodes.get(cursor.parent) ?? null) : null;
	}
	out.push(`Focus: "${focus.name}" (${chain.join(' ▸ ')})`);
	if (focus.description) out.push(`Description: ${focus.description}`);
	if (focus.domain) out.push(`Domain: ${focus.domain} · Complexity: ${focus.complexity}`);

	// Notes the focus already links to outside this tree (vault neighbours).
	const outside = focus.connections.filter((c) => !model.nodes.has(c));
	if (outside.length > 0) {
		out.push(`Already linked to these vault notes: ${outside.slice(0, 10).join(', ')}`);
	}

	const limit = Math.max(1, maxNodes);
	let used = 0; // chars used by the numbered list so far
	let omitted = 0;
	const lines: string[] = [];
	const descOf = (n: (typeof focus) | null): string => {
		const d = (n?.description ?? '').replace(/\s+/g, ' ').trim();
		return d || '(no description)';
	};

	// BFS the descendants (excluding the focus itself).
	const queue: { name: string; depth: number }[] = focus.children.map((c) => ({
		name: c,
		depth: 1,
	}));
	const seen = new Set<string>([focusName]);

	const pushNode = (node: (typeof focus) | null, prefix: string): void => {
		if (!node) return;
		const line = `${prefix}${node.name}${node.canExpand ? '' : ' (leaf)'}${
			node.domain ? ` — ${node.domain}` : ''
		}: ${descOf(node)}`;
		if (lines.length >= limit || used + (lines.length > 0 ? 1 : 0) + line.length > maxChars) {
			omitted++;
			return;
		}
		used += line.length + (lines.length > 0 ? 1 : 0);
		lines.push(line);
	};

	while (queue.length > 0) {
		const item = queue.shift()!;
		if (seen.has(item.name)) continue;
		seen.add(item.name);
		const node = model.nodes.get(item.name);
		if (!node) continue;
		pushNode(node, `${item.depth}. `);
		for (const c of node.children) {
			if (!seen.has(c)) queue.push({ name: c, depth: item.depth + 1 });
		}
	}

	// A leaf without children: give the model its siblings as anchors.
	if (lines.length === 0 && focus.parent) {
		const parent = model.nodes.get(focus.parent);
		if (parent) {
			out.push(
				`"${focus.name}" is a leaf — nearby siblings under "${parent.name}":`
			);
			for (const sib of parent.children) {
				if (sib === focus.name) continue;
				pushNode(model.nodes.get(sib) ?? null, '  ');
			}
		}
	}

	if (lines.length > 0) {
		out.push(
			`The branch contains these notes (in tree order, "${focus.name}" first):`
		);
		out.push(...lines);
	}
	if (omitted > 0) {
		out.push(`… (${omitted} more node(s) omitted to stay within the context budget)`);
	}

	return { text: out.join('\n'), nodeCount: lines.length + 1, omitted };
}

export interface SuggestedChild {
	name: string;
	description: string;
}

const CHILDREN_HEADINGS = new Set([
	'suggested children',
	'suggested children to add',
	'suggested sub-children',
	'new children',
	'suggested new children',
	'children to add',
	'add these children',
]);

/** Normalize a heading line for comparison ("### Suggested children" → "suggested children"). */
function normalizeHeading(line: string): string {
	return line
		.trim()
		.replace(/^#{1,6}\s*/, '')
		.replace(/[*_`]+/g, '')
		.replace(/\s+/g, ' ')
		.replace(/[:\uFF1A]+$/, '')
		.trim()
		.toLowerCase();
}

/** Strip bold/emphasis markers from a bullet's text. */
function stripEmphasis(s: string): string {
	return s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/[*_`]/g, '').trim();
}

/**
 * Parse the optional "Suggested children" section the follow-up prompt asks
 * the model to emit. Accepts bullet or numbered lists under a heading such
 * as `### Suggested children`, with items like `- Name: one-line reason`.
 * Returns [] when the model didn't emit the section.
 */
export function parseSuggestedChildren(markdown: string): SuggestedChild[] {
	if (!markdown) return [];
	const lines = markdown.split(/\r?\n/);
	const result: SuggestedChild[] = [];
	const seen = new Set<string>();
	let inSection = false;

	for (const raw of lines) {
		const trimmed = raw.trim();
		if (!trimmed) {
			if (inSection) break; // a blank line ends the list
			continue;
		}
		if (!inSection) {
			if (CHILDREN_HEADINGS.has(normalizeHeading(trimmed))) {
				inSection = true;
			}
			continue;
		}
		// Inside the section: only bullet / numbered items count.
		const bullet = trimmed.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
		if (!bullet) break;

		const item = stripEmphasis(bullet[1]);
		if (!item) continue;

		// Name: description (colon first, then em/en/spaced-hyphen dashes).
		let name = item;
		let description = '';
		const sep = item.match(/^(.*?)[:\uFF1A]\s+(.*)$/) ?? item.match(/^(.*?)\s*[—–]\s*(.*)$/) ?? item.match(/^(.*?)\s+-\s+(.*)$/);
		if (sep) {
			name = (sep[1] ?? '').trim();
			description = (sep[2] ?? '').trim();
		}
		name = name.replace(/^["'«(]+|["'»),.]+$/g, '').trim();
		if (!name || name.length > 90) continue;
		if (!description && item.length > 90) continue; // prose masquerading as a bullet
		const key = normalizeKey(name);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({ name, description });
		if (result.length >= 14) break;
	}
	return result;
}
