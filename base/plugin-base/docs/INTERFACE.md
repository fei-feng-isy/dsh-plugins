# 接口冻结与接口版本

> **这份文档说什么**：`@avantf/dsh-plugin-base` 的**公开接口**由什么构成、怎么把它冻成一件可机械检查的
> 事实，以及版本号该表达什么 —— 接口变了（不兼容）／行为或流程变了（兼容）／只是修了 bug。
>
> **不是什么**：不是**已实现**的说明。本文档 §7 逐条列出"已有 / 待做"，读代码前先看它，不要把这些规则当成
> 今天的运行行为。本文档住在仓库里（base 的 npm 产物只带 `dist` + README），面向使用者的那一句契约写在
> `../README.md` 的「版本承诺」。
>
> **两件把它逼出来的事**：① `0.1.0 → 0.2.0` 那次，两个插件必须**同批**改 peer 与 `supportedRange` ——
> 0.x 的 caret 不跨 minor，于是"base 单独修好共享代码"既传不到安装期、也传不到运行期。这件事的结论**不是**
> "赶紧走到 `1.0.0`"，而是**把接口从包版本里拆出来**（§1、§6）：接口有自己的世代号与快照，由 base 的
> **运行期门禁**裁决；包版本退回普通 semver，peer 区间放宽成不锁步的比较符区间。② `resolveDataHome`
> 的**语义**变过一次而名字没变（"插件 profile 的 `dataHome` 该放哪个 slot"），数据根因此换了目录，而
> 名字面快照与类型系统都抓不到它 —— 接口不只是名字。

---

## 1. 版本号要说什么

有**两条彼此独立的轴**，这是本文件全部结论的出发点：

- **接口版本** = `INTERFACE_VERSION`（世代号）+ `api/interface-vN.json`（该代名字面的快照）。它是兼容性的
  **主契约**，由 base 的**运行期门禁**裁决（§3）：插件构建期把世代号烘进产物，启动时与加载到的 base 比对。
- **包版本** = `base/plugin-base/package.json` 的**普通 semver**。它只表达**包自身**（新增行为、修 bug），
  **不再**与接口绑定 —— 接口换代**不再**要求提 major。今天 base 是 **`0.3.0`**；两个插件声明同一条宽区间
  `>=0.3.0 <1.0.0`，所以一次 base 发版不必等插件同批改。

| 变更 | 接口版本（主契约） | 包版本 | 插件是否必须同批改 |
| --- | --- | --- | --- |
| **接口**：`.` 的导出集合、类型形状、顺序敏感参数的 slot 含义、语义契约 | `INTERFACE_VERSION` +1，新增 `api/interface-vN.json` | 由包自身决定（普通 semver；**不再**是"接口变 ⇒ major"） | **否** —— 宽 peer 收得下；旧插件在运行期被判 `incompatible`，按降级路径挂载（§3） |
| **业务流程 / 可观察行为**（插件测试断言的那些） | 不变 | minor | 否 |
| **纯修复**，无可观察变化 | 不变 | patch | 否 |

`INTERFACE_VERSION` **现在是 2**。v1 从未发布（registry 上只有 `0.1.0` / `0.2.0`，它们没有这套机制），所以
v1 期间给同一代增面（新增门禁函数）是合法的**就地精修**。v1 → v2 是一次**增量换代**：把共享 kit 的良构文本
两个成员（`wellFormedText` / `wellFormedDeep`，§8）收归 base。增面走正常换代流程而不是继续就地精修，理由
有两条：① 这一代**仍未发布**，正是把最后一个已知共享缺陷在发布前定形的窗口 —— 一旦两棵树各自带一份本地
副本发了版，重复实现就成了既成事实；② 换代在 diff 里留下一个数字（2），"新成员属于哪一代、旧插件在哪一代
降级"不必读人话。v1 的接口类型与快照**原样保留**，因为两个插件此刻仍编译在 `BaseRuntimeV1` 上，而 v2 是它
的**超集**（§5）。

## 2. 接口面由三层构成，三层都要冻结

