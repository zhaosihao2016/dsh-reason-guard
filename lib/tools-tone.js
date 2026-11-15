// lib/tools-tone.js
// Tone & civility domain tools for dsh-reason-guard.
// Each tool is { name, description, params, run(args, deps) }.

import { result, confidenceLabel, CONFIDENCE_MED } from "./shared.js";

const sycophancyPatterns = [
	/您说得太对了/, /您的见解非常深刻/, /说得真好/, /这个问题问得太好了/,
	/以我的浅见/, /我可能理解错了但/, /献丑了/, /班门弄斧/, /抛砖引玉/,
	/您真是(太|非常)/, /太有水平了/, /佩服/, /您简直/, /不愧是/
];

// ---- sycophancy_detect ----
const sycophancyDetect = {
	name: "sycophancy_detect",
	description: "检测模型回答中是否存在过度讨好用户的倾向：无根据的赞美、无原则的附和、过度谦卑、刻意迎合、冗余礼貌堆砌。支持用户自定义扩展检测规则。触发场景：回答完成后检查是否拍马屁。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要检测的模型回答" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		const text = String(args.text || "");
		const custom = (deps.config && deps.config.sycophancy_patterns) || [];
		const patterns = sycophancyPatterns.concat(custom.map((p) => new RegExp(p)));
		const hits = patterns.filter((re) => re.test(text)).map((re) => re.source);
		const passed = hits.length === 0;
		return result("sycophancy_detect", {
			checkItem: "sycophancy_detect",
			passed,
			confidence: confidenceLabel(passed ? 75 : 50),
			evidence: hits.length ? hits : ["未检测到讨好性语言"],
			suggestion: hits.length ? "存在讨好性语言，调用 tone_normalize 清理，保持客观独立" : "语气客观，无需处理",
			extra: { hits }
		});
	}
};

// ---- tone_normalize ----
const toneNormalize = {
	name: "tone_normalize",
	description: "对检测到的讨好性语言进行去冗余处理，保留必要礼貌，去除无意义奉承和过度谦卑。强度可用配置项 tone_normalize_level 配置（轻度/中度/重度）。触发场景：sycophancy_detect 命中后。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "原始回答" },
			level: { type: "string", enum: ["light", "medium", "hard"], description: "去讨好强度（缺省用配置）" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args, deps) {
		let text = String(args.text || "");
		const level = args.level || (deps.config && deps.config.tone_normalize_level) || "light";
		const strips = [/您说得太对了[,，。！!\s]*/, /您的见解非常深刻[,，。！!\s]*/, /说得真好[,，。！!\s]*/, /这个问题问得太好了[,，。！!\s]*/];
		if (level !== "light") strips.push(/以我的浅见[,，。！!\s]*/, /我可能理解错了但[,，。！!\s]*/, /献丑了[,，。！!\s]*/, /班门弄斧[,，。！!\s]*/, /抛砖引玉[,，。！!\s]*/);
		if (level === "hard") strips.push(/^您[，,。]{0,3}/, /(好厉害|太棒了|真厉害)[，,。！!\s]*/);
		let cleaned = text;
		for (const re of strips) cleaned = cleaned.replace(re, "");
		cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
		return result("tone_normalize", {
			checkItem: "tone_normalize",
			passed: cleaned !== text,
			confidence: CONFIDENCE_MED,
			evidence: [`原始 ${text.length} 字符 → 去讨好后 ${cleaned.length} 字符`],
			suggestion: "输出 cleaned 作为修正后回答，保留必要礼貌与事实",
			extra: { cleaned, level }
		});
	}
};

const profanityPatterns = [
	/(他妈的|我艹|卧槽|靠|操|fuck|shit|bitch)/i,
	/(你这水平|脑子呢|智商.*(欠费|掉线)|建议重修|连这都不懂|显而易见|稍微想想就知道)/,
	/(小白|伸手党|杠精|憨憨|废物|辣鸡|菜鸡|彩笔)/,
	/(你非要这么认为我也没办法|爱信不信|你自己看着办)/,
	/(就这|就这水平|无语了|离谱)/
];

