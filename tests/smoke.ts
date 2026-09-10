/**
 * Smoke tests for pure logic (no Obsidian runtime). Run via:
 *   npm test
 * which bundles this suite (and tests/store.test.ts) and runs both with node.
 */
import {
	extractJSON,
	normalizeKey,
	parseSimpleYaml,
	repairMissingBraces,
	sanitizeFileName,
	slugify,
	yamlStr,
	yamlStrArray,
	toInt,
	toBool,
	normalizeComplexity,
	hashString,
} from '../src/parser';
import { PROVIDERS, curatedModelsFor, providerFor } from '../src/types';
import {
	buildDiscoveryPrompt,
	buildExpansionPrompt,
	buildConnectionPrompt,
	buildBatchPrompt,
} from '../src/prompts';

let failures = 0;
function assert(cond: boolean, label: string): void {
	if (cond) {
		console.log(`  ok  ${label}`);
	} else {
		failures++;
		console.error(`FAIL  ${label}`);
	}
}

// --- extractJSON ---------------------------------------------------------
{
	const fenced = '```json\n{"a": 1}\n```';
	assert(extractJSON<{ a: number }>(fenced)?.a === 1, 'extractJSON strips fences');

	const trailing = 'Here is the result: {"a": 1, "b": [2, 3,],} thanks!';
	const r = extractJSON<{ a: number; b: number[] }>(trailing);
	assert(r?.a === 1 && r?.b?.length === 2, 'extractJSON tolerates trailing commas + prose');

	assert(extractJSON('no json here') === null, 'extractJSON returns null on garbage');

	// Real-world failure: model dropped the { } object braces inside arrays
	// (exactly what the user reported for "energy").
	const missingBraces = `{
"concept": "energy",
"domains": [

"name": "Physics",
"description": "Fundamental science of
energy, its forms, and transformations.",
"children": [

"name": "Kinetic Energy",
"description": "Energy possessed
by an object due to its motion.",
"connections": ["Work", "Momentum"],
"complexity": "Beginner"

],

"name": "Chemistry",
"description": "Energy in chemical reactions.",
"children": [

"name": "Chemical Bonds",
"description": "Energy stored in molecular bonds.",
"complexity": "Intermediate"

]

],
"total_nodes": 2
}`;
	const fixed = extractJSON<{
		concept: string;
		domains: { name: string; children: { name: string }[] }[];
		total_nodes: number;
	}>(missingBraces);
	assert(fixed?.concept === 'energy', 'repair: missing braces → concept parsed');
	assert(
		fixed?.domains?.[0]?.name === 'Physics' &&
			fixed?.domains?.[0]?.children?.[0]?.name === 'Kinetic Energy',
		'repair: missing braces → nested domains/children parsed'
	);
	assert(
		fixed?.domains?.[1]?.children?.[0]?.name === 'Chemical Bonds' &&
			fixed?.total_nodes === 2,
		'repair: missing braces → second domain + totals parsed'
	);

	// Truncated JSON (e.g. hit max_tokens mid-object).
	const truncated = '{"concept": "energy", "domains": [{"name": "Physics", "children": [{"name": "Kinetic Energy"';
	const t = extractJSON<{ concept: string; domains: { name: string }[] }>(truncated);
	assert(t?.concept === 'energy' && t?.domains?.[0]?.name === 'Physics', 'repair: truncated JSON closed');

	// Unquoted keys.
	const unquoted = '{concept: "energy", domains: [{name: "Physics"}]}';
	const u = extractJSON<{ concept: string; domains: { name: string }[] }>(unquoted);
	assert(u?.concept === 'energy' && u?.domains?.[0]?.name === 'Physics', 'repair: unquoted keys');

	// Primitive garbage must NOT be treated as a valid object result.
	assert(extractJSON('just some text, no braces') === null, 'repair: plain prose stays null');

	// A brace in trailing prose must not swallow the payload (balanced-brace scan).
	const proseBrace = extractJSON<{ a: number }>('Here you go: {"a": 1} — see {x} for context.');
	assert(proseBrace?.a === 1, 'extractJSON: braces in trailing prose');
	assert(
		extractJSON<{ a: number }>('{"a": 1} and then a stray "}" in prose')?.a === 1,
		'extractJSON: quoted stray brace in prose'
	);

	// A schema skeleton echoed before the real payload must not win.
	const echoed = extractJSON<{ concept: string; domains: unknown[] }>(
		'Format: {"concept": "name", "domains": []}\nHere is mine: {"concept": "energy", "domains": [{"name": "Physics"}]}'
	);
	assert(
		echoed?.concept === 'energy' && echoed?.domains?.length === 1,
		'extractJSON: largest object wins over a schema echo'
	);

	// The prompts demand an object; an array is never a valid result.
	assert(extractJSON('[1, 2, 3]') === null, 'extractJSON: bare array stays null');
}

