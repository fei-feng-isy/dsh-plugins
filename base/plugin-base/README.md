# @avantf/dsh-plugin-base

> 家族的**一个** base 包：插件启动期的环境初始化框架 + 启动兼容门禁 + 两个插件共用的 kit。

`@avantf/dsh-plugin-base` 把原来分散在 `@avantf/dsh-envinit`（环境初始化框架）与
`@avantf/dsh-compat`（启动兼容门禁）两个包里的代码收成**一个可发布包**，并把两个插件共用的纯逻辑
（prompt 文件层、plugin logger、家族路径、Typert wire 约定）作为 `src/kit/**` 放在同一个包里。
**发布面因此是三个包**：`@avantf/dsh-plugin-base` + `@avantf/dsh-mem` + `@avantf/dsh-work`；
改共用逻辑（envinit / compat / kit 任一处）只需要发一版 base，**不需要重建或重发任何插件**。
旧的 `@avantf/dsh-envinit` / `@avantf/dsh-compat` 留在 registry 上不再发新版。

> 插件启动期的环境初始化：插件只**声明**它需要什么，base 负责把它装到盘上并**报告**。

插件在用户机器上启动时往往缺东西——运行期要用的 npm 包、要调用的命令行工具、要读的模型文件。
`@avantf/dsh-plugin-base` 让插件只写一份清单，其余交给框架：

```
声明 → 探测 → 获取 → 校验 → 报告
```

- 已经在盘上 / PATH 上的直接用，不重复下载；
- 需要安装的下载、校验完整性、原子落盘；
- 每一项给出 `present / installed / skipped / failed`，失败带稳定 `code`。

运行期零依赖：`dependencies` 为空，源码里连 `zod` 都不 import —— 兼容门禁的 typert 探针用的是**调用方自己**的 contribution，本包不造探针形状。`peerDependencies` 仍有一条 `zod`（`>=4.4.3 <5`），理由只有一个：让**插件的** wire 面与宿主解析到同一份 zod（见下）。要求 Node.js >= 22。

## 三部分与"只发 base"

| 部分 | 入口 | 谁在用 |
| --- | --- | --- |
| 环境初始化（原 `@avantf/dsh-envinit`） | `.` 上的 `createProvisioner` / 三个内置 provider 工厂 | 插件的 `bootstrap → 声明 item → 等 blocking 集 → 跑门禁` |
| 兼容门禁（原 `@avantf/dsh-compat`） | `.` 与 `./compat`（同一个模块，`./compat` 复用根导出的那份） | 插件判定"证明不兼容才拒载；测不出来只记一笔；版本差异只警告" |
| 共用 kit | `.` 上的 `PromptFiles` / `createPluginLogger` / `strictCodec` / `familyHome` 等 | 两个插件在 `apply()` 里从**装载后的 base 模块**取 `PromptFiles`（work 另取 `resolveDataHome`）；`createPluginLogger` / `strictCodec` / `familyHome` 是 base 的**规范副本**，目前两个插件仍各自保留等价实现（判据：这条知识必须能靠**一次 base 发布**修好吗？能 → 运行时从 base 取；不能 → 可以留在插件里，但改它要发插件） |

**插件绝不在构建期内联 kit，也绝不静态 import base**：否则 base 缺失时插件模块根本加载不出来，
正是家族禁止的"整行加载失败"。插件只内联**零依赖的 `./bootstrap`**，它动态 `import()` 出 base；
`prompt_files` / `logger` / `typert` / `family` 的源码都在 base 里，插件在 `apply()` 里从那个模块上
取用（当前实际取用的是 `PromptFiles`，以及 work 的 `resolveDataHome`）。
base 缺失或版本不被接受时插件**照常挂载**（WARN + 降级）：prompt 文件层不可用 → 用插件**自带的默认正文**；
兼容门禁不可用 → 走既有的 `compat:` WARNING 路径。

## 核心概念

