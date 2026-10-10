# Changelog

All notable changes to `@avantf/dsh-mission` are documented here.

## [Unreleased]

### Changed（模型工具面）
- **执行者可以派生 subagent**：worker 的工具面不再拒绝 `subagent` / `subagent_fork` —— 起子 agent 是节点**内部**的
  实现手段，树只认节点与结果，收敛不受影响。`send_message` 与 goal / mission 控制类工具对 worker 仍然不可见
  （`submit_mission` 仍是唯一出口）。worker 提示词相应补了一句：要并行就派生 `subagent`，并用
  `run_in_background: false` 同步取结果。
