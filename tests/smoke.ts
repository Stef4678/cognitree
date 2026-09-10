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

// --- report --------------------------------------------------------------
console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
