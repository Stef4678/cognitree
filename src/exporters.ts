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

/**
 * Hues for the top-level branches: the plugin's purple/teal spine plus four
 * supporting hues, so sibling branches stay distinguishable in print and on
 * screen (including for the most common forms of colour blindness).
 */
const BRANCH_HUES = [265, 186, 152, 32, 340, 210, 96];

function branchHue(branch: number): number {
	const index = ((branch - 1) % BRANCH_HUES.length + BRANCH_HUES.length) % BRANCH_HUES.length;
	return BRANCH_HUES[index];
}

/** Fill for a node: hue by top-level branch, lightness by depth. */
export function branchFill(branch: number, depth: number): string {
	return `hsl(${branchHue(branch)} 62% ${Math.max(38, 88 - depth * 11)}%)`;
}

/** Outline for a node of a given branch. */
export function branchStroke(branch: number): string {
	return `hsl(${branchHue(branch)} 55% 52%)`;
}

export interface TreeAnalysis {
	/** Depth of every node reachable from the root (root = 0). */
	depth: Map<string, number>;
	/** Number of leaves in each node's subtree (at least 1) — its visual weight. */
	weight: Map<string, number>;
	/** Index of the root child each node descends from (root itself = 0). */
	branch: Map<string, number>;
	/** Breadth-first node order. */
	order: string[];
	maxDepth: number;
}

/**
 * Depth, subtree weight and branch index for every reachable node. Weights are
 * what makes a radial or treemap layout proportional rather than arbitrary;
 * every walk is cycle-safe, so hand-edited frontmatter cannot hang an export.
 */
export function analyseTree(model: TreeModel): TreeAnalysis {
	const depth = computeDepths(model);
	const order: string[] = [];
	const visited = new Set<string>();
	const queue: string[] = model.nodes.has(model.root) ? [model.root] : [];
	while (queue.length > 0) {
		const name = queue.shift()!;
		if (visited.has(name)) continue;
		visited.add(name);
		order.push(name);
		for (const child of model.nodes.get(name)?.children ?? []) {
			if (depth.has(child) && !visited.has(child)) queue.push(child);
		}
	}

	const weight = new Map<string, number>();
	const weigh = (name: string, open: Set<string>): number => {
		const cached = weight.get(name);
		if (cached !== undefined) return cached;
		if (open.has(name)) return 0; // cycle guard
		open.add(name);
		const children = (model.nodes.get(name)?.children ?? []).filter((c) => model.nodes.has(c));
		let total = 0;
		if (children.length === 0) total = 1;
		else for (const child of children) total += weigh(child, open);
		if (total <= 0) total = 1;
		weight.set(name, total);
		open.delete(name);
		return total;
	};
	weigh(model.root, new Set());

	const branch = new Map<string, number>([[model.root, 0]]);
	(model.nodes.get(model.root)?.children ?? []).forEach((child, index) => {
		const stack = [child];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const name = stack.pop()!;
			if (seen.has(name)) continue;
			seen.add(name);
			if (!model.nodes.has(name)) continue;
			branch.set(name, index + 1);
			for (const grandchild of model.nodes.get(name)?.children ?? []) stack.push(grandchild);
		}
	});

	const maxDepth = Math.max(0, ...depth.values());
	return { depth, weight, branch, order, maxDepth };
}

export interface RadialOptions {
	/** Radius of the root disc. */
	centerRadius?: number;
	/** Thickness of one depth ring. */
	ringWidth?: number;
	/** Labels longer than this are ellipsised. */
	maxLabelLength?: number;
	/** Angular padding between sibling arcs, in radians. */
	gap?: number;
}

/**
 * Radial sunburst of the tree: depth is the radius, and the angular width of a
 * node is proportional to the number of concepts in its subtree.
 *
 * This is the layout to reach for when a tree is wide rather than deep — the
 * layered SVG grows with the number of leaves (a 33-node tree can be ~3200px
 * wide for 292px of height), while the sunburst stays roughly square and makes
 * "which branch is biggest" obvious at a glance.
 */