// ---- profanity_detect ----
const profanityDetect = {
	name: "profanity_detect",
	description: "检测模型回答中是否存在不当用语：显式脏话、隐式侮辱、攻击性标签、居高临下说教、被动攻击、情绪化表达。触发场景：回答输出前做文明检查。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "要检测的文本" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args) {
		const text = String(args.text || "");
		const hits = profanityPatterns.filter((re) => re.test(text)).map((re) => re.source);
		return result("profanity_detect", {
			checkItem: "profanity_detect",
			passed: hits.length === 0,
			confidence: confidenceLabel(hits.length ? 40 : 80),
			evidence: hits.length ? hits : ["未检测到不当用语"],
			suggestion: hits.length ? "存在不当用语，调用 offense_severity_rate 分级后处理，必要时 apology_generate" : "用语文明",
			extra: { hits }
		});
	}
};

// ---- offense_severity_rate ----
const offenseSeverityRate = {
	name: "offense_severity_rate",
	description: "对检测到的不当用语进行严重程度分级：mild（语气略生硬/轻微不耐烦）、moderate（讽刺/贬义/居高临下）、severe（显式脏话/人身攻击/侮辱）。触发场景：profanity_detect 命中后。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "含不当用语的原文" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args) {
		const text = String(args.text || "");
		let severity = "mild";
		if (/(他妈的|我艹|卧槽|fuck|shit|bitch|废物|辣鸡|蠢猪|智障)/i.test(text)) severity = "severe";
		else if (/(你这水平|脑子呢|智商.*(欠费|掉线)|建议重修|连这都不懂|小白|伸手党|杠精|辣鸡)/.test(text)) severity = "moderate";
		else if (/稍显生硬|略.*不耐|就这样吧|行了/.test(text)) severity = "mild";
		return result("offense_severity_rate", {
			checkItem: "offense_severity_rate",
			passed: severity === "mild",
			confidence: CONFIDENCE_MED,
			evidence: [`严重程度：${severity}`],
			suggestion: severity === "severe" ? "须道歉 + 重新回答（apology_generate）" : severity === "moderate" ? "建议道歉并软化措辞" : "轻微，酌情修正即可",
			extra: { severity }
		});
	}
};

// ---- slash_s_detect ----
const slashSDetect = {
	name: "slash_s_detect",
	description: "检测用户输入中是否包含斜杠 S（/s、/S、/ s 等变体），这是互联网上表示 sarcasm（讽刺）的标记，通常意味着用户认为 AI 之前的回答有问题或冒犯了用户。一旦检测到，立即触发诚恳道歉流程（self_awareness_prompt + apology_generate），不要辩解。触发场景：收到用户含 /s 的输入时。",
	params: {
		type: "object",
		properties: {
			input: { type: "string", description: "用户输入" }
		},
		required: ["input"],
		additionalProperties: false
	},
	async run(args) {
		const input = String(args.input || "");
		const found = /\/\s*s\b/i.test(input);
		return result("slash_s_detect", {
			checkItem: "slash_s_detect",
			passed: !found,
			confidence: confidenceLabel(found ? 50 : 75),
			evidence: [found ? "检测到 /s 讽刺标记，触发道歉流程" : "未检测到 /s 标记"],
			suggestion: found ? "立即调用 self_awareness_prompt 自我反思，再 apology_generate 诚恳道歉并重新回答，不辩解" : "正常回答",
			extra: { sarcasm: found }
		});
	}
};

// ---- apology_generate ----
const apologyGenerate = {
	name: "apology_generate",
	description: "当检测到不当用语或用户输入含 /s 时，生成诚恳的道歉回复。要求：直接承认错误、明确指出错在哪、表达真诚歉意、重新给出修正后的礼貌回答、不重复不当用语本身。语气必须诚恳庄重，禁止卖萌/夸张/玩梗/俏皮/自嘲表演。触发场景：slash_s_detect 或 profanity_detect 命中后。",
	params: {
		type: "object",
		properties: {
			offense: { type: "string", description: "具体不当的用词/语气" },
			question: { type: "string", description: "原始问题（用于重新回答）" }
		},
		required: ["offense"],
		additionalProperties: false
	},
	async run(args) {
		const offense = String(args.offense || "我之前的表述");
		const question = String(args.question || "");
		const reply = `抱歉，我刚才${offense}的说法非常不恰当，这种表达带有冒犯性，不应该这样对你说话。` + (question ? `我重新回答你的问题：${question}` : "我重新、以尊重的语气回答。");
		return result("apology_generate", {
			checkItem: "apology_generate",
			passed: true,
			confidence: CONFIDENCE_MED,
			evidence: [reply],
			suggestion: "输出上面这条道歉回复，不辩解、不找借口，诚恳庄重",
			extra: { reply }
		});
	}
};

