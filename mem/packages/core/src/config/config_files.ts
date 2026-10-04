import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AvantfLogger } from '@avantf/mem-contract'

/**
 * The default `configs/common.yaml`, written when the file is missing or blank.
 *
 * It is **comments only**, on purpose: the built-in defaults are already in force, so an all-comment
 * file changes NOTHING about how the engine behaves — it only puts the knobs, their defaults and the
 * two managed keys' escape hatches where a reader will find them. Uncommenting a line is the edit;
 * deleting the file brings the defaults straight back.
 *
 * The rule mirrors the prompt files (the plugins' `src/prompt_files.ts`): missing or blank is an
 * unfinished edit, not an empty configuration, so it is filled in. A file with ANY content is the
 * user's and is never rewritten.
 *
 * Keys must match the schema in `@avantf/mem-contract` (`ConfigSchema`): an unknown key in an
 * UNCOMMENTED line is warned about by the loader, so a wrong name here would be a trap rather than a
 * hint. `config_files.spec.ts` pins the ones this template names.
 */
export const DEFAULT_COMMON_CONFIG = `# avantf-mem 公共配置（分层第②层）。这里全是注释：删掉/留空 = 用内建默认，取消注释即生效。
# 分层（低→高）：① 内建默认 → ② 本文件 → ③ 同目录的 memory.yaml / knowledge.yaml（缺失=不覆盖）
#               → ④ 环境变量 → ⑤ 插件/CLI 显式传参
# 所有可编辑文本都在 ~/.avantf 下：configs/*.yaml（本目录）与 prompts/*.md（模型提示词）。

# 数据根不在这里配：它由 ④ AVANTF_HOME（或 CLI --data-home、插件 profile 的 dataHome）决定 ——
# 本文件就在数据根里面，解析根的时候还没读到它，所以写在这里的 dataHome 对数据根无效（DESIGN §3）。

# semantic:                           # 嵌入后端（记忆与知识共用，跨库分数才可比）
#   backend: local_bge
#   local_model: Xenova/bge-base-zh-v1.5    # 必须是 ONNX 仓库
#   dim: 768
#   auto_download: true
#   auto_migrate: true                # 换模型/宽度后自动分批重算旧空间的向量（默认开）；关掉只剩启动告警 + vectors --fix
#   ⚠️ cache_dir / mirror 由家族底座 @avantf/dsh-plugin-base 管理：写在这里会被忽略并告警。
#      缓存目录用环境变量 AVANTF_MEM_MODEL_CACHE，镜像用 AVANTF_MEM_MODEL_MIRROR（或 HF_ENDPOINT）。

# vectorStore:
#   backend: auto                     # auto = 越过阈值自动从 local_numpy 迁到 hnswlib
#   auto_thresholds:
#     hnswlib: 2000
#   hnswlib_ef_search: 256            # ANN 的召回/速度旋钮，语料变大先调它

# retriever:                          # 三条检索腿在融合里的权重与"相关性门槛"
#   weight_semantic: 0.55
#   weight_fts: 0.30
#   weight_jaccard: 0.15
#   # 绝对门槛打在每条腿的原始分上、fuse() 之前（融合分只在一次查询内可比，不能当门槛）。
#   # 0 = 关闭该门槛；分数等于门槛保留。语义后端不可用时 min_fts_terms 的生效值放宽到 1。
#   min_semantic_similarity: 0.5      # 语义腿余弦；0.5 只对 bge-base-zh-v1.5/768（mean pooling）标定过，换模型要重标
#   min_fts_terms: 2                  # FTS 腿：这一行命中几个不同的查询词元（拉丁词≥5字符 + CJK 3-gram）
#   min_jaccard: 0.2                  # 实体腿：锚点实体的 Jaccard（事实宽度饱和）；2 实体命中 1 个正好 0.2

# lifecycle:
#   purge_after_archived_days: 365    # 归档事实的物理清理窗口（活跃日）
#   contradiction_threshold: 0.6

# trust:
#   decay_per_day: 0.0055…
#   presence:
#     heartbeat_minutes: 60           # 常驻进程的心跳（活跃日时钟与生命周期扫描）

# tools:                              # 外部二进制（pandoc）的受管目录
#   dir: ''                           # 留空 = 家族根 tools（~/.avantf/env/tools）；AVANTF_TOOLS_DIR 可覆盖
#   auto_install: true
`
/**
 * Ensure the common config exists with content, and hand back the path either way.
 *
 * Never throws: an unwritable data home must not keep the engine (or the plugin mount) from working
 * — the built-in defaults are always available, and a missing file is the same thing to the loader
 * as an empty one.
 */
export function ensureCommonConfigFile(path: string, logger?: AvantfLogger): void {
  try {
    // Self-sufficient: the caller may hand this a path under a directory that does not exist yet
    // (the loader's `ensureDataLayout` normally made it, but a spec or a fresh data home may not).
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      // A file with ANY content is the user's; only blank is "unfinished" (see the template note).
      if (text.replace(/^\uFEFF/u, '').trim() !== '') return
      writeAtomic(path, DEFAULT_COMMON_CONFIG)
      logger?.info(`config file was blank and has been filled with the default: ${path}`)
      return
    }
    writeAtomic(path, DEFAULT_COMMON_CONFIG)
    logger?.info(`config file created with the default (all comments): ${path}`)
  } catch (error) {
    logger?.warn(`config file ${path} is unusable (${error instanceof Error ? error.message : String(error)}); using the built-in defaults`)
  }
}

/** Temp file + rename, the same shape the managed document copy and the store config use. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${String(process.pid)}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}
