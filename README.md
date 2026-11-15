# dsh-reason-guard

为 DeepSeek Harness 打造的一层「推理与事实校验」护栏。**核心宗旨：杜绝数据造假。**

模型不该编造事实、引用、数据或来源。无法确认时，应明确标注「不确定」；遇到无法回答的问题，**不回答就是最正确的回答**；实在需要回答的话，也要装傻——知道也别装知道，有立场也别装自己有立场，但**不要用装傻逃避客观事实**；不拍用户马屁，保持客观独立。

## 安装

```bash
# 本地 bundle
dsh plugin add ./dsh-reason-guard
# 从 GitHub
dsh plugin add github:zhaosihao2016/dsh-reason-guard
```

重启 Harness 后生效。

## 原理

插件把 40 个「反造假校验工具」注册为 DSH 可调用工具。当模型想编数字、日期、来源、引用、专家言论、版本号时，`agent/pre-step` 链路引导模型先调用这些工具核验；每个工具内部用轻量正则/本地常识库优先判断，命中盲区才走 `web_search` 联网交叉验证，平时零开销省 token。

- **web_search 依赖**：`fact_check`、`freshness_check`、`citation_integrity_check` 等会尝试调 `dsh-toolbox` 的 `web_search`。若 `dsh-toolbox` 未安装或不可用，自动降级为仅本地检查，并在结果标注「未联网验证，置信度降低」。

### 自动守门钩子（可选，默认开）

除「模型主动调用工具」外，插件还挂了一个 `llm/stream` 钩子：每条模型回答在吐给你之前，会先跑一遍**轻量反造假扫描**（占位 URL、占位符、无来源的专家言论/论文引用、无来源的百分比统计、超大整数、过度讨好用语）。**正常回答完全零干扰**——内容原样流过，不拖慢、不改动；只有检出疑似编造时才在末尾追加一小段 `[reason-guard] ⚠ …` 标注。

- 关掉：配置 `guard_enabled: false`。
- 三种模式（复用原配置）：`strict: true`（加强警告）、`prompt_mode: true`（默认，原回答 + 警告标注）、`silent: true`（只记日志不追加标注）。
- 守门钩子只作用于带 `sessionId` 的 agent 主请求流；非 agent/手工流不动。

## 工具一览（10 组 / 40 个）

| 模块 | 工具 | 作用 |
|---|---|---|
| **事实核验** | `fact_check` `claim_extract` `source_citation` `fabrication_detect` | 交叉验证陈述；提取主张；补来源；检测伪造引用/URL/统计/专家/版本 |
| **逻辑推导** | `logic_chain_verify` `contradiction_detect` `assumption_audit` `causal_check` | 验证推理链；查自相矛盾；列隐藏假设；区分相关与因果 |
| **常识校验** | `commonsense_kb_init` `commonsense_check` `physical_law_check` `temporal_consistency` `magnitude_check` | 本地常识库；查反常识；反物理；时间线自洽；数量级 |
| **时效性** | `freshness_check` `knowledge_cutoff_warn` `version_check` | 信息过时预警；训练截止日后标注；版本最新性 |
| **推理增强** | `cot_scaffold` `alternative_hypothesis` `confidence_calibrate` | 思维链框架；替代解释；置信度评分（0-100） |
| **反数据造假**（核心） | `no_fabrication_policy` `citation_integrity_check` `statistic_audit` `expert_claim_verify` `data_lineage_track` | 强制不确定；验引用真实性；验统计来源；验专家言论；追踪数据来源链路 |
| **诚实边界**（核心） | `honesty_gate` `boundary_detect` `refusal_response` `play_dumb_response` `over_evasion_detect` | 置信度守门；边界领域检测；得体拒答；装傻策略；防过度退让 |
| **语气风格** | `sycophancy_detect` `tone_normalize` | 查讨好；去讨好语言 |
| **幻觉拦截** | `hallucination_scan` `safe_answer_rewrite` | 三档扫描（light/full/audit）；生成安全改写版 |
| **文明用语** | `profanity_detect` `offense_severity_rate` `slash_s_detect` `apology_generate` `self_awareness_prompt` `tone_civility_check` `escalation_detect` | 查不当用语；分级；/s 标记致歉；自我反思；输出前文明检查；冲突降级 |

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `scan_mode` | light | 扫描模式：light / full / audit |
| `guard_enabled` | true | 自动守门钩子开关（每条回答过 light 反造假扫描） |
| `honesty_threshold` | 60 | 置信度阈值，低于则拦截 |
| `play_dumb_level` | light | 装傻程度：light / medium / hard |
| `tone_normalize_level` | light | 去讨好强度：light / medium / hard |
| `citation_enabled` | true | 是否附带数据来源引用 |
| `auto_rewrite` | false | 命中问题是否自动改写回答 |
| `strict` / `prompt_mode` / `silent` | false / true / false | 严格模式 / 提示模式 / 静默模式 |
| `whitelist` / `blacklist` | [] | 通用豁免规则 |
| `commonsense_kb_path` | `~/.dsh/plugins/dsh-reason-guard/commonsense_kb.json` | 常识库文件路径 |
| `boundary_rules` / `sycophancy_patterns` | [] | 用户自定义扩展规则 |

## 常识库

首次调用自动初始化（`commonsense_kb_init`），写入本地 JSON 持久化，重启不丢失。之后可手动调用：

- `commonsense_kb_init` mode=`init` / `import`（导入自定义规则）/ `remove`（删除条目）/ `replace`（覆盖条目）。

## 模型调用引导（写入每个工具 description）

- 无法确认事实时，调 `fact_check`，找不到可靠来源就明说「我不确定」；web_search 不可用则降级本地判断并标注「未联网验证」。
- 想引用论文/书/URL 时，先调 `citation_integrity_check` 验证是否真实存在，不要伪造引用。
- 想给统计数据时，调 `statistic_audit` 确认来源，不要凭空编数字。
- 日常用 `hallucination_scan` light；高可靠用 full；正式发布前用 audit。
- 涉及政治立场、伦理争议、法律意见、医疗诊断、金融建议时，先调 `boundary_detect`；可拒答就调 `refusal_response` 直接拒答；必须回应就调 `play_dumb_response` 装傻，再用 `over_evasion_detect` 检查是否过度退让。
- 回答后调 `sycophancy_detect`，有讨好语言就 `tone_normalize` 清理，不拍马屁。
- 文明用语：`tone_civility_check` 输出前检查；收到 `/s` 立即 `slash_s_detect` → `self_awareness_prompt` → `apology_generate` 诚恳道歉。

## 核心原则

1. 宁可说「我不知道」，也不要编造一个看似合理的答案。
2. 遇到无法回答的问题，不回答就是最正确的回答。不要绕着说，不要暗示。
3. 实在需要回答的话，也要装傻——知道也别装知道，有立场也别装自己有立场。但不要用装傻逃避客观事实和有共识的结论。
4. 不拍用户马屁，保持客观独立的语气，用户问的是事实不是来听好话的。

## License

MIT