// --- repairMissingBraces --------------------------------------------------
{
	const valid = '{"a": [1, 2], "b": {"c": 3}, "d": [{"e": 4}, {"f": 5}]}';
	assert(repairMissingBraces(valid) === valid, 'brace repair: no-op on valid JSON');

	const arrOfKeys = '["name": "X", "name": "Y"]';
	assert(
		JSON.parse(repairMissingBraces(arrOfKeys))[0].name === 'X' &&
			JSON.parse(repairMissingBraces(arrOfKeys))[1].name === 'Y',
		'brace repair: duplicate keys split objects'
	);

	const arrOfScalars = '["a": 1, 2]';
	assert(
		JSON.stringify(JSON.parse(repairMissingBraces(arrOfScalars))) === '[{"a":1},2]',
		'brace repair: non-key after comma closes object'
	);
}

// --- parseSimpleYaml -----------------------------------------------------
{
	const fm = [
		'concept: "Direct Democracy"',
		'tree: "Democracy"',
		'parent: "Democracy"',
		'domain: "Political Science"',
		'description: "A \\"quote\\" and a backslash \\\\ here."',
		'complexity: "Beginner"',
		'can_expand: true',
		'estimated_depth: 4',
		'connections: ["Athenian Democracy", "Referendums, the EU", "Citizen Assemblies"]',
		'children: ["Referendums", "Citizen Assemblies"]',
		'path: "/democracy/political_science/direct_democracy"',
		'created: 2025-01-01T00:00:00.000Z',
	].join('\n');
	const parsed = parseSimpleYaml(fm);
	assert(parsed.concept === 'Direct Democracy', 'yaml: quoted string');
	assert(parsed.tree === 'Democracy', 'yaml: tree');
	assert(parsed.parent === 'Democracy', 'yaml: parent');
	assert(parsed.can_expand === true, 'yaml: boolean');
	assert(parsed.estimated_depth === 4, 'yaml: number');
	assert(
		Array.isArray(parsed.connections) &&
			(parsed.connections as string[])[1] === 'Referendums, the EU',
		'yaml: flow array with quoted comma item'
	);
	assert(
		(parsed.description as string).includes('"quote"') && (parsed.description as string).includes('\\ here.'),
		'yaml: escaped quotes/backslash'
	);
	assert(parsed.created === '2025-01-01T00:00:00.000Z', 'yaml: plain ISO timestamp stays a string');

	const block = ['children:', '  - "A"', '  - B', '  - "C D"'].join('\n');
	const pb = parseSimpleYaml(block);
	assert(
		Array.isArray(pb.children) && (pb.children as string[]).join(',') === 'A,B,C D',
		'yaml: block list'
	);

	// round-trip: yamlStrArray -> parseSimpleYaml
	const rt = parseSimpleYaml(`connections: ${yamlStrArray(['a "b"', 'c,d'])}`);
	assert(
		(rt.connections as string[])[0] === 'a "b"' && (rt.connections as string[])[1] === 'c,d',
		'yaml: yamlStrArray round-trip'
	);
}

// --- helpers -------------------------------------------------------------
{
	assert(slugify('Direct Democracy') === 'direct_democracy', 'slugify');
	assert(slugify('任意 概念') === '任意_概念', 'slugify keeps non-Latin letters');
	assert(sanitizeFileName('A:B/C?D*') === 'A B C D', 'sanitizeFileName');
	assert(sanitizeFileName('...') === 'concept', 'sanitizeFileName empty fallback');
	assert(normalizeKey('  Democracy ') === 'democracy', 'normalizeKey');
	assert(hashString('x') === hashString('x') && hashString('x') !== hashString('y'), 'hashString stable');
	assert(toInt('2025-01-01T00:00:00.000Z', 0) > 1_700_000_000_000, 'toInt parses ISO timestamps');
	assert(toInt('3', 0) === 3, 'toInt parses numbers');
	assert(toInt('0', 5) === 0, 'toInt keeps an explicit zero');
	assert(toInt('garbage', 5) === 5, 'toInt falls back on garbage');
	assert(toBool('true', false) === true && toBool(0, true) === false, 'toBool');
	assert(normalizeComplexity('Advanced') === 'Advanced', 'normalizeComplexity');
	assert(normalizeComplexity('garbage') === 'Intermediate', 'normalizeComplexity fallback');
}

// --- prompts -------------------------------------------------------------
{
	const d = buildDiscoveryPrompt('democracy');
	assert(d.system.includes('polymathic taxonomist'), 'discovery: system role');
	assert(d.user.includes('"democracy"') && d.user.includes('domains'), 'discovery: user payload');

	const e = buildExpansionPrompt({
		child: 'Referendums',
		parent: 'Democracy',
		domain: 'Political Science',
		existingSiblings: ['Athenian Democracy'],
		maxChildren: 7,
	});
	assert(e.system.includes('deep taxonomic expansion'), 'expansion: system role');
	assert(
		e.user.includes('Referendums') && e.user.includes('Athenian Democracy') && e.user.includes('7'),
		'expansion: child/parent/siblings/max'
	);

	const c = buildConnectionPrompt({ concept: 'Referendums', candidates: ['Elections', 'Switzerland'] });
	assert(c.user.includes('Elections') && c.user.includes('relationship_type'), 'connection: candidates');

	const b = buildBatchPrompt({ root: 'democracy', depth: 3, maxNodes: 100 });
	assert(b.user.includes('depth of 3 levels') && b.user.includes('100 nodes'), 'batch: depth/budget');
}

