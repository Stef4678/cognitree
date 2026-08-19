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

export interface BuiltPrompt {
	system: string;
	user: string;
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
