# @avantf/dsh-plugin-base

DSH 插件共用的底座（共享库）。**插件在运行时按 file URL 动态加载它**——不静态 `import`、不打包进插件，
拿不到就降级挂载——把三件容易各写一遍的事收在一起：**启动期资源预装**、**宿主兼容门禁**、**一组与 DSH
无关的共享工具**。

- **运行期零依赖**：`dependencies` 为空，源码里连 `zod` 都不 import。
- 唯一一条 peer 是 `zod`（`>=4.4.3 <5`），由宿主 / 上层提供，好让调用方、本包与宿主解析到**同一份**
  `zod` —— 两份物理副本的 schema 身份不同，strict codec 会因此判不兼容。
- 要求 **Node.js ≥ 22**。

## 主要功能

### 1. 资源预装（声明式 provisioner）

调用方只写一份清单，其余交给框架：

```
声明 → 探测 → 获取 → 校验 → 报告
```

- 已经在盘上 / PATH 上的直接用，不重复下载；
- 需要安装的由框架下载、校验完整性、**原子落盘**（同目录临时文件 + rename；跨进程一把族根锁）；
- 锁被活体进程长期持有（锁文件 mtime 越过 `staleMs` 而 holder 的 pid 仍活着）时**不抢锁**：打一条用户可见的
  `warn`（写明 holder 的 pid、已持有时长、本次已等待时长）后继续按预算等待；等不到就报 `lock/timeout`，
  消息里带 holder 与 mtime 诊断；
- 每一项给出 `present / installed / skipped / failed`，失败带稳定 `code`；
- 三种内置资源种类：`npm-package`、`binary-archive`、`model-cache`。新的种类 = 一个新的 provider，
  核心不动；
- 策略可配：离线、镜像、每项的并发与超时、启动预算、下载总闸。

### 2. 宿主兼容门禁

在挂载之前判断"当前宿主能不能跑这段代码"，语义是**只有被证实的不兼容才拒绝**：

- 调用方交出自己真实的 contribution 与契约（服务、工具、方法、wire schema），由探针在**真实宿主**上验；
- 说不清只是一条备注，版本差异只是警告，**绝不抛错**；
- `compatReport(verdict, words)` 把裁决渲染成一份报告：**结构归本包，措辞归调用方**；
- `registerMegaphone` 在拒绝加载的路径上留一条用户可见的命令（那时它是唯一的信息渠道）；
- `verifyRegisteredFaces` 在挂载后复查"声明的每个 schema / 工具真的注册上了"（只告警）。

### 3. 共享工具（kit）

与 DSH 无关的纯逻辑，调用方在运行时复用：

| 工具 | 作用 |
| --- | --- |
| `PromptFiles` | "缺失或空白就写入默认、有内容则逐字读回"的用户可编辑文本文件层（含崩溃残留的死临时文件清理）。可传 `namespace` 把 `<dataHome>/prompts` 里属于本插件的 `mem-*` / `mission-*` 前缀变成 base 校验的字段（不传则行为不变） |
| `familyHome` / `familyToolsDir` / `familyModelsDir` / `resolveDataHome` / `expandHome` | 家族根与数据根解析：**⑤ 显式 → ④ 环境变量 → ② 配置值 → 默认**，一律传**具名 slot** |
| `wellFormedText` / `wellFormedDeep` | 出站文本的良构修复：孤立代理（lone surrogate）会被 `JSON.stringify` 原样写出、被严格解析器整篇拒收，这里统一换成 U+FFFD；引擎没有 `String.prototype.toWellFormed` 时走等价扫描。递归版只修字符串、数组与普通对象（含键），`Date` / 类实例等一律按同一性原样返回 |

没有运行期消费者的构件（如 `createPluginLogger`、Typert 符号、compat 的单个探针、`npmPackageProvider`）
放在不承诺兼容的 `./internal` 子路径，不属于 `.` 接口。

## 怎么用

### 安装

```bash
npm install @avantf/dsh-plugin-base
```

自己的插件把它声明成**普通运行期依赖**，装上插件就会带上它；插件在运行时从**自己的依赖树**解析它。

### 最小示例（完整，可直接抄）

下面是一个插件从构建期准备到启动期取用资源的完整路径。四步都要，缺一步会出现"能跑但拿不到底座"的
隐性降级。

