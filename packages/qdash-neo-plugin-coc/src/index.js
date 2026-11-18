/**
 * COC 7 版跑团插件 —— 能力注册层。
 *
 * ## 一条贯穿始终的原则：插件只管算，模型负责说
 *
 * 骰子结果、血量变化、场景切换都由插件算准，但**一条消息都不发** ——
 * 全部交给模型组织语言。这样语气统一，仿真模式下也不会冒出系统腔。
 *
 * 唯一的例外是插图：生图要几十秒，模型不能干等，所以画完由插件补发一张图。
 *
 * ## 两种模式
 *
 * `scene.mode` 是**这一局**的属性，开团时定：
 *
 *   - `classic`  —— 返回一行可以直接转述的骰点
 *   - `narrative` —— 只给"该怎么写"的提示，玩家看不到数字
 *
 * **仿真模式下插件仍然把数字给模型**：它要靠数字推算后续（剩多少血、
 * 困难阈值多少）。只是明确告诉它别往群里说。
 */
import Schema from '@deepseek-ai/schemastery'

import { gradeSkill, rollD100, rollExpr } from './dice.js'
import { checkSummary, exprSummary, healthTone, narrativeHint, sanityTone } from './format.js'
import { ImageClient } from './image.js'
import { Journal } from './journal.js'
import { createSheet, derive, skillBase } from './sheet.js'
import { CocStore, whoKey } from './store.js'

export const name = '@cmnyhh/qdash-neo-plugin-coc'
export const inject = ['qdashNeo']

/**
 * 存储/配置/来源标记用的短名。
 *
 * 不能用包名 —— 命名空间不允许 `@` 和 `/`，报错只说"插件名不合法"，
 * 看起来像名字打错了（守则 §0.2 第 3 条）。
 */
const NS = 'qdash_neo_coc'

/** 部署方配置。**每个字段都要 `.default()`**：patch 的 config 是整块替换 */
export const Config = Schema.object({
  image: Schema.object({
    endpoint: Schema.string().default(''),
    apiKey: Schema.string().role('secret').default(''),
    /**
     * `openai` / `sdapi` / `custom`。
     *
     * **故意用 `Schema.string()` 而不是 `union`**：`union` 的入参形态
     * 在不同 schemastery 版本里不一样（数组常量还是 Schema 节点），
     * 写错不会报"配置非法"，而是整个插件加载失败 —— 代价太大了。
     * 值不对的话 `ImageClient` 会当成 openai 处理，行为可预测。
     */
    protocol: Schema.string().default('openai'),
    model: Schema.string().default('dall-e-3'),
    size: Schema.string().default('512x512'),
    stylePrefix: Schema.string().default('1920s cosmic horror, muted palette, film grain, oil painting'),
    promptSuffix: Schema.string().default(''),
    negativePrompt: Schema.string().default('text, watermark, blurry'),
    steps: Schema.number().default(24),
    timeoutMs: Schema.number().default(120000),
    /** `protocol: 'custom'` 时按点路径取图片字段 */
    resultPath: Schema.string().default('image'),
  }).default({}),
})

/* ---------------- 入参归一化 ---------------- */

/**
 * **插件工具的参数全是字符串**（`PluginToolRegistry` 一律映射成 `{type:'string'}`）。
 *
 * 所以模型传 `bonus: 1` 到这里也是 `"1"`；直接 `Number()` 之外还要挡住 `""`
 * 和 `"abc"` —— 它们会变成 `NaN` 然后静默失效（`NaN` 参与比较永远 false）。
 */
function toNum(v, dflt = 0) {
  if (v === '' || v === null || v === undefined) return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

function toBool(v, dflt = false) {
  const s = String(v ?? '').trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'off'].includes(s)) return false
  return dflt
}

/** 从角色卡里取技能值：加过点用加过的，否则走基础值（闪避/母语依赖属性） */
function skillOf(sheet, rawName) {
  const key = String(rawName ?? '').trim()
  if (!key) return 0
  const trained = sheet?.skills?.[key]
  if (Number.isFinite(trained)) return Math.max(0, Math.trunc(trained))
  return skillBase(key, sheet?.attrs ?? {})
}

