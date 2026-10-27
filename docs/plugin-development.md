# 04 插件开发规范

适用范围：**所有** qdash-neo 功能插件——内置的（语音、人格、预算）和社区的，**契约完全相同**。区别只在来源与准入强度（§9），不在 API。

---

## 0. 一句话

> qdash-neo 插件就是一个普通的 DSH 插件，只多做两件事：`inject: ['qdashNeo']`，然后在 `apply` 里向内核注册自己的能力面。

不另造 `FeatureModule` 契约、不扫目录、**默认不用写前端**。控制台是我们自己的端口、自己的页面（§5.1），插件只往里注册选项卡描述。理由见 §10。

---

## 0.1 现在到底能用什么（2026-10-27）

**照这张表写不会撞空。**

| 能力 | 状态 | 备注 |
|---|---|---|
| `inject: ['qdashNeo']` | ✅ | 拿到的是内核 service 实例 |
| `console.registerTab()` | ✅ | 声明式四块（status / table / form / actions） |
| `tools.register()` | ✅ | 注册即可见，**授权才进会话**（默认不授予，见 §2.5）；与内核同名时内核赢 |
| `instructions.register()` | ✅ | 往系统提示加一段常驻引导。**注册不生效，要单独授权**（见 §2.9） |
| `settings.register()` | ✅ | 运行时配置，命名空间 `cfg:<plugin>:<key>` |
| `storage.forFeature()` | ✅ | **KV only**，不支持建表 |
| `storage.dir()` | ✅ | `<DSH_HOME>/qdash-plugins/<name>/` |
| `judgeApi.registerProvider()` | ✅ | 判定链的插件段 |
| `voice.send()` | ✅ | 发语音（路径、体积、限流、落库全在内核） |
| `outboxApi.forPlugin(name).sendText()` | ✅ | 走内核队列，来源标记不可伪造 |
| `outboxApi.forPlugin(name).sendSegments()` | ✅ | 同上（图片 / 语音 / 表情） |
| `voice.onSendVoice()` | ✅ | 出站钩子，**只允许挂一个**（见 §2.3） |
| `ctx.qdashNeo.on(...)` 事件 | ✅ | 只读旁听：`message/inbound` / `message/dropped` / `turn/end` |
| `ctx.qdashNeo.capabilities` | ✅ | 只读能力清单。**不是安装期校验**（见 §2.8） |
| `console.registerStatic()` | ❌ | 挂 `/plugin/<id>/` 静态页 |

**下面章节里凡是标 ❌ 的，都是设计稿而不是现状。**

这就带来一个必须说清的现实：想做「定时提醒发一条文字」这类插件，现在**发不出去** ——
`outbox` 那一层还缺一个门面。补它不难（内核的 `enqueueOut` / `enqueueSegmentsOut`
已经做了分条、限流、落库与死信），但它应该是下一个能力面。

这张表每加一个能力就要改一次。**文档写了"有"而代码没有，比不写更糟** ——
接手的人会照着写插件，然后花半天排查"为什么这个方法不存在"。

## 0.2 装进 DSH 才会暴露的六个坑

**本地跑测试、用 `--patch` 启动，这四个都测不出来。** 它们要么只在 cordis 的属性代理里存在，
要么只在浏览器里生效。照着下面写，能省掉一轮"装上去报错、看不出为什么"。

### 1. `ctx.xxx` 只能访问 `inject` 里声明过的服务

`log` 也是服务之一。没有声明时，**取属性那一刻**就抛错：

```js
export const inject = ['qdashNeo']

export function apply(ctx, config) {
  const neo = ctx.qdashNeo

  // ❌ cannot get property "log" without inject
  //    注意：`typeof ctx.log` 这个求值本身就会抛，
  //    "先探测再用"这种写法在 cordis 里不安全
  const log = typeof ctx.log === 'function' ? ctx.log : () => {}

  // ✅ 用内核实例上的方法（普通函数属性，不经过属性代理）
  const log = typeof neo?.log === 'function' ? (...args) => neo.log(...args) : () => {}
}
```

想要 `ctx.log` 也能用，就把它写进 `inject: ['qdashNeo', 'log']` —— 但那就依赖 DSH 的服务名，
换个宿主版本可能变。**借内核实例上的方法更稳。**

### 6. 「注册」和「登记」必须成对

有几类能力是**两处登记**，只做一处会**静默失效**（有报错，但报错指向的地方看不出因果）：

| 机制 | 注册（实现） | 登记（清单） |
|---|---|---|
| 内核工具 | `tools/index.js` 的 `createQqTools` | `tools/catalog.js` 的 `QQ_TOOLS` |
| 表单可编辑 | 插件传 `form.submit` | `tabs.js` 的 `#block` 规范化时透传 |

**只注册不登记**，调用时报：

```
Error: 工具不在白名单：qq_send_card（在控制台「工具」里勾选后可用）
```

它让你"去控制台勾选"，但**控制台里根本没有这一项** —— 因为目录里没有它，白名单算不出来。

**只登记不注册**，启动时 warn「白名单里有 N 项当前未注册」，工具不出现。

**插件侧的对应**：`form.submit` 传了、内核规范化时吞掉，表现是"表单永远是只读"，**没有任何报错**。

**通用判据**：一个能力只要需要「声明 + 实现」两处，改一处时**必须去另一处的清单里搜同一个名字**。

### 另一个同类：白名单是建会话时的快照

`allow` 在建会话那一刻算好，**之后才注册的工具对已有会话不可见**：

```
改了 catalog → 重启 → 旧会话仍然拒绝
必须删掉会话让它重建
```

改工具清单后，验证前先删会话。否则会误判成"改动没生效"。

### 2. 控制台页面不能有内联 `<style>` / `<script>`

CSP 是 `script-src 'self'; style-src 'self'`，内联的会被浏览器**直接拒绝**：

| 现象 | 服务端表现 |
|---|---|
| 页面没有任何样式，只剩浏览器默认排版 | 200，日志正常 |
| 按钮点了没反应 | 200，日志正常 |

只有浏览器控制台有一条 CSP 违规。从后端完全看不出问题。

**插件不要自己拼 HTML**：用 `registerTab` 的声明式四块（`status` / `table` / `form` / `actions`），
内核渲染，天然不受 CSP 影响。`form` 块带 `submit` 就能编辑，覆盖了绝大多数配置需求。

### 3. 插件名不能直接用包名

包名是 `@scope/name`，而命名空间**不允许 `@` 和 `/`**（要求 `^[a-z][a-z0-9_-]{0,31}$`）。
`settings.register` / `storage.forFeature` / `outboxApi.forPlugin` 会全部拒掉，报错是
「插件名不合法」，看起来像名字打错了。

**连字符是允许的**（2026-10-27 起），所以 `qdash-neo-plugin-voice` 去掉 scope 就能直接用。
最初正则只收 `a-z0-9_`，结果插件作者按包名去掉 scope 写出带 `-` 的名字，一装就报上面那句。

所以插件里通常有两个名字：

```js
export const name = '@cmnyhh/qdash-neo-plugin-voice'   // DSH 模块名 = 包名，必须与 package.json 一致
const NS = 'qdash-neo-plugin-voice'                     // 存储/配置/来源标记用这个
```

`NS` 是用户可见的（`tools.disabledPlugins` 里要填它），所以取短的那个。

### 4. `cordis.patch.yml` 的 `name` 必须等于 `package.json` 的 `name`

