# CogniTree

AI-powered **branching knowledge trees** for Obsidian. Type a single concept ("democracy", "tree", "consciousness") and a polymathic-taxonomist LLM grows it into a deep, interconnected tree of notes — one branch at a time, up to tens of thousands of nodes.

Built around a **four-prompt system** (Discovery, Expansion, Connection Discovery, Batch Generation) and designed for **large-scale scalability**: incremental growth, Markdown+frontmatter storage, response caching, background indexing via Obsidian's `metadataCache`, and virtualized rendering.

---

## Features

| Capability | How |
|---|---|
| **Discovery** (root concept) | Polymathic taxonomist prompt → 3–7 domains × 3–5 children |
| **Expansion** (drill deeper) | Knowledge-graph engineer prompt → 5–10 granular sub-concepts with `can_expand` / `estimated_depth` |
| **Connection Discovery** | Ranked vault-note candidates (background index) → relationship types + priorities; link or create notes |
| **Batch expansion** | Level-by-level BFS with bounded concurrency, node budget, live progress bar |
| **Incremental growth** | Never generate the whole tree at once; expand branches on demand |
| **Markdown storage** | One note per concept, full frontmatter (parent, domain, complexity, children, connections, path), wikilink `## Connections` section |
| **Response cache** | Identical queries hit the cache (LRU, expiry, disabled at `0`) |
| **Background indexing** | Vault note names/tags indexed from `metadataCache` — powers connection matching without loading files |
| **Virtualized rendering** | Only visible rows are in the DOM; smooth with tens of thousands of nodes |
| **Any OpenAI-compatible API** | DeepSeek (default), OpenAI, OpenRouter, Ollama, LM Studio… with optional SSE streaming |

### Tree interaction

| Feature | How |
|---|---|
| **Hover preview** | Hover a node → tooltip with its description; the same preview follows keyboard selection |
| **Keyboard navigation** | **↑ / ↓** move the selection, **→** expand, **←** collapse, **Enter** toggle — preview follows the selected node |
| **Filter that jumps** | Type in the search box: matching nodes keep their ancestor chain, matches are highlighted, and the view jumps to the first hit; a *No matching nodes* hint appears when nothing matches |
| **Copy link / path** | Right-click → **Copy [[link]]** or **Copy note path** |
| **Safe delete with undo** | Right-click → **Delete node + descendants**, then press **Undo** on the notice to recreate every deleted note |
| **Export tree** | Right-click → **Export tree…** → Markdown outline, JSON snapshot, or SVG graph, written to the vault root |
| **Batch connections** | Right-click → **Find connections in subtree** — runs the connection pass over every node and auto-links high-priority hits |
| **Tree stats & health** | Right-click → **Tree stats & health** — depth distribution, complexity breakdown, orphaned / dangling-node detection |
| **Duplicate detection** | Right-click → **Find duplicates across trees** — lists concepts present in 2+ trees with **Link** and **Merge A→B / B→A** actions |
| **Batch without collapsing** | Batch expansion preserves the current expansion state, then expands the batch subtree afterwards |
| **Expand all / Collapse** | Toolbar buttons to show or hide the whole tree at once |
| **Manual reindex** | **♺ Index** toolbar button (or the *Reindex vault notes* command) rebuilds the connection index on demand |

---

## Quick start

1. **Install** — copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/cognitree/` and enable the plugin. (Or `git clone` and run `npm run build`.)
2. **Set your API key** — ribbon icon 🕸 *Open CogniTree* → **⚙** in the header → paste your key (defaults to DeepSeek + `deepseek-v4-flash`). To use another provider, pick it from the **Provider** dropdown — the endpoint and model list switch automatically (Ollama / LM Studio need no key).
3. **Generate a tree** — type `democracy` in the input and press **Generate**. The Discovery prompt creates the root + domain children as notes under `CogniTree/Democracy/`.
4. **Explore** — click a row to select (or use **↑ / ↓** to navigate with the keyboard and a live preview tooltip); use **Expand** (Expansion prompt), **🔗** (Find connections), **Batch expand** (subtree to a depth), hover for the description preview, right-click for the context menu (copy, export, stats, duplicates, safe delete), double-click to open the note, and **⛶ Expand all** / **⛁ Collapse** / **♺ Index** from the toolbar.

Example flow: `democracy` → Discovery → *Political Science / Direct Democracy / Referendums* → click **Referendums** → Expansion → *Mandatory / Optional / Popular Initiative* → **🔗 Find connections** → link to *Elections*, *Switzerland*, *Popular Sovereignty*.

---

## Settings

Mirrors the spec's `PluginSettings`:

| Setting | Default | Purpose |
|---|---|---|
| `apiKey` | — | Key for the OpenAI-compatible endpoint (not needed for local providers) |
| **Provider** | — | Preset picker: DeepSeek, OpenAI, OpenRouter, Groq, Mistral, xAI, Together, Cerebras, Perplexity, NVIDIA NIM, Fireworks, SiliconFlow, Zhipu GLM, Moonshot, Qwen (DashScope), Ollama, LM Studio, or Custom… |
| `modelEndpoint` | `https://api.deepseek.com` | Base URL (`/chat/completions` is appended if missing) |
| `model` | `deepseek-v4-flash` | Model id — dropdown lists the provider's curated models + anything fetched via `GET /models`; **Custom…** accepts any id |
| `temperature` | `0.7` | Sampling temperature |
| `streaming` | `true` | Live text during generation |
| `maxTokensPerRequest` | `4000` | Token cap per call (reasoning models auto-retry with a larger budget if they run out mid-reasoning) |
| `maxChildrenPerLevel` | `7` | Children cap per expansion |
| `maxDepth` | `10` | Deepest auto/batch expansion level |
| `maxNodesPerBatch` | `100` | Node budget for batch expansion |
| `autoExpandDepth` | `1` | Levels auto-expanded on open (no API calls) |
| `showComplexity` | `true` | Beginner/Intermediate/Advanced badges |
| `virtualizeRendering` | `true` | Windowed rendering (recommended for large trees) |
| `cacheExpiryHours` | `24` | Cache TTL; `0` disables caching |
| `treeFolder` | `CogniTree` | Vault folder holding generated trees |