| 概念 | 含义 |
| --- | --- |
| **item** | 插件声明的一条资源：`id / kind / spec / target.root / onMissing / startup / needs` |
| **kind** | 资源种类。内置 `npm-package`、`binary-archive`、`model-cache`；自定义 kind 由 provider 认领 |
| **provider** | 认领一种 kind、负责这类资源获取与校验的 npm 包 |
| **home** | 受管族根，默认 `~/.avantf/env`；所有受管资源都在它下面 |
| **key** | 资源身份 `kind + name`，多个插件声明同一个资源时只落一份 |

## 怎么用

### 1. 声明依赖

插件把 base 声明为 **peer**（不要放 `dependencies`，否则会装出多份 base 副本）。peer 区间要**足够宽**
以接受 base 的补丁/小版本——`^0.1.0`——否则"只发 base"会被 peer 区间卡死；`devDependencies` 里再声明
同一条区间（本仓是 `^0.1.0`，并由根 workspace 的 `linkWorkspacePackages` 指向 `base/`），供
`pnpm install` 装上：

```jsonc
{
  "peerDependencies": { "@avantf/dsh-plugin-base": "^0.1.0" },
  "devDependencies":  { "@avantf/dsh-plugin-base": "^0.1.0" }
}
```

base 从**插件自己所在的树**往上解析，所以它必须由那棵树提供，而它**保持 required peer**：npm（以及默认
`autoInstallPeers: true` 的 pnpm）在装插件时会自动把它一起装上，多个插件共用提升到顶层的那一份；
pnpm 关掉 `autoInstallPeers` 或 yarn 不会自动装，那时要在宿主/profile 的 `dependencies` 里显式写一条
`"@avantf/dsh-plugin-base": "^0.1.0"`。宿主自己提供的 peer（宿主内部包）才标
`peerDependenciesMeta.optional`，避免包管理器跑去 registry 拉一份宿主内部实现；缺 base 时插件仍降级挂载。

### 2. 内联 bootstrap

唯一需要进入插件产物的是框架的零依赖 `bootstrap`：它只把这份框架解析出来并校验版本，**不安装任何东西**。

- **有打包步骤**：用框架的构建预设，它会强制内联 `./bootstrap`、让框架本包保持外部，并在产物写出后断言这两条：

  ```ts
  import { envinitPreset, assertEnvinitArtifacts, assertEnvinitPresetChecks } from '@avantf/dsh-plugin-base/preset'

  const preset = envinitPreset({ external: [/* 自己的外部名白名单 */] })
  assertEnvinitPresetChecks(preset.checks)
  // bundler：external 用 preset.external，内联 preset.noExternal
  // 产物写出后：
  assertEnvinitPresetChecks(assertEnvinitArtifacts({ artifacts: ['dist/plugin.js'], clientArtifacts: ['dist/client.js'] }))
  ```

- **`tsc` 直出**：把框架发布包里的 `dist/bootstrap.js` 拷进自己的产物，按相对路径 import。

### 3. 启动接线

```ts
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadFramework, readDependencyRange } from './bootstrap.js'   // 内联进来的那份
import type { Provisioner } from '@avantf/dsh-plugin-base'               // 只类型，会被擦除

export async function mount(logger: { warn(message: string): void }): Promise<void> {
  const home = join(homedir(), '.avantf', 'env')
  const range = await readDependencyRange(fileURLToPath(import.meta.url))  // 自己的 peerDependencies

  const framework = await loadFramework<typeof import('@avantf/dsh-plugin-base')>({ logger })
  if (framework === undefined) {
    logger.warn('预装设施不可用，降级挂载')   // 拿不到框架也照常挂载
    return
  }

  const provisioner: Provisioner = framework.createProvisioner({ home, logger, envinitRange: range })
  provisioner.register(framework.npmPackageProvider())
  provisioner.register(framework.binaryArchiveProvider())
  provisioner.register(framework.modelCacheProvider())
  provisioner.declare(manifest)

  // 挂载前必须就绪的项：阻塞等待
  await provisioner.ensure({ only: ['my-plugin:compat'], deadlineMs: 30_000 })

  // 其余项（含 background）后台预装，完成时回调
  void provisioner.ensure({
    onSettled: entry => {
      if (entry.id === 'my-plugin:model' && entry.action === 'installed') useModel()
      if (entry.action === 'failed') logger.warn(`${entry.id}: ${entry.code}`)
    },
  })
}
```

