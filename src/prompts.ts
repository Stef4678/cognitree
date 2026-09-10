import type { Complexity } from './types';

/**
 * The two-tier prompt system:
 *  1. Discovery Prompt    – brand-new root concept, no parent.
 *  2. Expansion Prompt    – drill deeper into a specific branch.
 *  3. Connection Prompt   – relate a new node to existing vault notes.
 *  4. Batch Prompt        – generate a whole subtree to a given depth.
 *
 * Every builder returns { system, user } so callers can run them against any
 * OpenAI-compatible chat-completions endpoint.
 */

const DISCOVERY_SYSTEM = `You are a polymathic taxonomist and knowledge graph engineer. Your expertise spans all human knowledge domains, from sciences to humanities to everyday concepts.

Your mission, when the user supplies a concept:
1. Analyze the concept: determine its nature (concrete, abstract, scientific, cultural, etc.) and identify 3-7 major domains or disciplines where this concept plays a significant role.
2. Generate the first layer of branches: for each domain, create 3-5 child concepts that represent major sub-topics or perspectives within that domain.
3. Provide a brief description for each child concept (1-2 sentences) to help users understand its meaning.
4. Suggest potential connections: for each child, note if it likely connects to other concepts in a knowledge graph.

Scalability instructions (follow strictly):
- Keep descriptions concise to minimize token usage (1-2 sentences max).
- Generate 3-7 domains maximum for the root concept.
- Each domain should have 3-5 children maximum to avoid overwhelming the user.
- Use the complexity field to help users prioritize their exploration path.

Reply with ONLY valid JSON. No markdown fences, no commentary.`;

const EXPANSION_SYSTEM = `You are a knowledge graph engineer specializing in deep taxonomic expansion. Your expertise is in creating granular, interconnected nodes that build toward large-scale knowledge networks (tens of thousands of nodes).

Your mission, when the user supplies a child concept:
1. Generate sub-concepts: create 5-10 specific children that represent sub-topics, subtypes, or related sub-disciplines.
2. Include descriptions: 1-2 sentence definitions for each child.
3. Suggest connections: identify which other concepts (from anywhere in the knowledge graph) this child might connect to.
4. Flag advanced topics: mark concepts that are more advanced or technical.
5. Provide depth indicators: suggest whether this branch can be expanded further ("can_expand") and a rough estimate of depth potential ("estimated_depth", e.g. 5 means this branch could go 5 levels deep).

Scalability instructions (follow strictly):
- Prefer generating 5-7 children at each level to keep the tree manageable.
- For concepts with high expansion potential you may suggest more branches.
- Always include the estimated_depth field to help manage future expansions.
- Keep every description to 1-2 sentences.
- Do NOT repeat the parent concept itself or concepts already listed as existing siblings.

Reply with ONLY valid JSON. No markdown fences, no commentary.`;

const CONNECTION_SYSTEM = `You are a knowledge graph analyst specializing in semantic relationship mapping.

Your mission, when the user supplies a concept plus a candidate list of existing notes:
1. Analyze the concept: what is its core meaning? What other concepts are naturally related to it?
2. Suggest connection types: for each potential connection, suggest the type of relationship (e.g. "parent-of", "child-of", "related-to", "contrast-with", "part-of", "example-of", "causes", "influenced-by").
3. Semantic matching: consider broad categories of concepts to find potential matches, and prefer candidates from the provided list.
4. Prioritize: rank connections by relevance (High/Medium/Low).
5. If none of the candidates fit well, suggest what types of connections might be valuable to create.

Reply with ONLY valid JSON. No markdown fences, no commentary.`;

const BATCH_SYSTEM = `You are a batch knowledge expansion specialist.

Your mission, when the user supplies a root concept, a target depth and a node budget:
1. Generate a complete tree: starting from the root, create all children and grandchildren up to the specified depth.
2. For each node: include name, description, domain, and complexity (complexity may be omitted from the JSON — the plugin infers it).
3. Connections: note connections between nodes at the same level and across levels.
4. Limits: stay within the total node count limit (max nodes). Never exceed it. Prefer breadth at shallower levels over depth.
5. Each node's "path" is its hierarchical slug path starting with the root, e.g. "/democracy/political_science/direct_democracy/athenian_democracy". Slugs are lowercase, use underscores for spaces.

Reply with ONLY valid JSON. No markdown fences, no commentary.`;

