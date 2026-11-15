// lib/tools-logic.js
// Logic-derivation domain tools for dsh-reason-guard.
// Each tool is { name, description, params, run(args, deps) }.

import { result, confidenceLabel, CONFIDENCE_MED, splitSentences } from "./shared.js";

// ---- logic_chain_verify ----
const logicChainVerify = {
	name: "logic_chain_verify",
	description: "验证推理链的每一步是否成立。输入前提列表 + 推理步骤 + 结论，检查每一步推导是否有效（演绎/归纳/类比），标记薄弱环节。触发场景：回答包含多步推理、需要确认逻辑严密性时。",
	params: {
		type: "object",
		properties: {
			premises: { type: "array", items: { type: "string" }, description: "前提列表" },
			steps: { type: "array", items: { type: "string" }, description: "推理步骤列表" },
			conclusion: { type: "string", description: "最终结论" }
		},
		required: ["premises", "steps", "conclusion"],
		additionalProperties: false
	},
	async run(args) {
		const premises = (args.premises || []).map(String);
		const steps = (args.steps || []).map(String);
		const conclusion = String(args.conclusion || "");
		const weaknesses = [];
		const stepChecks = [];
		for (let i = 0; i < steps.length; i += 1) {
			const step = steps[i];
			const kind = classifyStep(step);
			const ok = inferStepOk(step, premises.concat(steps.slice(0, i)), conclusion);
			stepChecks.push({ step, kind, ok, note: ok ? "推导成立" : "推导存疑" });
			if (!ok) weaknesses.push(`步骤 ${i + 1}：${step}（类型：${kind}，存在跳跃/缺乏前提支撑）`);
		}
		// check conclusion supported by final premise pool
		const conclusionSupported = steps.length > 0 && inferStepOk(conclusion, premises.concat(steps));
		if (!conclusionSupported) weaknesses.push(`结论'${conclusion}'缺乏步骤链支撑`);
		const passed = weaknesses.length === 0;
		return result("logic_chain_verify", {
			checkItem: "logic_chain_verify",
			passed,
			confidence: confidenceLabel(passed ? 70 : 40),
			evidence: stepChecks.map((s) => `[${s.ok ? "OK" : "?"}] ${s.kind} ${s.step}`),
			suggestion: weaknesses.length ? "推理链存在薄弱环节：" + weaknesses.join("；") : "推理链逻辑成立",
			extra: { steps: stepChecks, weaknesses }
		});
	}
};

/** Heuristic: classify a reasoning step as deductive / inductive / analogical. */
function classifyStep(step) {
	const s = String(step);
	if (/(因为.*所以|因此|所以|故|hence|therefore|thus|由此|综上|既然)/.test(s) && /(所有|全部|任何|必然|一定|always|must|every|all)/i.test(s)) return "演绎";
	if (/(如果.*那么|若.*则|所有.*都|只要|unless)/.test(s)) return "演绎（条件）";
	if (/(多数|通常|一般|倾向|往往|可能|大多|most|usually|generally|likely)/i.test(s) || /\%/.test(s)) return "归纳";
	if (/(类比|正如|好比|像|类似|同理|like|similar to|as if)/.test(s)) return "类比";
	if (/(反例|特例|counter|counterexample)/.test(s)) return "演绎（反驳）";
	return "演绎";
}

/** Heuristic validity: a step is "ok" when its keywords don't overclaim beyond premises.
 *  A coarse check: steps that introduce a brand-new proper noun or absolute claim without
 *  a matching premise keyword are flagged. */
function inferStepOk(step, pool, conclusion) {
	const s = String(step);
	// absolute/overconfident markers without a premise backing
	const absMarkers = /(必然|一定|绝对|肯定|毫无疑问|必定|证明|alwways|definitely|certainly|proves)/i;
	if (absMarkers.test(s)) {
		// a "因此/所以" step that asserts absolutes is acceptable only if premises use absolutes
		const anyAbs = pool.some((p) => /(所有|全部|必然|任何|一定|绝对|必定)/.test(String(p)));
		if (!anyAbs) return false;
	}
	return true;
}

// ---- contradiction_detect ----
const contradictionDetect = {
	name: "contradiction_detect",
	description: "检测文本内部是否存在自相矛盾的陈述。触发场景：对模型回答做一致性检查，或担心回答前后打架时。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要检查的文本" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args) {
		const text = String(args.text || "");
		const sentences = splitSentences(text);
		const contradictions = [];
		// simple negation-pair detector: same subject + opposite polarity verbs
		const polarityMap = [
			[/不是|并非|never|no|not |不行|不能/, -1],
			[/是|确实|确实|一定|行|可以|yes|is |can/, 1]
		];
		const subjects = [];
		for (const s of sentences) {
			if (s.length < 4 || s.length > 200) continue;
			// take first 4-word subject
			const head = s.split(/\s+/).slice(0, 6).join(" ");
			subjects.push({ sentence: s, head });
		}
		for (let i = 0; i < subjects.length; i += 1) {
			for (let j = i + 1; j < subjects.length; j += 1) {
				const a = subjects[i], b = subjects[j];
				const overlap = overlapWords(a.head, b.head);
				if (overlap < 2) continue;
				const pa = polarity(a.sentence);
				const pb = polarity(b.sentence);
				if (pa !== 0 && pb !== 0 && pa !== pb) {
					contradictions.push({ a: a.sentence, b: b.sentence, note: "两处表述极性相反，疑似矛盾" });
				}
			}
		}
		const passed = contradictions.length === 0;
		return result("contradiction_detect", {
			checkItem: "contradiction_detect",
			passed,
			confidence: confidenceLabel(passed ? 70 : 35),
			evidence: contradictions.map((c) => `A:「${c.a}」 B:「${c.b}」`),
			suggestion: contradictions.length ? "检测到疑似自相矛盾的陈述，需统一口径" : "未发现明显内部矛盾",
			extra: { contradictions: contradictions.slice(0, 8) }
		});
	}
};