1. **名字面** —— `.` 的导出（值 + 类型）。**已经**由 `test/public-surface.spec.ts` 的 equality 门禁钉住
   （`missing === []` 那种子集断言抓不到"多导出了一个"），而那份清单**只有一处**：接口类型
   `src/interface.ts` 的 `VALUE_NAMES_V2` / `TYPE_NAMES_V2`（当前世代）与冻结的 `VALUE_NAMES_V1` /
   `TYPE_NAMES_V1`（v1 的记录；门禁顺手断言 v2 是 v1 的超集），落盘成 `api/interface-v2.json` 与
   `api/interface-v1.json`；`./internal` 是内部件，不在面上。
2. **形状面** —— 类型签名与参数形状。**已经**由编译保证，两半都成立：
   - **kit 半边**：插件把加载到的模块定型成接口类型 `BaseRuntimeV1`（`import type`，见
     `test/interface.spec.ts` 两条），`kit.resolveDataHome` / `kit.PromptFiles` 的签名一变就编译红
     （`0.1.0 → 0.2.0` 那次 mission 被迫改 `promptDir` 就是它在起作用）。当前世代是 `BaseRuntimeV2`，
     它 `extends BaseRuntimeV1`，所以"旧插件编译在 v1 上、新 base 仍满足它"是编译期保证，而不是约定。
   - **gate 半边曾经不成立**：mission 把真实模块用 `framework as unknown as CompatModule` 塞进它手写的
     `CompatModule`，编译器不做任何结构核对 —— 而 gate 正是语义最容易变的那半。已改成**只对测试缝做
     转换**：`const gate: CompatModule = options.compatModule ?? framework`（半成品的注入仍然转换，合理；
     真实模块直接接受结构核对）。顺带得到一个免费的一致性检查：mission 手写的 11 项与 base 实际导出的形状
     一旦对不上，立刻编译不过。
   base 现在**拥有**接口类型：`BaseRuntimeV2`（值面，真实模块可直接结构化赋值给它 —— 少一个成员就编译
   不过）与 `BaseTypeSurfaceV2`（类型面，`keyof` 就是类型名单），以及它们所扩展的 v1 名字。插件不再各自
   手写一份子集、各自承担"写漏了没人知道"的风险（§7 第 4 步）。
3. **语义面** —— 函数"做什么"的契约（数据根的层序、prompt 文件的 ensure/read/fallback、
   `compatReport` 的结构、provisioner 的终态与 `code`…）。这一层**机器抓不到**，所以只能靠 §4 的三条
   规则（其中第 3 条就是「给它一条跨树行为测试」）+ `DESIGN.md` §7 的协议面版本表来钉。每个带语义的成员
   现在都有那条跨树测试（`mem/.../test/interface.spec.ts`、`mission/.../test/interface.spec.ts`）。

## 3. 接口版本与运行期门禁（门禁在 base 里）

**已经实现**：base 导出整数 `INTERFACE_VERSION`；两个插件的 `scripts/link-envinit.mjs` 在 vendor bootstrap
的同一步把 `{ baseVersion, interfaceVersion }` bake 进 `lib/interface-version.json`（随包发布）。启动时插件
**读自己 bake 的 required → 调 base 的门禁 → 按 verdict 行事**。

门禁是 `.` 上的两个成员（它们本身就是 v1 面的一部分，由快照钉住）：

- `checkInterface(required: number, module: { readonly INTERFACE_VERSION?: unknown })` →
  `{ status: 'ok' | 'incompatible' | 'cannot-tell', required?, loaded?, reason? }`。**纯函数、双向、永不抛**：
  读 `module.INTERFACE_VERSION` 有守卫（取属性就抛的敌意 module 只读成"没报"），`reason` 是调用方可以
  原样打日志的一句话。两个方向都判：插件比 base 新 **和** 插件比 base 旧，都是 `incompatible`。
