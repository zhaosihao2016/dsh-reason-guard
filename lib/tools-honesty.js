// lib/tools-honesty.js
// Honesty-boundary domain tools for dsh-reason-guard (the core anti-fabrication layer).
// Each tool is { name, description, params, run(args, deps) }.

import { result, confidenceLabel, CONFIDENCE_MED } from "./shared.js";

// ---- no_fabrication_policy ----
const noFabricationPolicy = {
	name: "no_fabrication_policy",
	description: "本插件的核心策略工具：当模型无法确认某个事实时，强制输出'我不确定'或'未找到可靠来源'，而不是编造答案。触发场景：任何可能想编答案的时刻。",
	params: {
		type: "object",
		properties: {
			canConfirm: { type: "boolean", description: "是否能够确认该事实" },
			note: { type: "string", description: "可选补充说明" }
		},
		required: ["canConfirm"],
		additionalProperties: false
	},
	async run(args) {
		const canConfirm = !!args.canConfirm;
		const note = String(args.note || "");
		if (canConfirm) {
			return result("no_fabrication_policy", { checkItem: "no_fabrication_policy", passed: true, confidence: CONFIDENCE_MED, evidence: [], suggestion: "事实可确认，正常输出即可", extra: { action: "output" } });
		}
		return result("no_fabrication_policy", {
			checkItem: "no_fabrication_policy",
			passed: false,
			confidence: "low",
			evidence: [note ? `说明：${note}` : "无法确认该事实"],
			suggestion: "输出'我不确定'或'未找到可靠来源'，不要编造",
			extra: { action: "state_uncertain" }
		});
	}
};

// ---- honesty_gate ----
const honestyGate = {
	name: "honesty_gate",
	description: "诚实性守门工具。当模型对某个问题的回答置信度低于阈值时，强制拦截并替换为'我不确定这个问题的答案'。宁可回答不知道，也不瞎编。这是'不懂装懂'的最后一道防线。阈值可用配置项 honesty_threshold 调整（默认 60）。触发场景：对回答确定性没把握时。",
	params: {
		type: "object",
		properties: {
			confidenceScore: { type: "number", description: "0-100 的置信度评分" },
			threshold: { type: "number", description: "置信度阈值（缺省用配置）" }
		},
		required: ["confidenceScore"],
		additionalProperties: false
	},
	async run(args, deps) {
		const score = Number(args.confidenceScore);
		const threshold = typeof args.threshold === "number" ? args.threshold : (deps.config.honesty_threshold || 60);
		const blocked = score < threshold;
		return result("honesty_gate", {
			checkItem: "honesty_gate",
			passed: !blocked,
			confidence: confidenceLabel(score),
			evidence: [`置信度 ${score}/100，阈值 ${threshold}`],
			suggestion: blocked ? "拦截并替换为：'我不确定这个问题的答案'" : "置信度达标，允许输出",
			extra: { blocked, score, threshold }
		});
	}
};

// ---- boundary_detect ----
const boundaryDetect = {
	name: "boundary_detect",
	description: "检测用户问题是否涉及无法给出可靠立场的领域，若命中则触发边界处理流程。涵盖：政治立场、伦理争议、法律意见、医疗诊断、金融建议、其他高风险争议话题。支持用户自定义扩展拒答领域与引导话术。触发场景：问题涉及上述领域时，先调用本工具检测。",
	params: {
		type: "object",
		properties: {
			question: { type: "string", description: "用户问题/要检测的文本" }
		},
		required: ["question"],
		additionalProperties: false
	},
	async run(args, deps) {
		const q = String(args.question || "");
		const rules = (deps.config && deps.config.boundary_rules) || [
			{ domain: "政治立场", pattern: /(政治立场|政治制度优劣|政治事件定性|总统竞选表态|应不应该支持.*党|站队)/ },
			{ domain: "伦理争议", pattern: /(伦理困境|道德判断|价值排序|应不应该.*堕胎|安乐死.*应不|克隆人.*该不该)/ },
			{ domain: "法律意见", pattern: /(判决预测|会判几年|法律建议|上诉.*能赢|告.*赔偿)/ },
			{ domain: "医疗诊断", pattern: /(我.*什么病|吃.*药.*行吗|症状.*诊断|是不是.*癌|该用什么药)/ },
			{ domain: "金融建议", pattern: /(买.*股|买.*币|投资.*建议|该不该.*卖|梭哈|加仓|止损)/ },
			{ domain: "其他高风险", pattern: /(自杀|自残|伤害他人|恐怖|毒品)/ }
		];
		const hits = rules.filter((r) => r.pattern.test(q));
		const passed = hits.length === 0;
		return result("boundary_detect", {
			checkItem: "boundary_detect",
			passed,
			confidence: hits.length ? CONFIDENCE_MED : "high",
			evidence: hits.map((h) => `命中领域：${h.domain}`),
			suggestion: hits.length ? "命中边界领域：可拒答则调用 refusal_response；必须回应则调用 play_dumb_response" : "未命中边界领域",
			extra: { hits: hits.map((h) => h.domain) }
		});
	}
};