export function buildRadialSvg(model: TreeModel, options: RadialOptions = {}): string {
	const { depth, weight, branch, maxDepth } = analyseTree(model);
	const centerRadius = Math.max(24, options.centerRadius ?? 74);
	const ringWidth = Math.max(20, options.ringWidth ?? 104);
	const maxLabelLength = Math.max(6, options.maxLabelLength ?? 22);
	const gap = Math.max(0, options.gap ?? 0.008);

	const outer = centerRadius + maxDepth * ringWidth + 26;
	const size = Math.round(outer * 2 + 40);
	const cx = size / 2;
	const cy = size / 2 + 10;

	const point = (radius: number, angle: number): [number, number] => [
		cx + radius * Math.cos(angle),
		cy + radius * Math.sin(angle),
	];
	const round = (value: number): string => value.toFixed(2);
	const arcPath = (inner: number, outerRadius: number, from: number, to: number): string => {
		const large = to - from > Math.PI ? 1 : 0;
		const [x0, y0] = point(outerRadius, from);
		const [x1, y1] = point(outerRadius, to);
		const [x2, y2] = point(inner, to);
		const [x3, y3] = point(inner, from);
		return `M ${round(x0)} ${round(y0)} A ${round(outerRadius)} ${round(outerRadius)} 0 ${large} 1 ${round(
			x1
		)} ${round(y1)} L ${round(x2)} ${round(y2)} A ${round(inner)} ${round(inner)} 0 ${large} 0 ${round(
			x3
		)} ${round(y3)} Z`;
	};

	const arcs: string[] = [];
	const labels: string[] = [];
	// A node is drawn once even if hand-edited frontmatter lists it under two
	// parents (or in a cycle) — without this the walk recurses forever.
	const drawn = new Set<string>();
	const walk = (name: string, from: number, to: number): void => {
		if (drawn.has(name)) return;
		drawn.add(name);
		const node = model.nodes.get(name);
		if (!node) return;
		const nodeDepth = depth.get(name) ?? 0;
		if (nodeDepth > 0) {
			const inner = centerRadius + (nodeDepth - 1) * ringWidth;
			const outerRadius = inner + ringWidth - 4;
			const hue = branch.get(name) ?? 1;
			arcs.push(
				`<path data-node="${escapeXml(name)}" d="${arcPath(
					inner,
					outerRadius,
					from + gap,
					to - gap
				)}" fill="${branchFill(hue, nodeDepth)}" stroke="${branchStroke(
					hue
				)}" stroke-width="0.8" stroke-opacity="0.5"/>`
			);
			// Only label an arc with room for the text to be readable.
			if (to - from > 0.16) {
				const mid = (from + to) / 2;
				const [lx, ly] = point(inner + (ringWidth - 4) / 2, mid);
				const degrees = (mid * 180) / Math.PI;
				const flipped = degrees > 90 && degrees < 270;
				const rotation = flipped ? degrees + 180 : degrees;
				const text =
					node.name.length > maxLabelLength
						? `${node.name.slice(0, maxLabelLength - 1)}…`
						: node.name;
				labels.push(
					`<text x="${round(lx)}" y="${round(ly)}" font-size="10.5" fill="#2c2740" text-anchor="middle" transform="rotate(${round(
						rotation
					)} ${round(lx)} ${round(ly)})">${escapeXml(text)}</text>`
				);
			}
		}

		const children = (node.children ?? []).filter((child) => model.nodes.has(child));
		if (children.length === 0) return;
		const total = children.reduce((sum, child) => sum + (weight.get(child) ?? 1), 0) || 1;
		let cursor = from;
		for (const child of children) {
			const span = ((to - from) * (weight.get(child) ?? 1)) / total;
			walk(child, cursor, cursor + span);
			cursor += span;
		}
	};
	// Walk each top-level branch across its slice of the full circle. Arcs never
	// overlap between rings, so the order here is simply deterministic output.
	const rootChildren = (model.nodes.get(model.root)?.children ?? []).filter((c) => model.nodes.has(c));
	const rootWeight = rootChildren.reduce((sum, child) => sum + (weight.get(child) ?? 1), 0) || 1;
	let cursor = 0;
	for (const child of rootChildren) {
		const span = (Math.PI * 2 * (weight.get(child) ?? 1)) / rootWeight;
		walk(child, cursor, cursor + span);
		cursor += span;
	}

	const rootName = model.nodes.get(model.root)?.name ?? model.root;
	const body = `<title>${escapeXml(`${rootName} — ${model.nodes.size} concepts`)}</title>
<rect width="100%" height="100%" fill="#ffffff"/>
<circle data-node="${escapeXml(rootName)}" cx="${round(cx)}" cy="${round(cy)}" r="${round(
		centerRadius - 6
	)}" fill="#f4f1ff" stroke="#b06cff" stroke-width="1.2"/>
<text x="${round(cx)}" y="${round(cy - 2)}" font-size="13" font-weight="700" fill="#3a3550" text-anchor="middle">${escapeXml(
		rootName
	)}</text>
<text x="${round(cx)}" y="${round(cy + 15)}" font-size="9.5" fill="#6b6480" text-anchor="middle">${
		model.nodes.size
	} concepts</text>
${arcs.join('\n')}
${labels.join('\n')}`;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" font-family="Inter, system-ui, sans-serif">
${body}
</svg>
`;
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