改包名时最容易漏这一处。漏了之后装上去报：

```
qdash-neo (qdash-neo): failed to import:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'qdash-neo' imported from profiles/web/
```

日志里那句话看着像"依赖没装"，实际是 patch 指错了模块名 —— 而 `node_modules` 里明明有。

### 5. 注册必须挂到 `ctx.effect`，否则卸载后残留

```js
export function apply(ctx, config) {
  // ✅ 登记了清理，DSH 停用/卸载插件时会调它
  ctx.effect(() => neo.tools.register({ ... }))
  ctx.effect(() => neo.console.registerTab({ ... }))

  // ❌ dispose 只有你知道，没人会替你调
  neo.tools.register({ ... })
}
```

内核返回的 disposer **只有插件自己拿着**。DSH 停用或卸载插件时，cordis
只跑 `ctx.effect` 登记过的清理 —— 没登记的注册会一直留在主包内存里，
**直到主框架重启**。

表现是「插件都删了，选项卡和工具还在」。而且这些残留还能被调用，
因为它挂在主包的注册表上，跟插件是否还在无关。

同一个 `ctx.effect` 里可以返回多个 disposer（返回数组或用 generator），
但**每个注册都必须是某个 effect 的产物**。

## 1. 插件的形状

```
qdash-neo-plugin-voice/
├── package.json
├── cordis.patch.yml
├── src/index.ts            # 能力注册（唯一必需文件）
└── pages/                  # 可选：只有 custom 选项卡才要
```

### 1.1 package.json

```jsonc
{
  "name": "qdash-neo-plugin-voice",
  "version": "1.0.0",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "qdashNeo": {
      "api": "^1.0",                                  // 依赖的内核契约版本（必填）
      "capabilities": ["settings", "storage", "outbox", "console-tab"],
      "tables": ["voice_log"],                        // 内核分配前缀 feature_voice_
      "consoleTabs": ["voice"]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/schemastery": "^0.2.0",
    "qdash-neo": "^1.0.0"
  }
}
```

`capabilities` 的取值就是**全部可用能力**，没有隐式能力：

| capability | 拿到什么 | 实现状态 |
|---|---|---|
| `console-tab` | `ctx.qdashNeo.console.registerTab()` | ✅ 已实现 |
| `tools` | `ctx.qdashNeo.tools.register(desc)` | ✅ 已实现（2026-10-27） |
| `settings` | `ctx.qdashNeo.settings.register({ plugin, key, schema, defaults })` | ✅ 已实现（2026-10-27） |
| `storage` | `ctx.qdashNeo.storage.forFeature(name)` → `get/set/del/list/clear` | ✅ 已实现（KV only，2026-10-27） |
| `console-static` | `ctx.qdashNeo.console.registerStatic()`（把 `pages/` 挂到 `/plugin/<id>/`） | ❌ 未实现 |
| `http-fetch` | `ctx.qdashNeo.fetch()`（带 SSRF 校验） | ❌ 未实现 |
| `judge` | `ctx.qdashNeo.judgeApi.registerProvider({ name, provider })` | ✅ 已实现（2026-10-27） |

> **现状（2026-10-27）**：`ctx.qdashNeo` 是**白名单门面**，不是整个 service。
>
> ```
> ctx.provide('qdashNeo', service.api)     // service.api = 白名单 Proxy
> ```
>
> 白名单里的属性正常返回（方法已绑定到实例）；**白名单外一律 `undefined`** ——
> 包括 `deliver` / `client` / `sleepUntil` / `outbox` 这些内部结构。
>
> 早先是直接 provide service 实例，`capabilities` 那张表只是"说明书"：
> 插件想绕过出站队列（限流、落库、死信重试），用 `neo.client` 就行。
>
> **不抛错而是返回 `undefined`** 是有意的：插件普遍用 `neo?.xxx` / `typeof`
> 做能力探测，抛错会把"探测"变成"崩溃"。
>
> **加能力要同时改三处**：`PLUGIN_API_KEYS`（service.js）、
> `this.capabilities`（同文件）、本表。三处不一致就是
> "文档说有、实际用不了"，或者反过来。
> 语音插件那次就是踩这个：文档里 5 个能力，代码里只有 1 个。

### 3. 关于「插件能不能让会话睡眠」

**不能，也不打算加。**

`[[SLEEP:N]]` 是**模型对"我现在不想说话"的表达**（它读过上下文、知道自己该不该安静）。
插件替它决定"你该睡了"是越权。

- 插件想让机器人**暂时不发** → 自己不发就行，不用动会话状态
- 插件想让机器人**别被打断** → 那是"发送锁"，语义完全不同，另说

会话睡眠状态会**阻塞正常聊天**（群友说话它不回），所以这个开关只该由
模型自己和用户掌控。

### 已实现的两个新能力（2026-10-27）

**`storage` 只给 KV，不给建表。**

```js
const db = ctx.qdashNeo.storage.forFeature('todo')   // 命名空间 feature:todo:
db.set('list', [{ text: '买菜', done: false }])      // 值会被 JSON 序列化
db.get('list', [])                                    // 第二个参数是缺省值
db.list()                                             // [{ key, value }]
db.clear()                                            // 只清自己前缀下的键，返回删除条数
```

**存文件用 `storage.dir()`，不是自己拼路径。**

```js
const dir = ctx.qdashNeo.storage.dir('tts')          // <DSH_HOME>/qdash-plugins/tts
const sub = ctx.qdashNeo.storage.dir('tts', 'mp3')   // 再下一层
```

这**不是"授予文件权限"**——插件是进程内代码，`import 'node:fs'` 本来就能读写全盘。
给的是**约定**：路径跟着 `DSH_HOME` 走（不会落在 `process.cwd()` 里）、
卸载时知道该清哪儿、备份 `DSH_HOME` 时会带上。

名字规则同 KV（小写、不转），子目录不允许 `/` 和 `..`。不设配额——
硬限额很容易误伤（一个语音就 3MB），真要控就在控制台看占用。

为什么不给建表：建表意味着插件要执行 DDL（`drop table messages` 只差一个手滑），
还带出迁移问题（v2 加列谁执行）。待办、提醒、签到这类东西用 JSON 塞进 value 就够。

插件名会被校验（`^[a-z][a-z0-9_-]{0,31}$`，**不转小写**，`Todo` 直接报错），
键名不能含 `%`（`kvList` 走 LIKE，`%` 会破坏前缀匹配）。

**`settings` 是运行时配置，和 patch 里的部署配置分工不同。**

```js
const conf = ctx.qdashNeo.settings.register({
  plugin: 'todo',                 // 命名空间 cfg:todo:<key>
  key: 'ui',
  schema: z.object({ enabled: z.boolean().default(false) }),
})
conf.get()            // 默认值 + 用户覆盖，schema 补齐
conf.set({ enabled: true })
conf.reset()          // 回到默认
```

`set` 会在**写入时**就过一遍 schema：非法值应该当场报错，而不是等插件下次读的时候才炸，
那时用户早已忘了自己改过什么。

命名空间是 `cfg:<plugin>:<key>`，插件只能读写自己那一份，碰不到 `cfg:policy.*` 这类内核配置。

### 1.2 cordis.patch.yml

```yaml
- insert:
    - id: qq-voice
      name: 'qdash-neo-plugin-voice'
      config:
        tts:
          endpoint: 'http://127.0.0.1:9880'
          format: 'silk'
```