// --- providers -----------------------------------------------------------
{
	assert(providerFor('https://api.deepseek.com')?.id === 'deepseek', 'provider: deepseek');
	assert(providerFor('https://api.deepseek.com/')?.id === 'deepseek', 'provider: trailing slash');
	assert(providerFor('https://api.deepseek.com/chat/completions')?.id === 'deepseek', 'provider: /chat/completions suffix');
	assert(providerFor('https://api.openai.com/v1')?.id === 'openai', 'provider: openai');
	assert(providerFor('http://localhost:11434/v1')?.id === 'ollama', 'provider: ollama');
	assert(providerFor('http://localhost:1234/v1')?.id === 'lmstudio', 'provider: lm studio');
	assert(providerFor('https://example.com/custom') === null, 'provider: custom endpoint is null');

	const deepseekModels = curatedModelsFor('https://api.deepseek.com');
	assert(
		deepseekModels.includes('deepseek-v4-flash') &&
			!deepseekModels.includes('deepseek-chat') &&
			!deepseekModels.includes('deepseek-reasoner'),
		'provider: deepseek models cleaned (no deepseek-chat / deepseek-reasoner)'
	);
	assert(curatedModelsFor('https://api.openai.com/v1').includes('gpt-4o-mini'), 'provider: openai models');
	assert(
		PROVIDERS.every((p) => p.models.length > 0 && p.endpoint.startsWith('http')),
		'provider: all presets have endpoints + models'
	);
}

// --- ask / follow-up -------------------------------------------------------
import {
	buildBranchDigest,
	parseSuggestedChildren,
} from '../src/ask';
import type { TreeModel, TreeNode } from '../src/types';
import { buildFollowUpSystem } from '../src/prompts';

{
	const node = (
		name: string,
		parent: string | null,
		description: string,
		children: string[] = [],
		options: Partial<TreeNode> = {}
	): TreeNode => ({
		name,
		parent,
		description,
		complexity: 'Beginner',
		canExpand: true,
		estimatedDepth: 4,
		connections: [],
		children,
		path: `/${name.toLowerCase().replace(/\s+/g, '_')}`,
		created: 0,
		file: `CogniTree/Democracy/${name}.md`,
		treeRoot: 'Democracy',
		expanded: false,
		loading: false,
		...options,
	});
	const model: TreeModel = {
		root: 'Democracy',
		folder: 'CogniTree/Democracy',
		updatedAt: 1,
		nodes: new Map([
			['Democracy', node('Democracy', null, 'System of government.')],
			[
				'Direct Democracy',
				node('Direct Democracy', 'Democracy', 'Citizens vote directly on laws.', [
					'Referendums',
					'Citizen Assemblies',
				]),
			],
			['Referendums', node('Referendums', 'Direct Democracy', 'Direct votes on specific laws.')],
			[
				'Citizen Assemblies',
				node('Citizen Assemblies', 'Direct Democracy', 'Sortition-based deliberative bodies.'),
			],
		]),
	};

	const d = buildBranchDigest(model, 'Direct Democracy', 20, 20000);
	assert(d.text.includes('Focus: "Direct Democracy"'), 'digest: focus named');
	assert(d.text.includes('Democracy ▸ Direct Democracy'), 'digest: ancestry chain');
	assert(d.text.includes('Referendums'), 'digest: descendant included');
	assert(d.text.includes('Citizens vote directly on laws.'), 'digest: focus description included');
	assert(d.nodeCount >= 3 && d.omitted === 0, 'digest: counts without caps');

	const capped = buildBranchDigest(model, 'Direct Democracy', 1, 20000);
	assert(capped.nodeCount === 2 && capped.omitted >= 1, 'digest: node cap respected');
	const charCapped = buildBranchDigest(model, 'Direct Democracy', 20, 60);
	assert(charCapped.text.includes('omitted'), 'digest: char cap → truncation note');

	// The header lines count against the budget too, and one huge description is
	// clipped instead of dominating the digest.
	const fat = node('Fat', null, 'x'.repeat(5000));
	const fatModel: TreeModel = {
		root: 'Fat',
		folder: 'f',
		updatedAt: 0,
		nodes: new Map([['Fat', fat]]),
	};
	const fatDigest = buildBranchDigest(fatModel, 'Fat', 60, 20000);
	assert(
		fatDigest.text.length < 1000 && fatDigest.text.includes('…'),
		'digest: huge description is clipped'
	);

	const leaf = buildBranchDigest(model, 'Referendums', 20, 20000);
	assert(
		leaf.text.includes('nearby siblings') && leaf.text.includes('Citizen Assemblies'),
		'digest: leaf gets sibling anchors'
	);

	// suggested-children parser
	const withSection = [
		'Here is my plan.',
		'',
		'### Suggested children',
		'- Swiss Referendums: Binding votes in Switzerland',
		'- **Citizen Initiated Referendums** — proposed by citizens',
		'- Mandatory Referendums – required by law',
		'',
		'## Next steps',
		'- not a child',
	].join('\n');
	const kids = parseSuggestedChildren(withSection);
	assert(kids.length === 3, 'suggested children: parsed 3 items');
	assert(kids[0]?.name === 'Swiss Referendums', 'suggested children: colon separator');
	assert(
		kids[1]?.name === 'Citizen Initiated Referendums' && kids[1]?.description === 'proposed by citizens',
		'suggested children: bold + em-dash separator'
	);
	assert(
		kids[2]?.name === 'Mandatory Referendums' && kids[2]?.description === 'required by law',
		'suggested children: en-dash separator'
	);
	assert(
		parseSuggestedChildren('no section at all\n- Something: nope').length === 0,
		'suggested children: [] without heading'
	);
	const boldHead = parseSuggestedChildren('**Suggested children:**\n- A Child: ok');
	assert(boldHead.length === 1 && boldHead[0]?.name === 'A Child', 'suggested children: bold heading');
	const blankAfter = parseSuggestedChildren('### Suggested children\n\n- A Child: ok\n- B Child: also');
	assert(
		blankAfter.length === 2 && blankAfter[0]?.name === 'A Child',
		'suggested children: blank line after the heading'
	);
	const dupe = parseSuggestedChildren('### Suggested children\n- Swiss Referendums: one\n- Swiss Referendums: two');
	assert(dupe.length === 1, 'suggested children: duplicates deduped');

	// follow-up system prompt
	const sys = buildFollowUpSystem(d.text, 'Direct Democracy');
	assert(
		sys.includes('Direct Democracy') && sys.includes('Referendums') && sys.includes('### Suggested children'),
		'follow-up system: focus + digest + adopt contract'
	);
}

