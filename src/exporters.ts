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
	/** Absolute cap on a label's characters, however much room it has. */
	maxLabelChars?: number;
	/** Maximum number of lines one label may wrap to. */
	maxLabelLines?: number;
	/** Angular padding between sibling arcs, in radians. */
	gap?: number;
	/** Font size of the ring labels; also drives the width estimate. */
	labelFontSize?: number;
	/**
	 * Smallest font a label may shrink to before its name is ellipsised instead.
	 * Shrinking beats cutting: a full name at a smaller size reads better than
	 * "Conser…" at the normal size.
	 */
	minLabelFontSize?: number;
	/**
	 * How far the rings may grow to keep names whole. The layout re-runs at
	 * growing radii so that a wide, deep tree can label every node in full
	 * instead of ellipsising the crowded rings. 1 disables the growth.
	 */
	radiusScaleLimit?: number;
}

/**
 * Advance width of one character, in em, for the label font stack. Measured
 * against Inter and Segoe UI at label size. A single average hides the fact
 * that "W" is nearly four times as wide as "i": a wedge sized for
 * "Thermodynamics in Chemistry" (0.50 em/char) is far too narrow for
 * "MMMMMMM WWWWWW" (0.87 em/char), and the label then runs over its
 * neighbours.
 */
const charWidthEm = (ch: string): number => {
	if (ch === ' ') return 0.26;
	if ('MW@%&'.includes(ch)) return 0.92;
	if ('mw'.includes(ch)) return 0.8;
	if ('ilj.,;:!|\'`'.includes(ch)) return 0.26;
	if ('frt()[]{}/\\-'.includes(ch)) return 0.37;
	if (ch >= '0' && ch <= '9') return 0.56;
	if (ch >= 'A' && ch <= 'Z') return 0.68;
	return 0.53;
};

/** Width of `text` in px at `fontSize`, from the per-character table. */
export function estimateTextWidth(text: string, fontSize: number): number {
	let em = 0;
	for (const ch of text) em += charWidthEm(ch);
	return em * fontSize;
}

/**
 * Average advance per character of `text`, in em, plus a small safety margin.
 * Wrapping works in characters, so this is what turns a pixel budget into a
 * character budget for one particular name.
 */
const avgCharWidthEm = (text: string): number => {
	if (!text) return 0.53;
	return (estimateTextWidth(text, 1) / text.length) * WIDTH_SAFETY;
};

/** Margin over the measured advances, for renderers whose font is slightly wider. */
const WIDTH_SAFETY = 1.06;

/**
 * Slack demanded when deciding whether a label still needs more room. Without
 * it the ring growth can stop exactly at the width where a name *just* fails to
 * fit, leaving it cut.
 */
const LABEL_HEADROOM = 1.04;

/** Font size and line advance of the footnote that lists unlabelled names. */
const NOTE_FONT_SIZE = 11;
const NOTE_LINE_HEIGHT = 15;

/**
 * Names that could not be drawn in full, wrapped as a note to put under the
 * drawing. An arc a few pixels wide cannot hold text and a box has its limits,
 * but the concept still has a name — it is listed rather than lost. `reason`
 * says why in the reader's terms ("too narrow to label" for a sunburst arc,
 * "shown shortened" for a graph box).
 */
function noteLines(names: string[], widthPx: number, reason: string): string[] {
	if (names.length === 0) return [];
	const perLine = Math.max(
		24,
		Math.floor((widthPx - 48) / (NOTE_FONT_SIZE * avgCharWidthEm(names.join(' '))))
	);
	const lines: string[] = [
		names.length === 1
			? `1 concept is ${reason}:`
			: `${names.length} concepts are ${reason}:`,
	];
	let current = '';
	for (const name of names) {
		const candidate = current ? `${current} · ${name}` : name;
		if (candidate.length <= perLine) {
			current = candidate;
			continue;
		}
		if (current) lines.push(current);
		current = name;
	}
	if (current) lines.push(current);
	return lines;
}

export interface RadialArc {
	name: string;
	depth: number;
	/** Top-level branch index (root = 0) — picks the colour. */
	branch: number;
	inner: number;
	outer: number;
	/** Angular start/end of the drawn arc (gaps already applied). */
	from: number;
	to: number;
}

export interface RadialLabel {
	name: string;
	/** The wrapped lines actually drawn (never empty). */
	lines: string[];
	/** The lines joined by a space, for tests and debugging. */
	text: string;
	/**
	 * `tangential` runs along the arc (nicer); `radial` runs outward from the
	 * centre, which has far more room when the arc is narrow.
	 */
	orientation: 'tangential' | 'radial';
	/** Angle of the arc's middle. */
	angle: number;
	/** Radius the text is centred on (tangential) or anchored at (radial). */
	radius: number;
	/** Anchor point, orientation-aware. */
	x: number;
	y: number;
	/** Rotation in degrees, already flipped so it is never upside down. */
	rotation: number;
	anchor: 'start' | 'middle' | 'end';
	fontSize: number;
	lineHeight: number;
	/** Angular half-width the text block occupies at its radius. */
	halfAngle: number;
	/** Arc length available inside the node's own arc, in px. */
	arcLength: number;
	/** True when the name had to be ellipsised to fit. */
	shortened: boolean;
	/**
	 * True when characters were actually dropped, as opposed to the name merely
	 * being capped at `maxLabelChars`. This is what the ring growth is driven by.
	 */
	truncated: boolean;
	/** True when a single word was longer than a line and had to be split. */
	hardBreak: boolean;
}

