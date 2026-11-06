/** Date-range helpers: Garmin caps some range endpoints at 28 or 31 days. */

export function addDays(date: string, n: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
	return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

/** Splits [start, end] (inclusive) into consecutive chunks of at most maxDays. */
export function splitRange(start: string, end: string, maxDays: number): [string, string][] {
	const out: [string, string][] = [];
	for (let s = start; s <= end; s = addDays(s, maxDays)) {
		const e = addDays(s, maxDays - 1);
		out.push([s, e < end ? e : end]);
	}
	return out;
}

/** Runs fn over items with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/**
 * Concatenates chunked responses. Handles bare arrays and the single-array
 * wrappers Garmin uses ({data: [...]}, {hrvSummaries: [...]}).
 */
export function mergeChunks(parts: unknown[]): unknown {
	if (parts.length === 1) return parts[0];
	if (parts.every(Array.isArray)) return (parts as unknown[][]).flat();
	const first = parts.find((p) => p && typeof p === "object") as Record<string, unknown> | undefined;
	const key = first && Object.keys(first).find((k) => Array.isArray(first[k]));
	if (!key) return parts;
	return {
		...first,
		[key]: parts.flatMap((p) => {
			const v = (p as Record<string, unknown> | null)?.[key];
			return Array.isArray(v) ? v : [];
		}),
	};
}
