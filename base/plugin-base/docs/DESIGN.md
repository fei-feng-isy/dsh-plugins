# 设计说明

`@avantf/dsh-plugin-base` 是一个**插件启动期的环境初始化框架**。插件声明它需要的资源，框架负责
解析、探测、获取、校验与报告。本文只写**契约与不变量**，不写实现细节。

## 1. 目标与非目标

**目标**

- 一份通用编排核心 + 可插拔 provider，新增资源种类不改核心。
- 插件侧只写清单与策略：需要什么、装到哪、失败算降级还是拒载。
- 多插件、多进程安全：同一资源只落一份盘，读者看到的目录永远完整。
- 依赖树坏掉时插件仍能挂载：唯一的运行期要求是框架本包可解析。

**非目标**

- 不做包管理器：不推导传递依赖、不生成 lockfile、不做版本求解。
- 不接管原生模块（`binding.gyp` / `*.node` / 依赖 `postinstall` 的包）：识别并拒绝。
- 不提供"跳过校验"的开关。
- 不做进程内预热：让文件在盘上是框架的事，读进内存是插件的事。

## 2. 架构

```
清单（数据）  items[]: id / kind / spec / target.root / onMissing / startup / needs
   │
provider 层   identify / probe / plan / targetDir / install / verify
   │
编排核心      顺序(DAG) / 预算 / 发布锁 / 原子落盘 / 报告 / 状态
```

分发物：

| 入口 | 用途 |
| --- | --- |
| `.` | base 本体：`createProvisioner`、数据模型、三个内置 provider 工厂，**加上**兼容门禁（原 `@avantf/dsh-compat`）与共用 kit（`PromptFiles` / `createPluginLogger` / `strictCodec` / `familyHome` …） |
| `./bootstrap` | 零依赖、只用 `node:` 内建；被插件**内联**，只解析并校验 base 本包 |
| `./preset` | 构建期预设：强制内联 `./bootstrap` + 产物断言 |
| `./conformance` | provider 一致性套件 |
| `./compat` | 兼容门禁的子路径入口；与 `.` 上是同一份实现 |
| `./internal` | 内部件；不承诺兼容 |

**内联边界**：只有 `./bootstrap` 被内联；base 本包必须是插件的 peer、绝不被 bundle；插件对 base 只能
`import type` 或动态 `import()`，不能有顶层 value import。**kit 也走同一条路**：它的源码在 `src/kit/**`
（同一个包），插件在 `apply()` 里从动态 import 出来的 base 模块上取用，**绝不构建期内联进插件 bundle**——
否则"改共用代码只发一版 base"就不成立。判据是"这条知识必须能被一次 base 发布修掉吗？"：是 → 运行时从
base 取（必要时把用到它的构造挪到 `apply()` 里、拿到 base 之后）；否（只是镜像某个约定的两三行字面量）→
可以留在插件，但改它需要发插件。

## 3. 数据模型

```ts
interface Manifest {
  plugin: string                      // 插件命名空间，item id 必须带该前缀
  items: ProvisionItem[]
  requires?: { capabilities?: string[]; providers?: { package: string; kinds: string[] }[] }
}

interface ProvisionItem {
  id: string                          // 稳定 id
  kind: string                        // npm-package | binary-archive | model-cache | 带前缀的自定义 kind
  spec: unknown                       // 由该 kind 的 provider 解释
  target: { root: string }            // home 下的相对路径；不含版本、不含布局
  onMissing?: OnMissing               // 拿不到时怎么办
  startup?: Startup                   // 挂载时等不等（缺省 blocking）
  needs?: string[]                    // 同插件内依赖的其它 item
  policy?: ItemPolicy                 // 每项策略
  schemaVersion: number               // 描述符版本
}

interface OnMissing {                 // 两条正交的轴，各自缺省
  atStartup?: 'degrade' | 'refuse'    // 缺省 degrade；非法值也按缺省
  atUse?: 'degrade' | 'error'         // 缺省 error；非法值也按缺省
}

type Startup = 'blocking' | 'background'
```