export interface RadialLayout {
	/** Canvas width: a square that holds the circle. */
	size: number;
	/** Canvas height: `size`, plus the footnote strip when there is one. */
	height: number;
	cx: number;
	cy: number;
	centerRadius: number;
	ringWidth: number;
	arcs: RadialArc[];
	labels: RadialLabel[];
	/** Root disc label, wrapped to fit the disc (empty when nothing fits). */
	rootLines: string[];
	rootLineHeight: number;
	/** Nodes left unlabelled because their arc could not hold readable text. */
	unlabelled: string[];
	/**
	 * The unlabelled names, wrapped ready to draw under the circle. An arc a few
	 * pixels wide cannot hold text, but the node still has a name, so it is
	 * listed instead of silently vanishing from the export.
	 */
	note: string[];
}

/**
 * Geometry for the radial sunburst: depth is the radius and the angular width of
 * a node is proportional to the number of concepts in its subtree.
 *
 * Kept separate from the SVG rendering so the invariants that matter — a label
 * never spills over its neighbours, and a name is shown in full whenever its arc
 * has room for it — can be asserted directly in tests.
 */
export function radialLayout(model: TreeModel, options: RadialOptions = {}): RadialLayout {
	const { depth, weight, branch, maxDepth } = analyseTree(model);
	const baseCenterRadius = Math.max(24, options.centerRadius ?? 74);
	const baseRingWidth = Math.max(20, options.ringWidth ?? 104);
	const maxLabelChars = Math.max(8, options.maxLabelChars ?? 64);
	const maxLabelLines = Math.max(1, options.maxLabelLines ?? 3);
	const gap = Math.max(0, options.gap ?? 0.008);
	const baseFontSize = Math.max(6, options.labelFontSize ?? 10.5);
	const minFontSize = Math.max(5, Math.min(baseFontSize, options.minLabelFontSize ?? 7.5));
	/** Font sizes to try, largest first (whole-pixel steps down to the floor). */
	const fontSizes: number[] = [];
	for (let size = baseFontSize; size >= minFontSize - 0.01; size -= 1) {
		fontSizes.push(Number(size.toFixed(2)));
	}

	/** Set by every pass to the ring growth its worst-fitting label still wants. */
	let demand = 1;

	/**
	 * One complete layout at one ring scale. The caller runs this repeatedly at
	 * growing radii: a wider ring gives every label both a longer arc and more
	 * characters per line, so a name that has to be cut at one scale can be
	 * whole at the next.
	 */
	const runPass = (centerRadius: number, ringWidth: number): RadialLayout => {
		const ringThickness = ringWidth - 4;
		const outer = centerRadius + maxDepth * ringWidth + 26;
		const size = Math.round(outer * 2 + 40);
		const cx = size / 2;
		const cy = size / 2 + 10;
		demand = 1;

		/** The name as it will be shown at most: long ones are capped with an ellipsis. */
		const cappedName = (name: string): string =>
			name.length > maxLabelChars ? `${name.slice(0, maxLabelChars - 1)}…` : name;

		/**
		 * Lines the greedy wrapper needs for `text` at `perLine`, with no cap — the
		 * honest measure of a name's height. Counting characters instead would
		 * under-report names whose words do not pack exactly ("Energy /
		 * Transformation / Pathways" needs three lines even though it is short
		 * enough for two by character count).
		 */
		const greedyLines = (text: string, perLine: number): number => {
			const words = text.split(/\s+/).filter(Boolean);
			let lines = 1;
			let current = '';
			for (const word of words) {
				const candidate = current ? `${current} ${word}` : word;
				if (candidate.length <= perLine) {
					current = candidate;
					continue;
				}
				if (current) lines += 1;
				current = word;
				while (current.length > perLine) {
					current = current.slice(perLine);
					lines += 1;
				}
			}
			return Math.max(1, lines);
		};

		/** Greedy word wrap; `hardBreak` is set when a word had to be split. */
		const wrap = (
			text: string,
			perLine: number,
			maxLines: number
		): { lines: string[]; hardBreak: boolean } | null => {
			if (perLine < 3) return null;
			const words = text.split(/\s+/).filter(Boolean);
			const lines: string[] = [];
			let hardBreak = false;
			let current = '';
			const push = (line: string): boolean => {
				if (lines.length >= maxLines) return false;
				lines.push(line);
				return true;
			};
			for (const word of words) {
				const candidate = current ? `${current} ${word}` : word;
				if (candidate.length <= perLine) {
					current = candidate;
					continue;
				}
				if (current && !push(current)) return null;
				current = '';
				let rest = word;
				while (rest.length > perLine) {
					if (!push(rest.slice(0, perLine))) return null;
					rest = rest.slice(perLine);
					hardBreak = true;
				}
				current = rest;
			}
			if (current && !push(current)) return null;
			return lines.length > 0 ? { lines, hardBreak } : null;
		};

		interface Fitted {
			lines: string[];
			orientation: 'tangential' | 'radial';
			shortened: boolean;
			/** True when the name was ellipsised to fit, rather than capped by length. */
			truncated: boolean;
			hardBreak: boolean;
			/** Arc length available where the text sits (binding edge). */
			arcLength: number;
			fontSize: number;
			lineHeight: number;
		}

		/** Layout options for one font size at one arc, for a name of `widthEm` per character. */
		const shapesAt = (
			span: number,
			innerRadius: number,
			midRadius: number,
			fontSize: number,
			widthEm: number
		) => {
			const charWidth = fontSize * widthEm;
			const lineHeight = fontSize * 1.25;
			// The glyph box is a little taller than the line advance and is centred
			// on the anchor, so a line costs `0.51em` beyond the baseline span.
			const boxPad = fontSize * 0.51;
			const maxLinesTangential = Math.max(
				1,
				Math.min(
					maxLabelLines,
					1 + Math.floor((ringThickness - 8 - 2 * boxPad) / lineHeight)
				)
			);
			// A tangential block is centred on the ring's middle, so its inner
			// corner sits half the block's height closer to the centre — where the
			// same number of pixels spans a wider angle. Size the line to that
			// edge, and also to what keeps the block's far corners inside the ring
			// itself: a long flat line is not contained by the arc length alone.
			const cornerRadius =
				midRadius - ((maxLinesTangential - 1) * lineHeight) / 2 - boxPad;
			const arcOuter = innerRadius - 6 + ringThickness;
			const widthCap = 2 * Math.sqrt(Math.max(0, arcOuter * arcOuter - cornerRadius * cornerRadius));
			const tangentialBudget = Math.min(span * cornerRadius - 6, widthCap);
			return [
				{
					orientation: 'tangential' as const,
					perLine: Math.floor(tangentialBudget / charWidth),
					maxLines: maxLinesTangential,
					arcLength: span * cornerRadius,
				},
				{
					orientation: 'radial' as const,
					perLine: Math.floor((ringThickness - 12) / charWidth),
					// Lines stack along the arc, so how many fit depends on the arc at the
					// inner edge. Zero means a radial label cannot be placed without
					// spilling over its neighbours, so this orientation is dropped.
					maxLines: Math.min(
						maxLabelLines,
						1 + Math.floor((span * innerRadius - 2 * boxPad) / lineHeight)
					),
					arcLength: span * innerRadius,
				},
			];
		};

		/**
		 * How far a label's text block would spill out of its own arc, in px. A
		 * block is symmetric about the middle of its arc, so this needs no absolute
		 * angles: only the arc's radii and the widest line. Zero means it fits.
		 *
		 * `shapesAt` sizes the text so this should already be zero everywhere; it
		 * is checked rather than assumed, because a wrong anchor, rotation or line
		 * height is invisible in the arithmetic until it is placed.
		 */
		const overflowInArc = (
			lines: string[],
			orientation: 'tangential' | 'radial',
			fontSize: number,
			lineHeight: number,
			span: number,
			innerRadius: number,
			midRadius: number
		): number => {
			const width = Math.max(...lines.map((line) => estimateTextWidth(line, fontSize)));
			const halfSpan = span / 2;
			const arcOuter = innerRadius - 6 + ringThickness;
			// The block is centred on the glyph box, not on the baselines (see the
			// renderer), so it reaches the same distance either side of the anchor.
			const boxHalf = ((lines.length - 1) * lineHeight) / 2 + fontSize * 0.51;
			if (orientation === 'radial') {
				// Runs outward from the inner edge; the lines stack across the arc,
				// which is narrowest right here, so measure them at this radius.
				const angular = boxHalf / innerRadius - halfSpan;
				const radial = width - (arcOuter - innerRadius);
				return Math.max(0, angular * innerRadius, radial);
			}
			// Tangential: centred on the ring. The block is a flat rectangle inside a
			// curved ring, so both the angle it subtends (worst at the inner edge)
			// and the corners it pushes outwards have to fit.
			const halfWidth = width / 2;
			const innerComponent = midRadius - boxHalf;
			const outerComponent = midRadius + boxHalf;
			const angular = Math.atan2(halfWidth, Math.max(1, innerComponent)) - halfSpan;
			const outerCorner = Math.hypot(outerComponent, halfWidth);
			const innerCorner = Math.hypot(innerComponent, halfWidth);
			return Math.max(
				0,
				angular * Math.max(1, innerComponent),
				outerCorner - arcOuter,
				innerRadius - 6 - innerCorner
			);
		};

		/**
		 * Fit a name into an arc:
		 *  1. the whole name at the largest font that can hold it without splitting a
		 *     word, then at a smaller font that can, and only then allowing a word to
		 *     be split (so "Mechanical / Energy / Conservation" wins over
		 *     "Mechanical Ener / gy Conservation");
		 *  2. failing all of that, as much of the name as the smallest font can show,
		 *     ellipsised;
		 *  3. failing that, no label (the arc still shows the node's size and colour).
		 */
		const fit = (name: string, span: number, innerRadius: number, midRadius: number): Fitted | null => {
			const capped = cappedName(name);
			const shortened = capped !== name;
			const widthEm = avgCharWidthEm(capped);

			/**
			 * Wrap `text` into a shape and keep narrowing it until the real glyph
			 * advances fit the arc. Wrapping itself counts characters using the
			 * name's average advance, but one line can be made of wider-than-average
			 * glyphs ("MMM" inside "Conservation"), so the wrapped block is measured
			 * and the line shortened until it fits.
			 */
			const wrapToFit = (
				text: string,
				shape: { orientation: 'tangential' | 'radial'; perLine: number; maxLines: number },
				fontSize: number,
				lineHeight: number
			): { lines: string[]; hardBreak: boolean } | null => {
				for (let perLine = shape.perLine; perLine >= 4; perLine--) {
					const wrapped = wrap(text, perLine, shape.maxLines);
					if (!wrapped) return null; // a narrower line cannot fit either
					if (
						overflowInArc(
							wrapped.lines,
							shape.orientation,
							fontSize,
							lineHeight,
							span,
							innerRadius,
							midRadius
						) <= 0
					) {
						return wrapped;
					}
				}
				return null;
			};

			for (const allowHardBreak of [false, true]) {
				for (const fontSize of fontSizes) {
					const lineHeight = fontSize * 1.25;
					const shapes = shapesAt(span, innerRadius, midRadius, fontSize, widthEm);
					for (const shape of shapes) {
						if (shape.perLine < 4 || shape.maxLines < 1) continue;
						const wrapped = wrapToFit(capped, shape, fontSize, lineHeight);
						if (!wrapped) continue;
						if (wrapped.hardBreak && !allowHardBreak) continue;
						return {
							lines: wrapped.lines,
							orientation: shape.orientation,
							shortened,
							truncated: false,
							hardBreak: wrapped.hardBreak,
							arcLength: shape.arcLength,
							fontSize,
							lineHeight,
						};
					}
				}
			}

			// Too small for the whole name even at the floor size: show as much as
			// possible from the size with the most room.
			for (const fontSize of [...fontSizes].reverse()) {
				const lineHeight = fontSize * 1.25;
				const shapes = shapesAt(span, innerRadius, midRadius, fontSize, widthEm);
				const best = shapes
					.slice()
					.sort((a, b) => b.perLine * b.maxLines - a.perLine * a.maxLines)[0];
				const capacity = best.perLine * best.maxLines;
				if (best.perLine < 4 || capacity < 6) continue;
				// Only signal a cut when characters really are dropped: dropping the
				// tail of a name that fits whole would be a lie, and it would also
				// keep the ring-growing pass asking for room it does not need.
				const dropped = capacity - 1 < capped.length;
				const text = dropped ? `${capped.slice(0, capacity - 1)}…` : capped;
				const wrapped = wrapToFit(text, best, fontSize, lineHeight);
				if (!wrapped) continue;
				return {
					lines: wrapped.lines,
					orientation: best.orientation,
					shortened: shortened || dropped,
					truncated: dropped,
					hardBreak: wrapped.hardBreak,
					arcLength: best.arcLength,
					fontSize,
					lineHeight,
				};
			}
			return null;
		};

		/**
		 * Angular width a name needs at the floor font, as a radial label — including
		 * the padding that will be cut from both ends of its wedge. The line count
		 * comes from the real word wrapper, because a name is only ever laid out on
		 * word boundaries unless there is no other way.
		 */
		const neededSpan = (name: string, nodeDepth: number): number => {
			const radius = Math.max(1, centerRadius + Math.max(0, nodeDepth - 1) * ringWidth + 6);
			const perLine = Math.max(
				1,
				Math.floor((ringThickness - 12) / (minFontSize * avgCharWidthEm(cappedName(name))))
			);
			const lines = greedyLines(cappedName(name), perLine);
			// Height of the centred glyph box, which is what has to fit the arc.
			const height = (lines - 1) * minFontSize * 1.25 + minFontSize * 1.02;
			return height / radius + 2 * gap;
		};

		/**
		 * How much wider this ring would have to be for the name to fit at the floor
		 * font; 1 when the label is already as complete as the layout allows. This is
		 * what tells the caller to grow the rings.
		 */
		const neededScale = (
			name: string,
			span: number,
			radius: number,
			fitted: Fitted | null
		): number => {
			if (span <= 0 || radius <= 0) return 1;
			if (fitted && !fitted.truncated) return 1;
			// The length cap is doing its job: no ring width can show a novel.
			if (name.length > maxLabelChars) return 1;
			const perLine = Math.max(
				1,
				Math.floor((ringThickness - 12) / (minFontSize * avgCharWidthEm(cappedName(name))))
			);
			const lines = greedyLines(cappedName(name), perLine);
			const wanted = (lines - 1) * minFontSize * 1.25 + minFontSize * 1.02;
			// A little headroom, so growth stops past the boundary rather than a
			// hair short of it, which would leave the name cut.
			return Math.max(1, (wanted * LABEL_HEADROOM) / (span * radius));
		};

		/**
		 * Split `total` radians between siblings: each one gets the wedge its label
		 * needs — never more than an equal share, so the floors can always be paid —
		 * and whatever is left is divided by subtree weight. Without the minimum, a
		 * one-leaf branch next to a thirty-leaf branch is a sliver, and
		 * "Mechanical Energy Conservation" cannot be drawn in a sliver at any font
		 * size; without the equal-share cap, many long names would collectively
		 * overdraw the ring and shrink each other into illegibility.
		 */
		const splitSpans = (
			kids: { name: string; depth: number; weight: number }[],
			total: number
		): number[] => {
			if (kids.length === 0) return [];
			const fair = total / kids.length;
			const floors = kids.map((kid) => Math.min(neededSpan(kid.name, kid.depth), fair));
			const floorTotal = floors.reduce((sum, value) => sum + value, 0);
			const totalWeight = kids.reduce((sum, kid) => sum + kid.weight, 0) || 1;
			const remaining = Math.max(0, total - floorTotal);
			return kids.map((kid, i) => floors[i] + (remaining * kid.weight) / totalWeight);
		};

		const arcs: RadialArc[] = [];
		const labels: RadialLabel[] = [];
		const unlabelled: string[] = [];
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
				// Padding must not dominate a narrow wedge.
				const gapForArc = Math.min(gap, Math.max(0, to - from) * 0.1);
				const arc: RadialArc = {
					name,
					depth: nodeDepth,
					branch: branch.get(name) ?? 1,
					inner,
					outer: outerRadius,
					from: from + gapForArc,
					to: to - gapForArc,
				};
				arcs.push(arc);

				const angle = (from + to) / 2;
				const radius = inner + ringThickness / 2;
				const span = Math.max(0, arc.to - arc.from);
				const fitted = fit(node.name, span, inner + 6, radius);
				demand = Math.max(demand, neededScale(node.name, span, inner + 6, fitted));
				if (fitted) {
					// A tangential label runs along the arc, so its baseline is a
					// quarter turn from the radius; a radial label runs along the
					// radius. Whichever way it points, text on the left half is
					// turned the other way round so it never reads upside down.
					const baseline = fitted.orientation === 'radial' ? angle : angle + Math.PI / 2;
					const baselineDegrees = (baseline * 180) / Math.PI;
					const upright = ((baselineDegrees % 360) + 360) % 360;
					const flipped = upright > 90 && upright < 270;
					const [px, py] =
						fitted.orientation === 'radial'
							? flipped
								? [cx + (outerRadius - 6) * Math.cos(angle), cy + (outerRadius - 6) * Math.sin(angle)]
								: [cx + (inner + 6) * Math.cos(angle), cy + (inner + 6) * Math.sin(angle)]
							: [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
					// Tangential footprint of the block, in px along the arc. For radial
					// labels that is the stacked height, measured at the inner edge
					// where the arc is narrowest.
					const tangentialExtent =
						fitted.orientation === 'radial'
							? fitted.lines.length * fitted.lineHeight
							: Math.max(
									...fitted.lines.map((line) => estimateTextWidth(line, fitted.fontSize))
								);
					const footprintRadius = fitted.orientation === 'radial' ? inner + 6 : radius;
					labels.push({
						name,
						lines: fitted.lines,
						text: fitted.lines.join(' '),
						orientation: fitted.orientation,
						angle,
						radius,
						x: px,
						y: py,
						rotation: flipped ? baselineDegrees + 180 : baselineDegrees,
						// A radial label always starts at the edge it is anchored to and
						// reads inward on the left half, outward on the right half. Ending
						// the text at the anchor instead would push the whole name out
						// past the outer edge of the ring.
						anchor: fitted.orientation === 'radial' ? 'start' : 'middle',
						fontSize: fitted.fontSize,
						lineHeight: fitted.lineHeight,
						halfAngle: tangentialExtent / 2 / footprintRadius,
						arcLength: fitted.arcLength,
						shortened: fitted.shortened,
						truncated: fitted.truncated,
						hardBreak: fitted.hardBreak,
					});
				} else {
					unlabelled.push(name);
				}
			}

			const children = (node.children ?? []).filter((child) => model.nodes.has(child));
			if (children.length === 0) return;
			const childSpans = splitSpans(
				children.map((child) => ({
					name: child,
					depth: nodeDepth + 1,
					weight: weight.get(child) ?? 1,
				})),
				to - from
			);
			let cursor = from;
			children.forEach((child, i) => {
				walk(child, cursor, cursor + childSpans[i]);
				cursor += childSpans[i];
			});
		};
		// Walk each top-level branch across its slice of the full circle. Arcs never
		// overlap between rings, so the order here is simply deterministic output.
		const rootChildren = (model.nodes.get(model.root)?.children ?? []).filter((c) => model.nodes.has(c));
		const rootSpans = splitSpans(
			rootChildren.map((child) => ({ name: child, depth: 1, weight: weight.get(child) ?? 1 })),
			Math.PI * 2
		);
		let cursor = 0;
		rootChildren.forEach((child, i) => {
			walk(child, cursor, cursor + rootSpans[i]);
			cursor += rootSpans[i];
		});

		const rootName = model.nodes.get(model.root)?.name ?? model.root;
		const rootFont = 13;
		const rootLineHeight = rootFont * 1.25;
		// The root label sits in a disc, so it wraps to the chord across it.
		const rootLines =
			wrap(
				rootName,
				Math.floor(
					(2 * (centerRadius - 14)) / (rootFont * avgCharWidthEm(rootName))
				),
				2
			)?.lines ?? [];

		return {
			size,
			height: size,
			cx,
			cy,
			centerRadius,
			ringWidth,
			arcs,
			labels,
			rootLines,
			rootLineHeight,
			unlabelled,
			note: [],
		};
	};

	// Grow the rings while any label still has to be cut, up to the scale limit.
	// Every step re-runs the whole walk, because a wider ring fits more
	// characters per line and so needs less angular room for the same name.
	const maxScale = Math.max(1, options.radiusScaleLimit ?? 2.5);
	let scale = 1;
	let result = runPass(baseCenterRadius, baseRingWidth);
	for (let step = 0; step < 6 && scale < maxScale && demand > 1.001; step++) {
		scale = Math.min(maxScale, scale * Math.min(demand, 1.6));
		result = runPass(baseCenterRadius * scale, baseRingWidth * scale);
	}

	// An arc a couple of pixels wide can never hold text, but the concept still
	// has a name — list those under the drawing instead of losing them.
	const note = noteLines(result.unlabelled, result.size, 'too narrow to label');
	if (note.length > 0) {
		result.note = note;
		result.height = result.size + note.length * NOTE_LINE_HEIGHT + 26;
	}
	return result;
}