**不挂载就不加载。** 内核不扫目录、不猜你想装什么——这是 DSH 的纪律（"安装不等于启用"），也是我们的。

### 1.3 src/index.ts

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'qq-voice'
export const inject = ['qdashNeo']                    // ← 唯一必需
export const Config = z.object({ /* 部署方配置，见 §4 */ })

export function apply(ctx: Context, config: typeof Config.Type) {
  const tts = new TtsClient(config.tts)

  // 1) 运行时配置（用户可改）
  const settings = ctx.qdashNeo.settings.register({
    key: 'voice',
    schema: z.object({
      enabled: z.boolean().default(false).description('AI 主动发语音'),
      maxChars: z.number().default(120).description('超过多少字转语音'),
      format: z.union(['silk', 'amr', 'mp3']).default('silk'),
    }),
  })

  // 2) 出站钩子：拦截发语音请求，转给 TTS
  // ⚠️ 这一段演示的是**设计稿**：`onSendVoice` 与 `outbox` 门面还没实现（见 §0.1）。
  // 现在真能跑的是 judgeApi / tools / storage / settings / voice.send。
  ctx.qdashNeo.outbox.onSendVoice(async (req) => {
    if (!settings.get().enabled) return req.fallbackToText()    // 关闭时降级为文本
    return { segments: [{ type: 'record', data: { file: await tts.render(req.text) } }] }
  })

  // 3) 控制台选项卡（当前支持的四块见 §5.4；静态快照，不要传函数）
  ctx.qdashNeo.console.registerTab({
    id: 'voice',
    title: '语音',
    order: 50,
    owner: 'qdash-neo-plugin-voice',
    layout: [
      { type: 'status', title: '运行状态', items: [{ label: 'TTS', value: '正常', tone: 'ok' }] },
      { type: 'actions', actions: [
        { id: 'test', label: '发一条测试语音', confirm: '会真的发一条语音，确认？',
          run: () => tts.selftest() },
      ]},
    ],
  })
}
```

卸载时**你不需要清理任何东西**：钩子、选项卡、settings 命名空间、定时器（如果用 `ctx.effect` 登记）都由内核随 fiber 回收。

---

## 2. 能力面 API

内核通过 `ctx.qdashNeo` 暴露七个面。全部方法都是**幂等可重复调用**、返回 disposer 或 handle。

### 2.1 settings — 运行时配置

```ts
const settings = ctx.qdashNeo.settings.register({
  key: 'voice',                     // 命名空间片段，最终 qdash-neo/voice
  schema,                           // schemastery
  defaults?: Record<string, unknown>,
})

settings.get()                      // 深冻结快照
settings.schema                     // 传给选项卡渲染表单
settings.describe()                 // 每个字段：当前值、来自哪层、能否改
await settings.update(patch)        // 只写用户层，revision 乐观并发
settings.onChange(cb)               // 返回 disposer
```

`describe()` 的用途：**告诉用户"这个字段被部署方锁了"**。patch 层覆盖优先于用户层，如果表单里能改但实际不生效，那是最让人困惑的体验。

#### 与 DSH 原生 `ctx.settings` 的关系（源码核实后必须讲清）

DSH 自带一套 settings 系统：`ctx.settings`（`SettingsForms` service），它按**插件 entry** 自动派生表单，`ns` 就是该 entry 的 id，`describe()` 返回 `SettingsDescriptor`：

```ts
{ ns, autoGenerate, schema, value, revision, base?, user?, applies: 'live', secrets? }
```

它已经有 `base`（composition/patch 层）/ `user`（用户层）分层和 `revision` 乐观并发（写冲突抛 `SettingsConflictError`）。

**所以我们的 `ctx.qdashNeo.settings` 不是必需品，而是一个刻意的选择。** 之所以还要有它：

| | DSH 原生 `ctx.settings` | 内核 `ctx.qdashNeo.settings` |
|---|---|---|
| 表单出现在 | DSH 自己的设置页 | **qdash-neo 控制台的选项卡里** |
| ns 来源 | 插件 entry id（安装时定） | `qdash-neo/<key>`（插件自报） |
| 落盘依赖 | 取决于挂了哪个 settings provider | 内核自己的 sqlite，恒定可用 |
| 适合 | 部署级配置、需要跟 DSH 一致的外观 | 需要嵌在控制台页面里、需要跟控制台权限/审计统一 |

**纪律（只有一条，但很硬）**：

> **同一个语义的配置只能存在一处。** 一个字段要么在 `Config`（部署层，DSH 设置页可见），要么在 `ctx.qdashNeo.settings`（运行层，控制台可见），**不许两边都放**。

两边都放的结果是：用户在 DSH 设置页改了 A，在控制台改了 B，而代码读的是 `base ?? user` 的某种混合，最后没人能解释"为什么我改了没生效"。这正是本方案全篇在反对的双真相源。

补充约束：
- `Config` 里**不要**放"用户会想改"的开关——那些放进 `ctx.qdashNeo.settings`
- `ctx.qdashNeo.settings` 里**不要**放密钥和端点——那些属于 `Config`，且应标 `.role('secret')`
- 内核必须对 `Config` 中每个字段提供 `.default()`（patch 的 `config` 是整块替换，不是深合并）


### 2.2 storage — 数据（KV + 目录）

**已实现，但只有 KV，没有建表。**

```js
const db = ctx.qdashNeo.storage.forFeature('voice')   // 命名空间 feature:voice:
db.get('lastRun', null)      // 第二个参数是缺省值
db.set('lastRun', Date.now())
db.list()                    // [{ key, value }]
db.clear()                   // 只清自己前缀下的键，返回条数
```

存文件走目录：

```js
const dir = ctx.qdashNeo.storage.dir('voice')       // <DSH_HOME>/qdash-plugins/voice
const sub = ctx.qdashNeo.storage.dir('voice', 'mp3')
```

**为什么不给建表**：建表意味着插件要执行 DDL（`drop table messages` 只差一个手滑），
还带出迁移问题（v2 加列谁执行）。待办、提醒、签到记录这类东西用 JSON 塞进 value 就够。

**`dir()` 不是"授予文件权限"**——插件是进程内代码，`import 'node:fs'` 本来就能读写全盘。
给的是**约定**：路径跟着 `DSH_HOME` 走（不会散落在 `process.cwd()`）、卸载时知道该清哪儿、备份会带上。

三条硬限制：

1. 插件名必须匹配 `^[a-z][a-z0-9_-]{0,31}$`，**不转小写**（`Todo` 直接报错，不悄悄合并）
2. 键名不能含 `%`（`kvList` 走 LIKE，`%` 会破坏前缀匹配）
3. 子目录不允许 `/` 和 `..`

### 2.3 outbox — 发消息（已实现）

**先取句柄，再发。**

```js
const out = ctx.qdashNeo.outboxApi.forPlugin('todo')

await out.sendText({ chatKey, text: '该喝水了' })