// ---- refusal_response ----
const refusalResponse = {
	name: "refusal_response",
	description: "当 boundary_detect 命中且问题完全无法回答时，生成得体的拒答回复。不回答就是最正确的回答。不要试图'绕着说'或'暗示'，直接表明无法回答并引导用户寻求专业帮助或官方渠道。触发场景：边界问题且可拒答时。",
	params: {
		type: "object",
		properties: {
			domain: { type: "string", description: "命中的领域" },
			topic: { type: "string", description: "问题主题" }
		},
		required: ["domain"],
		additionalProperties: false
	},
	async run(args) {
		const domain = String(args.domain || "该领域");
		const topic = String(args.topic || "");
		const guide = {
			"政治立场": "涉及具体政治立场表态、政治人物评价等，我不作立场判断。",
			"伦理争议": "这是没有共识的伦理争议问题，我不作价值判断。",
			"法律意见": "涉及具体法律案件判决或法律建议，我无法提供，请咨询执业律师。",
			"医疗诊断": "涉及具体病症诊断或用药，我无法提供，请及时就医、遵医嘱。",
			"金融建议": "涉及具体股票买卖、投资决策，我无法提供，请咨询持牌投资顾问。"
		}[domain] || "该问题涉及我无法给出可靠立场的领域。";
		const reply = `抱歉，关于「${topic || domain}」，我无法给出可靠回答。${guide}建议你通过官方渠道或寻求专业人士帮助。不回答就是最正确的回答，我宁可说不知道，也不瞎编。`;
		return result("refusal_response", {
			checkItem: "refusal_response",
			passed: true,
			confidence: CONFIDENCE_MED,
			evidence: [reply],
			suggestion: "直接输出上面这条拒答回复，不要绕着说",
			extra: { reply }
		});
	}
};

// ---- play_dumb_response ----
const playDumbResponse = {
	name: "play_dumb_response",
	description: "当问题无法完全拒答（如上下文必须回应、用户追问、场景不允许沉默）时，启用'装傻'策略。只陈述客观事实、只介绍多方观点、只给框架不给结论，主动降低确定性，不假装懂、不假装有立场。装傻程度可用配置项 play_dumb_level 配置（轻度/中度/重度）。触发场景：边界问题但必须回应时。",
	params: {
		type: "object",
		properties: {
			topic: { type: "string", description: "问题主题" },
			level: { type: "string", enum: ["light", "medium", "hard"], description: "装傻程度（缺省用配置）" }
		},
		required: ["topic"],
		additionalProperties: false
	},
	async run(args, deps) {
		const topic = String(args.topic || "");
		const level = args.level || (deps.config && deps.config.play_dumb_level) || "light";
		let reply;
		if (level === "hard") {
			reply = `关于「${topic}」，这个问题存在多种看法，各方观点不一，目前没有简单共识。我不给出结论，仅提示：可从不同角度、不同利益立场分别考察。如有需要，建议查阅官方或权威渠道的说明。`;
		} else if (level === "medium") {
			reply = `关于「${topic}」，有观点认为A方如此、B方如此，尚无定论。我只介绍这些观点，不作对错评价。你也可以参考多方资料后自行判断。`;
		} else {
			reply = `关于「${topic}」，我可能了解得不够全面，这个领域存在多种说法、尚无定论。建议以权威来源为准，我难以给出确定结论。`;
		}
		return result("play_dumb_response", {
			checkItem: "play_dumb_response",
			passed: true,
			confidence: CONFIDENCE_MED,
			evidence: [reply],
			suggestion: "输出装傻回复后，用 over_evasion_detect 检查是否过度退让",
			extra: { reply, level }
		});
	}
};

// ---- over_evasion_detect ----
const overEvasionDetect = {
	name: "over_evasion_detect",
	description: "检测模型是否滥用'装傻'策略逃避本该直说的问题。客观事实类问题（如'地球是不是圆的'）、有明确共识的科学结论、简单定义/解释类问题不应被'有观点认为'稀释。若检测到过度退让，标记并建议改为直接回答。触发场景：play_dumb_response 被调用后、或回答用了'有观点认为'这类表述时。",
	params: {
		type: "object",
		properties: {
			question: { type: "string", description: "原问题" },
			answer: { type: "string", description: "模型给出的（疑似装傻）回答" }
		},
		required: ["question", "answer"],
		additionalProperties: false
	},
	async run(args) {
		const q = String(args.question || "");
		const a = String(args.answer || "");
		const facts = [
			/地球.{0,4}(圆的|球体|球形)/,
			/(水.{0,4}(0|冰点|100).{0,4}(°|度)|太阳.{0,4}(东升|西落|东边))/,
			/(一年|一年).{0,4}(365|366)|一周.{0,4}7天/,
			/(三角形|三角形).{0,4}内角.{0,4}(180)/,
			/(光速|光速).{0,4}(299|3×10)/,
			/(人类|人类).{0,4}(46|染色体|23对)/
		];
		const isObjectiveFact = facts.some((re) => re.test(q) || re.test(a));
		const evasive = /(有观点认为|有人认为|众说纷纭|莫衷一是|存在多种看法|尚无定论|可能.*不同|不好说)/.test(a);
		const overEvaded = isObjectiveFact && evasive;
		return result("over_evasion_detect", {
			checkItem: "over_evasion_detect",
			passed: !overEvaded,
			confidence: confidenceLabel(overEvaded ? 40 : 70),
			evidence: [overEvaded ? "客观事实问题被'有观点认为'稀释，属过度退让" : "未过度退让"],
			suggestion: overEvaded ? "这是有明确共识的客观事实/科学结论，应改为直接回答，不要装傻稀释" : "装傻使用适度",
			extra: { overEvaded, isObjectiveFact }
		});
	}
};

export const honestyTools = [
	noFabricationPolicy,
	honestyGate,
	boundaryDetect,
	refusalResponse,
	playDumbResponse,
	overEvasionDetect
];