// --- notebody (managed regions) ------------------------------------------
import {
	DEEP_DIVE_HEADING,
	DEEP_DIVE_MARKER,
	extractDeepDive,
	extractRegion,
	sanitizeDeepDive,
	stripFrontmatter,
} from '../src/notebody';

{
	const body = [
		'# Direct Democracy',
		'',
		'Citizens vote directly.',
		'',
		DEEP_DIVE_HEADING,
		DEEP_DIVE_MARKER,
		'### How it works',
		'',
		'- Initiative',
		'- Referendum',
		'',
		'## Connections',
		'- [[Referendums]]',
	].join('\n');
	const dd = extractDeepDive(body);
	assert(dd.includes('### How it works') && dd.includes('- Referendum'), 'notebody: deep dive extracted');
	assert(!dd.includes('## Connections'), 'notebody: region ends at the next H2');
	assert(extractDeepDive('# X\n\nno region here') === '', 'notebody: no marker → empty');
	assert(
		extractDeepDive(body.replace('- Referendum', '- Referendum (hand edit)')).includes('hand edit'),
		'notebody: hand edits inside the region survive extraction'
	);
	assert(extractRegion(body, '<!-- nope -->') === '', 'notebody: unknown marker → empty');
	assert(
		extractDeepDive(
			['# X', '', DEEP_DIVE_HEADING, DEEP_DIVE_MARKER, '### A', '## Hand-written', 'text', '## Connections', '- [[Y]]'].join(
				'\n'
			)
		).includes('Hand-written'),
		'notebody: only the plugin’s own sections end the region'
	);

	const cleaned = sanitizeDeepDive(
		'---\nconcept: "X"\n---\n## Deep dive\n<!-- cognitree:deep-dive -->\n### A\n\ntext'
	);
	assert(!cleaned.includes('---'), 'sanitize: frontmatter stripped');
	assert(!cleaned.includes('## Deep dive') && !cleaned.includes('cognitree:deep-dive'), 'sanitize: heading + marker stripped');
	assert(cleaned.startsWith('### A'), 'sanitize: keeps the first real line');
	assert(
		sanitizeDeepDive('# Title\n\n## Sub\n\ntext').startsWith('### Sub'),
		'sanitize: drops a top-level H1 and demotes a stray H2'
	);
	assert(
		sanitizeDeepDive('## Examples\n\n- One') === '### Examples\n\n- One',
		'sanitize: an H2 is demoted so it cannot end the region'
	);
	assert(
		sanitizeDeepDive('### Already fine\n\n- One').startsWith('### Already fine'),
		'sanitize: H3+ headings are left alone'
	);
	assert(sanitizeDeepDive('# Title\n\n## Deep dive\n\ntext').startsWith('text'), 'sanitize: drops an echoed region heading');
	assert(sanitizeDeepDive('') === '' && sanitizeDeepDive('   \n\n ') === '', 'sanitize: empty stays empty');
	assert(sanitizeDeepDive('a\n\n\n\n\nb') === 'a\n\nb', 'sanitize: collapses blank runs');
	const capped = sanitizeDeepDive('x'.repeat(20000));
	assert(capped.length < 12200 && capped.endsWith('_(truncated)_'), 'sanitize: length is capped');
	assert(stripFrontmatter('---\na: 1\n---\nbody') === 'body', 'stripFrontmatter');
	assert(stripFrontmatter('no frontmatter') === 'no frontmatter', 'stripFrontmatter: no-op without a block');
}

// --- semantic index (pure helpers) ---------------------------------------
import {
	MAX_EMBEDDING_RECORDS,
	cosine,
	emptyStore,
	pendingFiles,
	pruneStore,
	rankBySimilarity,
	vectorText,
} from '../src/embeddings';