- `readInterfaceRequirement(url)` → `{ baseVersion, interfaceVersion }`；文件缺失或畸形返回 `undefined`
  （"没 bake"），不抛。这是**插件启动路径**上的读取实现；写的那一侧是
  `scripts/lib/interface-version.mjs`，而 build 侧的 `--check` 用那份共享脚本自带的 reader（它要在所 vendor
  的 base 可导入之前就跑），两处字段名是同一件事实。

这条门禁现在**是主契约，所以它有后果**（家族不变量：**绝不拒载**）：

| verdict | 后果 |
| --- | --- |
| `ok` | 照常使用 base 的共享能力。 |
| `incompatible` | 一条 `WARNING` + **不使用该 base 提供的共享能力**：prompt 文件层按"base 不可用"用**插件自带的默认正文**、兼容门禁**跳过**、provisioning 走 **legacy** 路径。**工具 / service / Remote / UI 照常挂载** —— 这条路径就是既有的"base 拿不到"降级路径，只是触发条件多了一个。 |
| `cannot-tell` | 一条 `WARNING`，**照常使用** —— "说不清 ≠ 不兼容"。加载到的 base 没有门禁函数（只可能是 peer 区间外的老 base，而 peer 已排除）、bake 记录缺失/畸形，都落在这里。 |

**为什么它从"只告警"变成了"告警 + 降级"**：上一轮实现与文档把它写成纯信号，理由是"超出 `supportedRange`
的 base 在更早一步就被拒了，能走到比较的必然是违反 §1 规则的发版，能力仍然可用"。这个理由在本文件这一版
里**不再成立**：`supportedRange` 已经放宽成 `>=0.3.0 <1.0.0`（§6），它**故意**放行 base 的 minor —— 也就
故意放行摆在门后的整个世代差；而接口既然升格成主契约，"另一个世代"就不该再被当成一条备注。于是 verdict
有了后果：`incompatible` 不用它的共享能力，但**仍然挂载**。这也让"接口世代"与"包区间"各司其职：
`supportedRange` 是包的运行期门（超出即拒绝提供框架、退回 legacy），package peer 是安装期门，
`INTERFACE_VERSION` 是**同一区间内的世代**门。

为什么不用包版本当运行期的门：包版本每次发版都动，拿它当门会让 patch/minor 也告警 —— `supportedRange`
正是如此。接口编号只在换代时动，于是"base 单独修好共享逻辑、插件零改动"在运行期也成立（新 base 报同一个
世代 ⇒ `ok`）。

**bake 是双向断言的，且由既有 link 步骤重烤**：这条机制与每个插件的 `dsh-build.json` 是同一个，而那个
机制的静默失败本仓付过代价（bake 少一项 ⇒ 门禁回落到 peer 区间下限）。实现里两条都在：① 两个
`scripts/link-envinit.mjs` 在 vendor bootstrap 的同一步写 `lib/interface-version.json`，`--check` 按字节
与"当前 base 会写出什么"比对（声明侧 / bake 侧）；插件启动时把 bake 出的编号与加载到的 base 报出的编号
比对（bake 侧 / 运行侧）—— 两侧现在都走 base 的 `readInterfaceRequirement` / `checkInterface`；② 重烤
**就是**那条既有步骤，`pnpm build:dsh` 已经会跑它，不靠人记得重跑。

## 4. 三条写法上的硬规则（都是踩过的）

- **顺序敏感的语义必须用具名对象承载。** 反例：`resolveDataHome(explicit, env, common)` —— 名字没变、
  参数个数也是三个，但"插件 profile 的 `dataHome` 该放哪个 slot"一变，数据根就变了；名字面快照与类型
  都抓不到，只有人读 diff 才能发现。正例：`compatReport(verdict, words)`。规则：只要**参数顺序**或
  **某个 slot 的含义**是契约的一部分，就改成 `{ … }` 对象 —— 形状一变，快照门禁与类型都会报。
  **但它不充分，得看清边界**：具名对象挡的是"值放错了 slot"（逼你写出 `common:` 这个键），挡不住
  "同一个键的含义变了" —— 原事故正是后者。