/**
 * Radial sunburst of the tree as an SVG string.
 *
 * This is the layout to reach for when a tree is wide rather than deep — the
 * layered SVG grows with the number of leaves (a 33-node tree can be ~3200px
 * wide for 292px of height), while the sunburst stays roughly square and makes
 * "which branch is biggest" obvious at a glance.
 *
 * Names are shown in full whenever their arc has room: labels wrap onto up to
 * three lines, and a narrow arc switches to a radial label running outward,
 * which has the whole ring thickness to work with.
 */
export function buildRadialSvg(model: TreeModel, options: RadialOptions = {}): string {
	const layout = radialLayout(model, options);
	const { size, height, cx, cy, centerRadius, arcs, labels, rootLines, rootLineHeight } = layout;
	const round = (value: number): string => value.toFixed(2);
	const point = (radius: number, angle: number): [number, number] => [
		cx + radius * Math.cos(angle),
		cy + radius * Math.sin(angle),
	];
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

	const arcMarkup = arcs
		.map(
			(arc) =>
				`<path data-node="${escapeXml(arc.name)}" d="${arcPath(
					arc.inner,
					arc.outer,
					arc.from,
					arc.to
				)}" fill="${branchFill(arc.branch, arc.depth)}" stroke="${branchStroke(
					arc.branch
				)}" stroke-width="0.8" stroke-opacity="0.5"/>`
		)
		.join('\n');
	const labelMarkup = labels
		.map((label) => {
			const tspans = label.lines
				.map((line, i) => {
					// Centre the glyph box, not the baselines: a line reaches 0.78em
					// above its baseline but only 0.24em below, so baseline-centred
					// text sits high and pokes out of a narrow arc.
					const dy =
						i === 0
							? -((label.lines.length - 1) * label.lineHeight) / 2 +
								label.fontSize * 0.27
							: label.lineHeight;
					return `<tspan x="${round(label.x)}" dy="${round(dy)}">${escapeXml(line)}</tspan>`;
				})
				.join('');
			return `<text x="${round(label.x)}" y="${round(label.y)}" font-size="${
				label.fontSize
			}" fill="#2c2740" text-anchor="${label.anchor}" transform="rotate(${round(label.rotation)} ${round(
				label.x
			)} ${round(label.y)})">${tspans}</text>`;
		})
		.join('\n');

	const rootName = model.nodes.get(model.root)?.name ?? model.root;
	const rootMarkup =
		rootLines.length > 0
			? `<text x="${round(cx)}" y="${round(cy - 2)}" font-size="13" font-weight="700" fill="#3a3550" text-anchor="middle">${rootLines
					.map((line, i) => {
						const dy = i === 0 ? -((rootLines.length - 1) * rootLineHeight) / 2 : rootLineHeight;
						return `<tspan x="${round(cx)}" dy="${round(dy)}">${escapeXml(line)}</tspan>`;
					})
					.join('')}</text>`
			: '';
	const subtitleY = rootLines.length > 1 ? cy + 30 : cy + 15;
	const noteMarkup = layout.note
		.map(
			(line, i) =>
				`<text data-note="true" x="24" y="${round(size + 18 + i * NOTE_LINE_HEIGHT)}" font-size="${NOTE_FONT_SIZE}" fill="#6b6480">${escapeXml(
					line
				)}</text>`
		)
		.join('\n');
	const body = `<title>${escapeXml(`${rootName} — ${model.nodes.size} concepts`)}</title>
<rect width="100%" height="100%" fill="#ffffff"/>
<circle data-node="${escapeXml(rootName)}" cx="${round(cx)}" cy="${round(cy)}" r="${round(
		centerRadius - 6
	)}" fill="#f4f1ff" stroke="#b06cff" stroke-width="1.2"/>
${rootMarkup}
<text x="${round(cx)}" y="${round(subtitleY)}" font-size="9.5" fill="#6b6480" text-anchor="middle">${
		model.nodes.size
	} concepts</text>
${arcMarkup}
${labelMarkup}
${noteMarkup}`;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}" viewBox="0 0 ${size} ${height}" font-family="Inter, system-ui, sans-serif">
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

