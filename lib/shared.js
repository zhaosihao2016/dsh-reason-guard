// lib/shared.js
// Shared helpers for dsh-reason-guard: whitelist/blacklist filtering,
// confidence calibration, web_search adapter (with graceful fallback),
// and result-shaping utilities used across every tool module.

export const CONFIDENCE_LOW = "low";
export const CONFIDENCE_MED = "medium";
export const CONFIDENCE_HIGH = "high";

export const DEGRADED_OFFLINE = "offline";
export const DEGRADED_NO_TOOLBOX = "no-toolbox";

/** Pick a high/medium/low label from a 0-100 score. */
export function confidenceLabel(score) {
	if (score >= 80) return CONFIDENCE_HIGH;
	if (score >= 55) return CONFIDENCE_MED;
	return CONFIDENCE_LOW;
}

/**
 * whitelist/blacklist gate.
 * A value is "blocked" (excluded) when it matches a blacklist entry,
 * or when a whitelist is non-empty and the value matches none of it.
 * Lists are arrays of regex strings or plain substrings (matched as case-insensitive includes).
 */
export function gateExcluded(value, whitelist = [], blacklist = []) {
	const text = String(value);
	const inBlack = (blacklist || []).some((p) => matchRule(p, text));
	if (inBlack) return true;
	const wl = whitelist || [];
	if (wl.length === 0) return false; // no whitelist => allow all not blacklisted
	return !wl.some((p) => matchRule(p, text));
}

function matchRule(rule, text) {
	const pat = String(rule);
	try {
		return new RegExp(pat, "i").test(text);
	} catch {
		return text.toLowerCase().includes(pat.toLowerCase());
	}
}

/** Build a JSON string result payload with the common schema fields. */
export function result(check, { checkItem, passed, confidence, evidence, counter, suggestion, degraded, extra = {} } = {}) {
	return JSON.stringify({
		check: check || checkItem,
		passed,
		confidence: confidence ?? CONFIDENCE_MED,
		evidence: evidence ?? [],
		counter: counter ?? null,
		suggestion: suggestion ?? "",
		degraded: degraded ?? null,
		...extra
	}, null, 0);
}

/**
 * A tiny structured search adapter.
 * webSearch is an async function (query) => { ok, sources[], answer? } or null when the
 * dsh-toolbox web_search tool is unavailable. Returns a normalized outcome:
 *   { web:true, sources, answer, sourceCount }
 *   { web:false, degraded: 'no-toolbox'|'offline', reason, sourceCount:0 }
 */
export async function webSearch(adapter, query) {
	if (!adapter || typeof adapter !== "function") {
		return { web: false, degraded: DEGRADED_NO_TOOLBOX, reason: "dsh-toolbox 未安装或 web_search 不可用", sourceCount: 0, sources: [] };
	}
	try {
		const out = await adapter(query);
		if (!out || out.ok === false) {
			return { web: false, degraded: DEGRADED_OFFLINE, reason: "web_search 调用失败（未联网）", sourceCount: 0, sources: [] };
		}
		const sources = (out.sources || []).filter(Boolean);
		return { web: true, degraded: null, sources, answer: out.answer || "", sourceCount: sources.length };
	} catch (err) {
		return { web: false, degraded: DEGRADED_OFFLINE, reason: `web_search 异常: ${err && err.message ? err.message : String(err)}`, sourceCount: 0, sources: [] };
	}
}

/** Shorten a URL/DOI string for display without truncating the useful tail. */
export function shortCite(url, max = 64) {
	const s = String(url);
	return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Clamp a number into a range. */
export function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}

/** Deterministic hash (FNV-1a) used to key a cache of normalized strings. */
export function hashString(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i += 1) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** LRU cache (get refreshes recency; insertion evicts the oldest beyond limit). */
export function makeLru(limit = 256) {
	const map = new Map();
	return {
		get(key) {
			if (!map.has(key)) return undefined;
			const v = map.get(key);
			map.delete(key);
			map.set(key, v);
			return v;
		},
		set(key, val) {
			if (map.has(key)) map.delete(key);
			map.set(key, val);
			if (map.size > limit) {
				const oldest = map.keys().next().value;
				map.delete(oldest);
			}
			return val;
		},
		has(key) {
			return map.has(key);
		},
		size: () => map.size
	};
}

/** Extract all numeric-looking tokens (incl. decimals, negatives, percent, versions) from a string. */
export function numberTokens(text) {
	const re = /-?\d+(?:\.\d+)?/g;
	const out = [];
	let m;
	while ((m = re.exec(text)) !== null) out.push(parseFloat(m[0]));
	return out;
}

/** Split a string into sentences on typical clause boundaries. */
export function splitSentences(text) {
	return String(text || "")
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?。！？])\s+/u)
		.map((s) => s.trim())
		.filter(Boolean);
}