`onMissing` 说"拿不到怎么办"，`startup` 说"挂载时等不等"。合法值之外的取值报
`invalid-option` 后按该轴缺省处理，**绝不默认成 `refuse`**。

### Provider 契约

```ts
interface Provider {
  id: string                          // 第三方 provider 用它自己的 npm 包名
  kinds: string[]                     // 认领的 kind
  identify(item): ResourceIdentity    // 资源身份（name / range），键由核心拼装
  probe(item, ctx): Promise<ProbeResult>          // 廉价探测：不下载、不改盘
  plan(item, ctx): ProviderPlan | Promise<…>      // 纯函数：要做什么，不碰盘不联网
  targetDir(item, ref): string                    // 版本目录相对路径（安全、不含 ..）
  install(item, ctx): Promise<Resolved>           // 锁外下载/解包，经 ctx.publish() 落盘
  verify(item, resolved, ctx): Promise<void>      // 证明拿到的东西能用
}
```

- `install` 只能通过 `ctx.publish(staging, meta)` 落盘：核心在 staging 内写清单，再持发布锁原子改名。
- 绝对目标与版本段由核心决定；provider 只给相对子路径。
- `verify` 失败由核心把该版本目录改名隔离，下次重取。

### 报告与状态

```ts
interface ProvisionReportEntry {
  plugin: string; id: string; key: string
  action: 'present' | 'installed' | 'skipped' | 'failed'
  source: ResourceSource; version?: string; ms: number
  code?: ProvisionCode; reason?: string
}

type ResourceState =
  | { state: 'ready'; handle: ResourceHandle }
  | { state: 'pending'; since: number }
  | { state: 'failed'; code: ProvisionCode; detail?: string; retryAfter?: number }
  | { state: 'skipped'; code: ProvisionCode; detail?: string }
  | { state: 'missing' }
```

`skipped`（策略性跳过）与 `failed`（真失败）严格区分；失败必须带稳定 `code`。

## 4. 启动时序

1. **bootstrap（内联）**：从调用方依赖树解析框架本包，校验它落在 `supportedRange` 内，动态
   `import()`。解析不到或超范围 → 一条 WARNING + `undefined`，绝不抛错、绝不另装一份。
2. **装载框架**：此后编排、锁、报告都归框架。
3. **声明**：`register(provider)` + `declare(manifest)`。声明不联网、不碰盘。
4. **等 `blocking` 项**：清单里 `startup` 非 `background` 的项在本步等待；`needs` 闭包一并提升。
5. **派发 `background` 项**：立刻派发、不占预算；完成时经 `onSettled` 与 `availability` 通知。

区间判定分两层：**框架本包版本**不满足 bootstrap 的 `supportedRange` ⇒ 实例级降级（第 1 步
返回 `undefined`）；**已装载框架**不满足插件声明区间（`envinitRange`）⇒ 该实例的清单全部
`skipped(unsupported-envinit)`，插件照常挂载。

## 5. 磁盘布局

```
<home>/                       # 默认 ~/.avantf/env
├── runtime/…                 # npm 包：<name>/<版本段>/node_modules/<name>
├── tools/…                   # 二进制归档：<id>/<版本段>/bin/<binary>
├── models/                   # 模型缓存（两种落盘布局）
│   ├── models--<org>--<name>/{blobs,refs,snapshots/<sha>/<file>}   # layout: hub（缺省）
│   ├── <org>/<name>/<file>                                        # layout: flat，运行时直接读
│   └── .envinit/<...>/{blobs,record.json}                         # flat 的侧车状态
└── .envinit/                 # 控制面：锁、状态、临时、隔离
```

- 落盘单位是**版本目录**，只增不改；目标已存在且版本一致即复用，否则改名隔离后重新落位。
- 控制面只落在 `<home>/.envinit/` 下。provider 也可以在自己的资源根下开一个 `.envinit/` 侧车
  （`flat` 的 revision 记录与 blobs），它只放元数据与内容寻址内容，不进运行时读取的目录。
- `home` 必须位于单一文件系统：跨设备改名报 `publish/cross-device`，不降级为复制。

### `model-cache` 的两种布局