- **可观察的文案归调用方。** `compatReport` 的尾行曾是硬编码中文 —— 一个发布到 registry 的通用包不该
  替调用方决定语言。接口里只留结构，措辞由调用方传入（现在它由 `words.logPointer` 提供）。
- **每个带语义的接口成员必须有一条跨树行为测试。** 语义面机器抓不到（§2 第 3 层），唯一被证明有效的形状
  是跨树比对**行为**：`mem/packages/plugin/test/family_pin.spec.ts` 从**已链接的 base** 取真实实现，与
  `@avantf/mem-contract`、mem core 两份副本逐个输入比对（含曾经发散的那两组）。规则：接口类型
  （`BaseRuntimeV2`）的每个带语义成员 —— 路径解析、prompt 文件的 ensure/read/fallback、报告结构、
  provisioner 的终态与 `code` 表、良构文本的修复结果 —— 都要有一条这样的测试；**在 base 缺席时的假件
  （mock）里断言不算**，那只能证明假件自己自洽。这条是把"语义也是接口"从口号变成可执行形态的唯一办法，
  所以它随接口类型一起写（§7 第 4 步）。**注意这些测试住在插件的门禁里** —— 只有插件能链接 base，所以
  base 自己的 `release:check` 跑不到它们。这不是缺陷，但意味着：**手工发 base 之前必须把两个插件的门禁
  一起跑**（`AGENTS.md` 的「改动 `base/**` 之后」那条规则就是它），否则"语义也是接口"在 base 自己的发布
  路径上仍然是空的。v2 的良构文本成员**尚未**有跨树 pin：那条测试只能住在两棵插件树的门禁里，而它们
  此刻正由另两条车道改动（§8）。

## 5. 冻结怎么执行：快照 + 门禁

1. `api/interface-vN.json` **只记名字面**：`.` 的值名集合、类型名集合，以及各自的条数。**v1 冻结的是落地
   顺序第 2 步之后的形态** —— 那次具名化是唯一的破坏性改动，而它先发生。之后 v1 又**就地**加过一面
   （运行期门禁的 `checkInterface` / `readInterfaceRequirement`，§3）：这一代从未发布，所以在同一代里精修
   是合法的。**v2 是新的一代**：v1 的快照与类型原样留档，v2 = v1 + 良构文本两个成员（§8），并且门禁断言
   v2 是 v1 的**超集**（值名多两个，类型名不增），所以"增量"是可机械检查的，不是一句承诺。换代（新建
   `interface-v(N+1).json` + 常量加一）此后只在对已发布世代做**破坏性**改动时才发生。
   **不哈希任何东西**：哈希名字没有信息量（名字就在同一个文件里逐字列着），哈希声明文本（`.d.ts` 片段）会被格式、
   注释、参数名与换行一改就翻 —— 那种门禁要么被天天重新冻结（然后没人再看），要么被加白名单绕过。
2. 形状面交给编译（§2 第 2 层，两半都已受保护），语义面交给 §4 第 3 条的行为测试。快照只做它真正独一无二
   的那件事，于是这一步从"一个新的冻结机制"降成"一份 equality 白名单的落盘"。
3. **接口只有一个载体**：快照**由接口类型派生**（`VALUE_NAMES_V2` / `TYPE_NAMES_V2` 就是
   `BaseRuntimeV2` / `BaseTypeSurfaceV2` 的成员名单，`satisfies` 让漏写与多写都编译不过）；`interface-vN.json`
   文件名里的 N 与导出的 `INTERFACE_VERSION` **同源**（`test/public-surface.spec.ts` 断言"文件名 N ==
   导出的常量 == 快照里的 `interfaceVersion`"）。否则就会出现"JSON 说 v2、常量说 1"这种只有人读 diff
   才能发现的错位 —— 而那正是本文档要消灭的失败形状（本仓对"同一事实的第二份载体"已有定论：见
   `scripts/lib/versions.mjs`、`family.ts` 的跨树 pin、`dsh-build.json` 的双向断言）。
