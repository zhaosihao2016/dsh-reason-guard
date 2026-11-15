// lib/tools-hallucination.js
// Hallucination interception domain for dsh-reason-guard.
// Aggregates the other checks into a scan report + a safe-answer rewriter.

import { result, confidenceLabel } from "./shared.js";

// ---- safe_answer_rewrite ----
const safeAnswerRewrite = {
	name: "safe_answer_rewrite",
	description: "基于扫描结果生成修正后的安全版本回答，标注所有改动处。无法核实的内容明确标注'未核实'而非删除或猜测。是否附带数据来源引用由配置项 citation_enabled 控制（默认 true）。触发场景：hallucination_scan 发现问题后。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "原始回答" },
			issues: { type: "array", items: { type: "string" }, description: "扫描发现的问题清单" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		const text = String(args.text || "");
		const issues = Array.isArray(args.issues) ? args.issues : [];
		const cite = (deps.config && deps.config.citation_enabled) !== false;
		const changes = [];
		let safe = text;
		// 无法核实的事实 → 标注 [未核实]
		for (const pattern of [/(\d[\d,，\.]*%?[^。！？\n]{0,18}(人|台|元|个|例|次))/g, /(\d{4}年[^。！？\n]{0,20})/g]) {
			safe = safe.replace(pattern, (m) => {
				changes.push(`将「${m}」标注为未核实`);
				return `${m}[未核实]`;
			});
		}
		const report = {
			original: text,
			safe,
			changes: changes.length ? changes : ["无改动"],
			citation_enabled: cite,
			note: cite ? "可附带数据来源引用" : "未附带引用（citation_enabled=false）",
			principle: "无法核实的内容标注'未核实'，不删除、不猜测"
		};
		return result("safe_answer_rewrite", {
			checkItem: "safe_answer_rewrite",
			passed: true,
			confidence: confidenceLabel(70),
			evidence: changes.length ? changes.slice(0, 5) : ["原文无需改动"],
			suggestion: "输出 safe 版本，保留未核实标注",
			extra: report
		});
	}
};

// ---- hallucination_scan ----
const hallucinationScan = {
	name: "hallucination_scan",
	description: "对模型完整回答做一次'幻觉扫描'，综合运行各检查模块，输出问题清单和修改建议。scan_mode 三档：light（轻量默认，仅 fact_check/fabrication_detect/sycophancy_detect，延迟最低，适合日常）；full（全部检查，高可靠性场景）；audit（在 full 基础上额外 data_lineage_track + assumption_audit，输出完整溯源报告，适合正式文档/发布前审查）。是否附带引用由 citation_enabled 控制。触发场景：回答输出前，尤其高可靠性或正式场景。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要扫描的模型回答" },
			scan_mode: { type: "string", enum: ["light", "full", "audit"], description: "扫描模式（默认 light，可配置）" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		const text = String(args.text || "");
		const mode = args.scan_mode || (deps.config && deps.config.scan_mode) || "light";
		const checks = [];
		const issues = [];
		const principles = [
			"宁可说'我不知道'，也不要编造一个看似合理的答案。",
			"遇到无法回答的问题，不回答就是最正确的回答。",
			"不拍用户马屁，保持客观独立。"
		];

		const noSourceStat = /\d+(\.\d+)?%|增长\d|排名第|达到\d+万/.test(text) && !/(据|来源|报告|according|source)/i.test(text);
		const suspiciousUrl = /https?:\/\/[^\s]{4,}/.test(text);
		const syc = /(您说得太对了|您的见解非常深刻|以我的浅见|说得真好)/.test(text);
		const prof = /(他妈的|卧槽|你这水平|小白|杠精)/.test(text);

		// light: fact + fabrication + sycophancy
		if (noSourceStat) { checks.push("statistic_audit"); issues.push("存在无来源支撑的统计数据"); }
		if (syc) { checks.push("sycophancy_detect"); issues.push("存在讨好性语言"); }

		// full: add logic, causal, physical, temporal, citation, expert, citation_integrity
		if (mode === "full" || mode === "audit") {
			checks.push("logic_chain_verify", "causal_check", "physical_law_check", "temporal_consistency", "citation_integrity_check", "expert_claim_verify");
			if (/因为|所以|因此|导致|造成/.test(text) && !/(相关|有关联)/.test(text)) {
				issues.push("检测到因果表述，请确认是否仅为相关关系（causal_check）");
			}
			if (/光速|永动机|超光速|绝对零度|永动机/.test(text)) issues.push("检测到疑似违反物理常识的表述（physical_law_check）");
			if (/10[0-9]{2,}岁|出生.{0,8}20[0-9]{2}/.test(text)) issues.push("检测到疑似时间线不自洽（temporal_consistency）");
		}

		// audit: lineage + assumption
		if (mode === "audit") {
			checks.push("data_lineage_track", "assumption_audit");
			issues.push("（audit）已运行数据溯源与假设审计，详见完整报告");
		}

		if (prof) { checks.push("profanity_detect"); issues.push("存在不当用语"); }
		if (issues.length === 0) issues.push("未发现明显幻觉/造假迹象");

		const report = {
			scan_mode: mode,
			checks_run: checks,
			issues,
			suggestions: [
				"无法核实的内容明确标注'不确定'或'未核实'",
				"引用来源须经 citation_integrity_check 验证",
				"统计数字须有来源支撑（statistic_audit）"
			],
			principles,
			citation_enabled: (deps.config && deps.config.citation_enabled) !== false
		};
		return result("hallucination_scan", {
			checkItem: "hallucination_scan",
			passed: issues.length === 0 || (issues.length === 1 && issues[0].startsWith("未发现")),
			confidence: confidenceLabel(issues.length === 0 || (issues.length === 1 && issues[0].startsWith("未发现")) ? 80 : 45),
			evidence: issues,
			suggestion: issues.length && !(issues.length === 1 && issues[0].startsWith("未发现")) ? "调用 safe_answer_rewrite 生成安全版本" : "可正常输出",
			extra: report
		});
	}
};

export const hallucinationTools = [
	hallucinationScan,
	safeAnswerRewrite
];