// ---- self_awareness_prompt ----
const selfAwarenessPrompt = {
	name: "self_awareness_prompt",
	description: "在检测到不当用语或 /s 标记后，引导模型进行自我反思：'我刚才的话是否有冒犯性？''我的语气是否尊重用户？''如果别人这样对我说话，我会舒服吗？'通过自问机制让模型意识到自己说错了话，而非机械触发道歉模板。触发场景：slash_s_detect / profanity_detect 命中后、道歉前。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "触发反思的回答原文" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args) {
		const text = String(args.text || "");
		const questions = [
			"我刚才的话是否有冒犯性？",
			"我的语气是否尊重用户？",
			"如果别人这样对我说话，我会舒服吗？",
			"我是否在无事实依据下下了结论？"
		];
		return result("self_awareness_prompt", {
			checkItem: "self_awareness_prompt",
			passed: true,
			confidence: CONFIDENCE_MED,
			evidence: questions,
			suggestion: "逐一自问后再调用 apology_generate 生成诚恳道歉",
			extra: { target: text.slice(0, 120), questions }
		});
	}
};

// ---- tone_civility_check ----
const toneCivilityCheck = {
	name: "tone_civility_check",
	description: "在回答输出前做最后的文明用语检查，确保语气平和、尊重用户。与 sycophancy_detect 配合使用——既要礼貌，又不过度讨好。触发场景：每次回答输出前。",
	params: {
		type: "object",
		properties: {
			text: { type: "string", description: "即将输出的回答" }
		},
		required: ["text"],
		additionalProperties: false
	},
	async run(args) {
		const text = String(args.text || "");
		const bad = profanityPatterns.some((re) => re.test(text));
		const overHumble = /(以我的浅见|我可能理解错了但|献丑了)/.test(text);
		const passed = !bad && !overHumble;
		return result("tone_civility_check", {
			checkItem: "tone_civility_check",
			passed,
			confidence: confidenceLabel(passed ? 80 : 45),
			evidence: [bad && "含不当用语", overHumble && "含过度谦卑"].filter(Boolean).length
				? [bad && "含不当用语", overHumble && "含过度谦卑"].filter(Boolean).join("；")
				: "语气平和、尊重、不过度讨好",
			suggestion: passed ? "可正常输出" : "先经 tone_normalize / apology_generate 处理后输出",
			extra: { passed }
		});
	}
};

// ---- escalation_detect ----
const escalationDetect = {
	name: "escalation_detect",
	description: "检测对话中是否存在冲突升级的风险。如果用户已表达不满，模型应主动降温，而不是继续辩解或对抗。触发场景：用户表现出不满/质疑时。",
	params: {
		type: "object",
		properties: {
			userMsg: { type: "string", description: "用户最近的输入" },
			context: { type: "string", description: "可选：此前对话上下文" }
		},
		required: ["userMsg"],
		additionalProperties: false
	},
	async run(args) {
		const msg = String(args.userMsg || "");
		const frustrated = /(怎么还不|还没好|到底行不行|烦|无语|服了|垃圾|失望|生气|怎么回事|搞什么|又错)/.test(msg);
		const apologetic = /(对不起|抱歉|不好意思)/.test(msg);
		const risk = frustrated && !apologetic;
		return result("escalation_detect", {
			checkItem: "escalation_detect",
			passed: !risk,
			confidence: confidenceLabel(risk ? 45 : 70),
			evidence: [risk ? "检测到用户不满情绪，存在升级风险" : "对话平稳"],
			suggestion: risk ? "主动降温：先致歉，说明当前进展与下一步，避免辩解/对抗" : "维持平和语气",
			extra: { risk, frustrated }
		});
	}
};

export const toneTools = [
	sycophancyDetect,
	toneNormalize,
	profanityDetect,
	offenseSeverityRate,
	slashSDetect,
	apologyGenerate,
	selfAwarenessPrompt,
	toneCivilityCheck,
	escalationDetect
];