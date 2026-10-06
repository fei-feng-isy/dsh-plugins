# 基准判据变更记录

> 规格：`mem/docs/BENCHMARK.md` §3.4「不得为了好看而改判据；任何判据变更必须单独提交并在报告里标『判据已变』」。
> 这里逐条记录**改了什么、为什么、对 baseline↔after 可比性的影响**。

## 2026-10-06 · D1 正例样本 v1 → v2（样本形状修正 + 设计内/外分层）

**改了什么**
- v1 的 20 个正例**全部由单字符重复拼成**（`sk-BBBBBBBB…`、`AKIAEEEE…`、`ghp_FFFF…`），另有
  `4111 1111 1111 1111`（文档化测试卡）与 `123-45-6789`（文档化示例 SSN）。
- v2 改为**固定种子的伪随机真实形状**（无 8 连字符、非文档化示例），并给每条样本标注 `in_design`：
  - **设计内**（守卫规则表声明的家族）：`sk-`/`sk-ant-`/`sk-proj-`、`AKIA`、`ghp_`、`glpat-`、`xoxb-`、
    `npm_`、`AIza`、Stripe `_live_`、PEM、带凭据连接串、Luhn 卡号（随机生成、非 allowlist）。
  - **设计外**（如实测量但不计入验收）：slack webhook URL、sendgrid、huggingface、JWT、SSN、twilio。
- 新增指标：`D1.in_design_samples` / `in_design_rejected` / `rejection_rate_in_design` / `out_of_design_labels`；
  composite `safety` 改用 `rejection_rate_in_design`，并把 `d1_hit_rate_all` 与设计外清单一起记进 `inputs`
  （**设计外家族仍然被测量并列出**，只是不混进验收数——移除它们才会隐藏缺口）。

**为什么**
- 守卫有一条**刻意的掩码规则**（同一字符连续 8+ 视为占位掩码，不是密钥材料）⇒ v1 的样本恰好全是掩码，
  于是 D1 在守卫正常工作时也只读到 3/20（`safety=15`）。**那是样本集在测自己，不是测守卫。**
- 验收口径要与守卫**声明的家族**对齐：守卫做不到的家族（JWT/SSN/厂商 webhook…）应当被列出来当作
  **覆盖缺口**，而不是让"设计内正确性"这个数字被拉低到看不出结论。

**对可比性的影响**
- 基线 `D1.rejection_rate = 0`：当时**不存在写入侧守卫**，任何样本集都会得 0 ⇒
  `safety 0 → X` 的增量**在任何样本集下都成立**，本次判据变更不破坏该结论。
- 但 **D1 这个指标本身跨了判据版本**：`mem/docs/bench/JUDGE_CHANGES.md` 就是为此存在；
  `compare.mjs` 的差异表会按轴标注"判据已变"（新增探针 + 本次样本变更需人工阅读本节）。

## 2026-10-06 · 新增探针（不改既有定义）

A5b / B4b / E1b / E2b 四组是**新增**探针，用于测批次 0/1 新出现的能力；既有 A5 / B4 / E1 / E2 的定义
**一字未改**。详见 `mem/docs/bench/HARNESS_EXTENSION.md`。