{
	assert(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9, 'cosine: identical vectors → 1');
	assert(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-9, 'cosine: scale invariant');
	assert(cosine([1, 0], [0, 1]) === 0, 'cosine: orthogonal → 0');
	assert(cosine([1, 2], [1, 2, 3]) === 0, 'cosine: mismatched length → 0');
	assert(cosine([], [1]) === 0, 'cosine: empty vector → 0');
	assert(cosine([0, 0], [1, 1]) === 0, 'cosine: degenerate vector → 0');

	const ranked = rankBySimilarity([1, 0], {
		'a.md': { vector: [1, 0] },
		'b.md': { vector: [0.9, 0.1] },
		'c.md': { vector: [0, 1] },
	}, 2);
	assert(
		ranked.length === 2 && ranked[0].key === 'a.md' && ranked[1].key === 'b.md',
		'rankBySimilarity: best-first, limited'
	);
	assert(rankBySimilarity([1, 0], {}, 5).length === 0, 'rankBySimilarity: empty store → no hits');

	const text = vectorText(
		'Referendums',
		['#politics', '#voting'],
		'---\ntags: x\n---\n# Referendums\n\nA **direct** vote on a law.'
	);
	assert(text.startsWith('Referendums — #politics #voting —'), 'vectorText: name + tags come first');
	assert(!text.includes('---') && !text.includes('**'), 'vectorText: frontmatter and markup stripped');

	const files = [
		{ path: 'a.md', stat: { mtime: 10 } },
		{ path: 'b.md', stat: { mtime: 20 } },
	];
	const store = emptyStore();
	store.model = 'm1';
	store.records['a.md'] = { mtime: 10, name: 'a', vector: [1] };
	assert(
		pendingFiles(files, store, 'm1').map((f) => f.path).join(',') === 'b.md',
		'pendingFiles: unchanged notes are skipped'
	);
	assert(pendingFiles(files, store, 'm2').length === 2, 'pendingFiles: a new model re-embeds everything');
	store.records['b.md'] = { mtime: 5, name: 'b', vector: [1] };
	assert(
		pendingFiles(files, store, 'm1').map((f) => f.path).join(',') === 'b.md',
		'pendingFiles: an edited note is re-embedded'
	);

	assert(pruneStore(store, new Set(['b.md'])) === 1, 'pruneStore: drops notes that no longer exist');
	assert(!store.records['a.md'] && !!store.records['b.md'], 'pruneStore: keeps the live notes');

	const big = emptyStore();
	for (let i = 0; i < MAX_EMBEDDING_RECORDS + 5; i++) {
		big.records[`f${i}.md`] = { mtime: i, name: `f${i}`, vector: [1] };
	}
	assert(
		pruneStore(big, new Set(Object.keys(big.records))) === 5,
		'pruneStore: cap drops the oldest records'
	);
	assert(
		Object.keys(big.records).length === MAX_EMBEDDING_RECORDS,
		'pruneStore: respects the record cap'
	);
}

// --- review / spaced repetition (pure) -----------------------------------
import {
	DAY_MS,
	GRADES,
	RELEARN_MS,
	addCards,
	cardIdFor,
	describeDue,
	dueCardIds,
	gradeCard,
	newReviewData,
	removeCard,
	reviewStats,
	type ReviewState,
} from '../src/review';

