import { hashString } from './parser';

/**
 * Spaced repetition for tree nodes — pure logic, no Obsidian imports.
 *
 * Scheduling is SM-2 lite (the algorithm behind classic SRS decks): four
 * grades, an ease factor that drifts with how well the answer was known, and
 * interval steps that follow the SM-2 table (1 day, 6 days, then × ease).
 * Cards and their state live in a hidden per-tree store so they travel with
 * the tree (see `ConceptStore.loadReview` / `saveReview`).
 */

export const REVIEW_DATA_VERSION = 1;
export const DAY_MS = 86_400_000;
/** A failed card comes back in the same session. */
export const RELEARN_MS = 10 * 60_000;
export const MIN_EASE = 1.3;
export const MAX_EASE = 2.8;
export const MAX_INTERVAL_DAYS = 365;
/** Interval at which a card counts as "mature". */
export const MATURE_DAYS = 21;

export type Grade = 'again' | 'hard' | 'good' | 'easy';
export const GRADES: Grade[] = ['again', 'hard', 'good', 'easy'];

export interface ReviewCard {
	id: string;
	/** Tree node this card was generated from (for scoped sessions). */
	node: string;
	question: string;
	answer: string;
	kind: string;
	created: number;
}

export interface ReviewState {
	cardId: string;
	/** Epoch ms when the card is next due. */
	due: number;
	intervalDays: number;
	ease: number;
	reps: number;
	lapses: number;
	lastReviewed?: number;
	/** Index into `GRADES` of the last grade given. */
	lastGrade?: number;
}

export interface ReviewData {
	version: number;
	tree: string;
	cards: Record<string, ReviewCard>;
	states: Record<string, ReviewState>;
}

export interface CardDraft {
	question: string;
	answer: string;
	kind?: string;
}

export function newReviewData(tree: string): ReviewData {
	return { version: REVIEW_DATA_VERSION, tree, cards: {}, states: {} };
}

/** Stable id for a question under a node — re-generating keeps its schedule. */
export function cardIdFor(tree: string, node: string, question: string): string {
	return hashString(`${tree}|${node}|${question.trim().toLowerCase()}`);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Apply one grade and return the updated state.
 * `again` resets the card (reps 0, due in minutes, ease down); `hard`/`good`/
 * `easy` move it along the SM-2 interval steps with an ease adjustment.
 */
export function gradeCard(
	state: ReviewState | undefined,
	grade: Grade,
	cardId: string,
	now: number
): ReviewState {
	const prev: ReviewState = state ?? {
		cardId,
		due: now,
		intervalDays: 0,
		ease: 2.5,
		reps: 0,
		lapses: 0,
	};
	const ease = clamp(prev.ease || 2.5, MIN_EASE, MAX_EASE);

	if (grade === 'again') {
		return {
			cardId,
			due: now + RELEARN_MS,
			intervalDays: 0,
			ease: clamp(ease - 0.2, MIN_EASE, MAX_EASE),
			reps: 0,
			lapses: prev.lapses + 1,
			lastReviewed: now,
			lastGrade: 0,
		};
	}

	// SM-2 quality: hard 3, good 4, easy 5.
	const quality = grade === 'hard' ? 3 : grade === 'good' ? 4 : 5;
	const nextEase = clamp(
		ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)),
		MIN_EASE,
		MAX_EASE
	);
	const reps = prev.reps + 1;
	let interval: number;
	if (reps === 1) interval = 1;
	else if (reps === 2) interval = 6;
	else interval = Math.round(Math.max(1, prev.intervalDays) * nextEase);
	if (grade === 'hard') interval = Math.round(interval * 0.6);
	if (grade === 'easy') interval = Math.round(interval * 1.3);
	interval = clamp(interval, 1, MAX_INTERVAL_DAYS);

	return {
		cardId,
		due: now + interval * DAY_MS,
		intervalDays: interval,
		ease: nextEase,
		reps,
		lapses: prev.lapses,
		lastReviewed: now,
		lastGrade: GRADES.indexOf(grade),
	};
}

/**
 * Cards to study now: overdue first (most overdue first), then never-seen
 * cards in creation order. `scope` limits the session to a set of node names.
 */
export function dueCardIds(
	data: ReviewData,
	now: number,
	limit = Number.POSITIVE_INFINITY,
	scope?: Set<string>
): string[] {
	const overdue: { id: string; due: number }[] = [];
	const fresh: { id: string; created: number }[] = [];
	for (const card of Object.values(data.cards)) {
		if (scope && !scope.has(card.node)) continue;
		const state = data.states[card.id];
		if (!state) fresh.push({ id: card.id, created: card.created });
		else if (state.due <= now) overdue.push({ id: card.id, due: state.due });
	}
	overdue.sort((a, b) => a.due - b.due);
	fresh.sort((a, b) => a.created - b.created);
	return [...overdue, ...fresh].slice(0, limit).map((entry) => entry.id);
}

export interface ReviewStats {
	total: number;
	due: number;
	fresh: number;
	learning: number;
	mature: number;
}

export function reviewStats(data: ReviewData, now: number, scope?: Set<string>): ReviewStats {
	let total = 0;
	let fresh = 0;
	let learning = 0;
	let mature = 0;
	for (const card of Object.values(data.cards)) {
		if (scope && !scope.has(card.node)) continue;
		total++;
		const state = data.states[card.id];
		if (!state) fresh++;
		else if (state.intervalDays >= MATURE_DAYS) mature++;
		else learning++;
	}
	return { total, due: dueCardIds(data, now, Number.POSITIVE_INFINITY, scope).length, fresh, learning, mature };
}

/**
 * Merge freshly generated cards into the store. Ids are derived from the
 * question, so re-running with `refresh` keeps the existing schedule of cards
 * whose wording did not change.
 */
export function addCards(
	data: ReviewData,
	node: string,
	drafts: CardDraft[],
	now: number,
	refresh = false
): { added: number; skipped: number } {
	let added = 0;
	let skipped = 0;
	for (const draft of drafts) {
		const question = String(draft?.question ?? '').trim();
		const answer = String(draft?.answer ?? '').trim();
		if (!question || !answer) continue;
		const id = cardIdFor(data.tree, node, question);
		const existing = data.cards[id];
		if (existing && !refresh) {
			skipped++;
			continue;
		}
		data.cards[id] = {
			id,
			node,
			question,
			answer,
			kind: String(draft.kind ?? 'recall').trim() || 'recall',
			created: existing?.created ?? now,
		};
		added++;
	}
	return { added, skipped };
}

/** Remove a card and its schedule. */
export function removeCard(data: ReviewData, cardId: string): boolean {
	const had = !!data.cards[cardId];
	delete data.cards[cardId];
	delete data.states[cardId];
	return had;
}

/** Human-readable next-due summary for notices. */
export function describeDue(due: number, now: number): string {
	const delta = due - now;
	if (delta <= 0) return 'now';
	const days = delta / DAY_MS;
	if (days < 1) return `in ${Math.max(1, Math.round(delta / 60_000))} min`;
	if (days < 30) return `in ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
	return `in ${Math.round(days / 30)} month(s)`;
}
