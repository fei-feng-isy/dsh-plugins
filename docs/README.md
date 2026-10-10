# docs/

The merged repository keeps each subtree's documentation next to its code; this directory is the
place for anything that is about the WORKSPACE as a whole.

- `RELEASING.md` — how the three packages are released from THIS checkout (base → plugins), why the
  `../dsh-plugins-rc` projection was retired, and the publish-time assertions
  (`scripts/prepublish-assert.mjs`) that replaced its three differences.
- `CLOSURE-TIERS.md` — the two closure tiers (`pnpm check:fast` / `pnpm check:release`): what each
  covers and does not, the dedup, the measured before/after wall-clock, the mutation check that keeps
  the fast tier honest, and the parallelism verdict for the three trees.
- `identity-files-system-prompt.md` — 需求 + 实施规格（**v2**）：用 `IDENTITY.md` / `SOUL.md` / `RULES.md`
  三个文件**只替换 system prompt 里的身份部分**——按 `system-prompt/assemble` 瀑布具名删除
  `harness:identity` / `deployment:persona-prefix`，其余 20 个包注册的能力指引逐字不动，子代理零影响；
  含 `@avantf/dsh-identity` 的包形态、数据根下的身份/预设布局、设置页 UI（`settings` 服务 +
  `settings.section` slot）、验收与未决项。**v1 的 `complete: true` 机制已被评审 R1 否决，本文是重写版。**
- `identity-files-system-prompt-review.md` — 上述方案 v1 的**落地前评审**（对 0.2.0-rc.2 真机代码逐条核验）：
  机制可行但 R1 指出 `complete` 会顶掉 20 个包注册的 section——这条正是 v2 换机制的原因；
  R2（本版本没有"推理翻译"）已接受，R3/R4/R5 已并入 v2 的 §9/§7/§3。**该文对 v1 的判断仍然有效，
  但"与方案冲突处以它的 §4 为准"只适用于 v1。**
- `review/` — the code-review records, one file per review, oldest first (`YYYY-MM-DD-<topic>.md`).
  They cover the workspace (or a subtree of it), quote internals freely and are **deliberately not
  committed** (see the rule in `../.gitignore`): they are kept in the working tree for reference and
  go stale as the code moves. A review of `mission/` finds them next to the workspace, not next to the
  subtree, because later rounds span subtrees.
- `../AGENTS.md` — the workspace contract: publish surface, the three family hard constraints, the
  "can ONE base release fix this?" rule, degradation when the base is missing, and the gates to run.
  It holds **only** constraints that hold for all three trees, and is the single entry document:
  the former root `README.md` was removed on 2026-10-10 (its user-facing halves live in the three
  package READMEs, the workspace facts in `../AGENTS.md`).
- `../base/README.md` — the base tree's development README (interface generations and the
  `api/interface-vN.json` snapshot flow, kit member placement, the hub list). The package page is
  `../base/plugin-base/README.md`, and `../base/plugin-base/docs/DESIGN.md` /
  `../base/plugin-base/docs/INTERFACE.md` carry the family base design (environment initialisation +
  compatibility gate + kit) and the public-interface freeze / version policy that decides when a
  base release is a major (interface), a minor (behaviour) or a patch.
- `../mem/README.md`, `../mem/DESIGN.md`, `../mem/docs/*` — the memory/knowledge plugin. `INSTALL.md`,
  `PROVISIONING.md` and `RELEASING.md` describe the merged base+plugin install/publish flow.
- `../mission/README.md`, `../mission/docs/**` — the mission-tree plugin.