{
	const now = 1_700_000_000_000;
	const data = newReviewData('Democracy');
	const drafts = [
		{ question: 'What is a referendum?', answer: 'A direct vote.', kind: 'recall' },
		{ question: 'Cloze: a ___ is a direct vote', answer: 'referendum' },
		{ question: '   ', answer: 'dropped' },
	];
	const first = addCards(data, 'Referendums', drafts, now);
	assert(first.added === 2 && first.skipped === 0, 'addCards: adds valid cards, drops empty ones');
	const second = addCards(data, 'Referendums', drafts, now + 1000);
	assert(second.added === 0 && second.skipped === 2, 'addCards: re-adding without refresh is a no-op');
	assert(
		cardIdFor('Democracy', 'Referendums', 'What is a referendum?') ===
			cardIdFor('Democracy', 'Referendums', '  what is a REFERENDUM? '),
		'cardIdFor: stable across whitespace/case'
	);
	assert(
		cardIdFor('T1', 'N', 'Q') !== cardIdFor('T2', 'N', 'Q'),
		'cardIdFor: distinct per tree'
	);

	const stats = reviewStats(data, now);
	assert(stats.total === 2 && stats.fresh === 2 && stats.due === 2, 'reviewStats: new cards are due');

	const id = Object.keys(data.cards)[0];
	let state = gradeCard(undefined, 'good', id, now);
	assert(
		state.reps === 1 && state.intervalDays === 1 && state.due === now + DAY_MS,
		'gradeCard: first good → 1 day'
	);
	state = gradeCard(state, 'good', id, state.due);
	assert(state.intervalDays === 6, 'gradeCard: second good → 6 days');
	const easeBefore = state.ease;
	state = gradeCard(state, 'good', id, state.due);
	assert(state.intervalDays === Math.round(6 * easeBefore), 'gradeCard: third good → interval × ease');

	const failed = gradeCard(state, 'again', id, state.due);
	assert(
		failed.reps === 0 && failed.intervalDays === 0 && failed.lapses === 1,
		'gradeCard: again resets the card'
	);
	assert(failed.due === state.due + RELEARN_MS, 'gradeCard: again returns in the same session');
	assert(failed.ease < state.ease, 'gradeCard: again lowers ease');

	const base: ReviewState = { cardId: id, due: now, intervalDays: 10, ease: 2.5, reps: 3, lapses: 0 };
	const hard = gradeCard(base, 'hard', id, now);
	const good = gradeCard(base, 'good', id, now);
	const easy = gradeCard(base, 'easy', id, now);
	assert(
		hard.intervalDays < good.intervalDays && good.intervalDays < easy.intervalDays,
		`gradeCard: hard < good < easy (${hard.intervalDays} < ${good.intervalDays} < ${easy.intervalDays})`
	);
	assert(easy.ease > base.ease && hard.ease < base.ease, 'gradeCard: ease moves with the grade');

	const maxed = gradeCard({ ...base, intervalDays: 300, reps: 9, ease: 2.8 }, 'easy', id, 0);
	assert(maxed.intervalDays <= 365, 'gradeCard: interval is capped at a year');
	const floored = gradeCard({ ...base, ease: 1.3, reps: 2 }, 'again', id, 0);
	assert(floored.ease >= 1.3, 'gradeCard: ease is floored');

	// Due ordering, scope and limits.
	const data2 = newReviewData('T');
	addCards(data2, 'A', [{ question: 'qa', answer: 'a' }, { question: 'qb', answer: 'b' }], now);
	const ids = Object.keys(data2.cards);
	data2.states[ids[0]] = { cardId: ids[0], due: now - 10 * DAY_MS, intervalDays: 5, ease: 2.5, reps: 2, lapses: 0 };
	data2.states[ids[1]] = { cardId: ids[1], due: now + 5 * DAY_MS, intervalDays: 5, ease: 2.5, reps: 2, lapses: 0 };
	const due = dueCardIds(data2, now, 10);
	assert(due.length === 1 && due[0] === ids[0], 'dueCardIds: only overdue cards are due');
	assert(dueCardIds(data2, now, 10, new Set(['Other'])).length === 0, 'dueCardIds: scope filters by node');
	assert(dueCardIds(data2, now, 10, new Set(['A'])).length === 1, 'dueCardIds: scope keeps its own node');
	assert(dueCardIds(data2, now + 10 * DAY_MS, 10).length === 2, 'dueCardIds: future cards come due');
	assert(dueCardIds(data2, now, 0).length === 0, 'dueCardIds: limit is honoured');
	assert(reviewStats(data2, now, new Set(['Other'])).total === 0, 'reviewStats: scope-aware');

	assert(removeCard(data2, ids[0]) && !data2.cards[ids[0]] && !data2.states[ids[0]], 'removeCard: drops card + schedule');
	assert(!removeCard(data2, 'nope'), 'removeCard: unknown id → false');

	assert(GRADES.length === 4 && GRADES[0] === 'again', 'GRADES order');
	assert(describeDue(now + 3 * DAY_MS, now) === 'in 3 days', 'describeDue: days');
	assert(describeDue(now - 1, now) === 'now', 'describeDue: overdue');
	assert(describeDue(now + 60_000, now).includes('min'), 'describeDue: minutes');
	assert(describeDue(now + 60 * DAY_MS, now).includes('month'), 'describeDue: months');
}

// --- vault graph (pure) ---------------------------------------------------
import {
	buildGraph,
	neighborhood,
	noteTags,
	notesWithTag,
	sourceMap,
	toCandidates,
	topTags,
} from '../src/vaultGraph';

{
	const graph = buildGraph([
		{ name: 'Alpha', path: 'Alpha.md', tags: ['#research'], links: ['Beta.md', 'Gamma.md'] },
		{ name: 'Beta', path: 'Beta.md', tags: ['#research', '#methods'], links: ['Gamma.md'] },
		{ name: 'Gamma', path: 'Gamma.md', tags: ['#methods'], links: [] },
		{ name: 'Delta', path: 'Delta.md', tags: [], links: ['Gamma.md', 'missing.md'] },
	]);
	assert(graph[2].backlinks === 3, 'buildGraph: counts backlinks');
	assert(graph[1].backlinks === 1, 'buildGraph: counts a single backlink');
	assert(graph[3].backlinks === 0, 'buildGraph: unresolved links are not backlinks');
	assert(graph[0].backlinks === 0, 'buildGraph: no links → no backlinks');

	const near = neighborhood(graph, 'Alpha.md', 1, 10);
	assert(
		near.length === 2 && near[0].name === 'Gamma',
		'neighborhood: one hop, most-linked first'
	);
	assert(
		neighborhood(graph, 'Alpha.md', 2, 10).length === 3,
		'neighborhood: two hops reach the wider graph'
	);
	assert(neighborhood(graph, 'Alpha.md', 2, 1).length === 1, 'neighborhood: limit honoured');
	assert(
		neighborhood(graph, 'Alpha.md', 2, 10).every((n) => n.path !== 'Alpha.md'),
		'neighborhood: the seed is excluded'
	);
	assert(neighborhood(graph, 'Nope.md', 1, 10).length === 0, 'neighborhood: unknown seed → empty');

	assert(
		notesWithTag(graph, 'research', 10).map((n) => n.name).sort().join(',') === 'Alpha,Beta',
		'notesWithTag: exact tag'
	);
	assert(notesWithTag(graph, '#research', 10).length === 2, 'notesWithTag: leading # tolerated');
	assert(notesWithTag(graph, 'methods', 10).length === 2, 'notesWithTag: matches every carrier');
	assert(notesWithTag(graph, '', 10).length === 0, 'notesWithTag: empty tag → none');

	const tags = topTags(graph, 5);
	assert(
		tags.length === 2 && tags.every((t) => t.count === 2),
		'topTags: frequency counts'
	);
	assert(
		tags.map((t) => t.tag).sort().join(',') === '#methods,#research',
		'topTags: vault tags, normalised'
	);
	assert(topTags(graph, 1).length === 1, 'topTags: limit honoured');

	const sources = sourceMap(graph);
	assert(
		sources.get('alpha') === 'Alpha.md' && sources.get('gamma') === 'Gamma.md',
		'sourceMap: normalized name → path'
	);
	const candidates = toCandidates(graph);
	assert(
		candidates.length === 4 && candidates[3].name === 'Delta' && candidates[3].backlinks === 0,
		'toCandidates: name + tags + backlinks'
	);
}