/** Margin around the whole diagram. */
const PAD = 24;
/** Horizontal padding inside a node box. */
const NODE_PAD_X = 28;
/** Vertical padding inside a box, and the gaps between subtrees and rows. */
const NODE_PAD_Y = 10;
const SIBLING_GAP = 20;
const ROW_GAP = 36;
const MIN_NODE_W = 96;
/** Width a label wraps to before the box may grow wider. */
const TARGET_NODE_W = 220;
/** Lines a node label may wrap onto. */
const MAX_NODE_LINES = 3;
const TREE_MIN_FONT = 9.5;
/** Font sizes a node label may shrink through, largest first. */
const TREE_FONTS = [12, 11, 10, 9.5];

interface TreeLabel {
	/** The lines as drawn; more than one when the name had to wrap. */
	lines: string[];
	font: number;
	w: number;
	h: number;
	/** True when the name could not be shown in full and was shortened. */
	shortened: boolean;
}

interface LayoutNode {
	x: number;
	y: number;
	w: number;
	label: TreeLabel;
}

/**
 * Greedy word wrap measured in pixels. A word wider than the line is split,
 * because a single very long token is still better broken than dropped.
 */
function wrapToWidth(text: string, maxWidth: number, font: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (estimateTextWidth(candidate, font) <= maxWidth) {
			current = candidate;
			continue;
		}
		if (current) lines.push(current);
		current = '';
		let rest = word;
		while (rest.length > 1 && estimateTextWidth(rest, font) > maxWidth) {
			let cut = rest.length - 1;
			while (cut > 1 && estimateTextWidth(rest.slice(0, cut), font) > maxWidth) cut--;
			lines.push(rest.slice(0, cut));
			rest = rest.slice(cut);
		}
		current = rest;
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [text];
}