await out.sendSegments({
  chatKey,
  segments: [{ type: 'image', data: { file: '/abs/path/a.png' } }],
  text: '[图片] 今天的报表',      // 给人看的标签，写进 messages 与控制台
})
```

**为什么是 `forPlugin(name)` 而不是 `sendText({ plugin: 'x' })`**：
来源标记必须**不可伪造**。审计里要能分清「这条是模型发的还是插件发的」，
如果由调用方自己传名字，插件可以冒充内核工具，出事时查不到是谁发的。
和 `storage.forFeature(name)` 是同一个思路。

标记会以 `plugin:<名字>` 落进 `messages` 的 `meta`，控制台里一眼能看出。

**走的是和模型完全相同的队列**：

- 分条（`outbound.split`）
- 每会话间隔（`perChatIntervalMs`，默认 1200ms）
- 死信重试（3 次）
- 落库（`messages` 表，控制台可见）

**插件绕不过去，也不该绕**：直接调 OneBot HTTP 等于绕开限流、死信与审计，
而且控制台里会看不到它发过什么。

### 出站钩子：`voice.onSendVoice()`

在语音**真正发出之前**改写它。挂在 `voice` 上，不在 `outbox` 上。

```js
const off = ctx.qdashNeo.voice.onSendVoice(({ chatKey, file, label }) => {
  // 返回 { file?, label? } 覆盖；返回 null 原样发送
  return { label: '被插件改过的标签' }
})
```

规矩：

- **只允许挂一个**。多个钩子串起来会变成"谁后注册谁说了算"，而晚注册的那个
  往往只是碰巧加载得慢 —— 排查起来是噩梦。第二个注册会直接抛错
- **抛错按"没挂钩子"处理**：记 warn 后原样发送。钩子是第三方代码，
  不该连累语音发不出去
- **改写后的文件仍要过体检**：体积、扩展名照查，钩子不能成为绕过检查的口子
- 返回里没有的字段保持不变

### 2.4 console — 选项卡（详见 §5）

### 2.5 tools — 给 agent 供工具（已实现）

```js
ctx.qdashNeo.tools.register({
  name: 'qq_speak',
  owner: 'qdash_neo_voice',        // 存储/禁用都按这个名字认，取短的
  description: '把一句话合成成语音发到当前会话',
  params: { text: '要合成成语音的文字，尽量短' },
  async execute(args, exec) {
    // exec.chatKey 是内核注入的会话标识；插件不自己解析
    return { ok: true }
  },
})
```

**注册不等于授予。** 注册之后：

- 工具出现在控制台「工具」页（**看得见**）
- 但**不进**会话的 `allow`，模型拿不到（**用不了**）
- 要有人在工具页点「授予」才算授权（落 `tools.grantedPlugins`，**默认空 = 一个都不授予**）

这是安全默认：**插件能注册工具，但不能自己给自己授权。** 否则装上一个插件就等于
把它的全部能力交给模型，管理员没有任何决策点。

控制台按**插件整体**授予/收回，不是单个工具 —— 内核不知道"摘掉这一个，
那个插件还能不能正常工作"，那个判断只有插件自己知道。

授予/收回**立刻**作用于已有会话，不用等新会话；新注册的工具也会立刻按当前
授予状态挂上或挂不上。

#### 注册与可用性必须分开

**注册是能力声明，不是可用性判断。** 插件装上就该注册；缺配置在 `execute` 里报。

```js
// ✅ 对：装上就注册，配置不齐在调用时给可行动的错误
ctx.qdashNeo.tools.register({
  name: 'qq_speak',
  async execute() {
    if (!tts.ready) {
      throw new Error('TTS 还没配好（缺接口地址）。这次请改用别的方式；想用语音请去控制台补齐。')
    }
    // ...
  },
})

// ❌ 错：按配置决定注不注册
if (tts.enabled) {
  ctx.qdashNeo.tools.register({ ... })
}
```

按配置决定注不注册有三个坏处：

1. 工具清单会**莫名其妙变长变短**（填了地址就出现、清空就消失），用户和模型都没法解释
2. 模型**根本看不到**这个能力，连"改用别的方式"的依据都没有
3. 日志里看不出"为什么没有这个工具"

担心"挂一个必然报错的工具比没有更糟"是合理的，但那个担心成立的前提是
**错误信息不可行动**。错误里写清缺什么、该怎么替代，模型就不会反复重试同一个工具。


### 2.6 judge — 判定器（已实现）

```js
ctx.qdashNeo.judgeApi.registerProvider({
  name: 'keywords',
  owner: 'my-plugin',
  provider: ({ inbound, batch, contextText, heuristic }) => {
    if (!inbound.text.includes('白绫')) return null          // 弃权，继续问下一个
    return { verdict: 'reply', score: 0.9, reason: '叫到名字了' }
  },
})
```

返回 `{ verdict: 'reply' | 'silent', score?, reason? }`，或 `null` / `undefined` 表示弃权。
`registerProvider` 返回 disposer。

**插在 `heuristics` 之后、`available()`/`costGate` 之前**：那两道闸是给 LLM 层准备的
（模型能不能用、今天花超了没），而插件判定器通常更便宜 —— 规则表、关键词、本地分类器，
既不需要模型也不需要配额。挡在成本闸后面等于让省钱方案先被"钱不够"拦住。

**三条约束**：

1. **抛错按弃权处理**。一个坏插件会让所有群消息都不回，而日志里只有"判定失败"
2. 认不出的 verdict 也按弃权（宁可继续问下一个，不把坏返回值当决定）
3. `heuristic` / `llm` / `plugin` 是保留字，注册期就拒

**API 叫 `judgeApi` 而不是 `judge`**：`service.judge` 是 `JudgeChain` 实例，在 `start()` 里才创建，
插件更早注册会拿到 `Cannot read property of null`，看起来像插件写错了、实际是加载顺序。
`judgeApi` 是稳定门面：先存着，`start()` 时灌进 chain；chain 已存在就立刻生效。

> 只在 `policy.groupTrigger === 'judge'` 时这条链才会跑。默认是 `agent`（直接交给模型自决）。

### 2.7 events — 内核事件（已实现）

```js
const off = ctx.qdashNeo.on('message/inbound', ev => {
  // ev 就是归一化后的消息事件：chatKey / kind / userId / text / ts …
})

ctx.qdashNeo.on('message/dropped', ev => {
  // 多两个字段：reason（被哪道闸挡住）、note（人话说明）
})

ctx.qdashNeo.on('turn/end', ({ kind, chatKey, inbound, costMs, error }) => {
  // 一轮对话结束。失败也会发，error 里有原因 —— 只发成功的等于看不到问题
})