Also: **Clear cache** (currently N cached generations) and **tree folder** relocation.

---

## The prompt system

The four prompts from the spec are implemented verbatim in [`src/prompts.ts`](src/prompts.ts):

1. **Discovery Prompt** — *"You are a polymathic taxonomist and knowledge graph engineer…"* — 3–7 domains, 3–5 children each, complexity ratings, connection hints, `suggested_starting_branch`. Strict JSON schema.
2. **Expansion Prompt** — *"You are a knowledge graph engineer specializing in deep taxonomic expansion…"* — 5–10 granular children, sibling de-duplication context, `can_expand` + `estimated_depth` depth indicators.
3. **Connection Discovery Prompt** — *"You are a knowledge graph analyst…"* — ranked candidate vault notes, `relationship_type` (parent-of / related-to / contrast-with…), High/Medium/Low priority, suggestions for concepts to create.
4. **Batch Generation Prompt** — *"You are a batch knowledge expansion specialist…"* — complete subtree to a depth within a node budget (`path`-based hierarchical output).

Responses are parsed tolerantly (markdown-fence stripping, trailing-comma repair, balanced-brace extraction) in [`src/parser.ts`](src/parser.ts).

## Scalability design (tens of thousands of nodes)

- **Incremental growth** — one branch per API call; the tree only exists where you've explored it.
- **Lazy loading** — tree models are rebuilt from `metadataCache` frontmatter (no full-file reads); a raw YAML parse is the fallback for notes Obsidian hasn't indexed yet.
- **Virtualized rendering** — fixed 34px rows, windowed DOM (`src/treeView.ts`), ~50 rows in the DOM regardless of tree size.
- **Prompt caching** — keyed `kind|model|prompt`, LRU-capped, persisted in the plugin data file.
- **Background indexing** — `VaultIndexer` subscribes to `metadataCache` `changed`/`deleted`/`resolved` (debounced) and ranks candidate note names by token overlap.
- **Bounded batch concurrency** — 3 parallel expansion requests per level, node budget enforced, progress `done/total` reported to the UI.

## Note format

Every concept is one Markdown note, e.g. `CogniTree/Democracy/Direct Democracy.md`:

```markdown
---
concept: "Direct Democracy"
tree: "Democracy"
parent: "Democracy"
domain: "Political Science"
description: "Citizens vote directly on laws and policies rather than through representatives."
complexity: "Beginner"
can_expand: true
estimated_depth: 4
connections: ["Athenian Democracy", "Referendums", "Citizen Assemblies"]
children: ["Referendums", "Citizen Assemblies"]
path: "/democracy/political_science/direct_democracy"
created: "2025-01-01T00:00:00.000Z"
---

# Direct Democracy
…
## Connections
- [[Athenian Democracy]]
- [[Referendums]]
```

This stays fully Obsidian-native: the graph view, backlinks, and search all work on generated trees.

## Development

```bash
npm install          # dev deps (esbuild, typescript, obsidian types)
npm run dev          # watch mode → main.js
npm run build        # typecheck + production bundle
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| **↑ / ↓** | Move the selection (description preview follows) |
| **→** | Expand the selected node |
| **←** | Collapse the selected node |
| **Enter** | Toggle expand / collapse |
| **Tab** | Focus the tree list (then use the arrows above) |

Click any node once to grab keyboard focus for the list. The toolbar actions (**⚡ Batch**, **♺ Index**) act on the currently selected node.

## Commands

- **Open CogniTree panel**
- **Create concept tree from selection** — uses the current editor selection as the root concept
- **Refresh CogniTree from vault** — reload trees if you edited notes by hand
- **Reindex vault notes** — rebuild the connection index on demand

## License

MIT © 2026 Kerekes Stefan
