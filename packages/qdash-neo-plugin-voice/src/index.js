import Schema from '@deepseek-ai/schemastery'

import { TtsClient } from './tts.js'

/**
 * 语音插件：把一句话合成成语音。
 *
 * **它只做主框架做不了的事**（TTS 需要外部服务）。发送、路径校验、体积体检、
 * 频率限流、`[语音] xxx` 落库全部由主框架的 `ctx.qdashNeo.voice.send()` 负责 ——
 * 插件只产出一个音频文件，其余什么都碰不到。
 *
 * 不装这个插件时主框架的语音功能照常可用（`qq_send_voice` 发语音库里现成的音频）。
 */

export const name = '@cmnyhh/qdash-neo-plugin-voice'

/**
 * 存储 / 配置 / 来源标记的命名空间。
 *
 * **不能直接用 `name`**：内核要求 `^[a-z][a-z0-9_]{0,31}$`（小写字母开头，
 * 只允许 a-z0-9_），而 `@cmnyhh/qdash-neo-plugin-voice` 里有 `@` 和 `/` ——
 * `settings.register` / `storage.forFeature` / `outboxApi.forPlugin` 会全部拒掉，
 * 而且报错是「插件名不合法」，看起来像写错了名字。
 *
 * 这个值是**用户可见**的：`tools.disabledPlugins` 里要填它，
 * 控制台选项卡的「来自 xxx」也显示它。所以取短的那个。
 */
const NS = 'qdash_neo_voice'

/** 只声明需要的能力：拿服务、注册工具 */
export const inject = ['qdashNeo']

/**
 * 本插件用到的能力面。
 *
 * **当前不被校验** —— 内核拿不到插件的 manifest，`ctx.qdashNeo.capabilities`
 * 也是一份只读清单（见规范 §2.8）。写在这里有两个用处：
 *
 *   1. 读代码的人一眼看到它依赖什么，不用翻全文
 *   2. 将来真做安装期校验时，这份声明就是现成的
 *
 * 名字与内核 `capabilities` 的键一致。
 */
export const capabilities = ['tools', 'settings', 'storage', 'voice-send', 'console-tab']

export const Config = Schema.object({
  tts: Schema.object({
    enabled: Schema.boolean().default(false).description('允许把文字合成语音（默认关）'),
    protocol: Schema.union(['openai', 'gpt-sovits', 'custom'])
      .default('openai')
      .description('接口形状：openai = /v1/audio/speech 兼容 / gpt-sovits = 原生 /tts / custom = 自己填 body 模板'),
    endpoint: Schema.string()
      .default('')
      .description('合成接口地址，如 http://127.0.0.1:9880/v1/audio/speech'),
    apiKey: Schema.string().role('secret').default('').description('可选，会以 Authorization: Bearer 发送'),
    timeoutMs: Schema.natural()
      .default(30000)
      .description('单次合成超时；超时直接失败（不重试），让模型改用文字说同样的话'),
    maxChars: Schema.natural()
      .default(200)
      .description('单次合成最多多少字；超过直接拒（合成慢、按量计费，长文本没意义）'),
    format: Schema.string().default('mp3').description('要回来的音频格式：mp3 / wav / opus / silk'),
    cacheMaxFiles: Schema.natural()
      .default(200)
      .description('合成缓存最多保留多少个文件，超出按最旧的删；同一句话不会重复合成'),

    model: Schema.string().default('tts-1').description('[openai] 模型名'),
    voice: Schema.string().default('alloy').description('[openai] 音色名'),

    refAudioPath: Schema.string()
      .default('')
      .description('[gpt-sovits] 参考音频在服务器上的绝对路径，必须真实存在'),
    promptText: Schema.string()
      .default('')
      .description('[gpt-sovits] 参考音频对应的文字（要与音频内容一致，否则音色会飘）'),
    promptLang: Schema.string().default('zh').description('[gpt-sovits] 参考音频的语言'),
    textLang: Schema.string().default('zh').description('[gpt-sovits] 要合成的文本语言'),
    speedFactor: Schema.number().default(1).description('[gpt-sovits] 语速倍率，1 = 原速'),

    bodyTemplate: Schema.string()
      .default('{"text":"{{text}}"}')
      .description('[custom] 请求体 JSON 模板，`{{text}}` 会被替换成要说的内容'),
  }).description('TTS：把文字合成语音（默认关）'),
}).description('语音插件配置')