off()   // 取消订阅
```

**只读，不能阻断也不能改写。** 事件是旁听用的；一旦允许返回 `false` 拦消息，
插件就成了消息处理链的一环，"某个插件装坏导致所有消息不回"只是时间问题。

三个事件的时机：

| 事件 | 何时 | 一定会回复吗 |
|---|---|---|
| `message/inbound` | 通过第一道闸（白名单/群开关） | **不一定**，后面还有批窗口、判定、沉睡 |
| `message/dropped` | 被第一道闸挡住 | 不会 |
| `turn/end` | 一轮对话真正跑完 | 是（`error` 非空表示这轮失败） |

**监听器抛错会被吞掉并记 warn**，其他监听器照常收到。异步监听器的
Promise rejection 也挂了 catch —— 否则会变成 `unhandledRejection` 把宿主带走。

### 2.8 capabilities — 能力清单（只读）

```js
if (!ctx.qdashNeo.capabilities['console-static']) {
  // 退回声明式选项卡，而不是调一个不存在的方法、拿到看不懂的 TypeError
}
```

**这不是安装期校验。** 我们拿不到插件的 manifest，DSH 也不会替我们读，
所以「声明了没用到的能力就报错」这件事**做不到**。

它的实际用途是让插件在运行时判断某个能力在不在（宿主版本不同、能力面还在补），
拿到 `false` 就走降级路径。

当前清单：`console-tab` `tools` `settings` `storage` `outbox` `events`
`voice-send` `voice-hook` `judge-provider` 为 `true`；
`console-static` `fetch` 为 `false`。

---

### 2.9 instructions — 往系统提示加常驻引导（已实现）

```js
const dispose = ctx.qdashNeo.instructions.register({
  key: 'sticker',                       // 卸载时按它移除；重复注册视为替换
  text: '看到群友发的图或表情包，如果以后可能用得上（好笑、能表达某种情绪、是常见的梗），' +
        '就调 sticker_save 存下来，顺手给几个标签。一般的截图、自己拍的日常照片不用存。',
})
ctx.effect(() => dispose)               // 和工具/选项卡一样，必须挂生命周期
```

这段文字**直接拼进每一轮的 prompt**，每段带来源标题：

```
【来自「sticker」插件】看到群友发的图…
```

#### 重要更正（2026-10-27）

**早期实现是把引导写进 `AGENTS.md`，那条路是死的 —— 引导从未到达模型。**

`dsh-agent-instructions` 靠 `projectRootMarkers=[".git"]` 定位项目根，在数据目录
（`~/.dsh/workspaces/qdash-neo`）里即使补了 `.git`，baseline 也没有进入会话记录
（`isSeeded:false`、记录里零命中）—— 中间还有 preset 那一层，我们控制不到。

后果很难发现，因为**每一环看起来都对**：

- `register()` 成功 ✓
- 控制台能看到全文、能授权 ✓
- `AGENTS.md` 文件内容正确 ✓
- 测试通过 ✓（测的是"注册表里有没有"，**没测"模型能不能看到"**）
- **模型：从来没收到过** ✗

同类问题被掩盖了：`SEND_RULE`（"把话放进 `qq_send_message`"）也写在那个文件里，
但 `normalize.js` 的 `REPLY_HINT` 在 prompt 里有**另一份**，所以发送方式一直是对的 ——
**只有插件引导没有 prompt 对应物，是唯一裸奔的**。

现在 `renderPrompt` 收了 `pluginRules` 参数，service 每轮传入。**不要再往
`AGENTS.md` 加东西**：写文件那半只是为了兼容旧路径保留的。

#### 什么时候该用它，而不是塞进工具 description

用工具 `description` 的情况：**解释这个工具怎么用**（参数含义、返回值）。

用 `instructions` 的情况：**描述一种行为习惯**（什么时机该想起来用它）。

区别在于可见性：

| | 工具 `description` | `instructions` |
|---|---|---|
| 什么时候被读到 | 模型"挑工具"时 | **每一轮都在** |
| 算不算 token 预算 | 占 schema 预算，写长了挤掉别的工具 | 占提示词预算 |
| 适合写什么 | 参数语义 | "看到 X 就做 Y"这类条件反射 |

内核的 `MEMORY_RULE` 就是同一个道理：不写那段，`memory_add` 基本不会被调用。
**「存表情包」也是同一类——不写引导，模型根本想不起来存。**

#### 注册不等于生效

```js
ctx.qdashNeo.instructions.register({ key, text })   // 注册：控制台可见
                                                    // 生效：还要 tools.grantedInstructions 里有这个 owner
```

**默认不注入。** 和工具授权同一个思路（§2.5）：插件能注册，但不能自己给自己授权。

而且**授权名单是独立的**（`tools.grantedInstructions`，不是 `tools.grantedPlugins`）：

> 工具是"能做什么"，引导是**行为准则**。这段文字进系统提示后能改写模型
> 对其他事的判断 —— 比工具权限更敏感。一个插件可能"工具能用，但它的引导
> 不想让它生效"。

#### 容量

| 限制 | 值 | 为什么 |
|---|---|---|
| 单段 | 2000 字 | 够写一段行为引导，又不至于淹掉别的内容 |
| 全局 | 8000 字 | 提示词有预算，不是"多写点总没坏处" |

超了**拒绝注册**（抛错），不会静默截断——截断的话插件作者以为写进去了。

#### 生效时机

**当轮生效，不需要重建会话。**

引导拼进的是每一轮的 prompt（`renderPrompt` 的 `pluginRules` 参数），
所以：

| 动作 | 何时生效 |
|---|---|
| `register()` | 下一轮 |
| 控制台点「允许」 | 下一轮 |
| 改 `text` 后重新 `register` | 下一轮 |

**这和早期设计不同**（那时写 `AGENTS.md`，要等会话重建）。如果你改完引导发现
"模型行为没变"，先确认它真的进了 prompt —— 而不是怀疑自己写错了。

#### 自检

改完引导想确认生效，看任意一轮的 prompt 里有没有 `【来自「<你的 owner>」插件】`。
没有就说明授权没点，或者 `grantedInstructions` 里没有你的 owner。

## 3. 钩子（唯一允许介入链路的地方）

> **本节全部未实现。** 这是设计稿，不是现状清单。
>
> 唯一"介入了链路"且真的存在的是 `judgeApi.registerProvider()`（§2.6），
> 它在判定链里插一段；其余的 `outbox.onSendVoice`、`judge.chain`、`turn.beforeForward`
> 在代码里都没有对应实现。要做插件，请只看 §0.1 那张表。

钩子是同步/异步函数，按注册顺序组成链。**只有显式声明的钩子点**，没有"任意中间件"。

| 钩子 | 时机 | 能做什么 | 不能做什么 |
|---|---|---|---|
| `inbound.beforeGate` | 归一化后、闸门前 | 补字段、标 mention | 放行被闸拒绝的消息 |
| `outbound.clean` | 文本清洗前 | 替换词、去格式 | 改变长度上限 |
| `outbox.onSendVoice` | 语音发送前 | 生成音频、降级为文本 | 改目标 chat |
| `judge.chain` | 判定器链 | 插一个 provider | 绕过阈值 |
| `turn.beforeForward` | 自动转发前 | 抑制转发（返回 false） | 伪造消息 |

约定：

1. 钩子**超时 3 秒**，超时视为放弃介入（走默认行为），记 warn
2. 钩子抛错 → 该插件本回合跳过，记 error，**不影响消息链路**
3. 钩子返回 `undefined` = 不介入，不算失败

---

## 4. 配置文件：两层，分清楚

这是最容易做错的地方。判据一句话：

> **"装插件的人定" → 静态 Config（patch 层）；"用插件的人定" → 运行时 settings（控制台表单）。**

| | 静态 Config | 运行时 settings |
|---|---|---|
| 典型字段 | 端点、目录、密钥、端口 | 开关、阈值、格式偏好、频率 |
| 改法 | 编辑 `cordis.patch.yml` + 重启 | 控制台表单，保存即生效 |
| 出现在选项卡 | 否（只读展示） | 是（可编辑） |
| 声明 | `export const Config` | `settings.register()` |

```ts
// 静态：部署方
export const Config = z.object({
  tts: z.object({
    endpoint: z.string().default('http://127.0.0.1:9880'),
    format: z.union(['silk', 'amr', 'mp3']).default('silk'),
    apiKey: z.string().role('secret').default(''),      // 界面只显示"已配置"
  }),
})