```ts
// ── ① 构建期：把零依赖的 bootstrap 拷进自己的源码树，按相对路径 import ──────────────
//    cp node_modules/@avantf/dsh-plugin-base/dist/bootstrap.js src/envinit-bootstrap.js
//    （有打包步骤时用 ./preset 自动内联，见「运行时装载」。）
import { loadFramework } from './envinit-bootstrap.js'

// ── ② 启动期：解析底座 → 校验版本 → 动态 import() ─────────────────────────────────
//    底座缺失或版本超出 supportedRange 时只返回 undefined（并打一条 warn），
//    插件照常挂载、走自己的降级路径。
const framework = await loadFramework<typeof import('@avantf/dsh-plugin-base')>({
  logger: { warn: (message) => { log.warn(`envinit: ${message}`) } },
})

if (framework === undefined) {
  log.warn('envinit: @avantf/dsh-plugin-base 不可用，改用内置默认路径继续')
} else {
  // ── ③ 取用一项就绪资源（完整调用；清单的形状见「写清单」）───────────────────────
  const home = framework.familyHome()                       // 受管族根（受 AVANTF_HOME 约束）
  const provisioner = framework.createProvisioner({ home, logger: log })
  provisioner.register(framework.binaryArchiveProvider())
  provisioner.register(framework.modelCacheProvider())
  provisioner.declare({
    plugin: 'my-plugin',
    items: [{
      id: 'my-plugin:tool',
      kind: 'binary-archive',
      spec: {
        id: 'tool',
        version: '1.2.3',
        packs: { 'linux-x64': { url: 'https://example.com/tool.tar.gz', sha256: '<hex>' } },
      },
      target: { root: 'tools' },
      schemaVersion: 1,
    }],
  })
  await provisioner.ensure({ only: ['my-plugin:tool'], deadlineMs: 30_000 })
  const state = provisioner.resolve('my-plugin:tool')
  if (state.state === 'ready') {
    // handle.dir 是可用入口目录（归档：可执行文件所在目录）；handle.env 是 PATH 等增量。
    process.env.PATH = [state.handle.dir, process.env.PATH].filter(Boolean).join(delimiter)
  } else {
    // pending / failed / skipped / missing 都走这里：用内置默认实现，不取消挂载。
    log.warn(`my-plugin:tool 未就绪（${state.state}），改用内置默认路径`)
  }

  // ── ④ 跑一次兼容门禁，读 compatReport 的结论（可选，但拒绝加载前必须有）──────────
  //    ctx 是插件自己的宿主 ctx，spec 是本插件的契约清单（服务 / 工具 / schema / 版本）。
  const verdict = framework.verdictOf(framework.gatherEvidence(ctx, spec))
  if (!verdict.load) {
    log.error(framework.compatReport(verdict, {
      heading: '插件未加载：与当前宿主的兼容性检查未通过。',
      warningsLabel: '风险提示：',
      warnings: verdict.warnings,
      fix: '升级宿主，或按本插件声明的版本重建。',
      logPointer: prefix => `完整诊断见日志里 ${prefix} 开头的行。`,
    }))
  } else if (verdict.warning !== undefined) {
    log.warn(`compat: ${verdict.warning}`)
  }
}
```

`delimiter` 来自 `node:path`（`import { delimiter } from 'node:path'`），`log` / `ctx` / `spec` 是插件自己的
对象——它们不来自底座，所以底座缺席时照样存在。

### 预装资源（逐项）

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Provisioner } from '@avantf/dsh-plugin-base'

const home = join(homedir(), '.avantf', 'env')

const provisioner: Provisioner = framework.createProvisioner({ home, logger })
provisioner.register(framework.binaryArchiveProvider())
provisioner.register(framework.modelCacheProvider())
provisioner.declare(manifest)

// 挂载前必须就绪的项：阻塞等待
await provisioner.ensure({ only: ['my-plugin:compat'], deadlineMs: 30_000 })

