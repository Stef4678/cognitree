/**
 * Shared type definitions for CogniTree.
 */

export type Complexity = 'Beginner' | 'Intermediate' | 'Advanced';

/** One generated child concept (shared by Discovery and Expansion results). */
export interface ChildConcept {
	name: string;
	description: string;
	connections?: string[];
	complexity?: Complexity;
	can_expand?: boolean;
	estimated_depth?: number;
}

export interface DomainGroup {
	name: string;
	description?: string;
	children: ChildConcept[];
}

/** Output of the Discovery prompt (brand-new root concept). */
export interface DiscoveryResult {
	concept: string;
	domains: DomainGroup[];
	total_nodes?: number;
	suggested_starting_branch?: string;
}

/** Output of the Expansion prompt (drill into a child). */
export interface ExpansionResult {
	parent: string;
	child: string;
	domain?: string;
	children: ChildConcept[];
	total_new_nodes?: number;
}

export interface ConnectionSuggestion {
	name: string;
	relationship_type?: string;
	description?: string;
	priority?: 'High' | 'Medium' | 'Low';
}

/** Output of the Connection Discovery prompt. */
export interface ConnectionResult {
	concept: string;
	connections?: ConnectionSuggestion[];
	suggested_connections_to_create?: string[];
}

export interface BatchNode {
	path: string;
	name: string;
	description: string;
	connections?: string[];
}

/** Output of the Batch Generation prompt. */
export interface BatchResult {
	root: string;
	depth: number;
	nodes: BatchNode[];
}

/**
 * A node of the in-memory tree model. Mirrors the frontmatter of one
 * Markdown note in the vault, plus ephemeral UI state.
 */
export interface TreeNode {
	name: string;
	parent: string | null;
	domain?: string;
	description: string;
	complexity: Complexity;
	canExpand: boolean;
	estimatedDepth: number;
	connections: string[];
	children: string[];
	/** Hierarchical slug path, e.g. /democracy/political_science/direct_democracy */
	path: string;
	created: number;
	/** Vault path of the backing note. */
	file: string;
	/** Display name of the tree root this node belongs to. */
	treeRoot: string;
	// --- ephemeral UI state (not persisted) ---
	expanded: boolean;
	loading: boolean;
}

export interface TreeModel {
	root: string;
	/** Vault folder holding this tree's notes, e.g. CogniTree/democracy */
	folder: string;
	nodes: Map<string, TreeNode>;
	updatedAt: number;
}

export interface IndexEntry {
	path: string;
	tags: string[];
}

export interface ProgressInfo {
	done: number;
	total: number;
	label: string;
}

export type ProgressCallback = (info: ProgressInfo) => void;

/** Plugin settings — see README for field semantics. */
export interface PluginSettings {
	// API configuration
	apiKey: string;
	modelEndpoint: string; // e.g. https://api.deepseek.com
	model: string;
	temperature: number;
	streaming: boolean;
	maxTokensPerRequest: number; // default: 4000
	// Generation settings
	maxChildrenPerLevel: number; // default: 7
	maxDepth: number; // default: 10
	maxNodesPerBatch: number; // default: 100
	// UI settings
	autoExpandDepth: number; // default: 1 (only root expanded)
	showComplexity: boolean; // default: true
	virtualizeRendering: boolean; // default: true
	// Performance
	cacheExpiryHours: number; // default: 24
	treeFolder: string; // vault folder that holds generated trees
}

export const DEFAULT_SETTINGS: PluginSettings = {
	apiKey: '',
	modelEndpoint: 'https://api.deepseek.com',
	model: 'deepseek-v4-flash',
	temperature: 0.7,
	streaming: true,
	maxTokensPerRequest: 4000,
	maxChildrenPerLevel: 7,
	maxDepth: 10,
	maxNodesPerBatch: 100,
	autoExpandDepth: 1,
	showComplexity: true,
	virtualizeRendering: true,
	cacheExpiryHours: 24,
	treeFolder: 'CogniTree',
};

/** Curated model suggestions shown in the pickers before the endpoint list loads. */
export const CORE_MODELS: string[] = [
	'deepseek-v4-flash',
	'gpt-4o-mini',
	'gpt-4o',
	'gpt-4.1-mini',
	'qwen2.5:7b',
	'llama3.1:8b',
	'mistral:7b',
];

/** One preset provider (OpenAI-compatible chat endpoints). */
export interface ProviderDef {
	id: string;
	name: string;
	/** Base URL — `/chat/completions` is appended automatically unless it ends with /v1. */
	endpoint: string;
	defaultModel: string;
	/** Curated model ids for this provider (plus anything fetched from GET /models). */
	models: string[];
	/** Local providers (Ollama, LM Studio) don't need an API key. */
	keyRequired?: boolean;
}