// 运行时：用户
const userSchema = z.object({
  enabled: z.boolean().default(false),
  maxChars: z.number().min(20).max(500).default(120),
})
```

**每个静态字段都必须 `.default()`**：patch 的 `config` 是整块替换，没有默认值的字段会收到 `undefined`，然后在某个深夜崩掉。

**密钥字段加 `.role('secret')`**：settings 会把值脱敏，界面只拿到"是否存在"的标记，永远不下发明文。

---

## 5. 控制台选项卡

### 5.1 形态：自己的端口，自己的页面

qdash-neo 自带一个控制台，**和原项目一样**：独立 HTTP 服务 + 一套自己的静态页面。它不是 DSH 控制台的一部分，也不往宿主 SPA 里塞任何东西。

为什么不用 DSH 的槽位（`sidebar.panellist` + `main`）：那套东西的意义是"长在 DSH 控制台里"，代价是我们得写一个 React 的 Client 半、跟着宿主的渲染树走、主题语言全受宿主约束。我们要的是**自己的地址**：

- 控制台能脱离 DSH 前端单独打开、单独刷新、单独排查
- 页面完全归我们管：排版、组件、图表，不用迁就宿主
- 与原项目形态一致，迁移者的上手成本最低

代价照实写：主题、语言、通用组件、鉴权这四件得自己实现。内核替插件作者做掉（§5.7），但内核自己得建这一层。

**服务器两种起法，默认第一种：**

| 起法 | 怎么 | 什么时候用 |
|---|---|---|
| **同端口**（默认） | `ctx.webServer.register({ kind: 'prefix', path: '/qdash-neo', handler })` | 已实测：prefix/exact 均 200，且 `/qdn-probe` 不会误吞 `/qdn-probes`。与宿主同端口、天然同源、直接继承宿主鉴权。地址 `http://127.0.0.1:<dsh-port>/qdash-neo` |
| **独立端口** | 自己 `http.createServer` 绑 `127.0.0.1:<port>`（约定 7800） | 要与 DSH 生命周期解耦、或 `ctx.webServer` 签名变化时。代价：端口管理、token 鉴权、Host 校验全部自己写 |

两种起法服务**同一份东西**，只有路由前缀不同：

```
GET /              → 控制台页面（单个 HTML）
GET /assets/*      → 页面用的 css/js/图标
GET /api/*         → 数据面（内核统一鉴权）
GET /plugin/<id>/* → 插件的静态页（custom 选项卡用）
```

> **坑**：`registerFallback` 只有一个 owner，被宿主 SPA 占着，抢根路径直接抛错。所以同端口起法必须带 `/qdash-neo` 前缀，不能占 `/`。

### 5.2 两种选项卡

控制台有自己的选项卡机制（左侧一列入口 + 主区一块内容）。插件注册的是**描述**，不是代码：

| 形态 | 插件要写什么 | 谁渲染 | 适用 |
|---|---|---|---|
| **declarative**（默认） | 只写 Host 半：`registerTab({layout})` | 控制台前端按 JSON 渲染 | 90% 的需求：表单、表格、状态、按钮 |
| **custom** | Host 半 + 一个静态 `page.html` | 控制台把它塞进 sandbox iframe | 图表、画布、老页面迁移 |

一句话：**默认你一行前端代码都不用写；真要写，就写一个纯静态 HTML，内核用 iframe 关起来跑。**

### 5.3 declarative — 注册

```ts
const dispose = ctx.qdashNeo.console.registerTab({
  id: 'voice',                     // ^[a-z0-9][a-z0-9-]*, ≤40，全局唯一，撞名即抛错
  title: '语音',
  order: 50,                       // 侧栏排序，小的在前；缺省 100
  owner: 'qdash-neo-plugin-voice', // 冲突时用来告诉用户"被谁占了"
  layout: LayoutBlock[],
})
```

**实现现状（2026-10-26）**：`icon` / `badge` 尚未支持（传了也会被忽略，不报错）。插件选项卡目前是
**侧栏里的独立入口**（内置五项之后按 `order` 追加），还没有"内核主面板内部的二级 tab bar"。
后者的设计意图不变（避免装五个插件长出五个图标），等内置入口收敛成「QQ」一个时再一起做。

`id` 冲突时**抛错而不是覆盖**——与 DSH 的路由纪律一致（撞名即配置错误）。内核记 error 并原样把原因交给插件，
控制台本身照常工作；**注册失败不能把控制台一起带崩**。

校验在注册期一次做完，越界一律抛错、不静默降级：`layout` 1~20 块、块 `type` 属于四种、
表格/状态条目上限 500、单个选项卡整体必须可 JSON 化（函数、循环引用在 HTTP 上没法传）。

### 5.4 声明式布局：四种块

**这是默认方式，覆盖 90% 的需求，且零前端代码。**

#### form — 配置表单

**块上带 `submit` 就是可编辑的，不带就只读。**

```js
{
  type: 'form',
  title: 'TTS 配置',
  fields: [
    { path: 'endpoint', label: '接口地址', type: 'string', value: 'http://127.0.0.1:9880/...' },
    { path: 'enabled', label: '开启', type: 'boolean', value: true },
    { path: 'maxChars', label: '字数上限', type: 'number', value: 200 },
  ],
  submit: { id: 'save', label: '保存' },     // ← 有它才渲染输入控件
}
```

点保存时，内核把所有字段按 `path` 收成 `{ [path]: value }`，
POST 到 `/api/tabs/<tabId>/actions/<submit.id>`，body 是 `{ values }`。
插件自己处理：

```js
actions: {
  save: async ({ values }) => {
    conf.set(values)              // conf = settings.register(...)
    return { ok: true, message: '已保存，立即生效' }
  },
}
```

**内核不解析 `values`**，只做透传和返回值包装。否则每加一个插件就要改一次内核的配置解析。

**控件类型**（按 `type` 选；带 `options` 时优先渲染下拉）：

| 写法 | 渲染成 |
|---|---|
| `type: 'string'`（默认） | 文本框 |
| `type: 'number'` | 数字框（空值转 0，避免 `NaN` 序列化成 `null`） |
| `type: 'boolean'` | 复选框 |
| `type: 'password'` | 密码框 |
| `options: [{ value, label }]` | 下拉选择 |

> `password` **不是安全措施**：值一样在 DOM 里，能打开控制台的就能看到。
> 它只防误看、误截图。真正的边界是控制台要登录。

#### 条件字段：`when`

同一个插件常有多种模式（openai / gpt-sovits / custom），各自参数完全不同。
全平铺出来，用户会看到一堆在他那个模式下**根本不生效**的框，而界面上没有任何
东西告诉他哪几个是相关的。

```js
{
  type: 'form',
  fields: [
    { path: 'protocol', label: '协议', options: [
      { value: 'openai', label: 'openai' },
      { value: 'gpt-sovits', label: 'gpt-sovits' },
    ] },
    { path: 'voice', label: '音色', when: { path: 'protocol', in: ['openai'] } },
    { path: 'refAudioPath', label: '参考音频路径', when: { path: 'protocol', in: ['gpt-sovits'] } },
  ],
}
```

| 写法 | 何时显示 |
|---|---|
| `when: { path: 'x', in: ['a', 'b'] }` | `x` 的值是 `a` 或 `b` |
| `when: { path: 'x', is: 'a' }` | `x` 的值等于 `a` |
| 不写 `when` | 一直显示 |

判断用**当前值**（用户刚改的优先），不是后端快照——所以切换下拉之后，
字段组会立刻跟着变，不用先保存一次。

