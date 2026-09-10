import type { TreeModel } from './types';

/**
 * Pure tree serializers: Markdown outline, JSON snapshot, and an SVG graph.
 * Kept obsidian-free so they can be unit-tested.
 */

function escapeXml(s: string): string {
	return s.replace(/[<>&'"]/g, (c) => {
		switch (c) {
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '&':
				return '&amp;';
			case "'":
				return '&apos;';
			case '"':
				return '&quot;';
			default:
				return c;
		}
	});
}

/**
 * Breadth-first depth of every node reachable from the root (root = 0).
 * Cycle-safe, and independent of the stored `path` — that path contains the
 * domain slug, so splitting it overstates the real tree depth.
 */
export function computeDepths(model: TreeModel): Map<string, number> {
	const depths = new Map<string, number>();
	if (!model.nodes.has(model.root)) return depths;
	depths.set(model.root, 0);
	const queue: string[] = [model.root];
	while (queue.length > 0) {
		const name = queue.shift()!;
		const d = depths.get(name)!;
		for (const c of model.nodes.get(name)?.children ?? []) {
			if (depths.has(c) || !model.nodes.has(c)) continue;
			depths.set(c, d + 1);
			queue.push(c);
		}
	}
	return depths;
}

/** Indented [[wikilink]] outline of the whole tree. */
export function buildOutline(model: TreeModel): string {
	const lines: string[] = [];
	const seen = new Set<string>();
	const visit = (name: string, depth: number) => {
		if (seen.has(name)) return; // cycle-safe
		seen.add(name);
		const node = model.nodes.get(name);
		if (!node) return;
		lines.push(`${'  '.repeat(depth)}- [[${node.name}]]`);
		for (const c of node.children) visit(c, depth + 1);
	};
	visit(model.root, 0);
	return `# ${model.root}\n\n${lines.join('\n')}\n`;
}

/** Compact JSON snapshot of the tree (name/parent/path/domain/metadata). */
export function buildJsonSnapshot(model: TreeModel): string {
	const nodes = [...model.nodes.values()].map((n) => ({
		name: n.name,
		parent: n.parent,
		domain: n.domain,
		description: n.description,
		complexity: n.complexity,
		can_expand: n.canExpand,
		estimated_depth: n.estimatedDepth,
		connections: n.connections,
		children: n.children,
		path: n.path,
		deepened: n.deepened ?? 0,
		source: n.source ?? null,
	}));
	return JSON.stringify({ root: model.root, node_count: nodes.length, nodes }, null, 2);
}

const NODE_H = 34;
const LAYER_GAP = 70;
const LEAF_W = 130;
const MIN_W = 110;
const PAD = 24;

interface LayoutNode {
	x: number;
	y: number;
	w: number;
}

/** Layered SVG diagram of the tree (nodes + curved parent→child connectors). */
export function buildTreeSvg(model: TreeModel): string {
	const nodes = model.nodes;
	const depth = computeDepths(model);
	const leafSpan = new Map<string, number>();
	const layout = new Map<string, LayoutNode>();

	const span = (name: string, open: Set<string>): number => {
		const n = nodes.get(name);
		if (!n) return 0;
		if (open.has(name)) return 0; // frontmatter cycle: stop descending
		open.add(name);
		if (n.children.length === 0) {
			leafSpan.set(name, LEAF_W);
			open.delete(name);
			return LEAF_W;
		}
		let s = 0;
		for (const c of n.children) s += span(c, open);
		const sp = Math.max(s, 120);
		leafSpan.set(name, sp);
		open.delete(name);
		return sp;
	};
	span(model.root, new Set());

	const boxW = (name: string) => Math.max(MIN_W, Math.min(240, name.length * 7.2 + 22));

	let minX = 0;
	let maxX = 0;
	const place = (name: string, left: number, open: Set<string>): number => {
		const n = nodes.get(name);
		if (!n) return 0;
		if (open.has(name)) return 0; // cycle guard (mirrors span())
		open.add(name);
		const sp = leafSpan.get(name) ?? LEAF_W;
		const cx = left + sp / 2;
		const w = boxW(name);
		const x = cx - w / 2;
		layout.set(name, { x, y: (depth.get(name) ?? 0) * LAYER_GAP, w });
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x + w);
		let cur = left;
		for (const c of n.children) cur += place(c, cur, open);
		open.delete(name);
		return sp;
	};
	place(model.root, 0, new Set());

	const maxDepth = Math.max(0, ...depth.values());
	const totalW = maxX - minX + PAD * 2;
	const totalH = maxDepth * LAYER_GAP + NODE_H + PAD * 2;
	const shiftX = PAD - minX;

	const edges: string[] = [];
	for (const n of nodes.values()) {
		const from = layout.get(n.name);
		if (!from) continue;
		for (const c of n.children) {
			const to = layout.get(c);
			if (!to) continue;
			const x1 = from.x + from.w / 2;
			const y1 = from.y + NODE_H;
			const x2 = to.x + to.w / 2;
			const y2 = to.y;
			const my = (y1 + y2) / 2;
			edges.push(
				`<path d="M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" fill="none" stroke="#b06cff" stroke-width="1.4" stroke-opacity="0.55"/>`
			);
		}
	}

	const boxes: string[] = [];
	for (const n of nodes.values()) {
		const l = layout.get(n.name);
		if (!l) continue;
		boxes.push(
			`<g transform="translate(${l.x + shiftX}, ${l.y + PAD})">
  <rect width="${l.w}" height="${NODE_H}" rx="8" fill="#f4f1ff" stroke="#b06cff" stroke-width="1"/>
  <text x="${l.w / 2}" y="${NODE_H / 2 + 4}" text-anchor="middle" font-size="12" fill="#3a3550">${escapeXml(n.name)}</text>
</g>`
		);
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="Inter, system-ui, sans-serif">
<rect width="100%" height="100%" fill="#ffffff"/>
${edges.join('\n')}
${boxes.join('\n')}
</svg>
`;
}