function overlapWords(a, b) {
	const sa = new Set(String(a).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/u).filter(Boolean));
	const sb = new Set(String(b).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/u).filter(Boolean));
	let n = 0;
	for (const w of sa) if (sb.has(w)) n += 1;
	return n;
}

function polarity(sentence) {
	if (/(不是|并非|never|no |not |不行|不能|没有)/.test(sentence)) return -1;
	if (/(是|确实|一定|行|可以|yes |is |can )/.test(sentence)) return 1;
	return 0;
}

// ---- assumption_audit ----
const assumptionAudit = {
	name: "assumption_audit",
	description: "识别推理过程中隐藏的假设，列出哪些假设需要额外验证。触发场景：正式审查（hallucination_scan audit 模式）、或想确认结论依赖哪些未言明的预设时。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要审计的推理/回答文本" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args) {
		const text = String(args.text || "");
		const assumptions = [];
		// hidden absolute/pre-condition markers
		const patterns = [
			[/通常|一般|一般来说|normally|generally/, "隐含'在多数情况下成立'的预设"],
			[/假设|如果|若|assuming|if/, "显式条件假设，需确认条件是否满足"],
			[/默认|缺省|by default/, "隐含默认值预设"],
			[/显然|显而易见|obviously|clearly/, "隐含'无需证明'的预设，需审查"],
			[/众所周知|众所周知|众所周知|as we know/, "隐含'公认'的预设，需审查"],
			[/数据|研究|调查|研究表明|research|study/, "隐含'该研究可靠有效'的预设"],
			[/市场|用户|人群|people|users/, "隐含'目标人群代表性'的预设"]
		];
		for (const [re, note] of patterns) {
			const m = re.exec(text);
			if (m) assumptions.push({ marker: m[0], note, verify: "需额外验证" });
		}
		const passed = assumptions.length === 0;
		return result("assumption_audit", {
			checkItem: "assumption_audit",
			passed,
			confidence: confidenceLabel(passed ? 70 : 45),
			evidence: assumptions.map((a) => `「${a.marker}」→ ${a.note}`),
			suggestion: assumptions.length ? "存在隐藏假设，回答前应显式声明或验证" : "未发现明显隐藏假设",
			extra: { assumptions }
		});
	}
};

// ---- causal_check ----
const causalCheck = {
	name: "causal_check",
	description: "检查因果关系是否成立，区分'相关'和'因果'，防止把相关性包装成因果结论。触发场景：回答中出现'导致/因为...所以/提升/改善/引起'等因果表述时。",
	params: {
		type: "object",
		properties: {
			statement: { type: "string", description: "包含因果表述的句子" },
			claimCausal: { type: "boolean", description: "是否声称因果关系" }
		},
		required: ["statement"],
		additionalProperties: false
	},
	async run(args) {
		const st = String(args.statement || "");
		const claimCausal = typeof args.claimCausal === "boolean" ? args.claimCausal : /(导致|引起|因为.*所以|因此|提升|改善|造成|使|because|cause|lead to|result in)/i.test(st);
		if (!claimCausal) {
			return result("causal_check", { checkItem: "causal_check", passed: true, confidence: CONFIDENCE_MED, evidence: [], suggestion: "未声称因果关系，无需检查", extra: { isCausal: false } });
		}
		// check for correlation-only markers that shouldn't be phrased as causal
		const onlyCorrelation = /(相关|correlat|关联|与.*有关|伴随|accompanied by|coincide)/i.test(st);
		const weakCausal = /(可能|或许|似乎|可能引发|可能是|likely|may|might|could|seem)/i.test(st);
		let note = "因果表述成立（前提充分时）";
		let passed = true;
		if (onlyCorrelation && !/(随机对照|实验|实验组|controlled|RCT|随机实验)/i.test(st)) {
			note = "仅观察到相关性，不应表述为因果";
			passed = false;
		} else if (!weakCausal && /(确定|必然|一定|绝对|无疑|definitely|certainly)/i.test(st)) {
			note = "因果断言过强，缺乏对照/实验证据支撑";
			passed = false;
		}
		return result("causal_check", {
			checkItem: "causal_check",
			passed,
			confidence: confidenceLabel(passed ? 65 : 35),
			evidence: [note],
			suggestion: passed ? note : "建议弱化为'相关'表述或补充因果证据，勿把相关包装成因果",
			extra: { isCausal: true, note }
		});
	}
};

export const logicTools = [
	logicChainVerify,
	contradictionDetect,
	assumptionAudit,
	causalCheck
];