export function apply(ctx, config) {
  const neo = ctx.qdashNeo
  /**
   * **不能用 `ctx.log`。**
   *
   * cordis 的 `ctx.xxx` 只能访问 `inject` 里声明过的服务，`log` 也是服务之一。
   * 没有声明时，**取属性那一刻**就抛 `cannot get property "log" without inject` ——
   * 连 `typeof ctx.log` 都会触发，所以"先探测再用"这种写法也不安全。
   *
   * 直接用内核 service 实例上的 `log`：它是普通函数属性，不经过 cordis 的属性代理。
   */
  const log = typeof neo?.log === 'function' ? (...args) => neo.log(...args) : () => {}

  /**
   * 主框架版本不匹配时**直接退出并说明原因**。
   * 「插件装了没反应」是最难查的一类问题：没有报错、页面也没变化。
   */
  if (!neo?.tools?.register) {
    log('warn', 'qdash-neo-plugin-voice: 主框架没有提供 tools.register（qdash-neo 版本太旧？），已跳过')
    return
  }
  if (!neo?.voice?.send) {
    log('warn', 'qdash-neo-plugin-voice: 主框架没有提供 voice.send，已跳过')
    return
  }
  if (!neo?.console?.registerTab) {
    log('warn', 'qdash-neo-plugin-voice: 主框架没有提供 console.registerTab，控制台选项卡将不可用')
  }

  // 缓存目录跟主框架的语音库走：两边各推一遍规则，换 DSH_HOME 后必然一个写对一个写错
  /**
   * 配置走**运行层**（`settings.register`），不是 patch 的 `config`。
   *
   * patch 里的 `config.tts` 只作为默认值：用户在控制台改过之后以控制台那份为准。
   * 这样"改个 endpoint 要重启宿主"就不存在了。
   */
  const conf = neo.settings.register({
    plugin: NS,
    key: 'tts',
    defaults: config?.tts ?? {},
  })

  /**
   * 缓存目录走 `storage.dir()`，**不是**内核的语音库目录。
   *
   * 之前是 `voice.dir() + '.tts/'`，把插件的产物塞进内核的数据目录 ——
   * 按边界说，语音库归主框架（用户往里放音频），插件缓存放进去会混在一起，
   * 卸载插件时也不知道该清哪一份。
   *
   * 对旧版内核降级回 `voice.dir()`：那时还没有 `storage.dir`。
   */
  const cacheDir =
    typeof neo.storage?.dir === 'function' ? neo.storage.dir('tts') : (neo.voice.dir?.() ?? '')

  const tts = new TtsClient({ tts: conf.get() }, { log, dir: cacheDir })

  /* ---------------- 工具 ---------------- */

  /**
   * 按当前配置挂 / 摘 `qq_speak`。
   *
   * **TTS 没开启就不注册**：挂一个必然报错的工具比没有更糟 ——
   * 模型会调一次、读错误、换个说法再调一次，一整轮就这么没了。
   *
   * **但也不能只在 apply 时判一次**：用户在面板里打开 TTS 之后工具要立刻可用，
   * 关掉之后也要摘掉。所以这里是个可重复调用的同步函数，
   * `save` 之后会再跑一遍（否则会表现为"开了 TTS 但工具清单里没有"）。
   *
   * @type {(() => void)|null} 已注册时的注销函数
   */
  let disposeSpeak = null

  const syncSpeak = () => {
    const on = tts.enabled === true

    if (on && !disposeSpeak) {
      try {
        disposeSpeak = neo.tools.register({
          name: 'qq_speak',
          owner: NS,
          description:
            '把一句话合成成语音发到当前会话。**语音是"语气比字面更重要"时才用的东西**：' +
            '一两句就说完、情绪明显、或者懒得打字。说正事、内容偏长、群里人多的时候，' +
            '用 qq_send_message 打字更合适。文本不宜过长（合成慢且按量计费）。',
          params: { text: '要合成成语音的文字，尽量短' },
          async execute(args, exec) {
            const text = String(args?.text ?? '').trim()
            if (!text) throw new Error('text 不能为空')
            const chatKey = String(exec?.chatKey ?? '').trim()
            if (!chatKey) throw new Error('拿不到会话标识（主框架未注入 chatKey）')

            // 只负责"造出文件"，发送与全部检查都交给主框架
            const { file } = await tts.render(text)
            await neo.voice.send({ chatKey, file, label: text, trusted: true })
            return { ok: true, spoke: text }
          },
        })
        log('info', 'qdash-neo-plugin-voice: 已注册工具 qq_speak（对新建会话生效）')
      } catch (err) {
        log('warn', `qdash-neo-plugin-voice: qq_speak 注册失败 msg=${err?.message}`)
      }
      return
    }

    if (!on && disposeSpeak) {
      try {
        disposeSpeak()
      } catch {
        /* 注销失败不该连带别的事 */
      }
      disposeSpeak = null
      log('info', 'qdash-neo-plugin-voice: TTS 已关闭，qq_speak 已摘除')
    }
  }

  syncSpeak()

  /* ---------------- 控制台选项卡 ---------------- */

  if (!neo.console?.registerTab) return

  let dispose = null
  const mb = n => (Number(n) / 1024 / 1024).toFixed(1)

  const snapshot = () => {
    try {
      return { voice: neo.voice.describe?.() ?? null, tts: tts.describe() }
    } catch (err) {
      log('warn', `qdash-neo-plugin-voice: 读状态失败 name=${err?.name} msg=${err?.message}`)
      return { voice: null, tts: tts.describe() }
    }
  }

  const build = () => {
    const s = snapshot()
    const v = s.voice
    const files = v?.files ?? []
    /** 当前生效的配置（含用户在控制台改过的） */
    const cur = conf.get()

    return {
      id: 'voice',
      // 不叫「语音库」：那是内核在配置页里的分组（voice.* 的开关与限制）。
      // 这个选项卡配的是 TTS，改叫「语音合成」避免两处同名。
      title: '语音合成',
      order: 50,
      owner: NS,
      layout: [
        {
          type: 'status',
          title: '状态',
          items: [
            { label: '语音功能', value: v?.enabled ? '已开启' : '未开启', tone: v?.enabled ? 'ok' : 'warn' },
            { label: '目录', value: v?.dir ?? '(未就绪)' },
            { label: '音频文件', value: `${files.length} 个`, tone: files.length ? 'ok' : 'warn' },
            {
              label: 'TTS',
              /**
               * 三种状态要分开说，否则"勾了开关但没填地址"会显示成「未开启」，
               * 用户以为是开关没生效，实际问题在缺配置。
               */
              value: s.tts.enabled
                ? s.tts.protocol
                : s.tts.missing?.length
                  ? `未就绪（缺${s.tts.missing.join('、')}）`
                  : '未开启',
              tone: s.tts.enabled ? 'ok' : 'warn',
            },
            { label: '合成缓存', value: `${s.tts.cachedFiles} 个` },
          ],
        },
        {
          type: 'table',
          title: '库里有什么',
          columns: [{ label: '文件' }, { label: '大小', num: true }, { label: '修改时间' }],
          rows: files
            .slice(0, 50)
            .map(f => [f.name, `${mb(f.size)}MB`, new Date(f.mtime).toLocaleString('zh-CN', { hour12: false })]),
          empty: '语音库是空的 —— 把 .mp3 / .silk 放进上面的目录，再点「刷新列表」',
        },
        {
          type: 'form',
          title: 'TTS 配置（改完点保存，立即生效）',
          fields: [
            { path: 'enabled', label: 'TTS 开关', type: 'boolean', value: cur.enabled === true },
            {
              path: 'protocol',
              label: '协议',
              type: 'string',
              value: cur.protocol,
              description: 'openai = /v1/audio/speech 兼容 / gpt-sovits = 原生 /tts / custom = 自己填模板',
            },
            {
              path: 'endpoint',
              label: '接口地址（必填）',
              type: 'string',
              value: cur.endpoint,
              description:
                '如 http://127.0.0.1:9880/v1/audio/speech。**只勾开关不填这里，工具不会注册** —— 调了必然失败，所以干脆不挂',
            },
            { path: 'format', label: '音频格式', type: 'string', value: cur.format },
            { path: 'maxChars', label: '单次字数上限', type: 'number', value: cur.maxChars },
            { path: 'voice', label: '音色（openai 协议）', type: 'string', value: cur.voice },
            {
              path: 'refAudioPath',
              label: '参考音频路径（gpt-sovits 协议）',
              type: 'string',
              value: cur.refAudioPath,
              description: '服务器上的绝对路径，必须真实存在',
            },
          ],
          submit: { id: 'save', label: '保存' },
        },
        {
          type: 'actions',
          actions: [
            {
              id: 'save',
              label: '保存配置',
              /**
               * `values` 是表单按 `path` 收上来的对象（`{ enabled: true, endpoint: '...' }`）。
               * 内核只透传，不解析 —— 插件的配置结构插件自己知道。
               */
              run: async ({ values } = {}) => {
                if (!values || typeof values !== 'object') {
                  return { ok: false, message: '没有收到字段值' }
                }
                try {
                  const next = conf.set(values)
                  // 立刻生效：工具闭包里那个实例跟着换配置，不重建对象
                  tts.applyConfig({ tts: next })
                  // 开关变了要跟着挂/摘 qq_speak —— 否则面板里开了 TTS，
                  // 工具清单里却一直没有它（下次重启才出现）
                  syncSpeak()
                } catch (err) {
                  return { ok: false, message: `保存失败：${err?.message ?? err}` }
                }
                registry()
                return { ok: true, message: '已保存，立即生效' }
              },
            },
            {
              id: 'refresh',
              label: '刷新列表',
              run: async () => {
                registry()
                return { ok: true, message: `已重新读取，共 ${(snapshot().voice?.files ?? []).length} 个文件` }
              },
            },
          ],
        },
      ],
    }
  }

  const registry = () => {
    try {
      dispose?.()
    } catch {
      /* 旧 disposer 抛错不该挡住重新注册 */
    }
    dispose = neo.console.registerTab(build())
  }

  registry()
}