// 其余项（含 background）后台预装，到达终态时回调
void provisioner.ensure({
  onSettled: entry => {
    if (entry.id === 'my-plugin:model' && entry.action === 'installed') useModel()
    if (entry.action === 'failed') logger.warn(`${entry.id}: ${entry.code}`)
  },
})
```

### 写清单

```jsonc
{
  "plugin": "my-plugin",
  "items": [
    {
      "id": "my-plugin:compat",
      "kind": "npm-package",
      "spec": { "name": "@scope/compat", "range": "^1.0.0" },
      "target": { "root": "runtime" },
      "startup": "blocking",
      "schemaVersion": 1
    },
    {
      "id": "my-plugin:tool",
      "kind": "binary-archive",
      "spec": {
        "id": "tool", "version": "1.2.3",
        "packs": { "linux-x64": { "url": "https://…/tool.tar.gz", "sha256": "<hex>" } }
      },
      "target": { "root": "tools" },
      "onMissing": { "atStartup": "degrade", "atUse": "error" },
      "schemaVersion": 1
    },
    {
      "id": "my-plugin:model",
      "kind": "model-cache",
      "spec": { "repo": "org/name", "revision": "main", "layout": "flat", "files": ["config.json"] },
      "target": { "root": "models" },
      "startup": "background",
      "schemaVersion": 1
    }
  ]
}
```

- `startup`：`blocking`（缺省，`ensure` 等它）或 `background`（派发后不占启动预算）。
- `onMissing.atStartup`：`degrade`（缺了也继续）/ `refuse`；`onMissing.atUse`：`degrade` / `error`。
- `needs`：同一清单内其它 item 的 id。

`model-cache` 的 `spec.layout` 决定文件怎么落盘：

| layout | 落盘形态 | 谁读 |
| --- | --- | --- |
| `hub`（缺省） | `<root>/models--<org>--<name>/{blobs,refs,snapshots/<sha>/<file>}` 的内容寻址快照树 | 认这套缓存形状的客户端 |
| `flat` | `<root>/<org>/<name>/<file>`，文件直接可读；revision 记录与 blob 在 `<root>/.envinit/` 侧车目录 | 直接按 `<repo>/<file>` 路径读取的运行时 |

两种布局共用同一套 revision 解析、文件列表、模型 hub 端点、内容寻址 blob 与原子落盘；`config.json`
在两种布局里都必需，`spec.requiredFiles` 在其上追加。已经落位但内容不对的条目（旧残留、指向错误 blob
的链接、同名目录）会在下次落位时被换成指向正确 blob 的链接。

`probe` 只做廉价的存在性判断（存在、不是目录、大小 > 0），不联网、不改盘；`verify` 才证明内容：
`hub` 逐项核对链接目标、blob 名与内容哈希；`flat` 按侧车记录里的 sha256 逐项核对（只有文件名的旧记录
仍然接受，不会把装好的树判成未安装）。落位与完成标记在同一把族根锁内完成。

> **只增不减**：受管的模型数据不会回收。`blobs` 与 `snapshots` 永不删除，换一个 revision 就会再存一份；
> `experimental().prune()` 只是打一条告警的 no-op。

`endpoint` 默认是内置的模型 hub；`policy.mirrors.model` 可给一组镜像端点（按序尝试、内置端点兜底），
`spec.endpoint` 优先于镜像。显式给出空白的 `endpoint`、非法的 `revision`（空、`.`、`..`、绝对路径、
反斜杠、控制字符）都会报 `invalid-option`。

```ts
framework.createProvisioner({
  home,
  logger,
  policy: { mirrors: { archive: [], model: ['https://mirror.example'] } },
})
```

清单可以不联网检查：

```bash
provision lint manifest.json
```

### 取用就绪资源

```ts
const state = provisioner.resolve('my-plugin:tool')
if (state.state === 'ready') {
  const entry = state.handle.dir      // 可用入口目录（归档：可执行文件所在目录）
  const env = state.handle.env        // PATH 等环境增量
}
```

`resolve()` 的五个状态：`ready` / `pending` / `failed` / `skipped` / `missing`。`ensure()` 返回的报告里
`ok` **不**把"还在后台装"算成失败。

### 跑兼容门禁

```ts
import { compatReport, gatherEvidence, verdictOf } from '@avantf/dsh-plugin-base'

const verdict = verdictOf(gatherEvidence(ctx, spec))
if (!verdict.load) {
  log.error(compatReport(verdict, {
    heading: '插件未加载：与当前宿主的兼容性检查未通过。',
    warningsLabel: '风险提示：',
    warnings: verdict.warnings,
    fix: '升级宿主，或按本插件声明的版本重建。',
    logPointer: prefix => `完整诊断见日志里 ${prefix} 开头的行。`,
  }))
}
```

### 取用共享工具

```ts
import { PromptFiles } from '@avantf/dsh-plugin-base'

// 插件自己的 logger（base 解析之前就要用）；提示词层传 `namespace` 让 base 校验前缀。
const files = new PromptFiles({ dir: join(dataHome, 'prompts'), namespace: 'my-plugin', logger })
  .load([{ file: 'my-plugin-prompt.md', fallback: '内置默认正文\n' }])
// files[0].text —— 用户写的正文（逐字），或刚写下的默认正文
```

### 运行时装载（`./bootstrap`）

如果调用方要在**运行时**装载本包（而不是让它出现在自己的 import 图里），本包提供零依赖的
`./bootstrap`：解析本包在哪 → 校验版本落在给定区间 → 动态 `import()`。它**不安装任何东西**，
失败只返回 `undefined` 并给出原因。把它拷进自己的源码、按相对路径 import（上面的最小示例），
本包缺席时调用方仍能加载，只是走降级路径。

```ts
import { loadFramework, readDependencyRange } from './envinit-bootstrap.js'

const range = await readDependencyRange(import.meta.url)   // 调用方自己声明的区间
const framework = await loadFramework<typeof import('@avantf/dsh-plugin-base')>({ logger })
if (framework === undefined) {
  logger.warn('本包不可用，按自己的默认路径继续')
} else {
  // 用 framework.xxx
}
```

有打包步骤时，本包提供构建预设把 `./bootstrap` 内联进产物、并断言产物里没有本包的静态引用：

```ts
import { envinitPreset, assertEnvinitArtifacts, assertEnvinitPresetChecks } from '@avantf/dsh-plugin-base/preset'