**隐藏的字段不会被清空**：`settings.set` 是合并（`{ ...get(), ...patch }`），
提交时只带可见字段，隐藏的保持原值。这条是"按条件隐藏"能安全成立的前提。

**不带 `submit` 时维持只读展示**：有些 form 块本来就只是展示（比如内核自己的配置项），
全变成输入框会让"哪些能改"变模糊。

> 早期这里是硬性只读的，注释写着"settings.register 还没接，假装可编辑而后端不接收，
> 比不可编辑更糟"。那个前提现在已经不成立 —— `settings.register` 与 `tabAction` 都通了。

```ts
{
  type: 'form',
  title: '语音设置',
  // 当前只支持**静态字段快照**（只读展示）：
  fields: [{ path: 'voice.maxChars', label: '超过多少字转语音', type: 'number', value: 120, description: '…' }],
}
```

**实现现状**：`scope` / `settings.register()` 还没接，所以 form 块现在是**只读**的（右上角标「只读」）。
内核自己的「配置」页已经是可写的（bool→开关、number→数字框、enum→下拉、string[]→逐行文本、
secret→只显示"已设置"、patch 层字段上锁），但那套走的是 `Config` 的**用户层**；
插件运行层配置要等 `settings.register()` 落地后才能复用同一套控件。**先只读，不做假可编辑。**

#### table — 数据表

```ts
{
  type: 'table',
  title: '最近发送',
  columns: [{ label: '时间' }, { label: '会话' }, { label: '字数', num: true }, { label: '状态' }],
  rows: [['12:04:11', 'g:777', 42, '成功']],   // 快照，注册时序列化
  empty: '还没有发送记录',
}
```

**实现现状**：`data(query)` / `pageSize` / 分页排序**尚未支持**，只接受静态 `rows` 快照。
插件要刷新数据，正确姿势是"动作 + 重新注册"或等下一轮的内核侧 `data()` 探针。

#### status — 状态卡

```ts
{ type: 'status', title: '运行状态', items: [
  { label: 'TTS 服务', value: '正常', tone: 'ok' },
  { label: '队列', value: '3 条', tone: 'warn' },
]}
```

`tone` 取 `ok / warn / bad`，其余按默认色。同样只接受静态快照。

#### actions — 按钮

```ts
{ type: 'actions', actions: [
  { id: 'test', label: '发一条测试语音',
    confirm: '将向管理员私聊发一条测试语音，确认？',
    run: async () => ({ ok: true, message: '已发送' }) },
]}
```

`run` **只在服务端执行**，前端只拿到 `{id, label, description, confirm}`；
点击走 `POST /api/tabs/<id>/actions/<actionId>`，返回任意可 JSON 化的值（推荐 `{ ok, message }`，前端会 toast 出来）。
`confirm` 非空时前端先弹二次确认——**含外部副作用的动作必须给 confirm**。

### 5.5 custom — 逃生舱：静态页

> **未实现。** `console.registerStatic()` 在代码里不存在，这一节是设计稿。
>
> 它是所有能力面里**风险最高的一个**：挂静态文件 = 路径穿越（`..%2f`、编码绕过、大小写）
> 加上要放宽 CSP（自定义页面通常要内联脚本）。没有真实插件需要时不做，
> 做了就是在给自己引入一条任意文件读取的攻击面。
>
> 现在的替代：`registerTab` 的 `table` 块能展示数据表，`actions` 块能触发刷新。
> 数据能看，只是不能画图。

确实需要图表、画布、别人写好的 HTML 时用：

```ts
{ type: 'custom', page: 'pages/voice-viz.html', height: 480 }
```

约束：

1. 控制台前端用 `<iframe sandbox="allow-scripts" src="/qdash-neo/plugin/voice/voice-viz.html">` 嵌入——**不给 `allow-same-origin`**，页面拿不到控制台 token、读不到 localStorage、碰不到父页 DOM
2. 数据通过 `postMessage` 请求，内核校验来源与消息形状后回传（**只回该插件自己的数据**）
3. 页面必须纯静态（无构建步骤），单文件 < 500KB
4. 不提供网络出口：`fetch` 被 CSP 限制为同源且仅限该插件命名空间下的端点

> 为什么这么严：同进程运行没有沙箱兜底，能拦的只有 API 面。iframe 是唯一能把"自定义代码"关进笼子的地方，那就必须关严。

### 5.6 配置文件：就写进你自己的选项卡

用户要"插件同时支持加选项卡和加配置文件"——这两件在我们的控制台里是**同一件事**：配置文件就是选项卡里的一个 `form` 块。

```ts
{ type: 'form', title: '语音设置', scope: settings }
```

前端按 `describe()` 出来的 schema 自动渲染（bool → 开关，number+min/max → 滑块，union → 下拉，secret → 密码框显示"已配置"），保存带 revision，patch 层覆盖的字段显示锁定图标。**插件作者不写 HTML、不写 fetch、不写校验。**

三种放法，按需选：

| 放法 | 怎么写 | 出现位置 |
|---|---|---|
| **独立选项卡**（默认） | `registerTab({ id:'voice', layout:[{type:'form',...}, {type:'table',...}] })` | 左侧多一个「语音」入口 |
| **塞进内核总览页** | `registerTab` 时 `id: 'overview'` 之外的块用 `form` 也行，或只注册 `status` | 不占入口，附在总览下方 |
| **只走 DSH 设置页** | 只声明 schemastery `Config`，不注册选项卡 | DSH 设置 → 插件 → 该插件页，**表单自动生成** |

**默认第一种**：控制台是自己的地址，用户不会为了改一个开关去翻 DSH 设置。第三种是白送的（`Config` 反正要声明），留着当"进不去控制台时也能改配置"的兜底。

`settings.register()` 在原始的 `ctx.settings` 之上加三件事：命名空间隔离（`qdash-neo/<key>`）、`secret` 字段脱敏、以及给 `form` 块复用同一份 `describe()`（含 patch 层来源标记）。

所以：**配置不改代码，选项卡尽量 declarative，只有真需要画图才 custom。**

### 5.7 内核提供的通用能力（不用自己实现）

选项卡里可以直接用，不需要插件写：

| 需求 | 用什么 |
|---|---|
| 分页表格 | `table` 块 |
| 表单 | `form` 块 + schema |
| 时间格式化 | `format: 'time' / 'duration' / 'money'` |
| 状态色 | `tone: 'ok' / 'warn' / 'error' / 'muted'` |
| 二次确认 | `confirm` |
| 空状态/加载/错误 | 自动 |
| 权限提示 | 自动（非 owner 只读） |
| 主题 / 深色模式 / 语言 | 内核实现（§5.1 说的"四件自己做"，这是其中三件），插件作者不用管 |

---

## 6. 命名规范（防撞车）

DSH 的纪律是"路由、RPC 通道、工具名撞名一律抛错，只有 list 类相加 → 把包名放进路径里"。我们照做：

| 对象 | 规则 | 例子 |
|---|---|---|
| 插件 `id`（patch entry） | `qq-<功能>`，定了不改 | `qq-voice` |
| 选项卡 `id` | 内核强制加包前缀 | `voice/voice` → 槽 key `qq/voice`，API `/qdash-neo/api/tabs/voice/voice` |
| settings 命名空间 | `qdash-neo/<key>` | `qdash-neo/voice` |
| 表名 | 内核强制 `feature_<key>_` 前缀 | `feature_voice_log` |
| agent 工具名 | `qq_<动词>_<对象>`，全局唯一 | `qq_send_voice` |
| 钩子 | 无 id，按注册顺序 | — |
| 状态键（kv） | `feature_<key>_*` | `feature_voice_schema_version` |