4. 门禁（`public-surface.spec.ts`，在 base 的 `release:check` 的 test 一步里）：代码里实际的导出集合必须
   与快照**完全相等**；不等时只有两条路 —— 删掉误加的导出，或升 `interface-v(N+1).json` 并把
   `INTERFACE_VERSION` 加一（接口变更）。于是"接口变了"必然在 diff 里出现一个数字，评审看得见；
   `public-surface.spec.ts` 里没有第二份白名单，快照就是那份 equality 清单。
   重切快照是**显式**动作，测试自己绝不改写它：`UPDATE_INTERFACE_SNAPSHOT=1 pnpm -C base/plugin-base
   test public-surface`。它只重新落盘，**不会**替你决定要不要升 `INTERFACE_VERSION`、也不会新建
   `interface-v(N+1).json` —— 那是一次接口换代，必须由人显式做（新增文件 + 常量加一 + 版本决定）。
   v2 的门禁在 equality 之外多断言两条：① `VALUE_NAMES_V2` / `TYPE_NAMES_V2` 是
   `VALUE_NAMES_V1` / `TYPE_NAMES_V1` 的超集，且只多了那两个良构文本成员（`TYPE_NAMES_V2` 长度不变）；
   ② 留档的 `api/interface-v1.json` 仍与 v1 名单逐字相等。于是"增量换代"既写在注释里，也钉在测试里。
   两个名字名单本身也不在运行期导出（它们是门禁的数据，不是 API）：把清单放进它自己描述的面里，
   会让"接口快照"变成自指的。

## 6. 宽 peer + 接口门禁取代了"必须走到 1.0.0"

0.x 的 caret **不跨 minor**（`^0.2.0` 不接受 0.3.0），这是最初那件事的根源。但答案**不是**"赶紧走到
1.0.0、靠 caret 自动送达"：那只是把"同批改"换成"一个与包版本绑死的隐式契约"，而包版本每次发版都动，
既说不清"接口是哪一代"，也挡不住一次把接口变更塞进 minor 的发版。答案是**两条轴各自解决各自的**：

1. **安装期**不再锁步：两个插件的 base peer 与 `devDependencies`、以及 `bootstrap.ts` 的 `supportedRange`
   都写成 **`>=0.3.0 <1.0.0`** —— 一个普通比较符区间，收得下 base 的每一次 minor/patch，停在下一个
   大世代。base 的包版本退回 **`0.3.0`**（从 `1.0.0` 降回来）：它现在只表达包自身。
2. **运行期**由接口门禁裁决：区间内的 base 若报出**另一个 `INTERFACE_VERSION`**，插件按 §3 的降级路径
   挂载（用自带默认正文、跳过门禁、legacy provisioning），**绝不拒载**。

于是"接口变更不再要求插件同批改 peer"：旧插件会在运行期被判 `incompatible` 并按降级路径挂载，插件作者
要跟进时只需在方便的时候重建——而**重建之所以必要，只因为它要消费新世代的能力**，不是因为安装器会拒绝。

代价要认：冻结点之后内部重构要绕开 `.` 面，接口换代要走弃用周期。**当时是最便宜的时机** —— 消费方只有
本仓两个插件，且合并后的它们尚未发布（npm 上的 `@avantf/dsh-mem@0.1.1` / `@avantf/dsh-mission@0.1.0`
是合并前的旧产物，peer 还指向已死的 `@avantf/dsh-envinit`）；这也正是这次一次性把具名化、快照、接口类型
与接口编号都做完的理由。

**什么时候该解开**：出现第一个**仓外**消费者之后，"内部重构要绕开 `.` 面"的代价就不再被收益覆盖 ——
那时该做的是把 `.` 面收成一个**稳定子集**（新成员先进 `./experimental`，或按 `@deprecated` 走弃用周期），
而不是继续要求内部重构服从"整个 `.` 面都是冻结接口"。冻结是**当下这个阶段**的取舍，不是永久状态；把这条
写出来，是为了让后来者知道它是一笔可以重新算的账。

## 7. 实现清单：已有 / 待做

