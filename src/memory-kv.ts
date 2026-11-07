import type { KVLike } from "./garmin.ts";

type Entry = { value: string; expiresAt?: number };

/**
 * In-memory stand-in for Workers KV, used by the local stdio server. Contents
 * last only as long as the process. Honours `expirationTtl` (seconds).
 */
export class MemoryKV implements KVLike {
	private readonly store = new Map<string, Entry>();
	private readonly now: () => number;

	/** @param now seconds since epoch; injectable for tests. */
	constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
		this.now = now;
	}

	async get(key: string): Promise<string | null> {
		const entry = this.store.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
			this.store.delete(key);
			return null;
		}
		return entry.value;
	}

	async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
		this.sweep();
		const ttl = options?.expirationTtl;
		this.store.set(key, { value, expiresAt: ttl === undefined ? undefined : this.now() + ttl });
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	/** Drop expired entries so a long-running process doesn't hold stale responses. */
	private sweep(): void {
		const now = this.now();
		for (const [key, entry] of this.store) {
			if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.store.delete(key);
		}
	}
}