**工具名、选项卡 id、命名空间一旦发布就不能改**——它们是模型/用户/历史数据认的 API。

---

## 7. 生命周期与失败

```ts
export function apply(ctx: Context, config) {
  // 只用 ctx 注册的东西 → 自动回收
  ctx.qdashNeo.console.registerTab({...})

  // 自己 new 的资源 → 必须登记
  ctx.effect(() => {
    const timer = setInterval(poll, 30_000)
    return () => clearInterval(timer)
  })
}
```

规则：

1. **禁止自建长连接与无限重试**。需要周期任务，用 `ctx.qdashNeo.schedule.register({ every, run })`，内核代管并计入同一份日志
2. **禁止在 `apply` 里做 IO**（建表除外）。网络请求放 `ctx.on('ready')`
3. **失败必须可见**：`apply` 抛错 → 该插件 `FAILED`，控制台「插件」页标红并显示 reason；运行期异常 → 降级记 error，其余功能照常
4. **不阻塞**：单次钩子/动作 ≤ 3 秒，超时被内核放弃
5. dispose 里不要依赖其他插件还活着

---

## 8. 准入与识别

### 8.1 识别（不猜）

内核只认两件事：

1. `package.json` 里有 `dsh.qdashNeo` 字段且 `api` 满足语义化版本
2. 该包出现在某个 profile patch 的 `insert` 行里（**显式挂载**）

不扫目录、不猜包名、不安 "有 inject 就算插件"。

### 8.2 校验顺序

```
安装 → 读 manifest → 校验 api 版本 → 校验 capabilities 取值合法
     → 校验包名未被占用 → 校验 consoleTabs 不撞 → 挂载（不加载）→ 用户启用 → apply
```

任一步失败：**跳过该插件，控制台「插件」页显示失败原因**，内核继续跑。

### 8.3 内置 vs 社区

| | 内置 | 社区 |
|---|---|---|
| 契约 | 相同 | 相同 |
| 发版 | 跟内核同版本号 | 独立 |
| 准入 | 随包，默认可信 | 逐条审查 |
| 默认状态 | 部分默认启用 | 一律未启用 |
| 控制台 | 同一张表，多一列「来源」 | 同左 |

**运行时身份完全一致**：拿到的是同一个 `ctx.qdashNeo`，受同一套限制。不存在"内置插件能多做事"的通道——有特权就意味着有两套行为，迟早分叉。

---

## 9. 作者自检清单

发布前逐条过。前六条是硬性，后四条是质量。

- [ ] `inject` 里只有 `qdashNeo` 一个（不直接 inject `agents`/`sessions`——那是绕过内核）
- [ ] `capabilities` 目前**不被校验**（机制未实现，见 §0.1），写不写都不影响运行；
      等真的实装之后再要求精确
- [ ] 静态 `Config` 每个字段都有 `.default()`，密钥字段 `.role('secret')`
- [ ] 所有发送走内核提供的入口（**现在只有 `ctx.qdashNeo.voice.send()`**），
      没有任何一处直连 OneBot HTTP —— 绕过队列等于绕过限流、分条、死信与审计
- [ ] SQL 只出现 `feature_<key>_` 前缀的表
- [ ] 自定义资源都进了 `ctx.effect`，没有裸 `setInterval`
- [ ] 表单里能改的字段，真的能生效（不是被 patch 层覆盖的死键）
- [ ] 含副作用的 action 都有 `confirm`
- [ ] **有 custom 页的**：`pages/` 下只有纯静态文件，没有构建产物、没有 node_modules
- [ ] **有 `html` 页的**：页面在 `sandbox="allow-scripts"` 下不依赖 `localStorage`/`document.cookie`/父页 DOM
- [ ] 卸载后重装一次，控制台不残留旧选项卡、表数据仍在
- [ ] 故意让 TTS 端点不可达 → 降级为文本发送 + 控制台可见，而不是消息消失

---

## 10. 为什么不用自定义 FeatureModule 契约

旧方案 §3 提过一套 `FeatureModule { name, optionalDeps, setup, dispose }` + `features.dir` 目录扫描。**放弃它，理由三条**：

1. **重复造轮子**：Fiber 生命周期、依赖注入（`inject`）、配置校验（schemastery）、运行时配置（`ctx.settings`）、卸载即回收——DSH 全都有且经过生态验证。自己再造一套，等于在插件层重演原项目"绕开公开 API"的错误。
2. **目录扫描与"配置单一真相源"冲突**：扫描目录意味着"装了就生效"，而我们的原则是"安装不等于启用，清单是唯一真相源"。显式挂载（patch insert 行）天然满足这条。
3. **少一个概念**：插件作者已经要理解 DSH 插件、Cordis、schemastery。再叠一层 `FeatureModule` 只会让"怎么写"变成"先学两套"。

代价是：插件必须是 npm 包（不能是一个丢进目录的 js 文件）。这个代价可以接受——真需要单文件时，用 `name: '/abs/path/index.js'` 的本地 patch 行即可，DSH 原生支持。

### 10.1 为什么不把 UI 挂到 DSH 控制台里

技术上有一条更省事的路：DSH 有现成的槽位（`sidebar.panellist` 加一个侧栏图标、`main` 挂主面板），官方 `ui-schedule`、`ui-plugin-manager` 就是这么把自己塞进控制台的。走这条路，我们不用写控制台页面、不用管主题和语言，白拿宿主的一整套 UI。

**但不走。** 三个理由：

1. **地址不是我们的**。挂上去之后，用户必须开着 DSH 前端才能进控制台；DSH 前端崩了、新版改了布局，我们的控制台跟着遭殃。qdash-neo 的管理面要比 DSH 的 lifespan 长。
2. **页面不是我们的**。槽位给的是一个"格子"：你能往里放组件，但放不了"整页的排版自由"。图表、自定义视图、以后想加的可视化编排，都会被格子的宽度和宿主的样式约束。
3. **要付一个 Client 半的代价**。挂槽位就必须写 React 组件、必须走 `dsh.client` 装载链、必须跟着宿主的 `ui-primitives` 版本走。这部分工作量并不比写一个静态页面小，却把我们的发版节奏绑到了 DSH 前端上。

所以形态定成：**自己的端口 + 自己的页面**（§5.1）。代价是主题、语言、组件、鉴权得自己实现一遍——这四件是内核的一次性成本，做完之后插件作者仍然零前端。

> 附一条实测记录（00 §三 第 3 项）：profile 插件的 Client 半确实会被 `@deepseek-ai/dsh-client-modules` 自动扫进启动图，这条路技术上完全可行。**不选它是因为权衡，不是因为做不到。**

---

## 11. 版本演进

`dsh.qdashNeo.api` 是契约版本，遵循 semver：

- **major**：能力面删除或语义变更（如 `registerTab` 参数结构改变）
- **minor**：新增能力（插件不声明就用不到，向后兼容）
- **patch**：修 bug

内核读到不兼容 major → **拒载并提示升级**，不是"试试看能不能跑"。minor 落后 → 加载但 warn。

插件的 `api` 声明不能写 `*`。写死才是对自己负责。