/** Shorten `text` until it fits `maxWidth` at `font`, ending with an ellipsis. */
function ellipsise(text: string, maxWidth: number, font: number): string {
	let cut = text.length;
	while (cut > 1 && estimateTextWidth(`${text.slice(0, cut - 1)}…`, font) > maxWidth) {
		cut--;
	}
	return `${text.slice(0, Math.max(1, cut - 1))}…`;
}

/**
 * The label as drawn for a node: wrapped onto a few lines, at the largest font
 * that lets the whole name fit. Only a name that cannot fit even at the floor
 * font in the allowed lines is shortened — and then it is listed under the
 * drawing, so the reader still gets the name.
 */
function fitTreeLabel(name: string): TreeLabel {
	const budget = TARGET_NODE_W - NODE_PAD_X;
	const box = (lines: string[], font: number, shortened: boolean): TreeLabel => {
		const lineHeight = font * 1.25;
		return {
			lines,
			font,
			w: Math.min(TARGET_NODE_W, Math.max(MIN_NODE_W, Math.max(...lines.map((line) => estimateTextWidth(line, font))) + NODE_PAD_X)),
			h: Math.round((lines.length - 1) * lineHeight + font * 1.02 + NODE_PAD_Y * 2),
			shortened,
		};
	};
	for (const font of TREE_FONTS) {
		const lines = wrapToWidth(name, budget, font);
		if (lines.length <= MAX_NODE_LINES) return box(lines, font, false);
	}
	// Still too long at the floor font: keep the first lines and ellipsise the last.
	const font = TREE_MIN_FONT;
	const lines = wrapToWidth(name, budget, font).slice(0, MAX_NODE_LINES);
	lines[lines.length - 1] = ellipsise(`${lines[lines.length - 1]} …`, budget, font);
	return box(lines, font, true);
}

