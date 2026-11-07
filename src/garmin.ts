/**
 * Minimal Garmin Connect Personal API client for Cloudflare Workers.
 *
 * Auth model (from Garmin's docs and their official Python client):
 *   - You hold a long-lived Personal API key (30 days to 1 year).
 *   - POST it to TOKEN_PATH with `Authorization: ApiKey <key>`; the response
 *     body is a raw JWT (text, not JSON), valid for up to 24h.
 *   - Data calls use `Authorization: Bearer <jwt>`. No refresh tokens: just
 *     exchange the key again.
 *
 * The bearer token is cached in isolate memory and in KV, and refreshed when
 * it has less than an hour left (same window Garmin's own client uses).
 */

export const GARMIN_BASE_URL = "https://personal.connectapi.garmin.com";
export const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

const REFRESH_WINDOW_SECONDS = 60 * 60;
/** Past-date responses are cached this long. Garmin data rarely changes once a few days old. */
const RESPONSE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Only cache requests whose dates all end at least this many days ago (covers late syncs). */
const RESPONSE_CACHE_MIN_AGE_DAYS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The subset of KVNamespace we use, so tests can pass a simple fake. */
export interface KVLike {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

export class GarminApiError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "GarminApiError";
		this.status = status;
	}
}

type CachedToken = { token: string; exp: number };

// Isolate-level cache: survives across requests handled by the same isolate.
const memoryCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<CachedToken>>();

/** Test hook: clear module-level caches. */
export function _resetCachesForTests() {
	memoryCache.clear();
	inflight.clear();
}

export interface GarminClientOptions {
	apiKey: string;
	kv: KVLike;
	fetch?: FetchLike;
	now?: () => number; // seconds since epoch
	baseUrl?: string;
	/** Cache responses for requests that only cover settled past dates. */
	cacheResponses?: boolean;
}

export class GarminClient {
	private readonly apiKey: string;
	private readonly kv: KVLike;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private readonly baseUrl: string;
	private readonly cacheResponses: boolean;
	private fingerprintPromise?: Promise<string>;

	constructor(opts: GarminClientOptions) {
		const key = opts.apiKey?.trim();
		if (!key) {
			throw new GarminApiError(
				"GARMIN_API_KEY is not set. Cloud: run npx wrangler secret put GARMIN_API_KEY. Local: set it in your MCP client's config.",
			);
		}
		this.apiKey = key;
		this.kv = opts.kv;
		this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
		this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
		this.baseUrl = (opts.baseUrl ?? GARMIN_BASE_URL).replace(/\/+$/, "");
		this.cacheResponses = opts.cacheResponses ?? false;
	}

	/** True when every date in the request is settled history, so the answer won't change. */
	isCacheable(url: URL): boolean {
		const dates = (url.pathname + url.search).match(/\d{4}-\d{2}-\d{2}/g);
		if (!this.cacheResponses || !dates) return false;
		// A startDate with no endDate (or the reverse) is open-ended: it keeps
		// growing as new data arrives, however old the one date is.
		if (url.searchParams.has("startDate") !== url.searchParams.has("endDate")) return false;
		const cutoff = new Date((this.now() - RESPONSE_CACHE_MIN_AGE_DAYS * 86_400) * 1000).toISOString().slice(0, 10);
		return dates.every((d) => d <= cutoff);
	}