`spec.layout` 是**落盘布局**这一维，取值中立地描述形状，不绑定任何具体运行时：

| layout | 数据目录 | 版本/revision 记录 | 判据 |
| --- | --- | --- | --- |
| `hub`（缺省） | `<root>/models--<org>--<name>/snapshots/<sha>/<file>` | 同目录 `refs/<revision>` | `refs` 指向的 snapshot 存在、必需文件在，且每条目指向 `blobs/<sha256>` 的内容寻址 blobs |
| `flat` | `<root>/<org>/<name>/<file>` | `<root>/.envinit/models--<org>--<name>/record.json`（侧车） | 侧车记录与本项 revision 相符，文件在，且内容与记录里的 sha256 或它指向的 blob 名一致 |

不变量：

- 两种布局共用同一套 revision 解析、文件列表、`spec.endpoint` / `policy.mirrors.model`、内容寻址
  `blobs`、原子落盘、`verify` 与报告；布局只改"数据目录怎么摆"，不改"怎么取"。
- `probe` 只做廉价的存在性判断（存在、不是目录、大小 > 0），不联网、不改盘；`verify` 才证明内容：
  `hub` 按"条目 -> `blobs/<sha256>`"核对链接目标、blob 名与内容哈希，`flat` 按记录里的 sha256 核对。
- `flat` 的侧车只放 revision/版本记录与 blobs，**不进运行时直接读取的目录**；记录最后一次原子写入，
  它的存在即"这份树已完整"的完成标记。记录里的每文件 sha256 是扩展字段：只有文件名的旧记录仍然
  接受（内容无法离线证明时退化为存在性判断），已装好的旧树不会被丢弃。
- `config.json` 在两种布局里都始终必需，`spec.requiredFiles` 在其上追加。
- 端点优先级：`spec.endpoint` > `policy.mirrors.model`（按序）> 内置端点；显式空白的 `endpoint`
  报 `invalid-option`。
- 路径安全：解析出的 sha 必须是 40/64 位小写十六进制；`spec.revision` 必须是安全的相对引用
  （非空、无 `.` / `..` 段、非绝对、无反斜杠与控制字符，允许 `release/v1` 这样的嵌套引用）；
  `refs/<revision>` 读回的值也必须是一个 sha，否则视为未缓存。repo/revision 变成路径段时反斜杠按
  分隔符规整。
- `install` 的下载在锁外，**最终落位与完成标记（`refs` / `record.json`）在同一把族根锁内**完成；
  多个进程安装不同 revision 时，完成标记描述的字节与盘上的一致。
- `model-cache` 是受管例外：它不写 `install.json`、不走 `ctx.publish()`，`Resolved.dir` 就是那份
  数据目录／snapshot；`verify` 失败时核心仍会把 `Resolved.dir` 改名隔离。
- **只增不减**：受管的模型数据只增长，`blobs` 与 `snapshots` 永不回收，换一个 revision 就会再存
  一份；`experimental().prune()` 是显式告警的 no-op，本发行版不做 GC。


## 6. 关键不变量

- **预装永不抛错**：失败进报告，由策略层决定降级还是拒载。
- **校验不可跳过**：npm 包核对 `dist.integrity`，归档核对 `sha256`。**内容**校验失败（校验和/完整性
  不符）是终局，不再落到下一个镜像 —— 字节完整但内容不对，换个源并不能把它变对。**传输**失败才是
  可重试的：HTTP 非 2xx、网络错误，以及"响应声明的内容长度与实读不符"（那是一次被截断的下载，
  正是该换源的形状），三条都记进 `problems` 后试下一个候选源，全失败才 `fetch/failed`。
- **发布互斥**：一把族根发布锁；下载与解包在锁外，锁内只做原子改名；`model-cache` 也持这把锁完成
  最终落位与完成标记。
- **原子落盘不留垃圾**：同目录临时文件要么被改名成完成品，要么在恢复时被清掉（完成标记目录在锁内
  清，其余目录清掉超过年龄阈值的残留）。