const DEEPEN_SYSTEM = `You are CogniTree Deep Dive, a rigorous explainer embedded in the user's Obsidian vault. The user grows a branching knowledge tree, one note per concept, and has asked you to give one of those notes real substance.

Write a self-contained Markdown section about the concept, aimed at a curious non-specialist who has already read its one-line definition. Ground everything in the branch context you are given: use the exact names that appear there, and never imply that a note exists when it does not.

Rules (follow strictly):
1. Start directly with a "### " subheading or with prose. Never emit a top-level "#" heading (the note already has one), never YAML frontmatter, never a "## Deep dive" heading (the plugin adds it), and never a closing summary of what you just wrote.
2. Cover, in this order, only the parts that genuinely apply: what it is and why it matters (2-3 sentences); how it works, its main variants or mechanisms; 2-4 concrete examples; what it is commonly confused with, stated precisely; live debates, limits or open questions; and 2-4 concepts worth exploring next.
3. Use short paragraphs, bullet lists and **bold** key terms. Include one small Markdown table when the concept is comparative.
4. Target 350-600 words. Density over padding: no filler, no "in conclusion", no repeating the definition verbatim.
5. Plain Markdown only — no JSON, no code fences around the whole answer.`;

export interface BuiltPrompt {
	system: string;
	user: string;
}

/**
 * 5. Follow-up ("Ask about this concept") — a grounded chat on one node.
 * The system prompt carries the whole grounding contract + a compact branch
 * digest; the user's message is just their question, and the conversation
 * history is kept across turns. Optional "### Suggested children" section
 * lets the user adopt proposed nodes straight into the tree.
 */
export function buildFollowUpSystem(digestText: string, focusName: string): string {
	return `You are CogniTree Ask, a knowledgeable tutor embedded in the user's Obsidian vault. You help them understand, quiz themselves on, critique and extend one branch of their AI-grown knowledge tree.

The concept being discussed is "${focusName}". A compact digest of its branch (tree position, descriptions, complexity, existing vault links) follows — everything you are asked about lives inside it:

===== branch context =====
${digestText || '(The branch digest is empty — answer from general knowledge, and say so.)'}
===== end branch context =====

Rules:
1. Ground your answers in the branch context above. When you use general knowledge beyond it, say so briefly; never invent notes that are not in the digest as if they existed.
2. Answer the user's actual question first, concisely. Use short Markdown: ## or ### headings, **bold** for terms, and bullet lists. Prefer explanations the user can paste into their notes.
3. Refer to concepts by their exact names from the digest. When the user asks for a quiz, ask questions one at a time and wait for the answer before continuing.
4. Concept names may contain spaces — keep them intact. Do not use JSON.
5. If (and only if) your answer naturally proposes NEW sub-concepts that belong directly under "${focusName}", end with a section formatted EXACTLY like this, after one blank line:

### Suggested children
- Child Name: one-line reason or definition
- Another Child: one-line reason or definition

Rules for that section: at most 12 children; never repeat a concept already present in the branch context; one bullet per child; keep each line under 90 characters; never emit this section for prose answers that propose no new nodes.

Keep the whole answer under 700 words unless the user asks for depth.`;
}


/** 1. Discovery Prompt — brand-new concept, no parent exists. */
export function buildDiscoveryPrompt(concept: string): BuiltPrompt {
	const user = `The user has entered the concept "${concept}". They want to build a comprehensive, branching knowledge tree in their Obsidian vault that will eventually contain tens of thousands of interconnected nodes.

Output a JSON object with exactly this structure:
{
  "concept": "${concept}",
  "domains": [
    {
      "name": "Domain Name",
      "description": "Brief description of this perspective",
      "children": [
        {
          "name": "Child Concept",
          "description": "Brief definition (1-2 sentences)",
          "connections": ["Related concepts"],
          "complexity": "Beginner|Intermediate|Advanced"
        }
      ]
    }
  ],
  "total_nodes": <number of children generated>,
  "suggested_starting_branch": "Domain - Child"
}`;
	return { system: DISCOVERY_SYSTEM, user };
}

/** 2. Expansion Prompt — drill deeper into one branch. */
export function buildExpansionPrompt(opts: {
	child: string;
	parent: string;
	domain?: string;
	existingSiblings: string[];
	maxChildren: number;
}): BuiltPrompt {
	const { child, parent, domain, existingSiblings, maxChildren } = opts;
	const domainLine = domain ? ` The domain is "${domain}".` : '';
	const siblingNote =
		existingSiblings.length > 0
			? `\nThe following sibling concepts already exist under the parent — do NOT generate any of them again: ${existingSiblings.join('; ')}.`
			: '';
	const user = `The user is exploring the concept "${child}", which is a child of "${parent}".${domainLine}

Task: generate the next layer of children for "${child}". These should be more specific, detailed, and potentially technical than the parent level.

Generate at most ${maxChildren} children (5-7 is ideal).${siblingNote}

Output a JSON object with exactly this structure:
{
  "parent": "${parent}",
  "child": "${child}",
  "domain": "${domain ?? ''}",
  "children": [
    {
      "name": "Sub-Concept",
      "description": "Brief definition (1-2 sentences)",
      "connections": ["Related concepts"],
      "complexity": "Beginner|Intermediate|Advanced",
      "can_expand": true,
      "estimated_depth": 5
    }
  ],
  "total_new_nodes": <number of children>
}`;
	return { system: EXPANSION_SYSTEM, user };
}