/**
 * Layered SVG diagram of the tree (nodes + curved parent→child connectors).
 *
 * Each subtree owns a disjoint horizontal interval, sized as the larger of its
 * own box and the intervals of its children plus a gap. Boxes are then centred
 * inside their interval, so two boxes can never overlap — the earlier version
 * spaced columns by leaf count while boxes were up to 240px wide, and a wide
 * box simply sat on top of its neighbour.
 *
 * Boxes are sized from the measured width of the label rather than a character
 * count, so a long concept name is not drawn outside its own rectangle. That
 * makes a wide tree wider still, so a long name shrinks before it is cut, and
 * anything still too long is listed under the drawing.
 */
export function buildTreeSvg(model: TreeModel): string {
	const nodes = model.nodes;
	const depth = computeDepths(model);
	const labels = new Map<string, TreeLabel>();
	for (const name of nodes.keys()) labels.set(name, fitTreeLabel(name));
	const labelOf = (name: string): TreeLabel => labels.get(name) ?? fitTreeLabel(name);
	const boxW = (name: string): number => labelOf(name).w;

	// Rows are as tall as the tallest box in them, so a wrapped label has room
	// without pushing every other row down.
	const rowHeight = new Map<number, number>();
	for (const [name, label] of labels) {
		const d = depth.get(name) ?? 0;
		rowHeight.set(d, Math.max(rowHeight.get(d) ?? 0, label.h));
	}
	const rowTop = new Map<number, number>();
	{
		let y = PAD;
		const maxRow = Math.max(0, ...rowHeight.keys());
		for (let d = 0; d <= maxRow; d++) {
			rowTop.set(d, y);
			y += (rowHeight.get(d) ?? 0) + ROW_GAP;
		}
	}

	/** Width a subtree needs, cycle-safe (hand-edited frontmatter can loop). */
	const slots = new Map<string, number>();
	const measure = (name: string, open: Set<string>): number => {
		const n = nodes.get(name);
		if (!n) return 0;
		if (open.has(name)) return 0;
		open.add(name);
		const children = (n.children ?? []).filter((child) => nodes.has(child));
		let childrenW = 0;
		children.forEach((child, index) => {
			childrenW += measure(child, open) + (index > 0 ? SIBLING_GAP : 0);
		});
		open.delete(name);
		const width = Math.max(boxW(name), childrenW);
		slots.set(name, width);
		return width;
	};
	measure(model.root, new Set());

	const layout = new Map<string, LayoutNode>();
	let minX = 0;
	let maxX = 0;
	/** Place `name` inside [left, left + its slot]; returns the slot width used. */
	const place = (name: string, left: number, open: Set<string>): number => {
		const n = nodes.get(name);
		if (!n) return 0;
		if (open.has(name)) return 0;
		open.add(name);
		const slot = slots.get(name) ?? MIN_NODE_W;
		const label = labelOf(name);
		const w = label.w;
		const y = (rowTop.get(depth.get(name) ?? 0) ?? PAD) + ((rowHeight.get(depth.get(name) ?? 0) ?? label.h) - label.h) / 2;
		const children = (n.children ?? []).filter((child) => nodes.has(child));
		if (children.length === 0) {
			const x = left + (slot - w) / 2;
			layout.set(name, { x, y, w, label });
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x + w);
			open.delete(name);
			return slot;
		}
		// Children take the whole slot, left to right; each one is placed inside
		// its own slot — which may be wider than the children it holds, when its
		// own box is the widest thing in it — so siblings cannot overlap.
		let cursor = left;
		const childSlots: number[] = [];
		for (const child of children) {
			const childSlot = slots.get(child) ?? MIN_NODE_W;
			place(child, cursor, open);
			childSlots.push(childSlot);
			cursor += childSlot + SIBLING_GAP;
		}
		const childrenW =
			childSlots.reduce((sum, width) => sum + width, 0) +
			Math.max(0, children.length - 1) * SIBLING_GAP;
		const centre = left + childrenW / 2;
		const x = Math.max(left, Math.min(left + slot - w, centre - w / 2));
		layout.set(name, { x, y, w, label });
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x + w);
		open.delete(name);
		return slot;
	};
	// `slots` is measured first, so a parent can be centred over its children's
	// true extent while placing them: one pass is enough.
	place(model.root, 0, new Set());

	const maxDepth = Math.max(0, ...depth.values());
	const totalW = Math.round(maxX - minX + PAD * 2);
	const diagramH = Math.round(
		(rowTop.get(maxDepth) ?? PAD) + (rowHeight.get(maxDepth) ?? 0) + PAD
	);
	// Names that had to be shortened are listed under the drawing, so no concept
	// is left unnamed in the export.
	const shortened = [...labels.entries()]
		.filter(([name, label]) => label.shortened || label.lines.join(' ') !== name)
		.map(([name]) => name);
	const note = noteLines(shortened, totalW, 'shown shortened');
	const noteHeight = note.length > 0 ? note.length * NOTE_LINE_HEIGHT + 26 : 0;
	const totalH = diagramH + noteHeight;
	const shiftX = PAD - minX;

	const edges: string[] = [];
	for (const n of nodes.values()) {
		const from = layout.get(n.name);
		if (!from) continue;
		for (const c of n.children) {
			const to = layout.get(c);
			if (!to) continue;
			const x1 = from.x + from.w / 2;
			const y1 = from.y + from.label.h;
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
		const label = l.label;
		const tspans = label.lines
			.map(
				(line, i) =>
					`<tspan x="${(l.w / 2).toFixed(1)}" dy="${
						i === 0 ? -((label.lines.length - 1) * label.font * 1.25) / 2 + label.font * 0.27 : label.font * 1.25
					}">${escapeXml(line)}</tspan>`
			)
			.join('');
		boxes.push(
			`<g data-node="${escapeXml(n.name)}" transform="translate(${l.x + shiftX}, ${l.y})">
  <rect width="${l.w.toFixed(1)}" height="${label.h}" rx="8" fill="#f4f1ff" stroke="#b06cff" stroke-width="1"/>
  <text x="${(l.w / 2).toFixed(1)}" y="${(label.h / 2).toFixed(1)}" text-anchor="middle" font-size="${label.font}" fill="#3a3550">${tspans}</text>
</g>`
		);
	}
	const noteMarkup = note
		.map(
			(line, i) =>
				`<text data-note="true" x="24" y="${(diagramH + 18 + i * NOTE_LINE_HEIGHT).toFixed(
					1
				)}" font-size="${NOTE_FONT_SIZE}" fill="#6b6480">${escapeXml(line)}</text>`
		)
		.join('\n');

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="Inter, system-ui, sans-serif">
<rect width="100%" height="100%" fill="#ffffff"/>
${edges.join('\n')}
${boxes.join('\n')}
${noteMarkup}
</svg>
`;
}