export const PROVIDERS: ProviderDef[] = [
	{
		id: 'deepseek',
		name: 'DeepSeek',
		endpoint: 'https://api.deepseek.com',
		defaultModel: 'deepseek-v4-flash',
		models: ['deepseek-v4-flash'],
	},
	{
		id: 'openai',
		name: 'OpenAI',
		endpoint: 'https://api.openai.com/v1',
		defaultModel: 'gpt-4o-mini',
		models: [
			'gpt-4o-mini',
			'gpt-4o',
			'gpt-4.1',
			'gpt-4.1-mini',
			'gpt-4.1-nano',
			'gpt-4-turbo',
			'o3-mini',
		],
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		endpoint: 'https://openrouter.ai/api/v1',
		defaultModel: 'openai/gpt-4o-mini',
		models: [
			'openai/gpt-4o-mini',
			'openai/gpt-4o',
			'anthropic/claude-3.5-sonnet',
			'google/gemini-flash-1.5',
			'meta-llama/llama-3.3-70b-instruct',
		],
	},
	{
		id: 'groq',
		name: 'Groq',
		endpoint: 'https://api.groq.com/openai/v1',
		defaultModel: 'llama-3.3-70b-versatile',
		models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
	},
	{
		id: 'mistral',
		name: 'Mistral',
		endpoint: 'https://api.mistral.ai/v1',
		defaultModel: 'mistral-small-latest',
		models: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'codestral-latest'],
	},
	{
		id: 'xai',
		name: 'xAI (Grok)',
		endpoint: 'https://api.x.ai/v1',
		defaultModel: 'grok-2-latest',
		models: ['grok-2-latest', 'grok-beta'],
	},
	{
		id: 'together',
		name: 'Together AI',
		endpoint: 'https://api.together.xyz/v1',
		defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
		models: [
			'meta-llama/Llama-3.3-70B-Instruct-Turbo',
			'meta-llama/Llama-3.1-8B-Instruct-Turbo',
			'mistralai/Mixtral-8x7B-Instruct-v0.1',
			'Qwen/Qwen2.5-72B-Instruct-Turbo',
		],
	},
	{
		id: 'cerebras',
		name: 'Cerebras',
		endpoint: 'https://api.cerebras.ai/v1',
		defaultModel: 'llama-3.3-70b',
		models: ['llama-3.3-70b', 'llama-3.1-8b'],
	},
	{
		id: 'perplexity',
		name: 'Perplexity',
		endpoint: 'https://api.perplexity.ai',
		defaultModel: 'sonar',
		models: ['sonar', 'sonar-pro', 'sonar-reasoning'],
	},
	{
		id: 'nvidia',
		name: 'NVIDIA NIM',
		endpoint: 'https://integrate.api.nvidia.com/v1',
		defaultModel: 'meta/llama-3.3-70b-instruct',
		models: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1', 'qwen/qwen2.5-72b-instruct'],
	},
	{
		id: 'fireworks',
		name: 'Fireworks AI',
		endpoint: 'https://api.fireworks.ai/inference/v1',
		defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
		models: [
			'accounts/fireworks/models/llama-v3p3-70b-instruct',
			'accounts/fireworks/models/qwen2p5-72b-instruct',
			'accounts/fireworks/models/deepseek-v3',
		],
	},
	{
		id: 'ollama',
		name: 'Ollama (local)',
		endpoint: 'http://localhost:11434/v1',
		defaultModel: 'llama3.2',
		models: ['llama3.2', 'llama3.1', 'qwen2.5', 'mistral', 'deepseek-r1'],
		keyRequired: false,
	},
	{
		id: 'lmstudio',
		name: 'LM Studio (local)',
		endpoint: 'http://localhost:1234/v1',
		defaultModel: 'local-model',
		models: ['local-model'],
		keyRequired: false,
	},
	{
		id: 'siliconflow',
		name: 'SiliconFlow',
		endpoint: 'https://api.siliconflow.cn/v1',
		defaultModel: 'deepseek-ai/DeepSeek-V3',
		models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/GLM-4-9B-Chat'],
	},
	{
		id: 'zhipu',
		name: 'Zhipu GLM',
		endpoint: 'https://open.bigmodel.cn/api/paas/v4',
		defaultModel: 'glm-4-flash',
		models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
	},
	{
		id: 'moonshot',
		name: 'Moonshot (Kimi)',
		endpoint: 'https://api.moonshot.cn/v1',
		defaultModel: 'moonshot-v1-8k',
		models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
	},
	{
		id: 'qwen',
		name: 'Qwen (DashScope)',
		endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		defaultModel: 'qwen-plus',
		models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen2.5-72b-instruct'],
	},
];

/** Normalize a base URL for comparison (strip trailing slash / /chat/completions). */
function normalizeEndpoint(e: string): string {
	return (e || '')
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/chat\/completions$/, '');
}

/** Find the preset provider whose endpoint matches (or null for custom endpoints). */
export function providerFor(endpoint: string): ProviderDef | null {
	const e = normalizeEndpoint(endpoint);
	if (!e) return null;
	return PROVIDERS.find((p) => normalizeEndpoint(p.endpoint) === e) ?? null;
}

/** Curated model list for the current endpoint (provider preset or CORE_MODELS). */
export function curatedModelsFor(endpoint: string): string[] {
	return providerFor(endpoint)?.models ?? CORE_MODELS;
}