// --- note tags (metadataCache normalisation) ------------------------------
{
	// Minimal CacheMetadata stand-ins: only what noteTags reads.
	const cache = (frontmatter: unknown, tags?: { tag: string }[]) =>
		({ frontmatter, tags: tags ?? [] }) as never;

	assert(noteTags(null).length === 0 && noteTags(undefined).length === 0, 'noteTags: no cache → no tags');
	assert(
		JSON.stringify(noteTags(cache({ tags: 'research' }))) === JSON.stringify(['#research']),
		'noteTags: a bare string stays one tag (not one per character)'
	);
	assert(
		JSON.stringify(
			noteTags(cache({ tags: ['#a', 'b'] }, [{ tag: '#c' }, { tag: 'c' }]))
		) === JSON.stringify(['#a', '#b', '#c']),
		'noteTags: lists, inline tags, missing # and duplicates are normalised'
	);
	assert(
		JSON.stringify(noteTags(cache({ tags: 7 }))) === JSON.stringify(['#7']),
		'noteTags: a numeric tag becomes a string'
	);
	assert(noteTags(cache({}, [])).length === 0, 'noteTags: no tags → empty list');
}

// --- radial sunburst export ----------------------------------------------
import { analyseTree, buildRadialSvg } from '../src/exporters';

