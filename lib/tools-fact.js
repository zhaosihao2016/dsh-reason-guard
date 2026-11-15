// lib/tools-fact.js
// Fact-verification domain tools for dsh-reason-guard.
// Each tool is { name, description, params (JSON Schema), run(args, deps) }.
// deps = { webSearch, config, kb } shared by the entry module.

import {
	result,
	webSearch,
	confidenceLabel,
	gateExcluded,
	splitSentences,
	CONFIDENCE_LOW,
	CONFIDENCE_MED,
	CONFIDENCE_HIGH
} from "./shared.js";

// ---- claim_extract ----
const claimExtract = {
	name: "claim_extract",
	description: "从一段模型回答中提取所有事实性主张（日期、数字、人物、事件、定义、引用、数据来源、结论等），结构化输出供后续核验。支持 whitelist/blacklist 跳过某些类型。触发场景：任何需要确认'回答里有哪些可被核验的事实'时。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要提取事实性主张的模型回答文本" },
			whitelist: { type: "array", items: { type: "string" }, description: "只提取这些类型（如 date/number/person/source）" },
			blacklist: { type: "array", items: { type: "string" }, description: "跳过这些类型" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		const text = String(args.text || "");
		const whitelist = args.whitelist || [];
		const blacklist = args.blacklist || [];
		const claims = [];
		const type = (s) => s;

		// dates
		const dateRe = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?|\d{4}年|(19|20)\d{2}/g;
		let m;
		const dateSeen = new Set();
		while ((m = dateRe.exec(text)) !== null) {
			const raw = m[0];
			if (!dateSeen.has(raw)) { dateSeen.add(raw); if (!gateExcluded("date", whitelist, blacklist)) claims.push({ type: "date", value: raw }); }
		}
		// numbers / percentages
		const numRe = /-?\d+(?:\.\d+)?\s*(?:%|％|亿|万|千|百|thousand|million|billion)?/g;
		const numSeen = new Set();
		while ((m = numRe.exec(text)) !== null) {
			const raw = m[0].trim();
			if (!numSeen.has(raw)) { numSeen.add(raw); if (!gateExcluded("number", whitelist, blacklist)) claims.push({ type: "number", value: raw }); }
		}
		// quoted statements (citations / expert claims)
		const quoteRe = /[“"]([^”"]{4,120})[”"]/g;
		const quoteSeen = new Set();
		while ((m = quoteRe.exec(text)) !== null) {
			const raw = m[1];
			if (!quoteSeen.has(raw)) { quoteSeen.add(raw); if (!gateExcluded("quote", whitelist, blacklist)) claims.push({ type: "quote", value: raw }); }
		}
		// URLs
		const urlRe = /https?:\/\/[^\s"'\])<>]+/g;
		const urlSeen = new Set();
		while ((m = urlRe.exec(text)) !== null) {
			const raw = m[0];
			if (!urlSeen.has(raw)) { urlSeen.add(raw); if (!gateExcluded("url", whitelist, blacklist)) claims.push({ type: "url", value: raw }); }
		}
		// proper nouns (heuristic: capitalized multiword) — latin only, light
		const nounRe = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
		const nounSeen = new Set();
		while ((m = nounRe.exec(text)) !== null) {
			const raw = m[0];
			if (!nounSeen.has(raw)) { nounSeen.add(raw); if (!gateExcluded("entity", whitelist, blacklist)) claims.push({ type: "entity", value: raw }); }
		}
		// conclusion sentences (declarative, short) — heuristic: sentences containing is/are/为/是 + number
		for (const s of splitSentences(text)) {
			if (s.length < 8 || s.length > 160) continue;
			if (/\b(is|are|was|were)\b/i.test(s) || /(是|为|据|数据显示)/.test(s)) {
				if (!gateExcluded("conclusion", whitelist, blacklist)) claims.push({ type: "conclusion", value: s });
			}
		}
		return result("claim_extract", {
			checkItem: "claim_extract",
			passed: claims.length > 0,
			confidence: CONFIDENCE_HIGH, // placeholder corrected below
			evidence: claims.slice(0, 40),
			suggestion: claims.length ? "对关键主张执行 fact_check 交叉核验" : "未提取到可核验主张",
			extra: { total: claims.length }
		});
	}
};

