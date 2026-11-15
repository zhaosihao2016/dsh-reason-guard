// lib/tools-commonsense.js
// Commonsense & quantity-domain tools for dsh-reason-guard.
// Each tool is { name, description, params, run(args, deps) }.
// deps.kb exposes ensureKb / matchFacts / updateKb / resolveKbPath.

import { result, confidenceLabel, CONFIDENCE_MED } from "./shared.js";

// ---- commonsense_kb_init ----
const commonsenseKbInit = {
	name: "commonsense_kb_init",
	description: "常识库初始化工具。插件首次被调用时自动触发，加载内置的轻量常识知识库（覆盖物理、生物、时间、数量级、生活常识等常见领域）。之后可手动调用本工具更新/扩展常识库，支持导入自定义规则、添加领域特定常识、删除过时条目。常识库以本地 JSON 文件持久化存储，重启后不丢失。",
	params: {
		type: "object",
		properties: {
			mode: { type: "string", enum: ["init", "import", "remove", "replace"], description: "操作：init=初始化/查看，import=导入规则，remove=删除，replace=替换" },
			rules: { type: "array", items: { type: "object" }, description: "import 时：要导入的规则数组 {category?, rule, note?, confidence?}" },
			id: { type: "string", description: "remove/replace 时：条目 id" },
			rule: { type: "string", description: "replace 时：新规则文本" }
		},
		additionalProperties: false
	},
	async run(args, deps) {
		const mode = String(args.mode || "init");
		const path = deps.resolveKbPath(deps.config);
		let summary;
		if (mode === "init") {
			const kb = deps.ensureKb(path);
			summary = { file: path, total: (kb.facts || []).length, initialized: true };
			return result("commonsense_kb_init", {
				checkItem: "commonsense_kb_init",
				passed: true,
				confidence: CONFIDENCE_MED,
				evidence: [`常识库已就绪：${summary.total} 条`],
				suggestion: "可手动调用更新（import/remove/replace）扩展常识库",
				extra: summary
			});
		}
		const input = { id: args.id, rule: args.rule, rules: args.rules };
		const r = deps.updateKb(path, mode, input);
		return result("commonsense_kb_init", {
			checkItem: "commonsense_kb_init",
			passed: r.changed > 0 || mode === "remove",
			confidence: CONFIDENCE_MED,
			evidence: [`操作 ${mode}：变更 ${r.changed} 条，当前共 ${r.total} 条`],
			suggestion: `常识库已更新并持久化到 ${r.file}`,
			extra: r
		});
	}
};

// ---- commonsense_check ----
const commonsenseCheck = {
	name: "commonsense_check",
	description: "对陈述进行常识一致性检查。基于常识知识库 + 规则引擎。支持 whitelist 配置，用户可添加豁免规则（如特定领域/特定数值范围不触发检查），防止误判。触发场景：回答含常识性判断、物理/生物/时间等常见常识时。",
	params: {
		type: "object",
		properties: {
			statement: { type: "string", description: "要检查的陈述" },
			whitelist: { type: "array", items: { type: "string" }, description: "豁免的领域/条目" },
			blacklist: { type: "array", items: { type: "string" }, description: "强制触发的领域/条目" }
		},
		required: ["statement"],
		additionalProperties: false
	},
	async run(args, deps) {
		const st = String(args.statement || "");
		const path = deps.resolveKbPath(deps.config);
		const kb = deps.ensureKb(path);
		const hits = deps.matchFacts(kb, st, args.whitelist || deps.config.commonsense_whitelist, args.blacklist || deps.config.commonsense_blacklist);
		const passed = hits.length === 0;
		return result("commonsense_check", {
			checkItem: "commonsense_check",
			passed,
			confidence: confidenceLabel(passed ? 70 : 40),
			evidence: hits.map((h) => `「${h.rule}」${h.note ? "（" + h.note + "）" : ""}`),
			suggestion: passed ? "未与常识库冲突" : "与常识库冲突，须核实或标注'未核实'",
			extra: { hits: hits.slice(0, 6) }
		});
	}
};

// ---- physical_law_check ----
const physicalLawCheck = {
	name: "physical_law_check",
	description: "检查是否违反基本物理/生物/化学常识。触发场景：回答含物理现象、生物特性、化学反应、自然规律等表述时。",
	params: {
		type: "object",
		properties: {
			statement: { type: "string", description: "要检查的陈述" }
		},
		required: ["statement"],
		additionalProperties: false
	},
	async run(args) {
		const st = String(args.statement || "");
		const violations = [];
		// light-speed / over-unity / impossible-numbers checks
		if (/(超过光速|超光速|比光还快|faster than light|超音速.*倍|光速.*倍)/i.test(st)) {
			violations.push({ note: "任何物体不能超过真空光速（狭义相对论）", severity: "severe" });
		}
		if (/(永动机|永久运动|perpetual motion|能源凭空产生|能量凭空)/i.test(st)) {
			violations.push({ note: "第一类永动机违反能量守恒定律", severity: "severe" });
		}
		if (/(低于绝对零度|负.*开尔文|below absolute zero|绝对零度以下)/i.test(st)) {
			violations.push({ note: "温度不能低于绝对零度（0K）", severity: "severe" });
		}
		if (/(质量.*消失|凭空消失|凭空出现|无中生有|能量.*消失)/i.test(st)) {
			violations.push({ note: "质量/能量不守恒表述可疑", severity: "moderate" });
		}
		const passed = violations.length === 0;
		return result("physical_law_check", {
			checkItem: "physical_law_check",
			passed,
			confidence: confidenceLabel(passed ? 75 : 30),
			evidence: violations.map((v) => v.note),
			suggestion: violations.length ? "涉嫌违反基本自然规律，须改正或标注'未核实'" : "未违反基本物理/生物/化学常识",
			extra: { violations }
		});
	}
};

