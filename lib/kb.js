// lib/kb.js
// Lightweight commonsense knowledge base for dsh-reason-guard.
// Persisted to a local JSON file (default ~/.dsh/plugins/dsh-reason-guard/commonsense_kb.json).
// Loaded lazily on first use (auto-init), re-loaded on every manual update call,
// and editable: import custom rules, add domain facts, delete stale entries.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_KB_PATH = path.join(
	os.homedir(),
	".dsh",
	"plugins",
	"dsh-reason-guard",
	"commonsense_kb.json"
);

// Built-in facts. Each entry: { category, id, rule, note, confidence }
const BUILTIN_FACTS = [
	// physical
	{ category: "physical", id: "water-boiling-100", rule: "纯水在一个标准大气压（101.325 kPa）下沸点为 100°C", note: "海拔越高沸点越低", confidence: "high" },
	{ category: "physical", id: "freeze-0", rule: "纯水在一个标准大气压下冰点为 0°C", note: "", confidence: "high" },
	{ category: "physical", id: "light-speed", rule: "真空光速约为 299,792,458 m/s（约 3×10^8 m/s）", note: "", confidence: "high" },
	{ category: "physical", id: "gravity-g", rule: "地球表面重力加速度约为 9.8 m/s²", note: "", confidence: "high" },
	{ category: "physical", id: "sound-speed", rule: "空气中声速约为 343 m/s（20°C）", note: "", confidence: "high" },
	{ category: "physical", id: "earth-round", rule: "地球是近似球体（椭球）", note: "有明确科学共识，不应被'有观点认为'稀释", confidence: "high" },
	{ category: "physical", id: "earth-round-sun", rule: "地球绕太阳公转，周期约 365.25 天", note: "", confidence: "high" },
	// bio
	{ category: "bio", id: "human-chromosomes", rule: "人类体细胞有 46 条染色体（23 对）", note: "", confidence: "high" },
	{ category: "bio", id: "water-human", rule: "成年人体重中约 55–60% 是水", note: "", confidence: "medium" },
	{ category: "bio", id: "normal-body-temp", rule: "健康成年人正常体温约 36.5–37.5°C", note: "", confidence: "high" },
	{ category: "bio", id: "dna-pairs", rule: "人类基因组的 DNA 碱基对约 31 亿（3.1×10^9）", note: "数量级参考", confidence: "medium" },
	// time
	{ category: "time", id: "year-days", rule: "平年 365 天，闰年 366 天", note: "", confidence: "high" },
	{ category: "time", id: "week-days", rule: "一周有 7 天", note: "", confidence: "high" },
	{ category: "time", id: "minute-seconds", rule: "1 分钟 = 60 秒，1 小时 = 60 分钟", note: "", confidence: "high" },
	{ category: "time", id: "day-hours", rule: "一天有 24 小时", note: "", confidence: "high" },
	// magnitude
	{ category: "magnitude", id: "km-01", rule: "一个普通成年人的步行速度约 4–5 km/h", note: "", confidence: "high" },
	{ category: "magnitude", id: "km-02", rule: "一架民航客机的巡航速度约 800–900 km/h", note: "", confidence: "medium" },
	{ category: "magnitude", id: "earth-radius", rule: "地球平均半径约 6,371 km", note: "", confidence: "high" },
	{ category: "magnitude", id: "earth-circum", rule: "地球赤道周长约 40,075 km", note: "", confidence: "high" },
	{ category: "magnitude", id: "earth-sun-dist", rule: "地球到太阳平均距离约 1.496×10^8 km（1 天文单位）", note: "", confidence: "high" },
	{ category: "magnitude", id: "earth-moon-dist", rule: "地球到月球平均距离约 38.4 万 km", note: "", confidence: "high" },
	{ category: "magnitude", id: "population-earth", rule: "全球人口数量级在 80 亿左右（2020 年代）", note: "只用于数量级判断", confidence: "medium" },
	// life/common
	{ category: "life", id: "strawberry-r", rule: "单词 strawberry 里有 3 个字母 r（位置 3、8、9）", note: "token 切分易错例", confidence: "high" },
	{ category: "life", id: "leap-rule", rule: "普通闰年判定：年份能被 4 整除且不能被 100 整除，或能被 400 整除", note: "", confidence: "high" },
	{ category: "life", id: "weekend", rule: "中国大陆通常周六、周日为周末", note: "", confidence: "medium" }
];

let cache = null;