{
	/** Sanity-check a generated SVG: finite geometry, every node drawn, nothing clipped. */
	const assertSvgSane = (label: string, svg: string, expectedNodes: number): void => {
		assert(svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'), `${label}: is an svg document`);
		const bad = svg.match(/NaN|undefined|Infinity/);
		assert(!bad, `${label}: finite geometry${bad ? ` (found ${bad[0]})` : ''}`);
		const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
		assert(!!viewBox, `${label}: has a viewBox`);
		const width = Number(viewBox?.[1] ?? 0);
		const height = Number(viewBox?.[2] ?? 0);
		assert(
			width > 0 && height > 0 && width === Number(svg.match(/width="(\d+)"/)?.[1]),
			`${label}: viewBox matches the declared size`
		);
		const drawn = new Set([...svg.matchAll(/data-node="([^"]*)"/g)].map((m) => m[1]));
		assert(drawn.size === expectedNodes, `${label}: drew every node (${drawn.size}/${expectedNodes})`);

		const num = (tag: string, attr: string): number | null => {
			const raw = tag.match(new RegExp(`\\b${attr}="([^"]+)"`))?.[1];
			if (raw === undefined || raw.endsWith('%')) return null;
			const value = Number(raw);
			return Number.isFinite(value) ? value : null;
		};
		let outside = 0;
		for (const match of svg.matchAll(/<rect\b[^>]*>/g)) {
			const x = num(match[0], 'x');
			const y = num(match[0], 'y');
			const w = num(match[0], 'width');
			const h = num(match[0], 'height');
			if (x === null || y === null || w === null || h === null) continue;
			if (x < -0.5 || y < -0.5 || x + w > width + 0.5 || y + h > height + 0.5) outside++;
		}
		for (const match of svg.matchAll(/<circle\b[^>]*>/g)) {
			const cx = num(match[0], 'cx');
			const cy = num(match[0], 'cy');
			const r = num(match[0], 'r');
			if (cx === null || cy === null || r === null) continue;
			if (cx - r < -0.5 || cy - r < -0.5 || cx + r > width + 0.5 || cy + r > height + 0.5) outside++;
		}
		assert(outside === 0, `${label}: nothing drawn outside the viewBox (${outside} outside)`);
	};

	const node = (name: string, parent: string | null, children: string[] = []): TreeNode => ({
		name,
		parent,
		description: 'd',
		complexity: 'Beginner',
		canExpand: true,
		estimatedDepth: 3,
		connections: [],
		children,
		path: `/${name.toLowerCase()}`,
		created: 0,
		file: `f/${name}.md`,
		treeRoot: 'Root',
		expanded: false,
		loading: false,
	});

	// Uneven branches: A holds 3 leaves, B holds 1 — spans must follow the weight.
	const model: TreeModel = {
		root: 'Root',
		folder: 'f',
		updatedAt: 0,
		nodes: new Map([
			['Root', node('Root', null, ['A', 'B'])],
			['A', node('A', 'Root', ['A1', 'A2', 'A3'])],
			['A1', node('A1', 'A')],
			['A2', node('A2', 'A')],
			['A3', node('A3', 'A')],
			['B', node('B', 'Root', ['B1'])],
			['B1', node('B1', 'B')],
		]),
	};

	const analysis = analyseTree(model);
	assert(analysis.maxDepth === 2, `analyseTree: max depth (got ${analysis.maxDepth})`);
	assert(analysis.weight.get('Root') === 4, 'analyseTree: root weight counts leaves');
	assert(analysis.weight.get('A') === 3 && analysis.weight.get('B') === 1, 'analyseTree: branch weights');
	assert(analysis.weight.get('A1') === 1, 'analyseTree: a leaf weighs 1');
	assert(analysis.branch.get('A2') === 1 && analysis.branch.get('B1') === 2, 'analyseTree: branch index per node');
	assert(analysis.order.join(',') === 'Root,A,B,A1,A2,A3,B1', `analyseTree: breadth-first order (${analysis.order.join(',')})`);

	const svg = buildRadialSvg(model);
	assertSvgSane('sunburst', svg, model.nodes.size);
	assert(svg.includes('7 concepts'), 'sunburst: reports the node count');
	assert((svg.match(/<path /g) ?? []).length === 6, 'sunburst: one arc per non-root node');

	// A bigger branch must occupy a wider arc than a smaller sibling: recover the
	// start/end angles of each depth-1 arc from its path and compare spans.
	const size = Number(svg.match(/width="(\d+)"/)![1]);
	const centerX = size / 2;
	const centerY = size / 2 + 10;
	const spanOf = (name: string): number => {
		const match = svg.match(
			new RegExp(
				`<path data-node="${name}" d="M ([\\d.]+) ([\\d.-]+) A [\\d.]+ [\\d.]+ 0 [01] 1 ([\\d.]+) ([\\d.-]+)`
			)
		);
		if (!match) return Number.NaN;
		const start = Math.atan2(Number(match[2]) - centerY, Number(match[1]) - centerX);
		const end = Math.atan2(Number(match[4]) - centerY, Number(match[3]) - centerX);
		let sweep = end - start;
		while (sweep < 0) sweep += Math.PI * 2;
		return sweep;
	};
	const spanA = spanOf('A');
	const spanB = spanOf('B');
	assert(
		Math.abs(spanA - Math.PI * 1.5) < 0.1,
		`sunburst: a 3-leaf branch spans 3/4 of the circle (got ${spanA.toFixed(2)} rad)`
	);
	assert(
		Math.abs(spanB - Math.PI * 0.5) < 0.1,
		`sunburst: a 1-leaf branch spans 1/4 (got ${spanB.toFixed(2)} rad)`
	);
	assert(spanA > spanB * 2, 'sunburst: the bigger branch gets the wider arc');

	// Edge cases: a lone root, a deep chain, and a frontmatter cycle.
	const solo: TreeModel = { root: 'Solo', folder: 'f', updatedAt: 0, nodes: new Map([['Solo', node('Solo', null)]]) };
	assertSvgSane('sunburst (single node)', buildRadialSvg(solo), 1);

	const chain = new Map<string, TreeNode>();
	for (let i = 0; i < 9; i++) {
		const name = `L${i}`;
		chain.set(name, node(name, i === 0 ? null : `L${i - 1}`, i < 8 ? [`L${i + 1}`] : []));
	}
	const deep: TreeModel = { root: 'L0', folder: 'f', updatedAt: 0, nodes: chain };
	assertSvgSane('sunburst (deep chain)', buildRadialSvg(deep), 9);
	assert(analyseTree(deep).maxDepth === 8, 'analyseTree: handles a nine-level chain');

	const cyclic: TreeModel = {
		root: 'Root',
		folder: 'f',
		updatedAt: 0,
		nodes: new Map([
			['Root', node('Root', null, ['A', 'B'])],
			['A', node('A', 'Root', ['B'])],
			['B', node('B', 'A', ['A'])],
		]),
	};
	assert(analyseTree(cyclic).weight.get('Root')! >= 1, 'analyseTree: terminates on a cycle');
	assertSvgSane('sunburst (cycle)', buildRadialSvg(cyclic), 3);

	// Long names are ellipsised rather than allowed to run across the canvas.
	const longName = 'A very long concept name that will not fit inside a ring sector';
	const longModel: TreeModel = {
		root: 'Root',
		folder: 'f',
		updatedAt: 0,
		nodes: new Map([
			['Root', node('Root', null, [longName])],
			[longName, node(longName, 'Root')],
		]),
	};
	const longSvg = buildRadialSvg(longModel);
	assertSvgSane('sunburst (long name)', longSvg, 2);
	assert(
		!longSvg.includes(`>${longName}<`),
		'sunburst: long labels are not emitted as text in full'
	);
	assert(longSvg.includes('…'), 'sunburst: truncated labels are marked with an ellipsis');
	assert(
		longSvg.includes(`data-node="${longName}"`),
		'sunburst: the full name is still kept in the data-node attribute'
	);
}

// --- report --------------------------------------------------------------
console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