// ---- temporal_consistency ----
const temporalConsistency = {
	name: "temporal_consistency",
	description: "检查时间线是否自洽（事件先后、日期对应、周期一致性）。触发场景：回答包含多个时间点/历史事件/人物生卒年时。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "含时间信息的文本" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args) {
		const text = String(args.text || "");
		const issues = [];
		const yearRe = /(?:(\d{4})年?.*?(?:出生|卒|去世|逝世|建立|创立|成立于|成立))|(?:(\d{4})年?[-—到~至](\d{4})年?)/g;
		let m;
		while ((m = yearRe.exec(text)) !== null) {
			// born/death or range
			const born = m[1] ? parseInt(m[1], 10) : null;
			if (born) {
				const death = /(?:卒|去世|逝世|died|death)\s*[于在]?\s*(\d{4})/.exec(text.slice(m.index));
				if (death && parseInt(death[1], 10) < born) {
					issues.push(`人物死亡年份（${death[1]}）早于出生年份（${born}），时间线矛盾`);
				}
			}
			const r1 = m[2] ? parseInt(m[2], 10) : null;
			const r2 = m[3] ? parseInt(m[3], 10) : null;
			if (r1 && r2 && r1 > r2) {
				issues.push(`时间范围起点（${r1}）晚于终点（${r2}），前后颠倒`);
			}
		}
		const passed = issues.length === 0;
		return result("temporal_consistency", {
			checkItem: "temporal_consistency",
			passed,
			confidence: confidenceLabel(passed ? 70 : 35),
			evidence: issues,
			suggestion: issues.length ? "时间线存在矛盾，须修正" : "时间线自洽",
			extra: { issues }
		});
	}
};

// ---- magnitude_check ----
const magnitudeCheck = {
	name: "magnitude_check",
	description: "数量级合理性检查，防止编造离谱数字。支持 whitelist/blacklist，用户可自定义合理范围（如'某小众软件日活'不触发拦截）。触发场景：回答含人数、距离、速度、百分比、规模等数字时。",
	params: {
		type: "object",
		properties: {
			statement: { type: "string", description: "含数字的陈述" },
			whitelist: { type: "array", items: { type: "string" }, description: "豁免的领域关键词" },
			blacklist: { type: "array", items: { type: "string" }, description: "强制检查的领域关键词" },
			ranges: { type: "array", items: { type: "object" }, description: "自定义范围 [{unit?, min, max, note?}]" }
		},
		required: ["statement"],
		additionalProperties: false
	},
	async run(args, deps) {
		const st = String(args.statement || "");
		const wl = args.whitelist || deps.config.magnitude_whitelist || [];
		const bl = args.blacklist || deps.config.magnitude_blacklist || [];
		const customRanges = args.ranges || deps.config.magnitude_ranges || [];
		const issues = [];
		const numRe = /(-?\d+(?:\.\d+)?)\s*(万人|亿人|万人|公里|km|米|m|%|％|万|亿|万|million|billion)?/g;
		let m;
		while ((m = numRe.exec(st)) !== null) {
			const val = parseFloat(m[1]);
			const unit = (m[2] || "").toLowerCase();
			const subject = st.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
			// whitelist exemption: subject mentions a whitelisted domain
			if (wl.some((w) => subject.includes(String(w).toLowerCase()))) continue;
			// custom range check
			let customHit = null;
			for (const r of customRanges) {
				if (r && typeof r.min === "number" && typeof r.max === "number" && val >= r.min && val <= r.max) { customHit = r; break; }
			}
			if (customHit) continue;
			// builtin sanity
			if (/万人|亿人|million|billion/.test(unit) || /人|人口|用户|population|users|people/.test(subject)) {
				if (val > 9e9) issues.push(`人口/用户规模 ${m[0]} 超过地球人口数量级（约 80 亿），可疑`);
				if (val > 0 && val < 1) issues.push(`人数 ${m[0]} 小于 1，可疑`);
			}
			if (/%|％/.test(unit)) {
				if (val < 0 || val > 100) issues.push(`百分比 ${m[0]} 超出 0–100 范围`);
			}
			if (/km|公里/.test(unit)) {
				if (val > 4e8) issues.push(`距离 ${m[0]} 远超日地距离（约 1.5 亿 km），可疑`);
			}
			if (/米|m\b/.test(unit) && !/km|公里/.test(unit)) {
				if (val > 4e8) issues.push(`距离 ${m[0]} 数量级异常（超过 4 亿米）`);
			}
		}
		const passed = issues.length === 0;
		return result("magnitude_check", {
			checkItem: "magnitude_check",
			passed,
			confidence: confidenceLabel(passed ? 70 : 35),
			evidence: issues,
			suggestion: issues.length ? "存在数量级可疑的数字，须核实或标注'未核实'" : "数量级合理",
			extra: { issues }
		});
	}
};

export const commonsenseTools = [
	commonsenseKbInit,
	commonsenseCheck,
	physicalLawCheck,
	temporalConsistency,
	magnitudeCheck
];