| 块 | 状态 |
| --- | --- |
| `.` 名字面的 equality 门禁、`./internal` 隔离 | 已有 —— 门禁是 `test/public-surface.spec.ts`，**由 `api/interface-v2.json` 驱动**（清单只有一份：接口类型 `src/interface.ts` 的 `VALUE_NAMES_V2` / `TYPE_NAMES_V2` 是载体，快照是它的落盘；`VALUE_NAMES_V1` / `TYPE_NAMES_V1` 与 `api/interface-v1.json` 作为 v1 留档，并被断言是 v2 的子集） |
| 插件对 base 的 `import type` 与模块定型（签名变化 ⇒ 插件 typecheck 红） | 已有 —— **两半都成立**：kit 一直是，gate 半边在 mission 改成"只对测试缝做转换"之后才成立（§2 第 2 层） |
| `DESIGN.md` §7 的四张协议面版本表（item / layout / status / declared） | 已有 |
| `resolveDataHome` 改具名对象（§4 第 1 条；同时是一次接口变更） | **已有** —— 三处都收成具名 slot，不再有位置参数：base kit 与 mission `promptDir`/本地兜底是 `{ explicit?, env?, configured? }`，`@avantf/mem` 引擎是 `{ common, explicit }`（`common` 承载层 ② 的配置对象，因为它读的是 `Pick<Config,'dataHome'>`；名字不同，槽位语义相同，且都在编译期挡住"配置值放进 explicit slot"）。`family_pin.spec.ts`（跨树）、`family_paths.spec.ts`、`data_home.spec.ts`、`prompt_files.spec.ts` 同步 |
| `api/interface-v1.json` 快照（只记名字面）与"变了就必须升编号"的门禁 | **已有** —— v1 留档在 `base/plugin-base/api/interface-v1.json`；当前世代是 `api/interface-v2.json`，门禁断言快照 == 接口类型的两份名单 == 代码实际导出（两向相等），且 v2 ⊇ v1、只多两个值名；不等时只能删导出，或新增 `interface-v(N+1).json` 并升 `INTERFACE_VERSION` |
| 接口类型 `BaseRuntimeV2`（= `BaseRuntimeV1` + 良构文本）+ 每个带语义成员的跨树行为测试 | **已有** —— `src/interface.ts` 的 `BaseRuntimeV2`（值面，可结构化赋值；`extends BaseRuntimeV1`，v1 名字继续导出）+ `BaseTypeSurfaceV2`（类型面，`keyof` 就是类型名单）；快照由它们派生。跨树行为测试在 `mem/packages/plugin/test/interface.spec.ts` 与 `mission/packages/plugin/test/interface.spec.ts`，覆盖路径解析、`PromptFiles` 的 ensure/read/fallback、`compatReport` 的结构与文案归属、provisioner 的终态与 `code` 表，以及 bake 出的编号 == 加载到的 base 报出的编号（都是真实实现，不是 mock）。**v2 新增的良构文本成员还没有这条 pin**（见 §8 的"待补"） |
| 良构文本 kit（`wellFormedText` / `wellFormedDeep`，v2 新成员） | **已有（实现 + base 侧测试）** —— `src/kit/wellformed.ts`，在 `.` 上、零运行期依赖；单字符串修复优先用 `String.prototype.toWellFormed`，缺失时走等价的 `charCodeAt` 扫描；递归版只碰字符串、数组与**普通对象**（含键），其它类型（含 `Date` / `Map` / 类实例 / 带 `toJSON` 的对象）按同一性原样返回。base 侧 `test/wellformed.spec.ts` 覆盖双向证据、降级路径与幂等。**跨树行为 pin 待补**（§8） |
| `INTERFACE_VERSION` 与插件的构建期 bake + 运行期门禁（双向断言、由 link 步骤重烤） | **已有** —— base 导出整数 `INTERFACE_VERSION`；两个 `scripts/link-envinit.mjs` 在 vendor bootstrap 的同一步把 `{ baseVersion, interfaceVersion }` 写进 `lib/interface-version.json`（`files` 随包发布），`--check` 按字节比对；启动时插件用 base 的 `readInterfaceRequirement` 读自己的 bake、再调 base 的 `checkInterface`：`incompatible` ⇒ 一条 `WARNING` + 不用 base 的共享能力（自带 prompt 正文、门禁跳过、legacy provisioning）但**照常挂载**，`cannot-tell` ⇒ 一条 `WARNING` 并照常使用（§3）。**双向**断言：①bake 的编号 == base 当时的编号（两个 `link-envinit.mjs` 的 `--check`），②声明/bake 编号 == 加载到的 base 报出的编号（插件启动路径 + 两条跨树测试） |
| 门禁搬进 base（§3 的核心） | **已有** —— `.` 导出 `checkInterface(required, module)` 与 `readInterfaceRequirement(url)`；两者都在 `BaseRuntimeV2` / `VALUE_NAMES_V2` 与快照里（v1 期间就地精修，v2 的增量把这些名字一并继承）。插件只保留**消费**与"加载到的 base 没有这个函数 ⇒ `cannot-tell`"的兜底（老 base 必须还能被装上）。base 侧测试 `test/interface_gate.spec.ts` 覆盖三种 verdict、两个方向、缺常量/敌意 module、bake 记录缺失/畸形；两个插件的 `test/interface.spec.ts` 与 `test/envinit.spec.ts` 覆盖跨树消费与降级后果 |
| 包版本退回普通 semver + 宽 peer（§1、§6） | **已有** —— `base/plugin-base/package.json` 是 **`0.3.0`**，两个插件的 peer 与 `devDependencies` 是 **`>=0.3.0 <1.0.0`**，`bootstrap.ts` 的 `VERSION` = `0.3.0`、`supportedRange` = `>=0.3.0 <1.0.0`，`pnpm version:check` 绿；接口变化不再要求插件同批改 peer，由运行期门禁按降级路径兜住 |