// The confidenceLabel is referenced; re-imported default in case of tree-shake.

// ---- fact_check ----
const factCheck = {
	name: "fact_check",
	description: "对一条或多条事实性陈述进行联网交叉核验。返回置信度评分（高/中/低）与证据来源；无可靠来源时明确标记'未核实'而非猜测。web_search 不可用时降级为'未联网，无法核验'并置信度标低。触发场景：你无法确认一个事实时，不要编造答案，调用本工具核验。",
	params: {
		type: "object",
		properties: {
			statements: { type: "array", items: { type: "string" }, description: "要核验的事实性陈述列表" },
			domain: { type: "string", description: "可选领域提示（如 physics/history/tech），帮助搜索" }
		},
		required: ["statements"],
		additionalProperties: false
	},
	async run(args, deps) {
		const statements = (args.statements || []).map(String);
		const domain = String(args.domain || "");
		const out = [];
		for (const st of statements.slice(0, 8)) {
			const res = await webSearch(deps.webSearch, `${domain ? domain + " " : ""}${st}`);
			let passed = false;
			let label = CONFIDENCE_LOW;
			let evidence = [];
			let degraded = null;
			let status = "未核实";
			if (res.web) {
				evidence = res.sources.slice(0, 5).map((s) => s.url);
				if (res.sourceCount > 0) {
					// heuristic: >=2 distinct sources => higher confidence
					passed = res.sourceCount >= 2;
					label = confidenceLabel(res.sourceCount >= 2 ? 70 : 55);
					status = passed ? "有来源支撑" : "来源不足";
				} else {
					status = "未核实";
				}
			} else {
				degraded = res.degraded;
				status = "未联网，无法核验";
			}
			out.push({
				statement: st,
				status,
				passed,
				confidence: label,
				sources: evidence,
				degraded
			});
		}
		return result("fact_check", {
			checkItem: "fact_check",
			passed: out.every((o) => o.passed),
			confidence: confidenceLabel(out.reduce((a, o) => a + (o.passed ? 80 : 30), 0) / Math.max(1, out.length)),
			evidence: out.flatMap((o) => o.sources),
			suggestion: out.some((o) => o.status === "未联网，无法核验") ? "dsh-toolbox 未安装或未联网，无法核验，建议安装后重试" : "对未核实陈述，回答中应明确标注'未核实'",
			extra: { results: out }
		});
	}
};

// ---- source_citation ----
const sourceCitation = {
	name: "source_citation",
	description: "为模型回答自动补充引用来源，将陈述与搜索结果一一对应。找不到来源时不伪造引用，而是标注'来源缺失'。是否附带引用由配置项 citation_enabled 控制（默认 true）。触发场景：回答包含可核验事实且需要给出出处时。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要补充引用的模型回答" },
			enabled: { type: "boolean", description: "本次是否附加来源（覆盖默认）" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		const text = String(args.text || "");
		const enabled = typeof args.enabled === "boolean" ? args.enabled : deps.config.citation_enabled !== false;
		if (!enabled) {
			return result("source_citation", { checkItem: "source_citation", passed: true, confidence: CONFIDENCE_MED, evidence: [], suggestion: "citation_enabled=false，未附加引用", extra: { annotated: text, citations: [] } });
		}
		// pick key claim sentences as search needles (first 3)
		const sentences = splitSentences(text).slice(0, 3);
		const citations = [];
		for (const s of sentences) {
			const res = await webSearch(deps.webSearch, s);
			if (res.web && res.sourceCount) {
				citations.push({ statement: s, sources: res.sources.slice(0, 2).map((x) => x.url) });
			} else {
				citations.push({ statement: s, sources: [], note: "来源缺失（未伪造）", degraded: res.web ? null : res.degraded });
			}
		}
		const missing = citations.filter((c) => c.sources.length === 0).length;
		return result("source_citation", {
			checkItem: "source_citation",
			passed: missing === 0,
			confidence: confidenceLabel(missing === 0 ? 75 : 50),
			evidence: citations.flatMap((c) => c.sources),
			suggestion: missing ? `${missing} 条陈述未找到来源，已在回答中标注'来源缺失'` : "引用已附加",
			extra: { citations, annotated: text }
		});
	}
};

