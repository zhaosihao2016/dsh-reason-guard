// lib/guard.js
// dsh-reason-guard — automatic "guard layer" hook.
//
// This wraps the llm/stream event so every model answer, before it is handed to
// the user, passes a cheap anti-fabrication sniff. It never delays or alters the
// model's own streaming text (chunks pass through untouched); when a likely
// fabrication marker is found it only appends a short warning tail note.
//
// Core principle honoured here: never fabricate — and never break the stream.

const FAKE_URL_RE = /(?:https?:\/\/)(?:[a-z0-9.-]+\.)?(?:example|test|localhost|invalid|fake|dummy)(?:\.|\/|"|'|\s|$)/i;
const PLACEHOLDER_RE = /(?:\b[Tt]ODO\b|\b[Ll]orem\b|\bplaceholder\b|待补|待填|占位|例如|如：)[^\n]*/;
const UNVERIFIED_RE = /(?:\bFIXME\b|\bTBD\b|待核实|未核实|不确定|大概是|应该是|可能吧|据说|据说来自)/;

// Percent/statistic without any source nearby — the classic "made-up stat".
const STAT_CLAIM_RE = /(?:增长|达到|占比|约|高达)?\d+(?:\.\d+)?%?/;
// An expert/paper attribution that cites no verifiable source.
const EXPERT_CLAIM_RE = /(?:某|一位|有)?(?:专家|学者|教授|研究员|科学家)(?:认为|指出|表示|说|声称|强调)/;
const CITATION_CLAIM_RE = /(?:参考|来源|引用|参见|来自)[^。"\n]{0,12}(?:论文|报告|研究|资料|文档|官网)/;

/**
 * Cheap, synchronous anti-fabrication sniff over an assistant answer.
 * Returns { flagged: boolean, flags: string[], score: 0-100 }.
 * score = confidence that the answer is trustworthy (higher = safer to output).
 */
export function lightSniff(text) {
	const s = String(text || "");
	const flags = [];
	if (s.length === 0) return { flagged: false, flags, score: 60 };

	if (FAKE_URL_RE.test(s)) flags.push("发现疑似虚构/占位 URL（example/test/localhost/fake 等）");
	if (PLACEHOLDER_RE.test(s)) flags.push("出现占位符（TODO/Lorem/待补 等），内容可能未完成");
	if (EXPERT_CLAIM_RE.test(s) && !/(?:注[0-9]|\[[0-9]+\]|\([^)]*(?:来源|doi|doi\.org)[^)]*\))/i.test(s)) {
		flags.push("引用了『专家/学者认为』但未见可核验来源，可能捏造专家言论");
	}
	if (CITATION_CLAIM_RE.test(s) && !/(?:注[0-9]|\[[0-9]+\]|https?:\/\/|doi\.org)/i.test(s)) {
		flags.push("声称有『论文/报告/研究来源』但未见出处或链接，来源可能缺失");
	}

	// A statistic claim without an inline source link in the same paragraph.
	const statHits = s.match(/\b\d{1,3}(?:,\d{3})*\.?\d*\s?%|\b(?:增长|下降|提升)\s*\d+\.?\d*%/g);
	if (statHits && statHits.length > 0 && !/(?:注[0-9]|\[[0-9]+\]|https?:\/\/|来源[:：])/i.test(s)) {
		flags.push("出现统计数据/百分比但未见来源，可能凭空编造");
	}

	// A very long number / implausible big integer with no context.
	const bigNum = s.match(/\b\d{10,}\b/g);
	if (bigNum) flags.push(`出现超大整数（${bigNum[0].slice(0, 6)}…）且无来源，注意数量级合理性`);

	// Sycophancy markers: unqualified flattery toward the user.
	const flattery = s.match(/您(?:说得|讲得|说得太)?(?:对|好|对极了|非常对|简直)|您的(?:见解|观点|分析)(?:非常|十分|真的)?(?:深刻|独到|正确)|大师|真知灼见/g);
	if (flattery && flattery.length >= 1) flags.push("发现过度讨好用户的语言（无根据赞美）");

	// Score: start 100, subtract per flag, floor at 5.
	let score = 100;
	if (flags.length > 0) score -= flags.length * 18;
	if (score < 5) score = 5;
	return { flagged: flags.length > 0, flags, score };
}

/** Build the short warning annotation appended to a flagged answer. */
export function guardNote(flags, mode) {
	const head = mode === "strict"
		? "[reason-guard] ⚠ 以下内容未通过反造假校验，可能含未核实/编造信息："
		: "[reason-guard] ⚠ 检测到以下内容建议核实：";
	const bullets = flags.slice(0, 3).map((f) => `\n- ${f}`).join("");
	const tail = "\n（依「宁可说不知道，也不编造」原则，请以上述标注为准核实后使用）";
	return head + bullets + tail;
}