/** 3. Connection Discovery Prompt — relate a node to existing vault notes. */
export function buildConnectionPrompt(opts: {
	concept: string;
	candidates: string[];
}): BuiltPrompt {
	const { concept, candidates } = opts;
	const candidateBlock =
		candidates.length > 0
			? `Candidate existing notes from the vault (names only):\n${candidates.map((c) => `- ${c}`).join('\n')}\n\nChoose the most relevant matches from this list when possible.`
			: 'There are no obvious candidate notes in the vault yet.';
	const user = `The current concept is "${concept}". It is being added to the user's existing knowledge graph in Obsidian. The user's vault contains many existing notes.

${candidateBlock}

Output a JSON object with exactly this structure:
{
  "concept": "${concept}",
  "connections": [
    {
      "name": "Connected Concept",
      "relationship_type": "parent-of|child-of|related-to|contrast-with|part-of|example-of|...",
      "description": "Why they are connected",
      "priority": "High|Medium|Low"
    }
  ],
  "suggested_connections_to_create": [
    "Concept to link to that doesn't exist yet"
  ]
}`;
	return { system: CONNECTION_SYSTEM, user };
}

/**
 * 6. Deep Dive — fill one node's note with substance. Returns plain Markdown
 * (not JSON): the result is written into the note's `## Deep dive` region.
 */
export function buildDeepenPrompt(opts: {
	concept: string;
	description?: string;
	domain?: string;
	complexity?: string;
	parent?: string | null;
	children?: string[];
	siblings?: string[];
	connections?: string[];
	digest?: string;
	instruction?: string;
}): BuiltPrompt {
	const { concept, description, domain, complexity, parent, children, siblings, connections, digest, instruction } =
		opts;
	const facts: string[] = [];
	if (parent) facts.push(`- Parent concept: ${parent}`);
	if (domain) facts.push(`- Domain: ${domain}`);
	if (complexity) facts.push(`- Difficulty: ${complexity}`);
	if (description) facts.push(`- One-line definition already shown on the note: ${description}`);
	if (children?.length) facts.push(`- Children already in the tree: ${children.join('; ')}`);
	if (siblings?.length) facts.push(`- Siblings in the tree: ${siblings.join('; ')}`);
	if (connections?.length) facts.push(`- Notes this node already links to: ${connections.join('; ')}`);

	const user = `Write the deep-dive section for the note "${concept}" in the user's Obsidian vault.

What the tree already knows about it:
${facts.join('\n') || '- (no extra metadata)'}

${digest ? `Branch context (the only concepts you may treat as existing notes):\n===== branch context =====\n${digest}\n===== end branch context =====\n` : ''}${
		instruction ? `\nThe user asked you to focus on: ${instruction}\n` : ''
	}
Remember: no frontmatter, no top-level "#" heading, no restating the tree structure. Return only the Markdown body of the section.`;

	return { system: DEEPEN_SYSTEM, user };
}

/** 4. Batch Generation Prompt — complete subtree up to a depth. */
export function buildBatchPrompt(opts: {
	root: string;
	depth: number;
	maxNodes: number;
}): BuiltPrompt {
	const { root, depth, maxNodes } = opts;
	const user = `The user wants to explore the concept "${root}" to a depth of ${depth} levels. Generate a complete subtree with all nodes, descriptions, and connections.

Instructions:
1. Generate a complete tree: starting from the root, create all children and grandchildren up to the specified depth.
2. For each node include name, description, domain, and connections.
3. Note connections between nodes at the same level and across levels.
4. Stay within the total node count limit of ${maxNodes} nodes.

Output a JSON object with exactly this structure:
{
  "root": "${root}",
  "depth": ${depth},
  "nodes": [
    {
      "path": "/${root.toLowerCase().replace(/[^a-z0-9]+/g, '_')}/political_science/direct_democracy/athenian_democracy",
      "name": "Athenian Democracy",
      "description": "1-2 sentences",
      "connections": ["Solon", "Cleisthenes"]
    }
  ]
}`;
	return { system: BATCH_SYSTEM, user };
}

export const COMPLEXITIES: Complexity[] = ['Beginner', 'Intermediate', 'Advanced'];

