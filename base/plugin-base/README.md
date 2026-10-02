# @avantf/dsh-plugin-base

给 DSH 插件用的基础包，把三件容易各写一遍的事收在一起：**启动期资源预装**、**宿主兼容门禁**、
**一组与 DSH 无关的共享工具**。

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
  消息里带 holder 与 mtime 诊断。抢一个活写者的锁会让两个写者进同一目录，超时只是报告；
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
| `PromptFiles` | "缺失或空白就写入默认、有内容则逐字读回"的用户可编辑文本文件层（含崩溃残留的死临时文件清理） |
| `createPluginLogger` | 带统一前缀、可镜像到宿主 logger 的 logger |
| `familyHome` / `familyToolsDir` / `familyModelsDir` / `resolveDataHome` / `expandHome` | 家族根与数据根解析：**⑤ 显式 → ④ 环境变量 → ② 配置值 → 默认**，一律传**具名 slot** |
| `strictCodec` / `endpointId` / `fieldSymbol` / `resultSymbol` | 组装 Typert wire 描述符的几行约定 |
| `wellFormedText` / `wellFormedDeep` | 出站文本的良构修复：孤立代理（lone surrogate）会被 `JSON.stringify` 原样写出、被严格解析器整篇拒收，这里统一换成 U+FFFD；引擎没有 `String.prototype.toWellFormed` 时走等价扫描。递归版只修字符串、数组与普通对象（含键），`Date` / 类实例等一律按同一性原样返回 |

### 4. 接口世代

`.` 上的导出构成本包的**接口**，由世代号冻结：

- `INTERFACE_VERSION`（正整数）+ `api/interface-vN.json` 快照（该代的值名与类型名，随源码在仓库里，
  不进产物）；
- `checkInterface(required, module)`：把"调用方构建时所对的世代"与"运行时加载到的本包报告的世代"
  比一比，返回 `ok` / `incompatible` / `cannot-tell`。纯函数、**非对称**、读属性有守卫（取属性就抛的
  对象读成"没报"）、**永不抛**。只有加载到的世代**更旧**（成员可能缺失）才是 `incompatible`；加载到的
  世代**更新**是 `ok` + 一句话的 `warning`（世代是纯增量，旧调用方要用的成员都还在），相等是 `ok`；
- `readInterfaceRequirement(url)`：读调用方产物里烘着的那条记录 `{ baseVersion, interfaceVersion }`；
  缺失或畸形返回 `undefined`（"没烘"），不抛；
- 拿到 `incompatible` 时的建议动作是**降级**（不使用本包的共享能力）而不是拒绝挂载；拿到 `ok` + `warning`
  时照常使用、只把那条警告记下来 —— 本包只把裁决与一句话的 `reason` / `warning` 交出去，怎么处理由调用方决定。

## 怎么用

### 安装

```bash
npm install @avantf/dsh-plugin-base
```

### 预装资源

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Provisioner } from '@avantf/dsh-plugin-base'

const home = join(homedir(), '.avantf', 'env')

const provisioner: Provisioner = framework.createProvisioner({ home, logger })
provisioner.register(framework.npmPackageProvider())
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

清单可以离线检查：

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
import { PromptFiles, createPluginLogger } from '@avantf/dsh-plugin-base'

const log = createPluginLogger({ prefix: '@scope/my-plugin' })
const files = new PromptFiles({ dir: join(dataHome, 'prompts'), logger: log })
  .load([{ file: 'my-plugin-prompt.md', fallback: '内置默认正文\n' }])
// files[0].text —— 用户写的正文（逐字），或刚写下的默认正文
```

### 运行时装载（`./bootstrap`）

如果调用方要在**运行时**装载本包（而不是让它出现在自己的 import 图里），本包提供零依赖的
`./bootstrap`：解析本包在哪 → 校验版本落在给定区间 → 动态 `import()`。它**不安装任何东西**，
失败只返回 `undefined` 并给出原因。

```ts
import { loadFramework, readDependencyRange } from '@avantf/dsh-plugin-base/bootstrap'

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

## 边界（不做的事）

- **不做包管理器**：不推导传递依赖、不生成 lockfile、不做版本求解；每个 item 自包含。
- **不接管原生模块**：`binding.gyp` / `*.node` / 依赖 `postinstall` 的包会被识别并拒绝。
- **不跳过校验**：npm 包核对 `dist.integrity`，归档核对 `sha256`。
- **不做进程内预热**：让文件在盘上是框架的事，读进内存是调用方自己的事。

## 版本承诺

- 接口面是 `.` 上的导出（值 + 类型）加上 `./preset` / `./conformance` / `./bootstrap` 三个子路径；`./internal`
  是内部件，从不承诺稳定。
- **当前这一代把 `.` 的整个名字面都算作冻结接口**（每一代的名字面落在 `api/interface-vN.json` 快照里，只增
  不改，该快照随源码在仓库、不进产物）。这是为了让本包自己的重构有一条明确边界而做的**阶段性**取舍，不是
  "这个集合永远不变"：当维护整个名字面的成本超过收益时，稳定承诺会收成 `.` 的一个**稳定子集** —— 新能力
  从明确标注为不稳定的入口引入，既有成员按弃用周期退出，而不是永远要求内部重构服从"整个 `.` 面都是接口"。
  收窄会在本 README 与接口世代里一起体现。
- **接口与包版本是两条轴**：接口换代只升 `INTERFACE_VERSION` 并新增 `api/interface-vN.json`；包版本是
  普通 semver，只表达包自身（行为变更 minor、修复 patch）。
- 顺序敏感的参数一律传**具名对象**（如 `resolveDataHome({ explicit, env, configured })`）；可观察的文案
  由调用方给（如 `compatReport` 的 `words`）。

## 开发

```bash
pnpm check          # 类型检查 + 测试
pnpm build          # tsc → dist/
pnpm pack           # 打包出 tarball
```

## 许可

MIT
