/**
 * Smoke tests for pure logic (no Obsidian runtime). Run via:
 *   node esbuild.config.mjs test  (see below) — or build+run manually.
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
	assert(sanitizeFileName('A:B/C?D*') === 'A B C D', 'sanitizeFileName');
	assert(sanitizeFileName('...') === 'concept', 'sanitizeFileName empty fallback');
	assert(normalizeKey('  Democracy ') === 'democracy', 'normalizeKey');
	assert(hashString('x') === hashString('x') && hashString('x') !== hashString('y'), 'hashString stable');
	assert(toInt('2025-01-01T00:00:00.000Z', 0) > 1_700_000_000_000, 'toInt parses ISO timestamps');
	assert(toInt('3', 0) === 3, 'toInt parses numbers');
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

// --- report --------------------------------------------------------------
console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