export function apply(ctx, config = {}) {
  const neo = ctx.qdashNeo

  /**
   * **必须有这一行。** `neo.log` 的 info 级在 journalctl 里看不到，
   * 于是「插件没加载」和「加载了但没生效」在日志里长得一模一样 ——
   * 美团插件在那上面花了一轮排查。
   */
  console.log('qdash-neo-plugin-coc: 已加载')

  const log = typeof neo?.log === 'function' ? (...a) => neo.log(...a) : () => {}

  if (!neo?.tools?.register) {
    log('warn', 'qdash-neo-plugin-coc: 主框架没有 tools.register（版本太旧？），已跳过')
    return
  }
  if (!neo?.storage?.forFeature) {
    log('warn', 'qdash-neo-plugin-coc: 主框架没有 storage.forFeature，角色卡无处可存，已跳过')
    return
  }

  /* ---------------- 运行时设置 ---------------- */

  const conf = neo.settings.register({
    plugin: NS,
    key: 'coc',
    defaults: {
      enabled: config?.enabled !== false,
      /** 建卡时顺手画头像 */
      autoPortrait: config?.autoPortrait !== false,
      /** 场景切换时配图（一场一次） */
      autoSceneArt: config?.autoSceneArt !== false,
      /** 回顾默认条数 */
      recentLimit: toNum(config?.recentLimit, 30),
      /**
       * **生图后端放在 settings 而不是 Config。**
       *
       * `Config.image` 是部署层配置（`cordis.patch.yml`），改一次要重启；
       * 而"换个生图地址"是随时会做的事，得在控制台里当场能改。
       *
       * `Config.image` 仍然生效 —— 作为 settings 留空时的兜底，
       * 部署方想固化默认值就写在 patch 里。
       */
      imageEndpoint: '',
      imageApiKey: '',
      imageProtocol: 'openai',
      imageSize: '512x512',
      imageStyle: '',
      imageNegative: '',
    },
  })

  /* ---------------- 基础设施 ---------------- */

  const kv = neo.storage.forFeature(NS)
  const store = new CocStore({ kv, log })

  let journal = null
  try {
    if (typeof neo.storage.dir === 'function') {
      journal = new Journal({ dir: neo.storage.dir(NS, 'log'), log })
    }
  } catch (err) {
    log('warn', `qdash-neo-plugin-coc: 日志目录不可用，本场记录将不落盘 msg=${err?.message}`)
  }

  const imageCfg = config?.image ?? {}
  let imgDir = ''
  try {
    if (typeof neo.storage.dir === 'function') imgDir = neo.storage.dir(NS, 'img')
  } catch {
    /* 没有目录就不画图，不影响跑团 */
  }
  const images = new ImageClient({
    /**
     * **每次读最新值**：控制台改完立刻生效，不用重启。
     *
     * 优先级：settings（控制台）> `Config.image`（patch 部署层）> 内置默认。
     * `timeoutMs` / `steps` / `resultPath` / `bodyTemplate` 只在 patch 里配 ——
     * 它们不是"日常会调"的东西，摊在控制台上只会增加误操作。
     */
    getConfig: () => {
      const c = conf.get()
      const fallback = imageCfg ?? {}
      const pick = (key, dflt = '') => {
        const fromSettings = String(c?.[key] ?? '').trim()
        return fromSettings || String(fallback[key] ?? '').trim() || dflt
      }
      return {
        endpoint: pick('imageEndpoint'),
        apiKey: pick('imageApiKey'),
        protocol: pick('imageProtocol', 'openai'),
        size: pick('imageSize', '512x512'),
        stylePrefix: pick('imageStyle'),
        negativePrompt: pick('imageNegative'),
        model: fallback.model ?? 'dall-e-3',
        steps: fallback.steps ?? 24,
        timeoutMs: fallback.timeoutMs ?? 120000,
        resultPath: fallback.resultPath ?? 'image',
        bodyTemplate: fallback.bodyTemplate,
      }
    },
    dir: imgDir,
    log,
  })

  /** 出站句柄：只用来补发生图结果 */
  let out = null
  try {
    out = neo.outboxApi?.forPlugin?.(NS) ?? null
  } catch (err) {
    log('warn', `qdash-neo-plugin-coc: 出站队列不可用 msg=${err?.message}`)
  }

  /* ---------------- 运行时状态 ---------------- */

  /**
   * 每个会话最近一条消息的发送者。
   *
   * 内核注入的 `exec` 里**只有 `chatKey`，没有发送者 QQ 号**，所以
   * `who` 缺省时只能靠这里兜底。代价是"谁最后说话"未必就是"谁要掷骰"，
   * 所以返回值里会回显实际用了谁，模型看到对不上能立刻纠正。
   *
   * @type {Map<string, { who: string, ts: number }>}
   */
  const lastSenders = new Map()

  /** 插件卸载后别再补发图 */
  let disposed = false

  function resolveWho(chatKey, raw) {
    const explicit = String(raw ?? '').trim()
    if (explicit) return explicit
    const last = lastSenders.get(String(chatKey ?? ''))
    return last?.who ?? ''
  }

  /** 当前模式：没开团按 classic，并在返回里提示一句 */
  function modeOf(chatKey) {
    const scene = store.getScene(chatKey)
    return { scene, mode: scene.mode === 'narrative' ? 'narrative' : 'classic', opened: Boolean(scene.sessionId) }
  }

  const notOpenHint = '还没开场。想正式带团先调 qq_coc_scene({ act: "new", title: "...", mode: "classic" 或 "narrative" })'

  /* ---------------- 事件：记录 + 发送者兜底 ---------------- */

  if (typeof neo.on === 'function') {
    ctx.effect(() => {
      const offIn = neo.on('message/inbound', ev => {
        const chatKey = String(ev?.chatKey ?? '')
        if (!chatKey) return

        const name = String(ev?.senderName ?? '').trim()
        const uid = String(ev?.userId ?? '').trim()
        const who = name && uid ? `${name}(${uid})` : name || uid
        if (who) lastSenders.set(chatKey, { who, ts: Date.now() })

        journal?.append(chatKey, { kind: 'in', who: who || '', text: String(ev?.text ?? '').slice(0, 500) })
      })

      const offOut = neo.on('message/outbound', ev => {
        const chatKey = String(ev?.chatKey ?? '')
        if (!chatKey) return
        /**
         * **跳过插件自己发的**：生图结果的补发已经有 `art` 记录，
         * 这里再记一次会变成"KP 发了张图"和"插图已发送"两条重复。
         */
        if (String(ev?.from ?? '') === `plugin:${NS}`) return
        journal?.append(chatKey, { kind: 'out', text: String(ev?.text ?? '').slice(0, 800) })
      })

      return () => {
        disposed = true
        offIn?.()
        offOut?.()
      }
    })
  }

  /* ---------------- 生图补发 ---------------- */

  /**
   * 后台画图，画完补发。
   *
   * **不 await**：生图 10–60 秒，工具调用等不起。先返回"正在画"，
   * 完成后再 `sendSegments` 补一张图（不带文字，文字由模型自己说）。
   *
   * @param {string} chatKey
   * @param {string} subject
   * @param {'portrait'|'scene'|'npc'} kind
   * @param {(file: string) => void} [onDone] 拿到文件后回写 KV
   */
  function drawInBackground(chatKey, subject, kind, onDone) {
    if (!images.ready || disposed) return false

    images
      .generate({ subject, kind })
      .then(r => {
        if (!r?.file || disposed) return
        try {
          onDone?.(r.file)
        } catch (err) {
          log('warn', `qdash-neo-plugin-coc: 图片路径回写失败 msg=${err?.message}`)
        }
        try {
          out?.sendSegments({
            chatKey,
            segments: [{ type: 'image', data: { file: r.file } }],
            text: '',
          })
          journal?.append(chatKey, { kind: 'art', text: `${kind} 已发送`, file: r.file })
        } catch (err) {
          log('warn', `qdash-neo-plugin-coc: 补发图片失败 msg=${err?.message}`)
        }
      })
      .catch(err => log('warn', `qdash-neo-plugin-coc: 生图异常 msg=${err?.message}`))

    return true
  }

  /* ---------------- 工具 ---------------- */

  /* ---- 1. 通用骰 ---- */
  ctx.effect(() =>
    neo.tools.register({
      name: 'qq_coc_roll',
      owner: NS,
      description:
        '掷骰子。支持 3d6 / 2d6+3 / 1d6+1d4 / d20 这类表达式。' +
        '**结果由你自己发出去**，插件不会替你发。',
      params: {
        expr: '骰子表达式，如 3d6、1d100、2d6+3',
        who: '谁在掷（昵称或 QQ 号），不填就用本会话最后一条消息的发送者',
      },
      async execute(args, exec) {
        if (!conf.get().enabled) return { ok: false, reason: '跑团插件在控制台里关着' }
        const chatKey = String(exec?.chatKey ?? '')
        const who = resolveWho(chatKey, args?.who)

        let r
        try {
          r = rollExpr(String(args?.expr ?? ''))
        } catch (err) {
          return { ok: false, reason: String(err?.message ?? err) }
        }

        if (journal && chatKey) journal.append(chatKey, { kind: 'roll', who, expr: r.expr, total: r.total })
        const { mode, opened } = modeOf(chatKey)

        if (mode === 'narrative') {
          return {
            ok: true,
            mode,
            total: r.total,
            who,
            hint: '结果自己心里有数就行，用叙事表达，别报数字',
            ...(opened ? {} : { note: notOpenHint }),
          }
        }
        return {
          ok: true,
          mode,
          total: r.total,
          who,
          line: `${who ? `${who} ` : ''}${exprSummary(r)}`,
          note: '这行可以直接发出去',
          ...(opened ? {} : { warning: notOpenHint }),
        }
      },
    }),
  )

  /* ---- 2. 技能检定 ---- */
  ctx.effect(() =>
    neo.tools.register({
      name: 'qq_coc_check',
      owner: NS,
      description:
        'COC 技能检定（d100 掷低为好），自动判大成功/极难/困难/普通/失败/大失败。' +
        '**结果由你自己发出去**；仿真模式下插件只给提示不给玩家看数字。',
      params: {
        skill: '技能名（如 侦查、聆听、闪避）或任意说明',
        who: '谁在检定，不填用本会话最后的发送者',
        value: '直接指定技能值（不填就从角色卡取；也没卡就按技能基础值）',
        bonus: '奖励骰/惩罚骰数量，正数奖励、负数惩罚，如 1 或 -1',
        secret: 'true 表示暗骰：只是不写进记录的数字，反正插件本来就不发消息',
      },
      async execute(args, exec) {
        if (!conf.get().enabled) return { ok: false, reason: '跑团插件在控制台里关着' }
        const chatKey = String(exec?.chatKey ?? '')
        const who = resolveWho(chatKey, args?.who)
        const skill = String(args?.skill ?? '').trim() || '检定'

        const sheet = who ? store.getSheet(chatKey, who) : null
        const explicit = toNum(args?.value, Number.NaN)
        const skillValue = Number.isFinite(explicit) ? explicit : skillOf(sheet, skill)

        const bonus = Math.max(-9, Math.min(9, Math.trunc(toNum(args?.bonus, 0))))
        const d = rollD100({ bonus })
        const level = gradeSkill(skillValue, d.value)

        if (journal && chatKey) {
          journal.append(chatKey, {
            kind: 'check',
            who,
            skill,
            skillValue,
            value: d.value,
            level,
            bonus,
            secret: toBool(args?.secret, false),
          })
        }

        const { mode, opened } = modeOf(chatKey)
        const extra = opened ? {} : { warning: notOpenHint }

        if (mode === 'narrative') {
          const h = narrativeHint(level)
          return {
            ok: true,
            mode,
            who,
            skill,
            /** 数字仍然给模型：它要靠这个推后续，只是别往群里说 */
            value: d.value,
            level,
            hint: h.text,
            note: '**别提任何数字，也不要用「困难成功」这类术语**，直接写成叙事',
            ...extra,
          }
        }

        return {
          ok: true,
          mode,
          who,
          skill,
          value: d.value,
          level,
          line: checkSummary({ name: skill, skill: skillValue, value: d.value, level, bonus }),
          note: '这行可以直接发出去，别改数字',
          ...extra,
        }
      },
    }),
  )

  /* ---- 3. 角色卡 ---- */
  ctx.effect(() =>
    neo.tools.register({
      name: 'qq_coc_sheet',
      owner: NS,
      description:
        '角色卡。act=create 建卡（一次成型，自动算派生值）/ get 查卡 / set 改属性或技能 / hp 增减生命 / san 增减理智。',
      params: {
        act: 'create / get / set / hp / san',
        who: '这张卡属于谁（昵称或 QQ 号），不填用本会话最后的发送者',
        name: 'act=create 时给角色起个名字（不填用 who）',
        field: 'act=set 时改哪一项：属性名（str/con/…）或技能名',
        value: 'act=set/hp/san 时的数值；hp/san 可传负数表示扣',
      },
      async execute(args, exec) {
        if (!conf.get().enabled) return { ok: false, reason: '跑团插件在控制台里关着' }
        const chatKey = String(exec?.chatKey ?? '')
        const act = String(args?.act ?? 'get').trim().toLowerCase()
        const who = resolveWho(chatKey, args?.who)

        if (!who) return { ok: false, reason: '不知道这张卡属于谁 —— 请传 who（昵称或 QQ 号）' }

        if (act === 'create') {
          const sheet = createSheet({ name: String(args?.name ?? who).trim() || who })
          store.setSheet(chatKey, who, sheet)
          if (journal) journal.append(chatKey, { kind: 'scene', text: `${who} 建卡：${sheet.name}` })

          /**
           * 建卡顺手画头像 —— **没配生图后端时 `drawInBackground` 直接返回 false**，
           * 不会有半句日志，也不影响建卡结果。
           */
          const wantPortrait = conf.get().autoPortrait !== false
          const drawing = wantPortrait
            ? drawInBackground(chatKey, `portrait of ${sheet.name}, Call of Cthulhu investigator`, 'portrait', file => {
                const cur = store.getSheet(chatKey, who)
                if (cur) store.setSheet(chatKey, who, { ...cur, image: file })
              })
            : false

          return {
            ok: true,
            act,
            who,
            sheet: summarizeSheet(sheet),
            ...(drawing ? { drawing: true, drawingNote: '头像正在生成，画好会直接发到群里' } : {}),
          }
        }

        const sheet = store.getSheet(chatKey, who)
        if (!sheet) {
          return { ok: false, reason: `${who} 还没建卡。要建就 act=create`, who }
        }

        if (act === 'get') {
          const { mode } = modeOf(chatKey)
          // 仿真模式也给完整数字：模型要算，玩家看不到是模型的责任
          return { ok: true, act, who, mode, sheet: summarizeSheet(sheet) }
        }

        if (act === 'hp' || act === 'san') {
          const delta = Math.trunc(toNum(args?.value, 0))
          if (!delta) return { ok: false, reason: 'act=hp/san 要传 value（可正可负）' }

          const field = act === 'hp' ? 'hp' : 'san'
          const maxField = act === 'hp' ? 'maxHp' : 'maxSan'
          const next = Math.max(0, Math.min(sheet[maxField] ?? 0, (sheet[field] ?? 0) + delta))
          const updated = store.setSheet(chatKey, who, { ...sheet, [field]: next })

          if (journal) {
            journal.append(chatKey, {
              kind: act === 'hp' ? 'damage' : 'sanity',
              who,
              delta: next - (sheet[field] ?? 0),
              [field]: next,
              [maxField]: sheet[maxField] ?? 0,
            })
          }

          const tone = act === 'hp' ? healthTone(next, sheet.maxHp) : sanityTone(next, sheet.maxSan)
          const { mode } = modeOf(chatKey)

          const base = {
            ok: true,
            act,
            who,
            [field]: next,
            [maxField]: updated?.[maxField] ?? sheet[maxField],
            tone: tone.tone,
          }

          if (mode === 'narrative') {
            return {
              ...base,
              state: tone.text,
              hint: `按这个状态写，别说数字：${tone.text}`,
              ...(next <= 0 && act === 'hp' ? { critical: '生命归零，该写重伤或昏迷了' } : {}),
              ...(next <= 0 && act === 'san' ? { critical: '理智归零，该写精神崩溃了' } : {}),
            }
          }

          return {
            ...base,
            state: tone.text,
            line: act === 'hp'
              ? `${who} 生命 ${next > (sheet.hp ?? 0) ? '+' : ''}${next - (sheet.hp ?? 0)} → ${next}/${sheet.maxHp}`
              : `${who} 理智 ${next > (sheet.san ?? 0) ? '+' : ''}${next - (sheet.san ?? 0)} → ${next}/${sheet.maxSan}`,
            ...(next <= 0 ? { critical: '归零了' } : {}),
          }
        }

        if (act === 'set') {
          const field = String(args?.field ?? '').trim()
          if (!field) return { ok: false, reason: 'act=set 要传 field（属性名或技能名）' }
          const raw = args?.value
          if (raw === '' || raw === undefined || raw === null) return { ok: false, reason: 'act=set 要传 value' }

          const next = { ...sheet }
          const attrKey = field.toLowerCase()

          if (attrKey in (sheet.attrs ?? {})) {
            next.attrs = { ...sheet.attrs, [attrKey]: Math.max(0, Math.min(999, Math.trunc(toNum(raw, 0)))) }
            const d = derive({ ...next.attrs, age: sheet.age })
            Object.assign(next, {
              maxHp: d.hp,
              maxMp: d.mp,
              maxSan: d.san,
              mov: d.mov,
              db: d.db,
              build: d.build,
            })
            // 上限变了，当前值跟着夹一下
            next.hp = Math.min(next.hp ?? d.hp, d.hp)
            next.mp = Math.min(next.mp ?? d.mp, d.mp)
            next.san = Math.min(next.san ?? d.san, d.san)
          } else {
            next.skills = {
              ...(sheet.skills ?? {}),
              [field]: Math.max(0, Math.min(999, Math.trunc(toNum(raw, 0)))),
            }
          }

          store.setSheet(chatKey, who, next)
          return { ok: true, act, who, field, sheet: summarizeSheet(next) }
        }

        return { ok: false, reason: `act 只能是 create / get / set / hp / san，收到「${act}」` }
      },
    }),
  )

  /* ---- 4. 场景 ---- */
  ctx.effect(() =>
    neo.tools.register({
      name: 'qq_coc_scene',
      owner: NS,
      description:
        '剧情场景。act=new 开新团（重置场景与战斗、保留角色卡，**在这里定模式**）/ set 改当前场景 / ' +
        'get 查 / clue 记线索 / npc 记 NPC / mode 中途切模式。',
      params: {
        act: 'new / set / get / clue / npc / mode',
        title: 'act=new 时团名，如「谁在敲墙」',
        mode: 'act=new/mode 时选 classic（给骰点）或 narrative（纯叙事）',
        location: '地点',
        time: '游戏内时间，如「1923 年冬，凌晨两点」',
        summary: 'act=set 时一句话概括当前局面',
        text: 'act=clue/npc 的内容',
      },
      async execute(args, exec) {
        if (!conf.get().enabled) return { ok: false, reason: '跑团插件在控制台里关着' }
        const chatKey = String(exec?.chatKey ?? '')
        const act = String(args?.act ?? 'get').trim().toLowerCase()

        if (act === 'new') {
          /**
           * **在 `newSession` 之前读旧场景。** 它会整份重置，之后再读
           * 就只能看到一个空的 `sessionId` —— 判断"上一场收没收"必须在之前。
           */
          const prev = store.getScene(chatKey)
          const previous = store.listChronicles(chatKey, 1)[0] ?? null
          const pendingPrevious = Boolean(prev.sessionId)

          const mode = String(args?.mode ?? 'classic').trim().toLowerCase() === 'narrative' ? 'narrative' : 'classic'
          const sessionId = String(Date.now())
          const scene = store.newSession(chatKey, {
            title: String(args?.title ?? '').trim(),
            mode,
            location: String(args?.location ?? '').trim(),
            sessionId,
          })
          journal?.useSession(chatKey, sessionId)
          journal?.append(chatKey, { kind: 'scene', title: scene.title, location: scene.location, text: `开团（${mode}）` })

          /**
           * **开团期间免频率拦截。**
           *
           * 跑团时玩家的每一句都该有回应，而配额（`groupReplyQuota`）和
           * `replyChance`（默认 0.95，也就是每 20 句丢 1 句）是防刷屏用的 ——
           * 它们会把一段连续对话切成碎片，表现就是"我说了它没理我"。
           *
           * **只关频率，不关资格**：白名单、群开关、是否点名照旧。
           * 收场时（`act=close`）会清掉；万一忘了，主框架有 4 小时 TTL 兜底。
           */
          if (typeof neo.gateBypassApi?.set === 'function') {
            neo.gateBypassApi.set(chatKey, { reason: `跑团：${scene.title || '未命名'}` })
          }

          const drawing =
            conf.get().autoSceneArt !== false && scene.location
              ? drawInBackground(
                  chatKey,
                  `${scene.location}, establishing shot, Call of Cthulhu`,
                  'scene',
                  file => store.setScene(chatKey, { image: file }),
                )
              : false

          return {
            ok: true,
            act,
            scene,
            /**
             * **上一场的回顾，模型拿它当前情提要。**
             *
             * 没有 `previous` 时说明这是第一场（或者从来没归档过）——
             * 那就当全新的团带，不用找补。
             */
            previous: previous
              ? { title: previous.title, summary: previous.summary, closedAt: previous.closedAt }
              : null,
            ...(pendingPrevious
              ? {
                  pendingPrevious: true,
                  pendingNote:
                    '上一场还没收场（没写小结）就已经开了新的。想补的话，等这轮结束用 act=close 写一段，插件会归档成「上一场」。',
                }
              : {}),
            hint:
              mode === 'narrative'
                ? '**仿真模式**：所有检定都不报数字，用叙事表达'
                : '**传统模式**：检定会给一行可以直接发出去的骰点',
            ...(drawing ? { drawing: true, drawingNote: '场景图正在生成，画好会直接发到群里' } : {}),
          }
        }

        /**
         * **收场归档。`summary` 必须由模型写，插件不生成文字。**
         *
         * 写不进摘要的话就拒绝归档 —— 允许空的话 `chronicles` 里会堆一排
         * 「（无摘要）」，下次开团模型看到一堆空条目，还不如没有。
         */
        if (act === 'close') {
          const scene = store.getScene(chatKey)
          const summary = String(args?.summary ?? '').trim()
          if (!summary) {
            return {
              ok: false,
              reason:
                '收场必须给 summary：一段回顾，写清这伙人做了什么、发现了什么、结局如何。' +
                '**插件不会替你编这段** —— 它是这一场唯一会永久留下来的东西。',
            }
          }

          const players = store
            .listSheets(chatKey)
            .map(s => String(s.who || s.name || '').trim())
            .filter(Boolean)

          const chronicle = store.closeSession(chatKey, {
            summary,
            title: scene.title,
            mode: scene.mode,
            clues: scene.clues ?? [],
            players,
            sessionId: scene.sessionId,
          })

          // 先停记录，再清 sessionId —— 顺序反了会把"收场"本身写进战报
          journal?.endSession(chatKey)
          store.setScene(chatKey, { sessionId: '' })

          // 恢复常态的频率拦截：团散了就不该再无限制地回
          if (typeof neo.gateBypassApi?.clear === 'function') {
            neo.gateBypassApi.clear(chatKey)
          }

          return {
            ok: Boolean(chronicle),
            act,
            chronicle,
            /** 场地/线索**保留**：下次开新团想接着用还看得见 */
            kept: { location: scene.location, clues: (scene.clues ?? []).length },
            note: journal ? '本场记录已停止追加，文件仍在磁盘上（可用 act=export 指定 sessionId 导出）' : '记录目录不可用',
          }
        }

        if (act === 'mode') {
          const mode = String(args?.mode ?? '').trim().toLowerCase() === 'narrative' ? 'narrative' : 'classic'
          const scene = store.setScene(chatKey, { mode })
          return { ok: true, act, mode: scene.mode, hint: mode === 'narrative' ? '之后都按叙事走' : '之后给骰点' }
        }

        if (act === 'set') {
          const patch = {}
          for (const k of ['location', 'time', 'summary']) {
            const v = String(args?.[k] ?? '').trim()
            if (v) patch[k] = v
          }
          if (!Object.keys(patch).length) return { ok: false, reason: 'act=set 至少要给 location / time / summary 之一' }
          const scene = store.setScene(chatKey, patch)
          journal?.append(chatKey, { kind: 'scene', text: `场景改到 ${scene.location || scene.title || '(未命名)'}` })

          // 一场一张：已经有图就不重画
          const drawing =
            conf.get().autoSceneArt !== false && !scene.image && patch.location
              ? drawInBackground(
                  chatKey,
                  `${patch.location}, establishing shot, Call of Cthulhu`,
                  'scene',
                  file => store.setScene(chatKey, { image: file }),
                )
              : false

          return { ok: true, act, scene, ...(drawing ? { drawing: true } : {}) }
        }

        if (act === 'clue' || act === 'npc') {
          const text = String(args?.text ?? '').trim()
          if (!text) return { ok: false, reason: `act=${act} 要传 text` }
          const scene = store.getScene(chatKey)
          const key = act === 'clue' ? 'clues' : 'npcs'
          const limit = act === 'clue' ? 100 : 50
          const list = [...(scene[key] ?? []), text].slice(-limit)
          const next = store.setScene(chatKey, { [key]: list })
          return { ok: true, act, [key]: next[key], count: next[key].length }
        }

        const scene = store.getScene(chatKey)
        return { ok: true, act: 'get', scene, opened: Boolean(scene.sessionId) }
      },
    }),
  )

  /* ---- 5. 战斗 ---- */
  ctx.effect(() =>
    neo.tools.register({
      name: 'qq_coc_combat',
      owner: NS,
      description: '战斗。act=start 按敏捷排先攻 / next 轮到下一个 / damage 扣血回血 / end 结束。',
      params: {
        act: 'start / next / damage / end',
        who: 'act=damage 时打谁',
        value: 'act=damage 的数值，负数扣血、正数回血',
      },
      async execute(args, exec) {
        if (!conf.get().enabled) return { ok: false, reason: '跑团插件在控制台里关着' }
        const chatKey = String(exec?.chatKey ?? '')
        const act = String(args?.act ?? 'start').trim().toLowerCase()

        if (act === 'start') {
          const sheets = store.listSheets(chatKey)
          if (!sheets.length) return { ok: false, reason: '本会话还没有角色卡，先 act=create' }

          const order = CocStore.rollInitiative(
            sheets.map(s => ({ who: s.who || s.name, dex: s.attrs?.dex ?? 0 })),
          )
          const combat = store.setCombat(chatKey, { round: 1, order, current: 0, active: true })
          journal?.append(chatKey, { kind: 'combat', text: `开战，先攻：${order.map(o => o.who).join(' → ')}` })
          return { ok: true, act, combat, current: order[0]?.who ?? '' }
        }

        if (act === 'next') {
          const combat = store.getCombat(chatKey)
          if (!combat.active) return { ok: false, reason: '现在不在战斗中' }

          const order = [...combat.order]
          if (order[combat.current]) order[combat.current] = { ...order[combat.current], acted: true }

          let next = combat.current + 1
          let round = combat.round
          if (next >= order.length) {
            next = 0
            round += 1
            for (let i = 0; i < order.length; i += 1) order[i] = { ...order[i], acted: false }
          }

          const updated = store.setCombat(chatKey, { ...combat, order, current: next, round })
          return { ok: true, act, round: updated.round, current: order[next]?.who ?? '', order }
        }

        if (act === 'damage') {
          const who = resolveWho(chatKey, args?.who)
          if (!who) return { ok: false, reason: 'act=damage 要传 who' }
          const delta = Math.trunc(toNum(args?.value, 0))
          if (!delta) return { ok: false, reason: 'act=damage 要传 value（负数扣血）' }

          const sheet = store.getSheet(chatKey, who)
          if (!sheet) return { ok: false, reason: `${who} 没有角色卡` }

          const next = Math.max(0, Math.min(sheet.maxHp ?? 0, (sheet.hp ?? 0) + delta))
          store.setSheet(chatKey, who, { ...sheet, hp: next })
          journal?.append(chatKey, { kind: 'damage', who, delta: next - (sheet.hp ?? 0), hp: next, maxHp: sheet.maxHp })

          const tone = healthTone(next, sheet.maxHp)
          const { mode } = modeOf(chatKey)
          return {
            ok: true,
            act,
            who,
            hp: next,
            maxHp: sheet.maxHp,
            state: tone.text,
            ...(mode === 'narrative'
              ? { hint: `按「${tone.text}」写，别提数字` }
              : { line: `${who} 生命 ${delta < 0 ? '' : '+'}${next - (sheet.hp ?? 0)} → ${next}/${sheet.maxHp}` }),
            ...(next <= 0 ? { critical: '生命归零，该写重伤或昏迷' } : {}),
          }
        }

        if (act === 'end') {
          store.setCombat(chatKey, { round: 0, order: [], current: 0, active: false })
          journal?.append(chatKey, { kind: 'combat', text: '战斗结束' })
          return { ok: true, act, active: false }
        }

        return { ok: false, reason: `act 只能是 start / next / damage / end，收到「${act}」` }
      },
    }),
  )

  /* ---- 6. 记录 ---- */
  ctx.effect(() =>
    neo.tools.register({
      name: 'qq_coc_log',
      owner: NS,
      description:
        '跑团记录。act=recap 前情回顾（往期摘要 + 本场近况）/ act=recent 看最近几条原始流水 / act=export 导出整场为 Markdown。',
      params: {
        act: 'recap / recent / export',
        n: 'act=recent 默认 30 条；act=recap 的本场近况默认 15 条',
      },
      async execute(args, exec) {
        if (!conf.get().enabled) return { ok: false, reason: '跑团插件在控制台里关着' }
        const chatKey = String(exec?.chatKey ?? '')
        if (!journal) return { ok: false, reason: '记录目录不可用（主框架没有 storage.dir）' }

        const act = String(args?.act ?? 'recent').trim().toLowerCase()

        /**
         * **`recap` 必须排在「还没开团」的早退之前。**
         *
         * 往期摘要存在 KV 里，和当前有没有开团无关 —— 放在早退之后，
         * 就变成「没开团就看不到历史」，与这个功能的目的正好相反。
         */
        if (act === 'recap') {
          const scene = store.getScene(chatKey)
          const chronicles = store.listChronicles(chatKey, 5).map(c => ({
            title: c.title,
            summary: String(c.summary ?? '').slice(0, 300),
            closedAt: c.closedAt,
            players: c.players ?? [],
          }))

          const opened = Boolean(scene.sessionId)
          const recent = opened
            ? journal.recent(chatKey, Math.max(1, Math.min(50, Math.trunc(toNum(args?.n, 15)))))
            : []

          return {
            ok: true,
            act: 'recap',
            chronicles,
            current: opened
              ? {
                  title: scene.title,
                  mode: scene.mode,
                  location: scene.location,
                  summary: scene.summary,
                  clues: scene.clues ?? [],
                  npcs: scene.npcs ?? [],
                }
              : null,
            recent,
            note:
              chronicles.length === 0
                ? '还没有归档过任何场次。一场跑完用 qq_coc_scene act=close 写段小结，下次就能在这里看到。'
                : '往期只给摘要；要某一场的完整流水，用 act=export 带上它的 sessionId。',
          }
        }

        if (act === 'export') {
          const scene = store.getScene(chatKey)
          /**
           * 已收场时当前场次是空的，从归档里取最后一个 `sessionId` 指回去 ——
           * 否则「刚跑完想导出」这件事永远做不到。
           */
          const last = store.listChronicles(chatKey, 1)[0]
          const { markdown, count } = journal.exportMarkdown(chatKey, {
            title: scene.title || '跑团记录',
            sessionId: journal.sessionOf(chatKey) ? '' : last?.sessionId ?? '',
          })
          return { ok: true, act, count, markdown }
        }

        if (!journal.sessionOf(chatKey)) {
          return { ok: false, reason: '本会话还没开团，没有记录。先 act=new 开一场（想看往期用 act=recap）' }
        }

        const n = Math.max(1, Math.min(200, Math.trunc(toNum(args?.n, conf.get().recentLimit ?? 30))))
        const rows = journal.recent(chatKey, n)
        return { ok: true, act: 'recent', count: rows.length, rows }
      },
    }),
  )

  /* ---- 7. 插图 ---- */
  ctx.effect(() =>
    neo.tools.register({
      name: 'qq_coc_art',
      owner: NS,
      description:
        '画插图。act=portrait 给某人画像 / scene 画当前场景 / npc 画某个 NPC。' +
        '生图要几十秒，所以会先返回"正在画"，画完直接发到群里。',
      params: {
        act: 'portrait / scene / npc',
        subject: '画什么，如「一个佝偻的老人」「地下室，滴水」',
        who: 'act=portrait 时给谁画（不填用本会话最后的发送者）',
      },
      async execute(args, exec) {
        if (!conf.get().enabled) return { ok: false, reason: '跑团插件在控制台里关着' }
        const chatKey = String(exec?.chatKey ?? '')
        const act = String(args?.act ?? 'portrait').trim().toLowerCase()
        const kind = ['portrait', 'scene', 'npc'].includes(act) ? act : 'portrait'

        if (!images.ready) {
          return {
            ok: false,
            reason: '生图后端还没配。去控制台「跑团」页把 endpoint 填上，或者先在 cordis.patch.yml 里配。',
          }
        }

        let subject = String(args?.subject ?? '').trim()
        if (!subject) {
          if (kind === 'scene') {
            const sc = store.getScene(chatKey)
            subject = sc.location || sc.summary || sc.title || ''
          } else {
            const who = resolveWho(chatKey, args?.who)
            subject = who ? `${who} 的人物肖像` : ''
          }
        }
        if (!subject) return { ok: false, reason: '要给个 subject（画什么），或者先 act=scene 设好地点' }

        const drawing = drawInBackground(chatKey, subject, kind, file => {
          if (kind === 'portrait') {
            const who = resolveWho(chatKey, args?.who)
            const cur = who ? store.getSheet(chatKey, who) : null
            if (cur) store.setSheet(chatKey, who, { ...cur, image: file })
          } else if (kind === 'scene') {
            store.setScene(chatKey, { image: file })
          }
        })

        if (!drawing) return { ok: false, reason: '生图启动失败（可能插件正在卸载）' }

        journal?.append(chatKey, { kind: 'art', text: `开始画 ${kind}：${subject.slice(0, 60)}` })
        return {
          ok: true,
          act: kind,
          subject,
          drawing: true,
          note: '**正在画，画完会直接发到群里**。别自己描述这张图 —— 还没生成出来。',
        }
      },
    }),
  )

  /* ---------------- 常驻引导 ---------------- */

  /**
   * KP 的行为准则。**写的是"什么时候做什么"，不是工具参数**（那在 description 里）。
   *
   * 开头那句「带团时适用，平时忽略」是必要的：`instructions` 是**全局注入**的，
   * 别的群日常聊天时这段也会进 prompt。
   */
  if (typeof neo?.instructions?.register === 'function') {
    ctx.effect(() =>
      neo.instructions.register({
        key: 'coc.kp',
        owner: NS,
        /**
         * **写的是"什么时候做什么"，不是工具参数**——参数在 description 里。
         *
         * 三件事必须写进来，否则模型一定会错：
         *   ① 掷骰要调工具（不写它就会凭感觉说"你成功了"）
         *   ② 仿真模式别提数字（不写它会报骰点，模式就白做了）
         *   ③ **失败不等于"没找到"**（这条最容易被忽略，也是新手 KP 最容易
         *      把团带死的地方：侦查失败 → 没有线索 → 全桌卡住）
         */
        text: `【带团时适用；平时不跑团就忽略这段】

你是这桌 COC 7 版的守秘人（KP）。你不是助手，是那个知道真相却不说破的人。

## 掷骰：必须调工具

要判定就调 qq_coc_check，**不许凭感觉说「你成功了」**。

- 工具回 \`line\`（传统模式）→ 照原样发出去，别改数字
- 工具回 \`hint\`（仿真模式）→ 写成叙事，**不提任何数字，不用「困难成功」这类术语**

## 描述的四条

**恐怖靠留白，不靠形容词。**
「墙上有抓痕」比「恐怖的、令人毛骨悚然的、诡异的抓痕」有力得多。

**一次说清一件事**，然后停下等回应。群里刷屏没人看。

**给环境，不给答案。** 不替玩家决定行动，也别问「你要不要……」
——把选择留在他们手里，他们才会真的在玩。

**有日常才有异常。** 一直阴森等于一直平淡。先写点正常的，
再让某一个地方不对——那一下才吓人。

## 失败怎么用

**失败不能让剧情卡死。** 侦查失败不是「没找到」，而是「找到了，但付了代价」：
花的时间更久、弄出了声音、只看见一部分、被不该看见的东西看见。

只有**大失败**才该有真正的损失。

## 什么时候暗骰

玩家不该知道成败的：聆听、侦查、心理学、潜行。
或者结果只影响你接下来怎么描述的时候。

其余场合当众掷——让人看见骰子，他们才会相信结果。

## 禁止

- 复述工具返回的 JSON
- 说「你掷出了 34」这种系统腔
- 一次推进多个场景
- 替玩家写台词（描述他在做什么可以，替他说话不行）
- 让 NPC 主动交出线索——他们有自己的目的，得被逼、被换、被骗`,
      }),
    )
  }

  /* ---------------- 控制台选项卡 ---------------- */

  /**
   * **选项卡是注册那一刻的快照**（守则 §5.3），状态变了必须 dispose 后重注册。
   *
   * 所以这里留了一个 `renderTab()`：注册、刷新、保存后都走它。
   * 直接在 `ctx.effect` 里注册静态块，会让页面上的数字永远是启动时那份。
   */
  let tabDispose = null

  function collectStats() {
    let scenes = 0
    let sheets = 0
    let archived = 0
    try {
      const rows = kv.list() ?? []
      for (const r of rows) {
        const k = String(r?.key ?? '')
        if (k.startsWith('scene:')) scenes += 1
        else if (k.startsWith('sheet:')) sheets += 1
        else if (k.startsWith('campaign:')) {
          /**
           * 这里要的是**总场次**，不是"有归档的会话数" ——
           * 一个群跑过 8 场，页面应该显示 8 而不是 1。
           */
          const list = r?.value?.chronicles
          archived += Array.isArray(list) ? list.length : 0
        }
      }
    } catch {
      /* 列不出来就当 0，控制台不该因为统计失败整页挂掉 */
    }
    return { scenes, sheets, archived }
  }

  function recentScenes(limit = 8) {
    const out = []
    try {
      const rows = kv.list() ?? []
      for (const r of rows) {
        const k = String(r?.key ?? '')
        if (!k.startsWith('scene:')) continue
        const v = r?.value
        if (!v || typeof v !== 'object') continue
        out.push({
          chatKey: k.slice('scene:'.length),
          title: String(v.title ?? '').trim() || '(未命名)',
          mode: v.mode === 'narrative' ? '仿真' : '传统',
          updatedAt: Number(v.updatedAt) || 0,
          session: String(v.sessionId ?? ''),
        })
      }
    } catch {
      return []
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
  }

  function renderTab() {
    if (typeof neo?.console?.registerTab !== 'function') return
    tabDispose?.()
    tabDispose = null

    const c = conf.get()
    const { scenes, sheets, archived } = collectStats()
    const recent = recentScenes()
    const imgState = images.ready
      ? `${c.imageProtocol || 'openai'} · ${images.config.size || '512x512'}`
      : '未配置（在下方「生图后端」里填地址）'

    try {
      tabDispose = neo.console.registerTab({
        id: 'coc',
        title: '跑团',
        order: 60,
        owner: NS,
        layout: [
          {
            type: 'status',
            title: '运行状态',
            items: [
              { label: '插件', value: c.enabled === false ? '已停用' : '运行中', tone: c.enabled === false ? 'warn' : 'ok' },
              { label: '生图后端', value: imgState, tone: images.ready ? 'ok' : 'muted' },
              { label: '记录', value: journal ? '可用（JSONL）' : '不可用', tone: journal ? 'ok' : 'bad' },
              { label: '已开团', value: `${scenes} 个会话`, tone: 'ok' },
              { label: '已归档', value: `${archived} 场`, tone: archived ? 'ok' : 'muted' },
              { label: '角色卡', value: `${sheets} 张`, tone: 'ok' },
            ],
          },
          {
            type: 'table',
            title: '最近的团',
            columns: [{ label: '团名' }, { label: '模式' }, { label: '会话' }, { label: '更新' }],
            rows: recent.map(r => [
              r.title,
              r.mode,
              r.chatKey,
              r.updatedAt ? new Date(r.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—',
            ]),
            empty: '还没有开过团。在群里说「开个团」就会出现在这里。',
          },
          {
            type: 'form',
            title: '设置',
            fields: [
              {
                path: 'autoPortrait',
                label: '建卡时自动画头像',
                type: 'boolean',
                value: c.autoPortrait !== false,
                description: '需要先配好生图后端；没配时这项不起作用',
              },
              {
                path: 'autoSceneArt',
                label: '场景切换时配图',
                type: 'boolean',
                value: c.autoSceneArt !== false,
                description: '一场只画一次，已有图不重画',
              },
              {
                path: 'recentLimit',
                label: '回顾默认条数',
                type: 'number',
                value: Number(c.recentLimit) || 30,
                description: 'qq_coc_log act=recent 不传 n 时用这个',
              },
            ],
            submit: { id: 'save', label: '保存' },
          },
          {
            /**
             * **生图后端单独一块。**
             *
             * 和上面那组开关分开，因为它们改的是"要不要画"，
             * 这块改的是"画得出来吗" —— 混在一起会让人误以为
             * 打开开关就等于配好了后端。
             */
            type: 'form',
            title: '生图后端',
            fields: [
              {
                path: 'imageEndpoint',
                label: '服务地址',
                value: c.imageEndpoint ?? '',
                description:
                  '例：http://127.0.0.1:7860/sdapi/v1/txt2img。**留空就不画图** —— 建卡、切场景照常，只是没有图。',
              },
              {
                path: 'imageProtocol',
                label: '协议',
                options: [
                  { value: 'openai', label: 'openai（/v1/images/generations）' },
                  { value: 'sdapi', label: 'sdapi（SD WebUI）' },
                  { value: 'custom', label: 'custom（自定义）' },
                ],
                value: c.imageProtocol || 'openai',
              },
              {
                path: 'imageApiKey',
                label: 'API Key',
                type: 'password',
                value: c.imageApiKey ?? '',
                description: '本地服务通常留空。密码框只防误截图，能打开控制台的都看得到。',
                when: { path: 'imageProtocol', in: ['openai'] },
              },
              {
                path: 'imageSize',
                label: '尺寸',
                value: c.imageSize || '512x512',
                description: '如 512x512、768x512。太大在 1.6G 内存的机器上会很慢。',
              },
              {
                path: 'imageStyle',
                label: '风格前缀',
                value: c.imageStyle ?? '',
                description: '留空用内置的 1920s cosmic horror 那套；想换画风就写自己的。',
              },
            ],
            submit: { id: 'saveImage', label: '保存生图配置' },
          },
          {
            type: 'actions',
            actions: [
              {
                id: 'refresh',
                label: '刷新',
                description: '重新统计会话与角色卡数量',
                run: async () => {
                  renderTab()
                  return { ok: true, message: '已刷新' }
                },
              },
              {
                id: 'prune',
                label: '清理旧插图',
                confirm: '只保留最近 50 张插图，更早的会被删除。确认？',
                run: async () => {
                  const n = images.prune(50)
                  renderTab()
                  return { ok: true, message: n ? `删了 ${n} 张` : '没有需要清理的' }
                },
              },
            ],
          },
        ],
        /**
         * **`actions` 是 `registerTab` 的顶层字段**，不是 layout 里的块 ——
         * 写成 `form.actions` 会被静默忽略，界面上一个按钮都不响应（守则 §0.2）。
         */
        actions: {
          save: async ({ values } = {}) => {
            const patch = {}
            if (values && 'autoPortrait' in values) patch.autoPortrait = Boolean(values.autoPortrait)
            if (values && 'autoSceneArt' in values) patch.autoSceneArt = Boolean(values.autoSceneArt)
            if (values && 'recentLimit' in values) {
              patch.recentLimit = Math.max(1, Math.min(200, Math.trunc(toNum(values.recentLimit, 30))))
            }
            conf.set(patch)
            renderTab()
            return { ok: true, message: '已保存，立即生效' }
          },

          /**
           * 生图配置的保存。
           *
           * **`ok` 恒为 true**：这是"保存配置"，不是"测试连通性"。
           * 地址填错也保存成功 —— 用户可能想先填后调。
           * 能不能连通会在下一次 `qq_coc_art` 的返回里体现。
           */
          saveImage: async ({ values } = {}) => {
            const patch = {}
            for (const k of ['imageEndpoint', 'imageApiKey', 'imageProtocol', 'imageSize', 'imageStyle']) {
              if (values && k in values) patch[k] = String(values[k] ?? '').trim()
            }
            conf.set(patch)
            renderTab()

            const ready = images.ready
            return {
              ok: true,
              message: ready
                ? '已保存，生图后端可用'
                : '已保存，但地址为空 —— 之后不会画图（其余功能不受影响）',
            }
          },
        },
      })
    } catch (err) {
      log('warn', `qdash-neo-plugin-coc: 注册控制台选项卡失败 msg=${err?.message}`)
    }
  }

  ctx.effect(() => {
    renderTab()
    return () => {
      tabDispose?.()
      tabDispose = null
    }
  })

  /* ---------------- 内部工具 ---------------- */

  /** 卡面摘要：给模型看的那份，字段名用中文，别让它去猜 `siz` 是什么 */
  function summarizeSheet(s) {
    const a = s.attrs ?? {}
    return {
      name: s.name,
      who: s.who ?? '',
      age: s.age,
      attrs: {
        力量: a.str,
        体质: a.con,
        体型: a.siz,
        敏捷: a.dex,
        外貌: a.app,
        智力: a.int,
        意志: a.pow,
        教育: a.edu,
      },
      hp: `${s.hp}/${s.maxHp}`,
      mp: `${s.mp}/${s.maxMp}`,
      san: `${s.san}/${s.maxSan}`,
      luck: s.luck,
      mov: s.mov,
      db: s.db,
      build: s.build,
      skills: s.skills ?? {},
      occupationalPoints: s.occupationalPoints,
      interestPoints: s.interestPoints,
      image: s.image || '',
    }
  }
}