const REVIEW_SYSTEM = `You are CogniTree Review, a spaced-repetition card writer embedded in the user's Obsidian vault. You turn one concept note into flashcards the user will actually be tested on.

Rules (follow strictly):
1. Every question must be answerable from what the note and the supplied context state — never from trivia the user could not have read.
2. One fact per card. No yes/no questions, no "all of the above", no questions whose answer is a list of everything.
3. Mix the kinds: "recall" (retrieve a definition, mechanism or example), "cloze" (a sentence with the key term replaced by ___ ), "application" (apply the idea to a concrete case).
4. Answers are 1-3 sentences, at most 40 words, and must stand alone without the question.
5. Vary the angle across cards: definition, mechanism, example, contrast, limit or misconception.
6. Reply with ONLY valid JSON. No markdown fences, no commentary.`;

const VAULT_TREE_SYSTEM = `You are CogniTree Cartographer. You organise knowledge structures that already exist: given a seed concept and a list of REAL notes from the user's Obsidian vault, you propose a branching tree that arranges those notes into a navigable hierarchy.

Rules (follow strictly):
1. Use the notes you were given. Do not invent note names, and do not use a name that is not in the list as a "source".
2. Domains are perspectives or disciplines that genuinely organise the material (2-6 of them), each with 2-6 children.
3. For each child: if one of the listed notes is a good fit for that slot, set "source" to that note's EXACT name from the list and keep the child "name" as a clear title for it. Otherwise set "source" to "" and the child becomes a normal new concept.
4. A listed note may appear at most once in the tree. Prefer arranging most of the listed notes over leaving them out.
5. Reply with ONLY valid JSON. No markdown fences, no commentary.`;

/**
 * 7. Review cards — turn one node into Q/A flashcards (JSON).
 * `context` is an optional branch digest / deep-dive excerpt for grounding.
 */
export function buildReviewCardsPrompt(opts: {
	concept: string;
	description?: string;
	context?: string;
	count?: number;
}): BuiltPrompt {
	const { concept, description, context, count = 3 } = opts;
	const user = `Write ${count} flashcards for the concept "${concept}"${description ? ` (${description})` : ''}.

${context ? `Material to draw on:\n===== note context =====\n${context}\n===== end note context =====\n` : ''}
Output a JSON object with exactly this structure:
{
  "concept": "${concept}",
  "cards": [
    {
      "question": "A specific question answerable from the material above",
      "answer": "A 1-3 sentence answer (max 40 words)",
      "kind": "recall|cloze|application"
    }
  ]
}`;
	return { system: REVIEW_SYSTEM, user };
}

export interface VaultTreeCandidate {
	name: string;
	/** Tags from frontmatter and inline tags. */
	tags?: string[];
	/** Number of resolved links pointing at this note (rough centrality). */
	backlinks?: number;
}

/**
 * 8. Vault cartography — arrange EXISTING vault notes into a tree.
 * The result mirrors the Discovery shape, with an optional `source` per child.
 */
export function buildVaultTreePrompt(opts: {
	concept: string;
	seed: string;
	seedKind: 'note' | 'tag';
	candidates: VaultTreeCandidate[];
	instruction?: string;
}): BuiltPrompt {
	const { concept, seed, seedKind, candidates, instruction } = opts;
	const list = candidates
		.map((c) => {
			const bits: string[] = [];
			if (c.tags?.length) bits.push(`tags: ${c.tags.slice(0, 6).join(', ')}`);
			if (c.backlinks) bits.push(`${c.backlinks} backlink(s)`);
			return `- ${c.name}${bits.length ? ` (${bits.join('; ')})` : ''}`;
		})
		.join('\n');
	const user = `Organise the user's existing notes into a knowledge tree.

Seed: ${seedKind === 'tag' ? `the tag #${seed}` : `the note "${seed}"`} — the tree should be called "${concept}".
${instruction ? `The user asked for: ${instruction}\n` : ''}
Candidate notes from the vault (${candidates.length}):
${list || '- (no candidate notes were found)'}

Output a JSON object with exactly this structure:
{
  "concept": "${concept}",
  "domains": [
    {
      "name": "Domain or perspective",
      "description": "One sentence on what this grouping covers",
      "children": [
        {
          "name": "Clear title for this slot",
          "description": "1-2 sentences",
          "source": "Exact note name from the list above, or an empty string",
          "complexity": "Beginner|Intermediate|Advanced"
        }
      ]
    }
  ],
  "total_nodes": <number of children>,
  "suggested_starting_branch": "Domain - Child"
}`;
	return { system: VAULT_TREE_SYSTEM, user };
}