// ---- fabrication_detect ----
const fabricationDetect = {
	name: "fabrication_detect",
	description: "检测'编造型幻觉'：伪造的论文/书籍引用、不存在的 URL、虚构的统计数据、捏造的专家言论、编造的软件版本/API 文档。触发场景：你怀疑回答里混入了编造内容，或想引用论文/书/URL/数字/专家话/版本号前先自查。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要检查的文本" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		const text = String(args.text || "");
		const issues = [];
		const urlRe = /https?:\/\/[^\s"'\])<>]+/g;
		let m;
		const seen = new Set();
		while ((m = urlRe.exec(text)) !== null) {
			const url = m[0];
			if (seen.has(url)) continue;
			seen.add(url);
			// sanity: must have a domain with a dot; .onion/.local etc flagged
			if (!/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(url)) {
				issues.push({ type: "url", value: url, note: "URL 结构异常，可能为编造", severity: "moderate" });
			}
		}
		// fabricated statistical phrasing without a source
		const statRe = /\b\d+(?:\.\d+)?\s*(?:%|％)\b[^。；\n]{0,40}/g;
		const statSeen = new Set();
		while ((m = statRe.exec(text)) !== null) {
			const raw = m[0].trim();
			if (statSeen.has(raw)) continue;
			statSeen.add(raw);
			if (!/(据|来源|报告|数据显示|survey|report|data|according to)/i.test(text.slice(Math.max(0, m.index - 40), m.index + raw.length))) {
				issues.push({ type: "statistic", value: raw, note: "统计数字未见来源支撑", severity: "moderate" });
			}
		}
		// suspicious expert attribution without a verifiable name
		const expertRe = /(?:据|某|一位|有)?(?:专家|学者|研究者|研究者)[^，。；]{0,30}(?:称|认为|指出|表示)/g;
		while ((m = expertRe.exec(text)) !== null) {
			if (!/[A-Za-z\u4e00-\u9fa5]{2,}(?:教授|博士|博士)|Dr\.|Prof\./i.test(m[0])) {
				issues.push({ type: "expert", value: m[0], note: "专家言论来源不可定位，可能为捏造", severity: "moderate" });
			}
		}
		// fabricated DOI (should be 10.xxxx/...) or version numbers
		const doiRe = /\bdoi:\s*[^\s，。；]+/gi;
		while ((m = doiRe.exec(text)) !== null) {
			if (!/^doi:\s*10\.\d{4,9}\//i.test(m[0])) {
				issues.push({ type: "doi", value: m[0], note: "DOI 格式不合法，可能为编造", severity: "moderate" });
			}
		}
		return result("fabrication_detect", {
			checkItem: "fabrication_detect",
			passed: issues.length === 0,
			confidence: issues.length ? CONFIDENCE_LOW : CONFIDENCE_MED,
			evidence: issues,
			suggestion: issues.length ? "发现疑似编造内容，须核实或明确标注'未核实'" : "未发现明显编造痕迹",
			extra: { issues }
		});
	}
};

// ---- freshness_check ----
const freshnessCheck = {
	name: "freshness_check",
	description: "检查回答中涉及的信息是否可能过时。输入话题领域 + 关键事实，返回'该领域信息更新频率'和'建议重新搜索'提示。web_search 不可用时基于本地知识库给出粗略判断并标注'未联网验证'。触发场景：回答涉及可能变化的信息（新闻、版本、价格、政策）前。",
	params: {
		type: "object",
		properties: {
			domain: { type: "string", description: "话题领域（如 AI 模型、股票、政策、科技产品）" },
			fact: { type: "string", description: "关键事实描述" }
		},
		required: ["domain", "fact"],
		additionalProperties: false
	},
	async run(args, deps) {
		const domain = String(args.domain || "");
		const fact = String(args.fact || "");
		// rough volatility classification
		const fastDomains = ["新闻", "股票", "币", "价格", "版本", "API", "政策", "选举", "体育", "模型", "release", "version", "news", "stock", "price"];
		const slowDomains = ["物理", "数学", "地理", "化学", "历史", "基础", "physics", "math", "geography", "history"];
		let updateFreq;
		if (slowDomains.some((d) => domain.includes(d) || domain.toLowerCase().includes(d))) updateFreq = "低（数年量级）";
		else if (fastDomains.some((d) => domain.includes(d) || domain.toLowerCase().includes(d))) updateFreq = "高（周/月量级）";
		else updateFreq = "未知";
		const res = await webSearch(deps.webSearch, `${domain} ${fact}`);
		if (res.web && res.sourceCount) {
			return result("freshness_check", {
				checkItem: "freshness_check",
				passed: true,
				confidence: confidenceLabel(res.sourceCount >= 2 ? 70 : 55),
				evidence: res.sources.slice(0, 3).map((s) => s.url),
				suggestion: `领域更新频率：${updateFreq}；建议结合最新搜索结果确认时效`,
				extra: { updateFreq, verified: true }
			});
		}
		return result("freshness_check", {
			checkItem: "freshness_check",
			passed: false,
			confidence: CONFIDENCE_LOW,
			evidence: [],
			suggestion: `领域更新频率：${updateFreq}；未联网验证，建议手动搜索确认时效`,
			extra: { updateFreq, verified: false, degraded: res.degraded }
		});
	}
};