const preset = envinitPreset({ external: [/* 自己的外部名白名单 */] })
assertEnvinitPresetChecks(preset.checks)
// bundler：external 用 preset.external，内联 preset.noExternal；产物写出后再断言：
assertEnvinitPresetChecks(assertEnvinitArtifacts({
  artifacts: ['dist/plugin.js'],
  clientArtifacts: ['dist/client.js'],
}))
```

### 写 provider（可选）

新增资源种类 = 新增一个 provider（不动核心）。provider 是实现五个动作的 npm 包：

```ts
import type { Provider } from '@avantf/dsh-plugin-base'

export const myProvider: Provider = {
  id: '@scope/my-provider',
  kinds: ['@scope/my-kind'],
  identify: item => ({ name: '…', range: '…' }),
  probe: async (item, ctx) => ({ found: false }),          // 只读、不联网
  plan: () => ({ action: 'install' }),                     // 纯函数
  targetDir: (_item, ref) => `${ref.name}/${ref.segment}`, // 安全相对路径
  install: async (item, ctx) => ctx.publish(await ctx.stage(), { name: '…', version: '…' }),
  verify: async (item, resolved, ctx) => { /* 证明能用 */ },
}
```

用一致性套件跑一遍再发布：

```ts
import { assertProviderConformance, runProviderConformance } from '@avantf/dsh-plugin-base/conformance'

const report = await runProviderConformance({ provider: myProvider, items: [...], packageName: '@scope/my-provider' })
assertProviderConformance(report)
```

## 接口要点

`.` 上的导出（值 + 类型）构成本包的**接口**，由世代号冻结；`./preset` / `./conformance` / `./bootstrap`
三个子路径也在承诺内，`./internal` 从不承诺稳定。

- `INTERFACE_VERSION`（正整数）标识当前世代；每一代的名字面有一份随包的快照，名称与导出对不上就是
  接口变更，必须升世代号。
- `checkInterface(required, module)`：把"调用方构建时所对的世代"与"运行时加载到的本包报告的世代"比一比，
  返回 `ok` / `incompatible` / `cannot-tell`。纯函数、**非对称**、读属性有守卫（取属性就抛的对象读成
  "没报"）、**永不抛**。只有加载到的世代**更旧**（成员可能缺失）才是 `incompatible`；加载到的世代
  **更新**是 `ok` + 一句话的 `warning`（新世代不拿走有消费者的成员），相等是 `ok`。
- `readInterfaceRequirement(url)`：读调用方产物里烘着的那条记录 `{ baseVersion, interfaceVersion }`；
  缺失或畸形返回 `undefined`（"没烘"），不抛。
- 拿到 `incompatible` 时的建议动作是**降级**（不使用本包的共享能力）而不是拒绝挂载；拿到 `ok` + `warning`
  时照常使用、只把那条警告记下来 —— 本包只把裁决与一句话的 `reason` / `warning` 交出去，怎么处理由
  调用方决定。

## 边界（不做的事）

- **不做包管理器**：不推导传递依赖、不生成 lockfile、不做版本求解；每个 item 自包含。
- **不接管原生模块**：`binding.gyp` / `*.node` / 依赖 `postinstall` 的包会被识别并拒绝。
- **不跳过校验**：npm 包核对 `dist.integrity`，归档核对 `sha256`。
- **不做进程内预热**：让文件在盘上是框架的事，读进内存是调用方自己的事。

## 版本承诺

- 接口面是 `.` 上的导出（值 + 类型）加上 `./preset` / `./conformance` / `./bootstrap` 三个子路径；`./internal`
  是内部件，从不承诺稳定。
- **当前这一代（v3）把 `.` 收成了一个稳定子集**：`.` 只列"插件真取用、或插件作者被期望调用"的成员，
  其余进 `./internal`。这是为了把"内部件的改动"与"接口"解耦，不是"这个集合永远不变"：新能力从明确
  标注为不稳定的入口引入，既有成员按弃用周期退出。
- **v3 是第一次破坏性换代**：v2 的成员如果有消费者，v3 一个不少；但 v3 不再对 v2 做结构超集。旧调用方
  遇到更新的 base 仍判 `ok` + `warning`，遇到更旧的 base 才降级。
- **接口与包版本是两条轴**：接口换代只升 `INTERFACE_VERSION` 并新增快照；包版本是普通 semver，只表达
  包自身（行为变更 minor、修复 patch）。
- 顺序敏感的参数一律传**具名对象**（如 `resolveDataHome({ explicit, env, configured })`）；可观察的文案
  由调用方给（如 `compatReport` 的 `words`）。

## 许可

MIT
