import { jsonrepair } from 'jsonrepair';
import type { Complexity } from './types';

/**
 * Robust helpers for parsing LLM output and producing safe file names / YAML.
 */

/** Strip markdown fences and trailing prose, then extract the first balanced JSON object. */
export function extractJSON<T = unknown>(text: string): T | null {
	if (!text) return null;
	let s = text.trim();

	// Strip ```json ... ``` fences (any fence flavor).
	const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch) s = fenceMatch[1].trim();

	const start = s.indexOf('{');
	if (start === -1) return null;
	// If the response was truncated (no closing brace), repair the tail.
	let end = s.lastIndexOf('}');
	if (end <= start) end = s.length - 1;
	s = s.slice(start, end + 1);

	const attempts: (() => unknown)[] = [
		// 1. Direct parse.
		() => JSON.parse(s),
		// 2. Tolerate trailing commas (a very common LLM slip).
		() => JSON.parse(s.replace(/,\s*([}\]])/g, '$1')),
		// 3. Insert missing "{ }" braces around object entries emitted
		//    directly inside arrays (the "energy" failure mode), then repair.
		() => JSON.parse(jsonrepair(repairMissingBraces(s))),
		// 4. Full repair — unquoted keys, single quotes, multiline strings,
		//    missing commas, truncated tails, …
		() => JSON.parse(jsonrepair(s)),
	];

	for (const attempt of attempts) {
		try {
			const value = attempt();
			// The prompts always demand an object; a repaired primitive is garbage.
			if (typeof value === 'object' && value !== null) {
				return value as T;
			}
		} catch {
			/* try next strategy */
		}
	}
	return null;
}

/**
 * Targeted pre-pass for the most common LLM JSON failure: object entries
 * emitted directly inside arrays with their "{ }" braces dropped, e.g.
 *
 *   "domains": [
 *     "name": "Physics",
 *     "children": [
 *       "name": "Kinetic Energy",
 *
 * Each "key": pair found in array context opens an implicit object. The
 * object is closed when a comma is followed by a key already seen inside it
 * (a new array element) or by a non-key token, or when `]` / `}` arrives.
 * It is a no-op on valid JSON; remaining issues go to jsonrepair.
 */
export function repairMissingBraces(s: string): string {
	interface Frame {
		type: '{' | '[';
		implicit: boolean;
		seen: Set<string>;
	}
	const stack: Frame[] = [];
	let out = '';
	let inString = false;

	/** From a `"` at `pos`, return the key text if this token is a "key": pair. */
	const keyAt = (pos: number): { key: string } | null => {
		let j = pos + 1;
		let key = '';
		let closed = false;
		while (j < s.length) {
			const c = s[j];
			if (c === '\\') {
				key += s[j + 1] ?? '';
				j += 2;
				continue;
			}
			if (c === '"') {
				closed = true;
				j++;
				break;
			}
			key += c;
			j++;
		}
		if (!closed) return null;
		while (j < s.length && /\s/.test(s[j])) j++;
		return s[j] === ':' ? { key } : null;
	};

	/** Peek the next "key": token after a comma at index `i`. */
	const nextKeyAfter = (i: number): string | null => {
		let j = i;
		while (j < s.length && /\s/.test(s[j])) j++;
		if (s[j] !== '"') return null;
		const k = keyAt(j);
		return k ? k.key : null;
	};

	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inString) {
			out += ch;
			if (ch === '\\' && i + 1 < s.length) {
				out += s[i + 1];
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			const top = stack[stack.length - 1];
			const k = keyAt(i);
			if (k) {
				if (top && top.type === '[') {
					// Object entry directly inside an array → open an implicit object.
					const frame: Frame = { type: '{', implicit: true, seen: new Set() };
					frame.seen.add(k.key);
					stack.push(frame);
					out += '{';
				} else if (top && top.type === '{') {
					top.seen.add(k.key);
				}
			}
			out += ch;
			inString = true;
			continue;
		}
		if (ch === '{' || ch === '[') {
			stack.push({ type: ch, implicit: false, seen: new Set() });
			out += ch;
			continue;
		}
		if (ch === '}') {
			let top = stack[stack.length - 1];
			while (top && top.implicit) {
				out += '}';
				stack.pop();
				top = stack[stack.length - 1];
			}
			if (top && top.type === '{') {
				out += '}';
				stack.pop();
			} else {
				out += ch;
			}
			continue;
		}
		if (ch === ']') {
			let top = stack[stack.length - 1];
			while (top && top.implicit) {
				out += '}';
				stack.pop();
				top = stack[stack.length - 1];
			}
			if (top && top.type === '[') {
				out += ']';
				stack.pop();
			} else {
				out += ch;
			}
			continue;
		}
		if (ch === ',') {
			const top = stack[stack.length - 1];
			if (top && top.type === '{' && top.implicit) {
				const nextKey = nextKeyAfter(i + 1);
				if (nextKey === null || top.seen.has(nextKey)) {
					// The implicit object ends here: next element or end of array.
					out += '}';
					stack.pop();
				}
			}
			out += ch;
			continue;
		}
		out += ch;
	}

	// Close anything left open (truncated tail).
	while (stack.length > 0) {
		const top = stack[stack.length - 1];
		out += top.implicit ? '}' : top.type === '{' ? '}' : ']';
		stack.pop();
	}
	return out;
}