	/** GET a Personal API path and return parsed JSON (or null for empty bodies). */
	async get(
		path: string,
		params?: Record<string, string | number | undefined>,
		opts: { cacheTtl?: number } = {},
	): Promise<unknown> {
		const url = this.buildUrl(path, params);
		const ttl = opts.cacheTtl ?? (this.isCacheable(url) ? RESPONSE_CACHE_TTL_SECONDS : 0);
		const cacheKey = ttl > 0 ? await this.responseKey(url) : undefined;
		if (cacheKey) {
			const hit = await this.kv.get(cacheKey).catch(() => null);
			if (hit !== null) return JSON.parse(hit);
		}

		let token = await this.getToken(false);
		let res = await this.request(url, token);

		if (res.status === 401) {
			// Token revoked or expired early: get a fresh one and retry once.
			// Release the unread body first so the connection isn't held open.
			await res.body?.cancel();
			await this.invalidateToken();
			token = await this.getToken(true);
			res = await this.request(url, token);
		}

		if (!res.ok) {
			const body = (await res.text()).slice(0, 500);
			throw new GarminApiError(describeHttpError(res.status, url.pathname, body), res.status);
		}

		const text = await res.text();
		let data: unknown = null;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				throw new GarminApiError(`Garmin returned non-JSON for ${url.pathname}`);
			}
		}
		if (cacheKey) {
			// Best effort: a failed cache write must never fail the request.
			await this.kv
				.put(cacheKey, JSON.stringify(data), { expirationTtl: Math.max(60, ttl) })
				.catch(() => {});
		}
		return data;
	}

	/** Cache key per API key and URL, so rotating GARMIN_API_KEY starts a fresh cache. */
	private async responseKey(url: URL): Promise<string> {
		const tokenKey = await this.cacheKey();
		const h = await sha256Hex(`${tokenKey}\0${url.pathname}${url.search}`);
		return `garmin:resp:${h.slice(0, 40)}`;
	}

	/** Builds a URL on the Garmin host only. Rejects anything that could escape it. */
	buildUrl(path: string, params?: Record<string, string | number | undefined>): URL {
		if (!/^\/[A-Za-z0-9\-._~/%]*$/.test(path) || path.includes("..") || path.includes("//")) {
			throw new GarminApiError(`Invalid Garmin API path: ${path}`);
		}
		const url = new URL(this.baseUrl + path);
		if (url.origin !== new URL(this.baseUrl).origin) {
			throw new GarminApiError(`Invalid Garmin API path: ${path}`);
		}
		for (const [k, v] of Object.entries(params ?? {})) {
			if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
		}
		return url;
	}

	private async request(url: URL, token: string): Promise<Response> {
		return this.fetchImpl(url.toString(), {
			method: "GET",
			headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}

	// ---- token handling -------------------------------------------------

	private async cacheKey(): Promise<string> {
		// Fingerprint the key so rotating GARMIN_API_KEY never reuses an old token,
		// and the key itself is never written anywhere.
		this.fingerprintPromise ??= sha256Hex(`${this.baseUrl}\0${this.apiKey}`).then(
			(h) => `garmin:token:${h.slice(0, 32)}`,
		);
		return this.fingerprintPromise;
	}

	private fresh(t: CachedToken | undefined | null): t is CachedToken {
		return !!t && t.exp - this.now() > REFRESH_WINDOW_SECONDS;
	}

	async getToken(forceRefresh: boolean): Promise<string> {
		const key = await this.cacheKey();

		if (!forceRefresh) {
			const mem = memoryCache.get(key);
			if (this.fresh(mem)) return mem.token;

			const stored = await this.kv.get(key);
			if (stored) {
				try {
					const parsed = JSON.parse(stored) as CachedToken;
					if (this.fresh(parsed)) {
						memoryCache.set(key, parsed);
						return parsed.token;
					}
				} catch {
					// Corrupt entry: fall through and replace it.
				}
			}
		}

		// Collapse concurrent refreshes into one call to Garmin.
		let pending = inflight.get(key);
		if (!pending) {
			pending = this.exchangeKey(key).finally(() => inflight.delete(key));
			inflight.set(key, pending);
		}
		return (await pending).token;
	}

	private async invalidateToken() {
		const key = await this.cacheKey();
		memoryCache.delete(key);
		await this.kv.delete(key);
	}

	private async exchangeKey(cacheKey: string): Promise<CachedToken> {
		const res = await this.fetchImpl(this.baseUrl + TOKEN_PATH, {
			method: "POST",
			headers: { Accept: "*/*", Authorization: `ApiKey ${this.apiKey}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) {
			const body = (await res.text()).slice(0, 300);
			if (res.status === 401 || res.status === 403) {
				throw new GarminApiError(
					"Garmin rejected the Personal API key (it may have expired or been deleted). " +
						"Create a new key at https://connect.garmin.com/app/settings/personalApiToken " +
						"then update GARMIN_API_KEY. Cloud: run npx wrangler secret put GARMIN_API_KEY. Local: change it in your MCP client's config.",
					res.status,
				);
			}
			throw new GarminApiError(
				`Garmin token exchange failed (HTTP ${res.status}): ${body}`,
				res.status,
			);
		}

		const token = (await res.text()).trim();
		const exp = jwtExpiry(token);
		const entry = { token, exp };

		memoryCache.set(cacheKey, entry);
		// KV TTL must be >= 60s; let the entry vanish at the token's real expiry.
		const ttl = Math.max(60, exp - this.now());
		await this.kv.put(cacheKey, JSON.stringify(entry), { expirationTtl: ttl });
		return entry;
	}
}

/** Reads the `exp` claim of a JWT without verifying it (Garmin verifies it). */
export function jwtExpiry(token: string): number {
	try {
		const payload = token.split(".")[1];
		if (!payload) throw new Error("not a JWT");
		const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
		const exp = Number(json.exp);
		if (!Number.isFinite(exp)) throw new Error("no exp");
		return exp;
	} catch {
		throw new GarminApiError("Garmin's token endpoint did not return a JWT with an exp claim");
	}
}

function describeHttpError(status: number, path: string, body: string): string {
	switch (status) {
		case 401:
		case 403:
			return `Garmin refused access to ${path} (HTTP ${status}), even with a fresh token. The key may lack access to this data, or have been revoked.`;
		case 404:
			return `Garmin returned HTTP 404 for ${path}. If the date or activity ID came from the user or search_activities, there is simply no data for it. Do not retry with other dates or IDs unless the user asks.`;
		case 429:
			return "Garmin rate limit hit (HTTP 429). Wait a minute and try a smaller request.";
		default:
			return `Garmin request to ${path} failed (HTTP ${status})${body ? `: ${body}` : ""}`;
	}
}

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