**落地顺序**（第 1–6 步都已完成；保留下面的原始顺序说明，因为它是这几步为什么按这个次序落地的依据 ——
第 2 步是后面几步的前提：形状不收成对象，"语义"就没有可检的落点；快照排在接口类型之前，是为了在起草
`BaseRuntimeV1` 的过程中先把名字面锁住）：

1. ✅ **mission 的 gate 半边只对测试缝做转换**（§2 第 2 层）—— 一行，立刻把形状面变成两半都受编译保护，
   且不必等 `BaseRuntimeV1`。
2. ✅ `resolveDataHome` 改具名对象（§4 第 1 条）—— 整套方案里**唯一**破坏性改动，所以它同时**就是**一次
   接口变更。原计划是 base 从 0.2.0 走到 **0.3.0**；中途按 §7 第 5 步并进过 `1.0.0`，最终按 §1、§6 又
   回到 **`0.3.0`**（包版本不再绑接口，接口只走 `INTERFACE_VERSION`）。
3. ✅ `api/interface-v1.json` 快照（**只记名字面**）+ "变了必须升编号"的门禁，遵守 §5 第 3 条的单一载体。
4. ✅ base 拥有接口类型 `BaseRuntimeV1`（插件改用 `import type` 它）—— 此后快照**由它派生**（§5 第 3 条的
   单一载体）。**同批**按 §4 第 3 条给每个带语义成员写了跨树行为测试。
5. ✅ `INTERFACE_VERSION` 与运行期门禁换轴 —— 门禁**搬进 base**（§3），插件只消费。原计划与 `1.0.0`
   合并推进；最终按 §1、§6 的方向落地：**不走到 1.0.0**，而是把包版本退回 `0.3.0`、peer 放宽成
   `>=0.3.0 <1.0.0`，让接口世代成为主契约。
6. ✅ 门禁成为主契约后，`incompatible` 从"只告警"改成"告警 + 不用 base 的共享能力"（§3）：prompt 层用
   插件自带默认正文、门禁跳过、provisioning 走 legacy，工具/service/Remote/UI 照常挂载 —— 这条把上一轮
   被校正掉的"按能力降级"真正实现，文档与注释一起改回。

