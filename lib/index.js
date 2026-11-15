// lib/index.js
// dsh-reason-guard — a "reasoning & fact-verification" anti-fabrication guard layer.
// Core principle: never fabricate data. When a fact cannot be confirmed, mark it
// "uncertain"/"unverified" instead of inventing numbers, dates, sources, quotes.
// Registers ~40 tools under ctx.tools.register, with a graceful web_search adapter
// that degrades when dsh-toolbox (web_search) is not installed.

import { webSearch } from "./shared.js";
import * as kb from "./kb.js";
import { lightSniff, guardNote } from "./guard.js";

import { factTools } from "./tools-fact.js";
import { citeTools } from "./tools-cite.js";
import { logicTools } from "./tools-logic.js";
import { commonsenseTools } from "./tools-commonsense.js";
import { reasonTools } from "./tools-reason.js";
import { honestyTools } from "./tools-honesty.js";
import { toneTools } from "./tools-tone.js";
import { hallucinationTools } from "./tools-hallucination.js";

export const name = "dsh-reason-guard";
export const inject = ["tools"];

export const Config = null; // optional schemastery config; left null to avoid a hard dep

const DEFAULT_CONFIG = {
	enabled: true,
	guard_enabled: true,   // 自动守门钩子：对每条模型回答做 light 反造假扫描
	scan_mode: "light",
	honesty_threshold: 60,
	play_dumb_level: "light",
	tone_normalize_level: "light",
	citation_enabled: true,
	auto_rewrite: false,
	strict: false,       // strict: 所有检查通过才输出（拦截不达标回答）
	prompt_mode: true,   // prompt: 输出原回答 + 警告标注
	silent: false,       // silent: 仅记录日志，不干扰输出
	whitelist: [],
	blacklist: [],
	commonsense_kb_path: "",
	boundary_rules: [],
	sycophancy_patterns: []
};

const TOOL_MODULES = [
	...factTools,
	...citeTools,
	...logicTools,
	...commonsenseTools,
	...reasonTools,
	...honestyTools,
	...toneTools,
	...hallucinationTools
];

/**
 * Resolve the dsh-toolbox web_search adapter lazily, if the service/tool is present.
 * Returns null when unavailable so webSearch() falls back to offline/local-only.
 */
function resolveWebAdapter(ctx, nameToCheck = "web_search") {
	try {
		const svc = ctx.get ? ctx.get("web_search") : undefined;
		if (svc && typeof svc === "function") return svc;
	} catch { /* not present */ }
	try {
		const tools = ctx.tools;
		if (tools && typeof tools.get === "function") {
			const t = tools.get(nameToCheck);
			if (t && typeof t.execute === "function") {
				return (query) => t.execute({ query }).then((res) => {
					const text = typeof res === "string" ? res : JSON.stringify(res);
					return { ok: true, sources: [{ title: "web_search", url: text }], answer: text };
				});
			}
		}
	} catch { /* not present */ }
	return null;
}

