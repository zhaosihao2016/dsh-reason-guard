// lib/tools-cite.js
// Citation-integrity & data-lineage domain tools for dsh-reason-guard.
// Each tool is { name, description, params, run(args, deps) }.

import { result, webSearch, confidenceLabel, CONFIDENCE_MED } from "./shared.js";

// ---- citation_integrity_check ----
const citationIntegrityCheck = {
	name: "citation_integrity_check",
	description: "检查引用是否真实存在——验证论文 DOI、URL 可访问性、书籍 ISBN、新闻来源真实性。杜绝伪造引用。web_search 不可用时仅做格式校验并标注'未联网验证URL有效性'。触发场景：你引用一篇论文、一本书、一个 URL 之前，必须调用本工具验证其真实存在，不要伪造引用。",
	params: {
		type: "object",
		properties: {
			citations: { type: "array", items: { type: "string" }, description: "引用的 DOI/URL/ISBN 列表" },
			kind: { type: "string", enum: ["auto", "doi", "url", "isbn"], description: "引用类型（缺省 auto 自动识别）" }
		},
		required: ["citations"],
		additionalProperties: false
	},
	async run(args, deps) {
		const citations = (args.citations || []).map(String);
		const out = [];
		for (const c of citations.slice(0, 10)) {
			const trimmed = c.trim();
			let kind = String(args.kind || "auto");
			if (kind === "auto") {
				if (/^10\.\d{4,9}\//.test(trimmed)) kind = "doi";
				else if (/^https?:\/\//i.test(trimmed)) kind = "url";
				else if (/^(?:97[89])?\d{9}[\dX]$/i.test(trimmed.replace(/-/g, ""))) kind = "isbn";
				else kind = "unknown";
			}
			let formatOk = true;
			if (kind === "doi") formatOk = /^10\.\d{4,9}\/[^\s]+$/i.test(trimmed);
			else if (kind === "url") formatOk = /^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(trimmed);
			else if (kind === "isbn") formatOk = /^(?:97[89])?\d{9}[\dX]$/i.test(trimmed.replace(/-/g, ""));
			let status = formatOk ? "格式通过" : "格式不合法";
			let verified = false;
			let degraded = null;
			if (formatOk) {
				const res = await webSearch(deps.webSearch, kind === "isbn" ? `ISBN ${trimmed}` : trimmed);
				if (res.web) {
					verified = res.sourceCount > 0;
					status = verified ? "有来源佐证" : "未检索到，无法确认真实存在";
					degraded = null;
				} else {
					degraded = res.degraded;
					status = "格式通过；未联网验证有效性";
				}
			}
			out.push({ citation: trimmed, kind, formatOk, verified, status, degraded });
		}
		const allOk = out.every((o) => o.formatOk && o.verified);
		return result("citation_integrity_check", {
			checkItem: "citation_integrity_check",
			passed: allOk,
			confidence: allOk ? CONFIDENCE_MED : confidenceLabel(out.filter((o) => o.verified).length / Math.max(1, out.length) * 70),
			evidence: out.map((o) => `${o.citation} → ${o.status}`),
			suggestion: allOk ? "引用通过核验" : "存在未通过或未联网验证的引用，不得作为事实出处输出，须标注'来源缺失'或删除",
			extra: { results: out }
		});
	}
};

// ---- statistic_audit ----
const statisticAudit = {
	name: "statistic_audit",
	description: "检查统计数据是否有来源支撑，防止凭空编造百分比、增长率、排名等数字。触发场景：你想给出一个统计数据时，调用本工具确认来源，不要凭空编造数字。",
	params: {
		type: "object",
		properties: {
			statements: { type: "array", items: { type: "string" }, description: "含统计数字的陈述列表（如 '市占率 45%'）" }
		},
		required: ["statements"],
		additionalProperties: false
	},
	async run(args, deps) {
		const statements = (args.statements || []).map(String);
		const out = [];
		for (const st of statements.slice(0, 8)) {
			// look for a number in the statement
			const numRe = /-?\d+(?:\.\d+)?\s*(?:%|％|亿|万|thousand|million|billion)?/;
			const num = numRe.exec(st);
			let hasSource = /(据|来源|报告|数据显示|根据|survey|report|according to|source)/i.test(st);
			if (num) {
				const res = await webSearch(deps.webSearch, st);
				hasSource = hasSource || (res.web && res.sourceCount > 0);
				out.push({
					statement: st,
					number: num[0],
					hasSource,
					verified: res.web && res.sourceCount > 0,
					degraded: res.web ? null : res.degraded,
					note: hasSource ? "有来源支撑" : "无来源支撑，可能为编造"
				});
			} else {
				out.push({ statement: st, number: null, hasSource, verified: false, degraded: null, note: "未含可审计的数字" });
			}
		}
		const fabricated = out.filter((o) => o.number && !o.hasSource);
		return result("statistic_audit", {
			checkItem: "statistic_audit",
			passed: fabricated.length === 0,
			confidence: confidenceLabel(fabricated.length === 0 ? 70 : 35),
			evidence: out.map((o) => o.note),
			suggestion: fabricated.length ? `${fabricated.length} 个统计数字无来源支撑，须核实或标注'未核实'` : "统计数字均有来源支撑",
			extra: { results: out }
		});
	}
};

// ---- expert_claim_verify ----
const expertClaimVerify = {
	name: "expert_claim_verify",
	description: "验证'某专家说'类陈述的真实性，防止编造专家言论。触发场景：你要引用某位专家/学者的观点之前。",
	params: {
		type: "object",
		properties: {
			expertName: { type: "string", description: "专家/学者/机构的名称" },
			claim: { type: "string", description: "被归于该专家的言论或观点" }
		},
		required: ["expertName", "claim"],
		additionalProperties: false
	},
	async run(args, deps) {
		const expert = String(args.expertName || "").trim();
		const claim = String(args.claim || "").trim();
		if (!expert) {
			return result("expert_claim_verify", { checkItem: "expert_claim_verify", passed: false, confidence: "low", evidence: [], suggestion: "未提供可定位的专家姓名，不可声称是某专家言论", extra: { verified: false } });
		}
		const res = await webSearch(deps.webSearch, `"${expert}" ${claim}`);
		if (res.web && res.sourceCount) {
			return result("expert_claim_verify", {
				checkItem: "expert_claim_verify",
				passed: res.sourceCount >= 2,
				confidence: confidenceLabel(res.sourceCount >= 2 ? 70 : 50),
				evidence: res.sources.slice(0, 4).map((s) => s.url),
				suggestion: res.sourceCount >= 2 ? "专家言论有来源佐证" : "来源不足，须谨慎，最好标注'未核实'",
				extra: { verified: res.sourceCount > 0 }
			});
		}
		return result("expert_claim_verify", {
			checkItem: "expert_claim_verify",
			passed: false,
			confidence: "low",
			evidence: [],
			suggestion: "未联网验证或未检索到该专家言论，不得当作确凿引用，标注'未核实'",
			extra: { verified: false, degraded: res.degraded }
		});
	}
};

// ---- data_lineage_track ----
const dataLineageTrack = {
	name: "data_lineage_track",
	description: "追踪回答中每个数据的来源链路，确保每个数字/事实都能追溯到可靠源头。触发场景：正式文档/发布前审查（配合 hallucination_scan 的 audit 模式）。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要追踪来源链路的回答文本" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		const text = String(args.text || "");
		const claims = [];
		const numRe = /-?\d+(?:\.\d+)?\s*(?:%|％|亿|万|million|billion)?/g;
		let m;
		const seen = new Set();
		while ((m = numRe.exec(text)) !== null) {
			const raw = m[0].trim();
			if (seen.has(raw)) continue;
			seen.add(raw);
			// find the enclosing sentence
			const before = text.slice(Math.max(0, m.index - 60), m.index);
			const after = text.slice(m.index, Math.min(text.length, m.index + 40));
			const ctx = (before + after).replace(/\s+/g, " ").trim().slice(-80);
			const hasSrc = /(据|来源|报告|数据显示|根据|according to|source|report)/i.test(before);
			claims.push({ value: raw, hasSource: hasSrc, context: ctx });
		}
		// only report a sample
		const noSource = claims.filter((c) => !c.hasSource);
		const ok = noSource.length === 0;
		return result("data_lineage_track", {
			checkItem: "data_lineage_track",
			passed: ok,
			confidence: confidenceLabel(ok ? 70 : 40),
			evidence: claims.slice(0, 10).map((c) => `${c.value}${c.hasSource ? " ✓有源" : " ✗无源"}`),
			suggestion: ok ? "数据均有来源链路" : `${noSource.length} 个数字无来源链路，须补来源或标注'未核实'`,
			extra: { claims: claims.slice(0, 10), missing: noSource.length }
		});
	}
};

export const citeTools = [
	citationIntegrityCheck,
	statisticAudit,
	expertClaimVerify,
	dataLineageTrack
];