### 4. 写清单

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

- `startup`：`blocking`（缺省，`ensure` 等它）或 `background`（派发后不占预算）。
- `onMissing.atStartup`：`degrade`（缺了也挂载）/ `refuse`；`onMissing.atUse`：`degrade` / `error`。
- `needs`：同一插件内的其它 item id。

`model-cache` 的 `spec.layout` 决定文件怎么落盘，两种取值：

| layout | 落盘形态 | 谁读 |
| --- | --- | --- |
| `hub`（缺省） | `<root>/models--<org>--<name>/{blobs,refs,snapshots/<sha>/<file>}` 的内容寻址快照树 | 认这套缓存形状的客户端 |
| `flat` | `<root>/<org>/<name>/<file>`，文件直接可读；revision 记录与 blob 在 `<root>/.envinit/` 侧车目录 | 直接按 `<repo>/<file>` 路径读取的运行时 |

两种布局共用同一套 revision 解析、文件列表、模型 hub 端点、内容寻址 blobs 与原子落盘；`config.json` 在两种布局里都始终必需，`spec.requiredFiles` 在其上追加。已经落位但内容不对的条目（旧残留、指向错误 blob 的链接、同名目录）会在下次落位时被换成指向正确 blob 的链接。

`probe` 只做廉价的存在性判断（存在、不是目录、大小 > 0），不联网、不改盘；`verify` 才证明内容：

- `hub`：snapshot 里的每一项都指向 `blobs/<sha256>`，逐项核对链接目标、blob 名与内容哈希一致；
- `flat`：侧车记录里带每个文件的 sha256，逐项核对；只有文件名的旧记录仍然接受，不会把已经装好的树判成未安装。

落位与完成标记（`hub` 的 `refs/<revision>`、`flat` 的 `record.json`）在同一把族根锁内完成，所以多个进程安装不同 revision 时，记录与盘上的字节始终一致。

> **只增不减**：受管的模型数据不会回收。`blobs` 与 `snapshots` 永不删除，换一个 revision 就会再存一份；`experimental().prune()` 只是打一条告警的 no-op。

`endpoint` 默认是内置的模型 hub；`policy.mirrors.model` 可以给一组镜像端点（按序尝试，内置端点兜底），`spec.endpoint` 优先于镜像。显式给出空白的 `endpoint`、非法的 `revision`（空、`.`、`..`、绝对路径、反斜杠、控制字符）都会报 `invalid-option`；端点返回的 sha 必须是 40/64 位小写十六进制，内容长度与声明不符的下载会报 `fetch/failed`。例如：

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

### 5. 取用就绪资源

```ts
const state = provisioner.resolve('my-plugin:tool')
if (state.state === 'ready') {
  const entry = state.handle.dir      // 可用入口目录（归档：可执行文件所在目录）
  const env = state.handle.env        // PATH 等环境增量
}
```

`resolve()` 的五个状态：`ready` / `pending` / `failed` / `skipped` / `missing`。
`ensure()` 返回的报告里 `ok` **不**把"还在后台装"算成失败。

### 6. 写 provider（可选）

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
- **不做进程内预热**：让文件在盘上是框架的事，读进内存是插件自己的事。
- **运行期零依赖，peer 只有一条 `zod`**：`dependencies` 为空，本包源码不 import `zod`；`peerDependencies` 里那条 `zod`（`>=4.4.3 <5`）是给**用它的插件**的 wire 面用的 —— 插件、base 与宿主必须解析到**同一份** zod（两份物理副本的 schema 身份不同，strict codec 会因此判不兼容），范围宽到同一份 base 既服务本仓、也服务宿主自带的 4.6.5。**只解析一份**。

## 开发

```bash
pnpm check          # 类型检查 + 测试
pnpm build          # tsc → dist/
pnpm pack           # 打包到 release/ 并断言产物
pnpm release:check  # 发布门禁：typecheck → build → test → pack
```