export function apply(ctx, config = {}) {
	const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
	const kbPath = cfg.commonsense_kb_path || kb.resolveKbPath(cfg);

	// First-call auto-init of the commonsense KB (idempotent).
	try {
		kb.ensureKb(kbPath);
	} catch { /* best effort */ }

	const web = resolveWebAdapter(ctx, "web_search");
	const deps = {
		webSearch: (query) => webSearch(web, query),
		config: cfg,
		// flat kb accessors — used by tools-commonsense.js (deps.resolveKbPath / deps.ensureKb / deps.updateKb / deps.matchFacts)
		resolveKbPath: (c) => kb.resolveKbPath(c || cfg),
		ensureKb: (p) => kb.ensureKb(p || kbPath),
		invalidateKb: kb.invalidateKb,
		updateKb: (mode, input) => kb.updateKb(kbPath, mode, input),
		matchFacts: (needle, wl, bl) => kb.matchFacts(kb.ensureKb(kbPath), needle, wl, bl),
		kb: {
			ensureKb: (p) => kb.ensureKb(p || kbPath),
			invalidateKb: kb.invalidateKb,
			updateKb: (mode, input) => kb.updateKb(kbPath, mode, input),
			matchFacts: (needle, wl, bl) => kb.matchFacts(kb.ensureKb(kbPath), needle, wl, bl),
			path: kbPath
		}
	};

	const disposers = [];

	// ---- Automatic guard hook: wrap llm/stream so each model answer gets a
	// cheap anti-fabrication sniff before it reaches the user. Chunks pass
	// through untouched (zero added latency to the model's own text); a short
	// warning note is appended only when a fabrication marker is found.
	if (cfg.guard_enabled && typeof ctx.on === "function") {
		try {
			const off = ctx.on("llm/stream", async function* (options, next) {
				const inner = next();
				// Only guard process-local agent-loop requests (carry a sessionId);
				// leave hand-built / non-agent streams alone.
				const isAgentRequest = Boolean(options && options.sessionId);
				let collected = "";
				let sawText = false;
				let tailIndex = 0;
				try {
					for await (const chunk of inner) {
						if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") {
							sawText = true;
							tailIndex = typeof chunk.index === "number" ? chunk.index : tailIndex;
							collected += chunk.text;
						}
						yield chunk;
					}
				} catch (err) {
					// Never let the guard break streaming — log and rethrow the original.
					ctx.logger && ctx.logger.warn(`[dsh-reason-guard] llm/stream 透传异常: ${err && err.message ? err.message : String(err)}`);
					throw err;
				}
				// Only append when: it was an agent answer with real text, not silent mode,
				// and the sniff actually flagged something.
				if (!isAgentRequest || !sawText || cfg.silent) return;
				let sniff;
				try {
					sniff = lightSniff(collected);
				} catch (err) {
					ctx.logger && ctx.logger.warn(`[dsh-reason-guard] 扫描异常: ${err && err.message ? err.message : String(err)}`);
					return;
				}
				if (!sniff.flagged) return;
				const mode = cfg.strict ? "strict" : (cfg.prompt_mode ? "prompt" : "silent");
				if (mode === "silent") {
					ctx.logger && ctx.logger.info(`[dsh-reason-guard] 检出未核实内容(silent): ${sniff.flags.join("；")}`);
					return;
				}
				const note = guardNote(sniff.flags, mode);
				ctx.logger && ctx.logger.info(`[dsh-reason-guard] 回答追加反造假标注: ${sniff.flags.join("；")}`);
				yield { type: "text-delta", index: tailIndex, text: note };
			});
			if (typeof off === "function") disposers.push(off);
		} catch (err) {
			ctx.logger && ctx.logger.warn(`[dsh-reason-guard] 注册 llm/stream 守门钩子失败: ${err && err.message ? err.message : String(err)}`);
		}
	}

	for (const tool of TOOL_MODULES) {
		if (!tool || !tool.name || !tool.run) continue;
		const def = {
			name: tool.name,
			description: tool.description,
			parameters: tool.params || { type: "object", properties: {}, additionalProperties: false },
			output: {
				schema: { type: "object", additionalProperties: true },
				render: (_args, value) => [{ type: "text", text: String(value) }]
			},
			execute: async (args) => {
				if (!cfg.enabled) return { disabled: true, check: tool.name };
				return tool.run(args || {}, deps);
			}
		};
		try {
			ctx.tools.register(def);
			disposers.push(() => { try { ctx.tools.unregister(tool.name); } catch { /* noop */ } });
		} catch (err) {
			ctx.logger && ctx.logger.warn(`[dsh-reason-guard] 注册工具 ${tool.name} 失败: ${err && err.message ? err.message : err}`);
		}
	}

	const dispose = () => { for (const d of disposers) { try { d(); } catch { /* noop */ } } };
	return dispose;
}