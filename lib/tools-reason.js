// lib/tools-reason.js
// Reasoning-enhancement domain tools for dsh-reason-guard.
// Each tool is { name, description, params, run(args, deps) }.

import { result, confidenceLabel, CONFIDENCE_MED } from "./shared.js";

// ---- cot_scaffold ----
const cotScaffold = {
	name: "cot_scaffold",
	description: "为复杂问题生成思维链框架（分解问题 → 列出已知 → 逐步推导 → 得出结论），引导模型按结构推理。触发场景：遇到需要多步推理的复杂问题时。",
	params: {
		type: "object",
		properties: {
			problem: { type: "string", description: "要解决的复杂问题" }
		},
		required: ["problem"],
		additionalProperties: false
	},
	async run(args) {
		const problem = String(args.problem || "");
		const scaffold = {
			problem,
			framing: "【分解问题】将主问题拆成若干子问题",
			known: "【列出已知】明确题设、给定条件、可用的约束",
			derive: "【逐步推导】每步标注依据，避免跳跃",
			conclude: "【得出结论】检查结论是否覆盖全部子问题、是否有未言明假设"
		};
		return result("cot_scaffold", {
			checkItem: "cot_scaffold",
			passed: true,
			confidence: CONFIDENCE_MED,
			evidence: Object.values(scaffold),
			suggestion: "按此框架组织推理，并在结论前用 confidence_calibrate 评估确定性",
			extra: scaffold
		});
	}
};

// ---- alternative_hypothesis ----
const alternativeHypothesis = {
	name: "alternative_hypothesis",
	description: "对给定结论生成 2-3 个替代解释/反例，帮助模型反思。触发场景：结论较笃定、或需要检验是否有其他可能解释时。",
	params: {
		type: "object",
		properties: {
			conclusion: { type: "string", description: "当前结论" },
			context: { type: "string", description: "可选：相关背景/前提" }
		},
		required: ["conclusion"],
		additionalProperties: false
	},
	async run(args) {
		const conclusion = String(args.conclusion || "");
		const context = String(args.context || "");
		const alternatives = [
			`反例：是否存在一个反例，使「${conclusion}」不成立？`,
			`替代解释：在给定前提${context ? `（${context}）` : ""}下，是否有另一种同样可能、但指向不同结论的解释？`,
			`隐含假设：该结论依赖了哪个未被证实的假设？若该假设为假，结论是否仍成立？`
		];
		return result("alternative_hypothesis", {
			checkItem: "alternative_hypothesis",
			passed: true,
			confidence: CONFIDENCE_MED,
			evidence: alternatives,
			suggestion: "若无法排除替代解释，应降低确定性或用'可能/有观点认为'表述",
			extra: { alternatives }
		});
	}
};

// ---- confidence_calibrate ----
const confidenceCalibrate = {
	name: "confidence_calibrate",
	description: "根据证据充分性、逻辑完整性、来源可靠性，对模型回答给出置信度评分（0-100）。置信度低时强制标注'不确定'。触发场景：回答完成后、或输出前评估自身确定性。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要评估的模型回答" },
			hasSources: { type: "boolean", description: "是否有可靠来源支撑" },
			logicComplete: { type: "boolean", description: "逻辑是否完整无跳跃" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		const text = String(args.text || "");
		const hasSources = typeof args.hasSources === "boolean" ? args.hasSources : /(据|来源|报告|根据|according to|source)/i.test(text);
		const logicComplete = typeof args.logicComplete === "boolean" ? args.logicComplete : !/显然|显而易见|总之|easily|obviously/.test(text);
		let score = 40;
		if (hasSources) score += 30;
		if (logicComplete) score += 20;
		if (text.length > 40) score += 5;
		score = Math.max(0, Math.min(100, score));
		const threshold = (deps.config && deps.config.honesty_threshold) || 60;
		const below = score < threshold;
		return result("confidence_calibrate", {
			checkItem: "confidence_calibrate",
			passed: !below,
			confidence: confidenceLabel(score),
			evidence: [`置信度 ${score}/100；来源:${hasSources ? "有" : "无"}；逻辑:${logicComplete ? "完整" : "有跳跃"}`],
			suggestion: below ? "置信度低于阈值，须标注'不确定'或调用 honesty_gate 拦截" : "置信度达标，可正常输出",
			extra: { score, threshold, below, calibrated: true }
		});
	}
};

export const reasonTools = [
	cotScaffold,
	alternativeHypothesis,
	confidenceCalibrate
];