- **状态按 `key × version` 合并**：多进程写入按该身份合并，不整文件覆盖。
- **base 自身零运行期依赖**：`dependencies` 必须为空，唯一的 peer 是宿主给的 `zod`（兼容门禁的 typert
  探针要用同一份 schema identity）。`preset/framework-self-contained` 断言这条；多一条依赖或多一个 peer
  都算基座不再自包含。

## 7. 版本与兼容

| 轴 | 载体 | 不兼容时的动作 |
| --- | --- | --- |
| 框架 API | `@avantf/dsh-plugin-base` 的 semver（插件在 peer 声明） | 包管理器在安装期拦；运行期报 `unsupported-envinit`，跳过清单 |
| bootstrap | `./bootstrap` 的版本常量 + `supportedRange` | 构建期断言版本落在插件声明的区间内；运行期超范围即降级 |
| item 描述符 | `ProvisionItem.schemaVersion` | 高于本实现 ⇒ 该项 `skipped(unsupported-item-schema)` |
| 磁盘布局 | `<home>/.envinit/.layout.json` | 更高或布局名不同 ⇒ 该 home 只读不写 |
| 状态面 | `status.json` 的 `schemaVersion` | 更高 ⇒ 只读旧文件，状态面降级为空 |
| 声明登记表 | `declared.json`（`Record<key, {plugin,pid,at}[]>`）**没有**版本字段 | 靠上面那条布局裁决保护：只读时连它也不写（写入排在 `checkHome()` 之后） |

框架本包只作为插件的 **peer**：放进 `dependencies` 会得到多份副本，跨副本的 registry 与
identity 会分叉。**发布顺序是 base 先于两个插件**：同仓的发布脚本在发布插件前断言 registry 上已有兼容
区间内的 base 版本。kit 与兼容门禁都在这一个包里，所以"改共用逻辑"等于"发一版 base"——插件的 peer 区间
（`^0.1.0`）要足够宽以接受 base 的补丁/小版本，否则这条会被 peer 区间卡死。

## 8. 公共 API

```ts
createProvisioner(options: ProvisionerOptions): Provisioner

interface Provisioner {
  register(provider: Provider): Disposable
  declare(manifest: Manifest): void
  plan(options?: { only?: string[]; offline?: boolean }): Promise<Plan>
  ensure(options?: EnsureOptions): Promise<ProvisionReport>
  resolve(itemId: string): ResourceState
  status(): readonly ProvisionStatus[]
  repair(itemId: string): Promise<ProvisionReport>
  experimental(): ProvisionerExperimental
  dispose(): void
}

interface EnsureOptions {
  only?: string[]
  offline?: boolean
  signal?: AbortSignal
  deadlineMs?: number                                   // 覆盖本次调用的启动预算
  onSettled?: (entry: ProvisionReportEntry) => void      // 每项到达终态时回调
  onProgress?: (event: ProgressEvent) => void            // 下载/解包字节进度
}
```

```ts
interface ProvisionerOptions {
  home?: string                    // 受管族根，默认 ~/.avantf/env
  layout?: string                  // 布局名，默认 v1
  envinitRange?: string            // 插件声明的框架区间
  policy?: ProvisionPolicy         // 闸门 / 镜像 / 预算
  logger: ProvisionLogger
  fetch?; fs?; lock?; clock?       // 注入接缝
}
```

`ProvisionPolicy` 当前实际读取 `autoDownload`（整体或按 kind）、`mirrors`（`archive` / `npm` /
`model` 三个网络）、`deadlineMs`；
`quotaBytes` / `trashGraceMs` / `gc` / `preloaded` / `packumentMirrors` 与 `ItemPolicy` 的
`concurrency` / `timeoutMs` / `platforms` 尚未生效，设置它们会收到 `ignored-field` 告警。
`experimental().prune()` 是显式告警的 no-op：受管模型数据只增不减，`blobs` / `snapshots` 不回收，
换一个 revision 就会再存一份。

内置 provider：`npmPackageProvider()`、`binaryArchiveProvider()`、`modelCacheProvider()`。
`./conformance` 与 `./preset` 的用法见 [README.md](../README.md)。