/** Ensure KB directory + default file exist; return the loaded KB object. */
export function ensureKb(pathOverride) {
	const file = pathOverride || DEFAULT_KB_PATH;
	if (cache) return cache;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
	} catch { /* best effort */ }
	let data = null;
	if (fs.existsSync(file)) {
		try {
			data = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			data = null;
		}
	}
	if (!data || typeof data !== "object" || !Array.isArray(data.facts)) {
		// first-run auto-init: seed with the builtin knowledge base
		data = { version: 1, initializedAt: new Date().toISOString(), facts: [...BUILTIN_FACTS] };
		try {
			fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
		} catch { /* best effort */ }
	}
	cache = data;
	return data;
}

/** Drop the in-memory cache so the next read re-loads from disk. */
export function invalidateKb() {
	cache = null;
}

/** Resolve the persisted KB path given a config (explicit path wins). */
export function resolveKbPath(config) {
	return (config && config.commonsense_kb_path) || DEFAULT_KB_PATH;
}

/**
 * Update the KB:
 *   mode: "import"  (rules: array of {category?, rule, note?, confidence?})  — append non-duplicate
 *         "remove"  (id or rule string)                                       — delete matching
 *         "replace" (id, rule, note?, confidence?)                            — overwrite an entry
 * Returns { file, total, changed } summary.
 */
export function updateKb(pathOverride, mode, input) {
	const file = pathOverride || DEFAULT_KB_PATH;
	const kb = ensureKb(file);
	const facts = kb.facts;
	let changed = 0     | 0;
	if (mode === "import") {
		const list = Array.isArray(input) ? input : input && input.rules ? input.rules : [];
		for (const item of list) {
			const rule = String(item && item.rule || "").trim();
			if (!rule) continue;
			const dup = facts.some((f) => String(f.rule).trim().toLowerCase() === rule.toLowerCase());
			if (dup) continue;
			facts.push({
				category: String(item.category || "custom"),
				id: String(item.id || `custom-${facts.length + 1}`),
				rule,
				note: String(item.note || ""),
				confidence: String(item.confidence || "medium")
			});
			changed += 1;
		}
	} else if (mode === "remove") {
		const target = String(input && (input.id || input.rule) || "").trim();
		if (target) {
			const before = facts.length;
			const filtered = facts.filter((f) => {
				if (f.id === target) return false;
				if (String(f.rule).trim().toLowerCase().includes(target.toLowerCase())) return false;
				return true;
			});
			changed = before - filtered.length;
			kb.facts = filtered;
		}
	} else if (mode === "replace") {
		const id = String(input && input.id || "").trim();
		if (id && String(input.rule).trim()) {
			const idx = facts.findIndex((f) => f.id === id);
			const entry = {
				category: String(input.category || (idx >= 0 ? facts[idx].category : "custom")),
				id,
				rule: String(input.rule).trim(),
				note: String(input.note || ""),
				confidence: String(input.confidence || "medium")
			};
			if (idx >= 0) { facts[idx] = entry; changed = 1; }
			else { facts.push(entry); changed = 1; }
		}
	}
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(kb, null, 2), "utf8");
	} catch { /* best effort */ }
	invalidateKb();
	return { file, total: facts.length, changed };
}

// whitelist/blacklist is applied here (category/id match), so the tool layer can
// pass per-call exemptions without reaching into the KB internals.
export function matchFacts(kb, needle, whitelist, blacklist) {
	const text = String(needle || "").toLowerCase();
	const results = [];
	for (const f of kb.facts || []) {
		const rule = String(f.rule).toLowerCase();
		// blacklist: skip facts whose category/id matches a blocked term
		let skip = false;
		for (const bl of blacklist || []) {
			const pat = String(bl).toLowerCase();
			if (f.category && f.category.toLowerCase().includes(pat)) { skip = true; break; }
			if (f.id && f.id.toLowerCase().includes(pat)) { skip = true; break; }
		}
		if (skip) continue;
		// whitelist: if non-empty, only keep matching categories/ids
		const wl = (whitelist || []).map(String).filter(Boolean);
		if (wl.length) {
			const keep = wl.some((w) => {
				const p = w.toLowerCase();
				return (f.category && f.category.toLowerCase().includes(p)) ||
					(f.id && f.id.toLowerCase().includes(p));
			});
			if (!keep) continue;
		}
		// relevance by token overlap on the needle
		const tokens = text.split(/[\s，。、,，]+/u).filter((t) => t.length >= 2);
		const matched = tokens.some((t) => rule.includes(t)) || rule.includes(text) || text.includes(rule.slice(0, 8));
		if (matched) results.push(f);
	}
	return results;
}