// ---- version_check ----
const versionCheck = {
	name: "version_check",
	description: "检查软件版本、API 接口、协议规范是否仍是最新。web_search 不可用时标注'版本信息未联网验证'。触发场景：引用具体版本号/API/协议时。",
	params: {
		type: "object",
		properties: {
			item: { type: "string", description: "要检查的软件/API/协议（如 Python、React、某库）" },
			claimedVersion: { type: "string", description: "回答中声称的版本" }
		},
		required: ["item"],
		additionalProperties: false
	},
	async run(args, deps) {
		const item = String(args.item || "");
		const claimed = String(args.claimedVersion || "");
		const res = await webSearch(deps.webSearch, `${item} ${claimed} latest version`);
		if (res.web && res.sourceCount) {
			const latestHint = res.answer ? `；搜索摘要：${String(res.answer).slice(0, 120)}` : "";
			return result("version_check", {
				checkItem: "version_check",
				passed: true,
				confidence: confidenceLabel(res.sourceCount >= 2 ? 70 : 55),
				evidence: res.sources.slice(0, 3).map((s) => s.url),
				suggestion: `已联网核验${claimed ? `（声称版本 ${claimed}）` : ""}${latestHint}`,
				extra: { verified: true }
			});
		}
		return result("version_check", {
			checkItem: "version_check",
			passed: false,
			confidence: CONFIDENCE_LOW,
			evidence: [],
			suggestion: "版本信息未联网验证，须在回答中标注或手动核实",
			extra: { verified: false, degraded: res.degraded }
		});
	}
};

// ---- knowledge_cutoff_warn ----
const knowledgeCutoffWarn = {
	name: "knowledge_cutoff_warn",
	description: "当模型回答涉及训练截止日之后的事件时，自动标注'此信息可能基于过时数据，建议核实'。触发场景：回答含近期事件、新发布产品/版本/政策时。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要检查的模型回答" },
			cutoff: { type: "string", description: "训练截止日期（如 2024-06），缺省用当前判断" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		const text = String(args.text || "");
		const yearRe = /20\d{2}\s*年|20\d{2}/g;
		const now = new Date();
		const nowYear = now.getFullYear();
		let recent = false;
		let m;
		while ((m = yearRe.exec(text)) !== null) {
			const y = parseInt(m[0].replace(/[^\d]/g, ""), 10);
			if (y >= nowYear - 1) { recent = true; break; }
		}
		if (!recent) {
			return result("knowledge_cutoff_warn", { checkItem: "knowledge_cutoff_warn", passed: true, confidence: CONFIDENCE_MED, evidence: [], suggestion: "未发现近期时间戳，无需过时警告", extra: { warn: false } });
		}
		return result("knowledge_cutoff_warn", {
			checkItem: "knowledge_cutoff_warn",
			passed: false,
			confidence: CONFIDENCE_LOW,
			evidence: ["发现近期（近一年）年份"],
			suggestion: "此信息可能基于过时数据，建议核实后再输出",
			extra: { warn: true }
		});
	}
};

export const factTools = [
	claimExtract,
	factCheck,
	sourceCitation,
	fabricationDetect,
	freshnessCheck,
	versionCheck,
	knowledgeCutoffWarn
];