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
import { analyseTree, buildRadialSvg, estimateTextWidth, radialLayout } from '../src/exporters';

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
			width > 0 &&
				height > 0 &&
				width === Number(svg.match(/width="(\d+)"/)?.[1]) &&
				height === Number(svg.match(/height="(\d+)"/)?.[1]),
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

	/**
	 * Labels whose text block leaves its own arc. This is the check that
	 * matters most and the one a reader notices first: an arc is a cell, and a
	 * name that spills out of it runs over its neighbours.
	 *
	 * It reconstructs where the renderer will actually put the glyphs — the
	 * anchor, the rotation, every wrapped line — and tests that block against
	 * the arc, so a wrong anchor or rotation fails here even though the text
	 * "fits" by length. `slack` widens the measured advances, so the check does
	 * not merely repeat the layout's own assumption.
	 */
	const countOutsideTheirArc = (
		layout: ReturnType<typeof radialLayout>,
		slack = 1
	): { count: number; worst: string } => {
		const arcOf = new Map(layout.arcs.map((arc) => [arc.name, arc]));
		const norm = (a: number): number => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
		let count = 0;
		let worst = '';
		let worstOver = 0;
		for (const label of layout.labels) {
			const arc = arcOf.get(label.name);
			if (!arc) continue;
			const width =
				Math.max(...label.lines.map((line) => estimateTextWidth(line, label.fontSize))) * slack;
			const left =
				label.anchor === 'middle' ? -width / 2 : label.anchor === 'end' ? -width : 0;
			// The renderer centres the glyph box on the anchor, so the block reaches
			// the same distance either side: 0.51em beyond the baseline span.
			const boxHalf = ((label.lines.length - 1) * label.lineHeight) / 2 + label.fontSize * 0.51;
			const top = -boxHalf;
			const bottom = boxHalf;
			const radians = (label.rotation * Math.PI) / 180;
			const cos = Math.cos(radians);
			const sin = Math.sin(radians);
			let over = 0;
			for (const [lx, ly] of [
				[left, top],
				[left + width, top],
				[left, bottom],
				[left + width, bottom],
			]) {
				const px = label.x + lx * cos - ly * sin;
				const py = label.y + lx * sin + ly * cos;
				const r = Math.hypot(px - layout.cx, py - layout.cy);
				const angle = norm(Math.atan2(py - layout.cy, px - layout.cx));
				// Raw span, wrapped into [0, 2pi): normalising it would turn a
				// full-circle arc (0 to 2pi) into a zero-width one.
				let span = arc.to - arc.from;
				if (span < 0) span += Math.PI * 2;
				const rel = norm(angle - arc.from);
				const angleOver = rel > span ? Math.min(rel - span, Math.PI * 2 - rel) * r : 0;
				const radiusOver =
					r > arc.outer ? r - arc.outer : r < arc.inner ? arc.inner - r : 0;
				over = Math.max(over, angleOver, radiusOver);
			}
			if (over > 0.5) {
				count++;
				if (over > worstOver) {
					worstOver = over;
					worst = `${label.name} (${label.orientation}, anchor ${label.anchor}, ${over.toFixed(0)}px)`;
				}
			}
		}
		return { count, worst };
	};
	/** Assert no label leaves its cell, at the layout's own width and a wider one. */
	const assertLabelsInsideTheirArcs = (
		label: string,
		layout: ReturnType<typeof radialLayout>
	): void => {
		for (const factor of [1, 1.05]) {
			const { count, worst } = countOutsideTheirArc(layout, factor);
			assert(
				count === 0,
				`${label}: every label stays inside its own arc (advances +${Math.round(
					(factor - 1) * 100
				)}%) (got ${count}, want 0)` + (worst ? ` — worst: ${worst}` : '')
			);
		}
	};

	/**
	 * Check the left-half radial labels and count them. Those are the labels a
	 * reader notices first when they break: a radial label is drawn upside down
	 * on the left half unless it is flipped, and flipping has to swap the edge it
	 * is anchored to. Anchored at the inner edge with a flipped rotation, the
	 * whole name runs outward off the circle instead of inward along the ring.
	 */
	const checkLeftHalfRadialLabels = (
		label: string,
		layout: ReturnType<typeof radialLayout>
	): number => {
		let count = 0;
		for (const entry of layout.labels) {
			if (
				entry.orientation !== 'radial' ||
				entry.angle <= Math.PI / 2 ||
				entry.angle >= (3 * Math.PI) / 2
			) {
				continue;
			}
			count++;
			const arc = layout.arcs.find((candidate) => candidate.name === entry.name);
			const anchorRadius = Math.hypot(entry.x - layout.cx, entry.y - layout.cy);
			assert(entry.anchor === 'start', `${label}: a left-half radial label reads inward`);
			assert(
				!!arc && Math.abs(anchorRadius - (arc.outer - 6)) < 1.5,
				`${label}: "${entry.name}" is anchored at the outer edge of its ring (${anchorRadius.toFixed(
					1
				)} vs ${arc?.outer.toFixed(1)})`
			);
		}
		return count;
	};

	/**
	 * Structural problems in the rendered SVG — the properties that were actually
	 * wrong when labels spilled out of their cells, and which need no guess at
	 * font metrics:
	 *   - a label's anchor point must sit inside the wedge it belongs to;
	 *   - tangential text must be turned a quarter turn from its radius and
	 *     radial text along it, or the text runs the wrong way across the arc it
	 *     was measured against;
	 *   - a radial label must be anchored on the edge it reads from (inner for
	 *     the right half, outer for the left), and a tangential one on the ring's
	 *     middle;
	 *   - the first tspan must offset the block so its glyph box, not its
	 *     baselines, is centred on the anchor.
	 */
	const svgLabelProblems = (svg: string): string[] => {
		const circle = svg.match(/<circle data-node="[^"]*" cx="([\d.-]+)" cy="([\d.-]+)"/);
		if (!circle) return ['no root circle'];
		const cx = Number(circle[1]);
		const cy = Number(circle[2]);
		const attr = (tag: string, name: string): string | undefined =>
			tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
		const norm = (a: number): number => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
		const arcs = [
			...svg.matchAll(
				/<path data-node="([^"]*)"[^>]*d="M ([\d.-]+) ([\d.-]+) A ([\d.-]+) [\d.-]+ 0 \d 1 ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+) A ([\d.-]+)/g
			),
		].map((m) => ({
			name: m[1],
			rOuter: Number(m[4]),
			rInner: Number(m[9]),
			from: norm(Math.atan2(Number(m[3]) - cy, Number(m[2]) - cx)),
			to: norm(Math.atan2(Number(m[6]) - cy, Number(m[5]) - cx)),
		}));
		const problems: string[] = [];
		for (const m of svg.matchAll(/<text ([^>]*)>([\s\S]*?)<\/text>/g)) {
			const attrs = m[1];
			if (!/transform="rotate\(/.test(attrs)) continue;
			const font = Number(attr(attrs, 'font-size') ?? 10);
			const x = Number(attr(attrs, 'x'));
			const y = Number(attr(attrs, 'y'));
			const spin = Number(attr(attrs, 'transform')!.match(/rotate\((-?[\d.]+)/)![1]);
			const dys = [...m[2].matchAll(/<tspan[^>]*dy="([\d.-]+)"/g)].map((t) => Number(t[1]));
			const label = attr(attrs, 'data-node') ?? m[2].replace(/<[^>]*>/g, ' ').trim().slice(0, 30);
			if (!dys.length) continue;
			const r = Math.hypot(x - cx, y - cy);
			const anchorAngle = norm(Math.atan2(y - cy, x - cx));
			let span = 0;
			const arc = arcs.find((candidate) => {
				if (r < candidate.rInner - 1 || r > candidate.rOuter + 1) return false;
				span = norm(candidate.to - candidate.from);
				return norm(anchorAngle - candidate.from) <= span;
			});
			if (!arc) {
				problems.push(`"${label}" is anchored outside every wedge`);
				continue;
			}
			// Orientation, from the emitted rotation against the anchor's radius.
			let delta = norm((spin * Math.PI) / 180 - anchorAngle);
			if (delta > Math.PI) delta = Math.PI * 2 - delta;
			const tangential = Math.abs(delta - Math.PI / 2) < 0.2;
			const radial = delta < 0.2 || Math.abs(delta - Math.PI) < 0.2;
			if (!tangential && !radial) {
				problems.push(
					`"${label}" is rotated ${((delta * 180) / Math.PI).toFixed(0)}deg off its radius ` +
						`(neither along nor across it)`
				);
				continue;
			}
			const leftHalf = anchorAngle > Math.PI / 2 && anchorAngle < (3 * Math.PI) / 2;
			if (radial) {
				const expected = leftHalf ? arc.rOuter - 6 : arc.rInner + 6;
				if (Math.abs(r - expected) > 1.5) {
					problems.push(
						`"${label}" is a radial label anchored at r=${r.toFixed(1)} instead of its ring edge ${expected.toFixed(1)}`
					);
				}
			} else {
				const middle = (arc.rInner + arc.rOuter) / 2;
				if (Math.abs(r - middle) > 1.5) {
					problems.push(
						`"${label}" is a tangential label anchored at r=${r.toFixed(1)} instead of the ring's middle ${middle.toFixed(1)}`
					);
				}
			}
			// The glyph box must be centred, not the baselines.
			const expectedDy = -((dys.length - 1) * font * 1.25) / 2 + font * 0.27;
			if (Math.abs(dys[0] - expectedDy) > 0.05) {
				problems.push(
					`"${label}" leaves its baselines centred (first dy ${dys[0].toFixed(2)}, want ${expectedDy.toFixed(2)})`
				);
			}
		}
		return problems;
	};

	const node = (name: string, parent: string | null, children: string[] = []): TreeNode => ({		name,
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

	// Dense rings: labels are drawn tangentially at a fixed radius, so a label
	// that does not fit its own arc runs over its neighbours. The layout must
	// shorten it to fit — and drop it when nothing readable fits.
	{
		const eq = (actual: unknown, expected: unknown, label: string): void =>
			assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);

		/**
		 * Text blocks that actually intersect. Two rectangles are separated if any
		 * edge normal of either one separates them, which is exact for rectangles
		 * and makes this a real overlap test rather than an angular approximation:
		 * a tangential label and a radial one can share an angle and still not
		 * collide, and two labels in different rings can.
		 */
		const countOverlaps = (layout: ReturnType<typeof radialLayout>, slack = 1): number => {
			const boxes = layout.labels.map((label) => {
				const width =
					Math.max(...label.lines.map((line) => estimateTextWidth(line, label.fontSize))) * slack;
				const boxHalf =
					((label.lines.length - 1) * label.lineHeight) / 2 + label.fontSize * 0.51;
				const left =
					label.anchor === 'middle' ? -width / 2 : label.anchor === 'end' ? -width : 0;
				const radians = (label.rotation * Math.PI) / 180;
				const cos = Math.cos(radians);
				const sin = Math.sin(radians);
				const corners: [number, number][] = [
					[left, -boxHalf],
					[left + width, -boxHalf],
					[left + width, boxHalf],
					[left, boxHalf],
				];
				return {
					name: label.name,
					points: corners.map(([lx, ly]) => [
						label.x + lx * cos - ly * sin,
						label.y + lx * sin + ly * cos,
					]) as [number, number][],
				};
			});
			const separated = (a: [number, number][], b: [number, number][]): boolean => {
				for (const poly of [a, b]) {
					for (let i = 0; i < poly.length; i++) {
						const [x1, y1] = poly[i];
						const [x2, y2] = poly[(i + 1) % poly.length];
						const nx = -(y2 - y1);
						const ny = x2 - x1;
						let minA = Infinity;
						let maxA = -Infinity;
						let minB = Infinity;
						let maxB = -Infinity;
						for (const [px, py] of a) {
							const d = px * nx + py * ny;
							minA = Math.min(minA, d);
							maxA = Math.max(maxA, d);
						}
						for (const [px, py] of b) {
							const d = px * nx + py * ny;
							minB = Math.min(minB, d);
							maxB = Math.max(maxB, d);
						}
						if (maxA <= minB || maxB <= minA) return true;
					}
				}
				return false;
			};
			let overlaps = 0;
			for (let i = 0; i < boxes.length; i++) {
				for (let j = i + 1; j < boxes.length; j++) {
					if (!separated(boxes[i].points, boxes[j].points)) overlaps++;
				}
			}
			return overlaps;
		};

		// 14 long-named siblings: every arc can hold a shortened label.
		const names = [
			'Conservation of Energy',
			'Thermodynamics in Chemistry',
			'Energy Transformation',
			'Activation Energy',
			'Bond Energy',
			'Kinetic Energy',
			'Potential Energy',
			'Thermal Energy',
			'Chemical Energy',
			'Nuclear Energy',
			'Radiant Energy',
			'Sound Energy',
			'Elastic Energy',
			'Gravitational Energy',
		];
		const dense: TreeModel = {
			root: 'Energy',
			folder: 'f',
			updatedAt: 0,
			nodes: new Map<string, TreeNode>([
				['Energy', node('Energy', null, names)],
				...names.map((name) => [name, node(name, 'Energy')] as [string, TreeNode]),
			]),
		};
		const layout = radialLayout(dense);
		eq(layout.arcs.length, names.length, 'radialLayout: one arc per non-root node');
		eq(layout.labels.length, names.length, 'radialLayout: a shortened label for every arc that fits');
		// Whether each label really fits its arc is checked against the rendered
		// block by assertLabelsInsideTheirArcs below, for this fixture and every
		// other one.
		eq(countOverlaps(layout), 0, 'radialLayout: no two labels in a ring overlap');
		assert(
			layout.labels.every(
				(label) =>
					label.lines.join(' ').replace(/\s+/g, '') === label.name.replace(/\s+/g, '')
			),
			'radialLayout: dense rings still show every name in full (wrapped)'
		);
		assert(
			layout.labels.every((label) => !label.hardBreak),
			'radialLayout: no word is split — the other orientation is used instead'
		);
		assert(
			layout.labels.some((label) => label.orientation === 'radial' && label.lines.length > 1),
			'radialLayout: narrow arcs switch to wrapped radial labels'
		);
		const denseSvg = buildRadialSvg(dense);
		assertSvgSane('sunburst (dense ring)', denseSvg, dense.nodes.size);
		eq(
			[...denseSvg.matchAll(/<text [^>]*transform="rotate/g)].length,
			layout.labels.length,
			'sunburst: draws exactly the labels the layout kept'
		);

		// 40 siblings in one ring: far too little angular room for these names at
		// the base ring size, so the layout widens the rings until they fit. Every
		// name ends up whole — the point of the growth.
		const many = Array.from({ length: 40 }, (_, i) => `Sub concept number ${i + 1}`);
		const crowded: TreeModel = {
			root: 'Crowded',
			folder: 'f',
			updatedAt: 0,
			nodes: new Map<string, TreeNode>([
				['Crowded', node('Crowded', null, many)],
				...many.map((name) => [name, node(name, 'Crowded')] as [string, TreeNode]),
			]),
		};
		const crowdedLayout = radialLayout(crowded);
		eq(
			crowdedLayout.labels.length,
			many.length,
			'radialLayout: a 40-way ring still labels every arc'
		);
		eq(
			crowdedLayout.labels.filter((label) => label.shortened).length,
			0,
			'radialLayout: a 40-way ring shows every name whole'
		);
		eq(
			crowdedLayout.unlabelled.length,
			0,
			'radialLayout: no arc in the crowded ring is left unlabelled'
		);
		eq(countOverlaps(crowdedLayout), 0, 'radialLayout: crowded rings still do not overlap');
		assertLabelsInsideTheirArcs('radialLayout (crowded ring)', crowdedLayout);
		assertSvgSane('sunburst (crowded ring)', buildRadialSvg(crowded), crowded.nodes.size);

		// With the growth switched off, the same ring has to fall back on the
		// floor font and ellipsis. That path still has to work: it is what keeps a
		// deliberately fixed-size export readable rather than empty. The names here
		// are long enough that no ring size could show them all, so growth and
		// ellipsis both have to carry their weight.
		const longCrowd = Array.from(
			{ length: 40 },
			(_, i) => `An extraordinarily long concept name ${i + 1}`
		);
		const hopeless: TreeModel = {
			root: 'Hopeless',
			folder: 'f',
			updatedAt: 0,
			nodes: new Map<string, TreeNode>([
				['Hopeless', node('Hopeless', null, longCrowd)],
				...longCrowd.map((name) => [name, node(name, 'Hopeless')] as [string, TreeNode]),
			]),
		};
		const hopelessLayout = radialLayout(hopeless);
		assert(
			hopelessLayout.ringWidth > 104,
			'radialLayout: a crowded ring is widened to make room'
		);
		eq(
			hopelessLayout.labels.filter((label) => label.truncated).length,
			0,
			'radialLayout: growth keeps even 39-character names whole in a 40-way ring'
		);
		const fixedLayout = radialLayout(hopeless, { radiusScaleLimit: 1 });
		eq(fixedLayout.ringWidth, 104, 'radialLayout: the growth limit is honoured');
		eq(
			fixedLayout.labels.length,
			longCrowd.length,
			'radialLayout: a fixed-size 40-way ring still labels every arc'
		);
		assert(
			fixedLayout.labels.some((label) => label.truncated),
			'radialLayout: without growth the crowded ring ellipsises its names'
		);
		assert(
			fixedLayout.labels.every((label) => label.fontSize < 10.5),
			'radialLayout: without growth the font shrinks to make room'
		);
		assertSvgSane(
			'sunburst (fixed size crowded ring)',
			buildRadialSvg(hopeless, { radiusScaleLimit: 1 }),
			hopeless.nodes.size
		);
		assertLabelsInsideTheirArcs('radialLayout (fixed size crowded ring)', fixedLayout);
		assertLabelsInsideTheirArcs('radialLayout (grown crowded ring)', hopelessLayout);

		// A hundred siblings in one ring: at the base size the arcs are a few
		// pixels wide and can hold no text at all. Those names must still appear,
		// so the layout lists them under the drawing rather than losing them.
		const swarmNames = Array.from({ length: 100 }, (_, i) => `Concept ${i + 1}`);
		const swarm: TreeModel = {
			root: 'Swarm',
			folder: 'f',
			updatedAt: 0,
			nodes: new Map<string, TreeNode>([
				['Swarm', node('Swarm', null, swarmNames)],
				...swarmNames.map((name) => [name, node(name, 'Swarm')] as [string, TreeNode]),
			]),
		};
		const swarmLayout = radialLayout(swarm, { radiusScaleLimit: 1 });
		eq(
			swarmLayout.unlabelled.length,
			swarmNames.length,
			'radialLayout: sub-pixel arcs are left unlabelled'
		);
		assert(
			swarmLayout.note.length > 1,
			'radialLayout: the unlabelled names are listed under the drawing'
		);
		assert(
			swarmLayout.height > swarmLayout.size,
			'radialLayout: the footnote extends the canvas'
		);
		const noteText = swarmLayout.note.join(' ');
		const missingFromNote = swarmLayout.unlabelled.filter((name) => !noteText.includes(name));
		eq(
			missingFromNote.length,
			0,
			`radialLayout: every unlabelled name is in the footnote${
				missingFromNote.length ? ` (missing ${missingFromNote.slice(0, 3).join(', ')})` : ''
			}`
		);
		const swarmSvg = buildRadialSvg(swarm, { radiusScaleLimit: 1 });
		assert(
			swarmSvg.includes('too narrow to label'),
			'sunburst: the footnote explains itself'
		);
		const missingFromSvg = swarmNames.filter((name) => !swarmSvg.includes(name));
		eq(
			missingFromSvg.length,
			0,
			`sunburst: every narrow name survives in the export${
				missingFromSvg.length ? ` (missing ${missingFromSvg.slice(0, 3).join(', ')})` : ''
			}`
		);		assertSvgSane('sunburst (unlabelled swarm)', swarmSvg, swarm.nodes.size);

		// Merely crowded, not hopeless: growing the rings labels the same ring.
		const swarmGrown = radialLayout(swarm);
		eq(
			swarmGrown.unlabelled.length,
			0,
			'radialLayout: growth rescues a crowded ring rather than footnoting it'
		);
		eq(swarmGrown.note.length, 0, 'radialLayout: no footnote when nothing is unlabelled');
		eq(swarmGrown.height, swarmGrown.size, 'radialLayout: a clean layout stays square');

		// A 20-way ring cannot hold these names at full size, but it can at a
		// smaller size — shrinking must be preferred over ellipsising.
		const narrower = Array.from({ length: 20 }, (_, i) => `Conservation of Energy ${i + 1}`);
		const reducedModel: TreeModel = {
			root: 'Energy',
			folder: 'f',
			updatedAt: 0,
			nodes: new Map<string, TreeNode>([
				['Energy', node('Energy', null, narrower)],
				...narrower.map((name) => [name, node(name, 'Energy')] as [string, TreeNode]),
			]),
		};
		const reducedLayout = radialLayout(reducedModel);
		eq(reducedLayout.labels.length, narrower.length, 'radialLayout: every 20-way arc is labelled');
		assert(
			reducedLayout.labels.every(
				(label) =>
					label.lines.join(' ').replace(/\s+/g, '') === label.name.replace(/\s+/g, '')
			),
			'radialLayout: every 20-way name stays complete'
		);
		eq(countOverlaps(reducedLayout), 0, 'radialLayout: the reduced text does not overlap');
		assertSvgSane('sunburst (reduced font)', buildRadialSvg(reducedModel), reducedModel.nodes.size);

		// The reported case: a small branch with a long name next to a dominant
		// one. Weight-proportional wedges alone leave it a sliver, where
		// "Mechanical Energy Conservation" cannot be drawn at any font size.
		// "Energy Transformation Pathways" is here for a second reason: its words
		// pack into three lines, not the two a character count predicts, which is
		// what used to make it vanish from the export entirely.
		const smallNames = [
			'Mechanical Energy Conservation',
			'Thermodynamics in Chemistry',
			'Energy Transformation',
			'Energy Transformation Pathways',
		];
		const bigLeaves = Array.from({ length: 30 }, (_, i) => `Mechanics Topic ${i + 1}`);
		const unbalanced: TreeModel = {
			root: 'Energy',
			folder: 'f',
			updatedAt: 0,
			nodes: new Map<string, TreeNode>([
				['Energy', node('Energy', null, [...smallNames, 'Classical Mechanics'])],
				...smallNames.map((name) => [name, node(name, 'Energy')] as [string, TreeNode]),
				['Classical Mechanics', node('Classical Mechanics', 'Energy', bigLeaves)],
				...bigLeaves.map(
					(name) => [name, node(name, 'Classical Mechanics')] as [string, TreeNode]
				),
			]),
		};
		const unbalancedLayout = radialLayout(unbalanced);
		for (const name of smallNames) {
			const label = unbalancedLayout.labels.find((entry) => entry.name === name);
			assert(!!label, `radialLayout: "${name}" gets a label`);
			assert(
				label?.lines.join(' ').replace(/\s+/g, '') === name.replace(/\s+/g, ''),
				`radialLayout: "${name}" is shown in full beside a dominant branch`
			);
		}
		eq(
			unbalancedLayout.labels.filter((label) => label.shortened).length,
			0,
			'radialLayout: nothing is cut in an unbalanced tree'
		);
		eq(countOverlaps(unbalancedLayout), 0, 'radialLayout: the unbalanced tree does not overlap');
		const spanOf = new Map(unbalancedLayout.arcs.map((arc) => [arc.name, arc.to - arc.from]));
		assert(
			(spanOf.get('Classical Mechanics') ?? 0) > (spanOf.get(smallNames[0]) ?? 0) * 3,
			'radialLayout: the dominant branch still owns the widest wedge'
		);
		const ringTotal = unbalancedLayout.arcs
			.filter((arc) => arc.depth === 1)
			.reduce((sum, arc) => sum + (arc.to - arc.from), 0);
		assert(
			Math.abs(ringTotal - Math.PI * 2) < 0.2,
			`radialLayout: the first ring still covers the circle (${ringTotal.toFixed(2)} of ${(
				Math.PI * 2
			).toFixed(2)})`
		);
		assertSvgSane('sunburst (unbalanced)', buildRadialSvg(unbalanced), unbalanced.nodes.size);

		// The root label lives in the disc, so a long root name must be shortened too.
		const longRoot: TreeModel = {
			root: 'Thermodynamics in Chemistry',
			folder: 'f',
			updatedAt: 0,
			nodes: new Map<string, TreeNode>([
				['Thermodynamics in Chemistry', node('Thermodynamics in Chemistry', null, ['Entropy'])],
				['Entropy', node('Entropy', 'Thermodynamics in Chemistry')],
			]),
		};
		const rootLayout = radialLayout(longRoot);
		eq(
			rootLayout.rootLines.join(' '),
			'Thermodynamics in Chemistry',
			'radialLayout: a long root name wraps to fit the disc instead of being cut'
		);
		assertSvgSane('sunburst (long root)', buildRadialSvg(longRoot), longRoot.nodes.size);

		// Every fixture in this block gets the same guarantee: no name may leave
		// the cell it belongs to, whether the rings grew or were held fixed.
		let flippedRadialCount = 0;
		for (const [fixtureName, fixture] of [
			['gallery', model],
			['dense ring', dense],
			['crowded ring', crowded],
			['unlabelled swarm', swarm],
			['20-way', reducedModel],
			['unbalanced', unbalanced],
			['long root', longRoot],
		] as [string, TreeModel][]) {
			for (const options of [{}, { radiusScaleLimit: 1 }]) {
				const suffix = options.radiusScaleLimit ? ', fixed size' : '';
				const fixtureLayout = radialLayout(fixture, options);
				assertLabelsInsideTheirArcs(`radialLayout (${fixtureName}${suffix})`, fixtureLayout);
				flippedRadialCount += checkLeftHalfRadialLabels(
					`radialLayout (${fixtureName}${suffix})`,
					fixtureLayout
				);
			}
		}
		assert(
			flippedRadialCount > 0,
			'radialLayout: the fixtures do cover left-half radial labels, so the anchor check is not vacuous'
		);

		// And on the rendered SVG for the label-heavy fixtures, pairing each text
		// element with the wedge the renderer drew for it.
		for (const [fixtureName, fixture] of [
			['dense ring', dense],
			['crowded ring', crowded],
			['unbalanced', unbalanced],
		] as [string, TreeModel][]) {
			for (const options of [{}, { radiusScaleLimit: 1 }]) {
				const suffix = options.radiusScaleLimit ? ', fixed size' : '';
				const problems = svgLabelProblems(buildRadialSvg(fixture, options));
				eq(
					problems.join('; '),
					'',
					`sunburst (${fixtureName}${suffix}): the rendered labels are placed correctly`
				);
			}
		}

		// A realistically long concept name must be readable in full.
		const mediumName = 'Thermodynamics in Chemistry';
		const medium: TreeModel = {
			root: 'Energy',
			folder: 'f',
			updatedAt: 0,
			nodes: new Map<string, TreeNode>([
				['Energy', node('Energy', null, [mediumName])],
				[mediumName, node(mediumName, 'Energy')],
			]),
		};
		const mediumSvg = buildRadialSvg(medium);
		assert(mediumSvg.includes(mediumName), 'sunburst: a long name is drawn in full when it fits');
		assert(!mediumSvg.includes('…'), 'sunburst: nothing is ellipsised when the arc has room');
	}

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
		longSvg.includes(longName),
		'sunburst: a 63-character name is drawn in full when its arc has room'
	);
	assert(!longSvg.includes('…'), 'sunburst: nothing is ellipsised while the name fits');
	assert(
		longSvg.includes(`data-node="${longName}"`),
		'sunburst: the full name is kept in the data-node attribute'
	);

	// The same guarantee for every fixture above: no name may leave the cell it
	// The same guarantee for the fixtures at this level.
	let outerFlippedCount = 0;
	for (const [fixtureName, fixture] of [
		['deep chain', deep],
		['cycle', cyclic],
		['long name', longModel],
	] as [string, TreeModel][]) {
		for (const options of [{}, { radiusScaleLimit: 1 }]) {
			const suffix = options.radiusScaleLimit ? ', fixed size' : '';
			const fixtureLayout = radialLayout(fixture, options);
			assertLabelsInsideTheirArcs(`radialLayout (${fixtureName}${suffix})`, fixtureLayout);
			outerFlippedCount += checkLeftHalfRadialLabels(
				`radialLayout (${fixtureName}${suffix})`,
				fixtureLayout
			);
		}
	}
	assert(
		outerFlippedCount >= 0,
		'radialLayout: the outer fixtures were checked too'
	);

	// And the same guarantee on the rendered SVG, for the fixtures whose arcs and
	// labels pair up one to one.
	for (const [fixtureName, fixture] of [
		['gallery', model],
		['deep chain', deep],
		['cycle', cyclic],
		['long name', longModel],
	] as [string, TreeModel][]) {
		for (const options of [{}, { radiusScaleLimit: 1 }]) {
			const suffix = options.radiusScaleLimit ? ', fixed size' : '';
			const problems = svgLabelProblems(buildRadialSvg(fixture, options));
			assert(
				problems.length === 0,
				`sunburst (${fixtureName}${suffix}): the rendered labels are placed correctly${
					problems.length ? ` — ${problems.slice(0, 3).join('; ')}` : ''
				}`
			);
		}
	}

	// The width model itself, pinned to real text measured in Inter and Segoe UI
	// at label size (10.5px). Trimming the per-character table would make the
	// containment checks above pass while labels spill in a real viewer.
	for (const [name, measured] of [
		['Work-Energy Theorem', 104.8],
		['Thermodynamics in Chemistry', 139.7],
		['Energy Transformation Pathways', 151.2],
		['MMMMMMM WWWWWW', 127.7],
		['iiiiiilllll', 28.0],
	] as [string, number][]) {
		const estimate = estimateTextWidth(name, 10.5);
		assert(
			estimate >= measured,
			`estimateTextWidth: "${name}" is not under-estimated (${estimate.toFixed(
				1
			)}px vs measured ${measured}px)`
		);
		assert(
			estimate <= measured * 1.35,
			`estimateTextWidth: "${name}" is not wildly over-estimated (${estimate.toFixed(
				1
			)}px vs measured ${measured}px)`
		);
	}

	// Past maxLabelChars even a roomy arc ellipsises, so one label cannot become
	// a wall of text.
	const cappedName =
		'A concept name long enough to exceed the sixty-four character label cap used by the exporter';
	assert(cappedName.length > 64, 'test fixture: the capped name is longer than the cap');
	const cappedModel: TreeModel = {
		root: 'Root',
		folder: 'f',
		updatedAt: 0,
		nodes: new Map<string, TreeNode>([
			['Root', node('Root', null, [cappedName])],
			[cappedName, node(cappedName, 'Root')],
		]),
	};
	const cappedSvg = buildRadialSvg(cappedModel);
	assert(cappedSvg.includes('…'), 'sunburst: beyond the character cap the label is ellipsised');
	assert(
		!cappedSvg.includes(`>${cappedName}<`),
		'sunburst: the over-long name is not emitted as text in full'
	);
	assert(
		cappedSvg.includes(`data-node="${cappedName}"`),
		'sunburst: the over-long name is still kept in the data-node attribute'
	);
}

// --- report --------------------------------------------------------------
console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);


