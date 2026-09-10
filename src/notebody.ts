/**
 * Pure helpers for the plugin-managed regions of a note body.
 *
 * `ConceptStore.writeNode` rebuilds a note from the in-memory model every time
 * the plugin touches it (adding a connection, expanding children, merging), so
 * anything living in the body survives only if the store knows how to carry it
 * over. Each managed region therefore has a heading plus an HTML-comment
 * marker, and its content runs until the next `## ` heading (or end of file):
 *
 *   ## Deep dive
 *   <!-- cognitree:deep-dive -->
 *   …generated Markdown, freely editable by hand…
 *
 * The region runs until the next section the plugin itself owns (`## Connections`
 * or `## Meta`) or the end of the file. Hand edits and extra headings inside it
 * are preserved verbatim on the next rewrite.
 */

export const DEEP_DIVE_HEADING = '## Deep dive';
export const DEEP_DIVE_MARKER = '<!-- cognitree:deep-dive -->';

/** Hard cap for a generated region — keeps one bad response from bloating a note. */
export const MAX_DEEP_DIVE_CHARS = 12000;

/**
 * The only headings that end a managed region: the plugin's own sections.
 * Anything else (including a hand-written `## Notes`) stays inside the region,
 * so it is carried over instead of being dropped on the next rewrite.
 */
const REGION_TERMINATORS = [/^##\s+connections\s*$/i, /^##\s+meta\s*$/i];

/** Body text of a marker-delimited region, trimmed ('' when the marker is absent). */
export function extractRegion(body: string, marker: string): string {
	if (!body) return '';
	const lines = body.split(/\r?\n/);
	const start = lines.findIndex((l) => l.trim() === marker);
	if (start === -1) return '';
	const out: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (REGION_TERMINATORS.some((re) => re.test(lines[i].trim()))) break;
		out.push(lines[i]);
	}
	return out.join('\n').trim();
}

/** The current "## Deep dive" content of a note body ('' when absent). */
export function extractDeepDive(body: string): string {
	return extractRegion(body, DEEP_DIVE_MARKER);
}

/** Strip the YAML frontmatter block, if the model emitted one. */
export function stripFrontmatter(text: string): string {
	return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/**
 * Normalise LLM output into something safe to drop into a note body: no
 * frontmatter, no duplicate top-level heading, no echo of the region heading or
 * marker, no runaway blank lines, length-capped.
 */
export function sanitizeDeepDive(raw: string): string {
	let s = stripFrontmatter(String(raw ?? '').trim()).trim();
	if (!s) return '';

	const lines: string[] = [];
	for (const line of s.split(/\r?\n/)) {
		const trimmed = line.trim();
		// The note owns the region heading, the marker and the H1 — a model that
		// echoes any of them would nest a duplicate section.
		if (trimmed === DEEP_DIVE_MARKER) continue;
		if (trimmed.toLowerCase() === DEEP_DIVE_HEADING.toLowerCase()) continue;
		if (/^#\s/.test(trimmed)) continue;
		// A "## " heading inside the region would read as the start of the next
		// section and take the rest of the deep dive with it, so demote it.
		const demoted = /^(\s*)##(\s+)/.test(line) ? line.replace(/^(\s*)##(\s+)/, '$1###$2') : line;
		lines.push(demoted.replace(/\s+$/, ''));
	}
	while (lines.length > 0 && !lines[0].trim()) lines.shift();

	s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
	if (s.length > MAX_DEEP_DIVE_CHARS) {
		s = s.slice(0, MAX_DEEP_DIVE_CHARS).replace(/\n[^\n]*$/, '').trim() + '\n\n_(truncated)_';
	}
	return s;
}

/** True when a note body already carries a generated deep dive. */
export function hasDeepDive(body: string): boolean {
	return extractDeepDive(body).length > 0;
}