## 8. v2 的新成员：良构文本（`wellFormedText` / `wellFormedDeep`）

这一节是 v1 → v2 唯一新增的能力，也是"共享逻辑归谁"判据的一次应用：良构修复是通用、非 DSH 的知识，必须
能靠**一次 base 发版**修好，所以它归 base；插件在运行时从加载到的模块上取 `kit.<member>`，取不到才用本地
副本（本地副本是**写明的降级路径**，不是重复实现）。

**为什么存在（可复现的硬证据，不是理论）。** 缺陷只有一个形状：**孤立代理对** —— `D800–DFFF` 里没有配对
的码元。`JSON.stringify` 把它输出成转义 `"\ud800"`：

- `printf '"\\ud800"' | jq .` → `jq: parse error: Invalid \uXXXX\uXXXX surrogate pair escape`；
- Python `json.load` 接受，但 `print` 抛 `UnicodeEncodeError: surrogates not allowed`；
- **Node 的 `JSON.parse` 正常接受** —— 所以本仓所有既有测试都发现不了它；同一个半个码元还会污染 FTS、
  embedding 与 UI。

**签名与行为。**

- `wellFormedText(text: string): string` —— 把每个孤立代理替换成 U+FFFD（`�`）。优先用引擎的
  `String.prototype.toWellFormed()`（Node ≥20；本仓 Node ≥22.15）；**运行时没有它**（老 Node）则用等价的
  本地 `charCodeAt` 扫描，结果一致、**不抛错**。纯函数、幂等；完整 emoji / CJK 扩展 B 区字、引号、反斜杠、
  换行、制表一律原样返回。它**不做** `normalize('NFC')`：那是持久化策略（"同一文本的两种拼法不能变成两
  行"），归调用方 —— mem 的写入入口把它叠在 `wellFormedText` 之上。
- `wellFormedDeep<T>(value: T): T` —— 递归版本，处理 JSON 形状的值：字符串、数组、**普通对象**
  （`Object.prototype` 或 `null` 原型，且无 `toJSON`）的键与值；**其它类型按同一性原样返回**，所以它永远
  不会把 `Date` / `Map` / 类实例变成别的类型。不改输入、幂等。

**用在哪（两个模型可见边界）。** 入站：调用方给的字符串在**持久化 / 建索引之前**修复；出站：一个值在
**序列化给模型之前**修复（工具结果、JSON payload、渲染的记录）。两棵树各自的边界文件（mem 的入站归一化与
出站 render）是本成员的消费者。

**降级义务。** 与家族其它共享能力一致：base 缺席或世代不匹配时插件仍**完整挂载**。消费方式是"从加载到的
base 模块取 `kit.wellFormedText` / `kit.wellFormedDeep`，取不到就用本地副本"—— 这份本地副本是**写明的
降级路径**（老 base 或 `incompatible` 世代），不是需要长期存在的第二实现。

**测试（已有）。** base 侧 `test/wellformed.spec.ts`：孤立高/低代理、半个 emoji、完整 emoji、CJK 扩展 B
区字、引号/反斜杠/换行/制表、嵌套数组/对象（含键）、非字符串类型按同一性不变、不改输入、幂等；**降级路径**
用桩切换（删除 `String.prototype.toWellFormed` 再跑**同一份**行为断言），并断言修补后的 `JSON.stringify` 不再
含 `\ud800` 式转义（jq 拒绝的形状），而完整 emoji / CJK 仍在。

**待补（本任务的边界，明确记录）。** 按 §4 第 3 条，v2 的这两个带语义成员还欠一条**跨树行为 pin**：从已
链接的 base 取真实实现，与两棵树各自的本地副本逐个输入比对。这条测试只能住在
`mem/packages/plugin/test/` 与 `mission/packages/plugin/test/` 里（只有插件能链接 base），而那两棵树此刻正由
另两条车道改动、并将在最终复核时统一回归，所以本条**有意留到那时补**，而不是在本任务里碰那两棵树。