export function normalizeKey(s: string): string {
	return (s || '').trim().toLowerCase();
}

export function titleCase(s: string): string {
	return s
		.trim()
		.split(/\s+/)
		.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
		.join(' ');
}

/** Deterministic small hash (djb2) — used for cache keys. */
export function hashString(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36);
}

/** Escape a string for single-line double-quoted YAML. */
export function yamlStr(s: string): string {
	let out = '';
	for (const ch of s) {
		const code = ch.charCodeAt(0);
		if (ch === '"') out += '\\"';
		else if (ch === '\\') out += '\\\\';
		else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
		else out += ch;
	}
	return `"${out}"`;
}

/** YAML flow-style array of strings. */
export function yamlStrArray(arr: string[]): string {
	return '[' + arr.map((a) => yamlStr(a)).join(', ') + ']';
}

/** Slugify a concept name for hierarchical paths: /democracy/political_science */
export function slugify(s: string): string {
	return (s || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

/** Sanitize a concept name into a safe vault file stem. */
export function sanitizeFileName(s: string): string {
	let out = (s || '')
		.trim()
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[. ]+$/g, '');
	if (!out) out = 'concept';
	if (out.length > 100) out = out.slice(0, 100).trim();
	return out;
}

/** Coerce an LLM-provided complexity string into the union type. */
export function normalizeComplexity(c: unknown, fallback: Complexity = 'Intermediate'): Complexity {
	const s = String(c ?? '').toLowerCase();
	if (s.includes('begin') || s.includes('basic')) return 'Beginner';
	if (s.includes('advanced')) return 'Advanced';
	if (s.includes('intermediate')) return 'Intermediate';
	return fallback;
}

/** Parse estimated_depth / created / etc. tolerantly (numbers or ISO timestamps). */
export function toInt(v: unknown, fallback: number): number {
	if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : fallback;
	}
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

export function toBool(v: unknown, fallback: boolean): boolean {
	if (typeof v === 'boolean') return v;
	if (typeof v === 'number') return v === 1;
	if (typeof v === 'string') {
		const s = v.trim().toLowerCase();
		if (s === 'true' || s === 'yes' || s === '1') return true;
		if (s === 'false' || s === 'no' || s === '0') return false;
	}
	return fallback;
}

/** Convert a numeric timestamp to an ISO-ish string. */
export function isoTime(ts: number): string {
	return new Date(ts).toISOString();
}

/**
 * Minimal tolerant parser for our generated frontmatter (and Obsidian's own
 * rewrites of it). Handles:
 *   key: value            (quoted / plain / bool / number)
 *   key: [a, "b c", d]    (flow arrays)
 *   key:                  (block arrays)
 *     - item
 * Nested maps are intentionally not supported (we never write them).
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const lines = text.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith('#')) {
			i++;
			continue;
		}
		const m = line.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
		if (!m) {
			i++;
			continue;
		}
		const key = m[2];
		let value = (m[3] ?? '').trim();
		if (!value) {
			// Block scalar / list
			const items: string[] = [];
			i++;
			while (i < lines.length) {
				const l = lines[i];
				const item = l.match(/^\s*-\s+(.*)$/);
				if (item) {
					items.push(unquote(item[1].trim()));
					i++;
				} else if (!l.trim() || /^[A-Za-z0-9_-]+:/.test(l.trim())) {
					break;
				} else {
					i++;
				}
			}
			out[key] = items.length > 0 ? items : '';
			continue;
		}
		if (value.startsWith('[') && value.endsWith(']')) {
			const inner = value.slice(1, -1);
			out[key] = splitFlowArray(inner);
		} else {
			out[key] = parseScalar(value);
		}
		i++;
	}
	return out;
}

function splitFlowArray(inner: string): string[] {
	const items: string[] = [];
	let cur = '';
	let inQuote: '"' | "'" | null = null;
	for (let k = 0; k < inner.length; k++) {
		const ch = inner[k];
		if (inQuote) {
			if (ch === '\\' && inQuote === '"' && k + 1 < inner.length) {
				cur += inner[k + 1];
				k++;
			} else if (ch === inQuote) {
				inQuote = null;
			} else {
				cur += ch;
			}
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
		} else if (ch === ',') {
			items.push(cur.trim());
			cur = '';
		} else {
			cur += ch;
		}
	}
	if (cur.trim()) items.push(cur.trim());
	return items.filter(Boolean);
}

function unquote(s: string): string {
	if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
		return s.slice(1, -1).replace(/\\(.)/g, '$1');
	}
	if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
		return s.slice(1, -1).replace(/''/g, "'");
	}
	return s;
}

function parseScalar(s: string): unknown {
	const u = unquote(s);
	if (u === 'true') return true;
	if (u === 'false') return false;
	if (/^-?\d+$/.test(u)) return parseInt(u, 10);
	if (/^-?\d*\.\d+$/.test(u)) return parseFloat(u);
	return u;
}
