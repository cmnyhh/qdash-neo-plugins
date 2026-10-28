import * as bili from './api.js'
/** 纯 JS 的二维码生成器（MIT，无依赖）—— 见文件末尾 `qrDataUrl` 的说明 */
import qrcode from './vendor/qrcode.mjs'

const NS = 'qdash_neo_bili'

export const name = '@cmnyhh/qdash-neo-plugin-bili'

export const inject = ['qdashNeo']

export const capabilities = {
  tools: true,
  settings: true,
  storage: true,
  instructions: true,
}

/**
 * B 站「闲逛」插件。
 *
 * 干的事：**定时把模型叫醒，让它去看看 B 站有什么值得分享的**。
 * 数据由插件抓（热门/分区榜/搜索），判断由模型做，发送走内核的 `qq_send_card`。
 *
 * ## 为什么定时在插件、挑选在模型
 *
 * 定时是机制（模型自己不会到点醒来），挑选是判断（哪条有意思、配什么话）。
 * 把挑选也写进代码，等于用规则替它决定"什么好笑"。
 *
 * ## 工具名为什么叫 bili_hot / bili_find
 *
 * 社区里的 `dsh-bili-scroll` 已经占了 `bili_search`。插件工具同名会注册失败
 * （不同 owner 视作冲突），所以换名字避开。
 */
export function apply(ctx, config = {}) {
  const neo = ctx.qdashNeo
  /** 不能用 `ctx.log`（要 inject），用 service 上的普通属性 */
  const log = typeof neo?.log === 'function' ? (...a) => neo.log(...a) : () => {}

  /**
   * 诊断用：`neo.log` 的 info 级在 DSH 里看不到，而"插件没启动"和
   * "启动了但没打日志"从外部看一模一样。先确认 `apply` 真的被调用了。
   */
  console.log('qdash-neo-plugin-bili: apply 被调用')

  if (!neo?.tools?.register) {
    log('warn', 'qdash-neo-plugin-bili: 主框架没有 tools.register（版本太旧？），已跳过')
    return
  }

  const conf = neo.settings.register({
    plugin: NS,
    key: 'bili',
    defaults: {
      enabled: config?.enabled !== false,
      minMinutes: Number(config?.minMinutes) > 0 ? Number(config.minMinutes) : 180,
      maxMinutes: Number(config?.maxMinutes) > 0 ? Number(config.maxMinutes) : 480,
      /** 额外指定的群；留空则用内核 `policy.groupWhitelist` */
      chatKeys: Array.isArray(config?.chatKeys) ? config.chatKeys : [],
      /** 每次给几条候选 */
      limit: Number(config?.limit) > 0 ? Number(config.limit) : 6,
      /**
       * 想刷的方向。**留空就随便逛**。
       *
       * 每一项可以是**分区名**（游戏、科技…，见 `RIDS`），也可以是**关键词**
       * （「太刀」「装机」）。每轮随机取一个，并避开上一轮用过的 ——
       * 只配两三个方向时，纯随机很容易连着两次同一个。
       */
      topics: Array.isArray(config?.topics) ? config.topics : [],
    },
  })

  const store = neo.storage.forFeature(NS)

  /** 内存里的扫码状态；不持久化，重启就作废（二维码本来也只有几分钟） */
  let qr = null
  let qrTimer = null
  let timer = null
  let nextAt = Number(store.get('nextAt') ?? 0) || 0

  const cookie = () => String(store.get('cookie') ?? '')
  const loggedIn = () => Boolean(cookie())

  /* ---------------- 目标会话 ---------------- */

  /**
   * 发到哪些群。
   *
   * 优先用插件自己的 `chatKeys`；没配就跟着内核的群白名单走 ——
   * 那是用户已经表达过「这些群我允许它说话」的地方，再让他配一遍是重复。
   *
   * **白名单为空时什么都不发**，并留一条 warn：群白名单为空在内核里的语义是
   * 「不限群」，但插件不该据此往所有群推送 —— 那是另一种事故。
   */
  /**
   * 把配置里的会话标识规整成内核要的 `chatKey`。
   *
   * **`policy.groupWhitelist` 里存的是纯群号**（`"705590372"`），而
   * `openProactive` 靠 `chatKey.startsWith('g:')` 判断群聊还是私聊 ——
   * 不补前缀就会被当成**私聊**，`userId = "705590372"`，
   * 消息发往一个不存在的用户，然后**静默失败**。
   *
   * 这正是"立刻试一次说成功、群里什么都没有"的原因之一。
   */
  const toChatKey = raw => {
    const s = String(raw ?? '').trim()
    if (!s) return ''
    if (s.startsWith('g:') || s.startsWith('u:')) return s
    // 纯数字（或其它没前缀的）一律当群号：白名单就是这么存的
    return `g:${s}`
  }

  const targets = () => {
    const own = (conf.get().chatKeys ?? []).map(toChatKey).filter(Boolean)
    if (own.length) return own
    const wl = (neo.config?.policy?.groupWhitelist ?? []).map(toChatKey).filter(Boolean)
    /**
     * 诊断：出现「（没配，不会发）」时，这两行能立刻分清是
     * "插件没读到内核配置" 还是 "白名单真的是空"。
     */
    console.log(
      `qdash-neo-plugin-bili: targets own=${JSON.stringify(own)} ` +
        `whitelist=${JSON.stringify(neo.config?.policy?.groupWhitelist ?? null)}`,
    )
    return wl
  }

  /* ---------------- 定时 ---------------- */

  /**
   * @param {number} [elapsedMs] 上一轮已经跑掉的时间，用来补偿间隔
   */
  const schedule = (elapsedMs = 0) => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!conf.get().enabled) return

    /**
     * **下限是 1 分钟，不是 10。**
     *
     * 这里原来写 `Math.max(10, …)`，于是配置页填 1 分钟、2 分钟都没用 ——
     * 实际永远至少等 10 分钟，而**配置页照原样显示你填的值**，
     * 看起来像"设置不生效"。
     *
     * 那个 10 应该是为了防高频调 B 站接口，但热门榜不是按次计费的接口，
     * 1 分钟一次完全没问题；真要限流该由调用方自己控制。
     */
    const min = Math.max(1, Number(conf.get().minMinutes) || 180)
    const max = Math.max(min, Number(conf.get().maxMinutes) || 480)
    /**
     * **间隔从"上一轮开始"算，不从"结束"算。**
     *
     * 原来 `tick` 在 `finally` 里调 `schedule()`，而那时一轮已经跑完了 ——
     * 于是实际周期 = 执行耗时 + 间隔。设 1 分钟、一轮跑 3 分钟，
     * 实际就是 4 分钟一次，而日志只会写"1 分钟"。
     *
     * 现在把执行耗时算进去：`waitMs = gap - elapsed`。
     * 兜底留 15 秒喘息 —— 执行比间隔还长时不能无缝连跑。
     */
    const gapMs = Math.round((min + Math.random() * (max - min)) * 60_000)
    /**
     * 本轮已经跑了 `elapsedMs`，剩下的时间补上就行。
     *
     * 兜底 15 秒：执行比间隔还长时（比如一轮唤起 3 个群各等了 40 秒），
     * 不能无缝连跑，否则就是一个死循环，而且会持续占用模型调用。
     */
    const waitMs = Math.max(15_000, gapMs - elapsedMs)

    nextAt = Date.now() + waitMs
    store.set('nextAt', nextAt)
    timer = setTimeout(tick, waitMs)
    // 不阻止进程退出：这是个后台节奏，不是必须完成的任务
    timer.unref?.()
    if (elapsedMs > 5_000) {
      log(
        'info',
        `qdash-neo-plugin-bili: 本轮耗时 ${Math.round(elapsedMs / 1000)}s，` +
          `${(waitMs / 60_000).toFixed(1)} 分钟后下一轮`,
      )
    }
  }

  /**
   * 这一轮往哪个方向逛。
   *
   * 配置了 `topics` 就随机取一个（避开上一轮），没配就返回空串 = 随便逛。
   *
   * **避开上一轮**：只配两三个方向时，纯随机有 1/3 概率连着两次同一个，
   * 而用户看到的就是"它又发那个分区了"。
   */
  const pickTopic = () => {
    const list = (conf.get().topics ?? []).map(s => String(s).trim()).filter(Boolean)
    if (!list.length) return ''

    const last = String(store.get('lastTopic') ?? '')
    const pool = list.length > 1 ? list.filter(t => t !== last) : list
    const pick = pool[Math.floor(Math.random() * pool.length)]

    store.set('lastTopic', pick)
    return pick
  }

  /**
   * @param {string} topic 本轮方向（空 = 随便逛）
   */
  const hint = topic => {
    const list = `有分区榜：${Object.keys(bili.RIDS).slice(0, 12).join('、')}`

    /**
     * 方向可能是分区名，也可能是关键词 —— 用 `RIDS` 里有没有来区分。
     *
     * 不区分的话只能一律当关键词搜，而搜索**需要登录**；
     * 没登录时那条路是断的，分区榜却不需要。
     */
    let focus = ''
    if (topic) {
      const rid = bili.RIDS[topic]
      if (rid != null) {
        focus = `这轮往「${topic}」这个分区看（bili_hot 带上 rid 传「${topic}」）。`
      } else if (loggedIn()) {
        focus = `这轮找找跟「${topic}」有关的东西（bili_find 用关键词「${topic}」）。`
      } else {
        // 没登录搜不了，退一步：提示它按这个方向在热门榜里挑
        focus = `这轮重点看跟「${topic}」有关的，热门榜里挑也行。`
      }
    }

    return (
      '你去 B 站逛逛。' +
      focus +
      `没指定方向就用 bili_hot 看热门榜，想看某个分区就带上 rid（${list}）；` +
      (loggedIn() ? '想找具体的东西就用 bili_find 按关键词搜。' : '') +
      '看到真的有意思、值得跟群友聊的，就调 qq_send_card 发出去，' +
      '**再补一条 qq_send_message 说说你觉得哪里有意思** —— 卡片里只有标题和封面，正文读不到。' +
      '没看到什么值得说的就不用发，也不用为了"到点了"硬找一个。'
    )
  }

  const tick = async () => {
    timer = null
    /** 记开始时间：`finally` 里要把它算进间隔，不然实际周期会多出一整轮的执行时间 */
    const startedAt = Date.now()
    /** 本轮遇到的问题（空 = 全部唤起成功） */
    const problems = []
    try {
      const keys = targets()
      if (!keys.length) {
        const reason = '没有可发的群：插件 chatKeys 与内核群白名单都为空'
        log('warn', `qdash-neo-plugin-bili: ${reason}，跳过本轮`)
        return { ok: false, reason, count: 0 }
      }
      /**
       * 方向**每轮只选一次，所有群共用**。
       *
       * 放在循环里各自随机会很怪：同一个时间点，几个群收到的是完全不同的
       * 方向，像几个人各刷各的；而它本来该是「它此刻在逛什么」。
       */
      const topic = pickTopic()
      for (const key of keys) {
        try {
          /**
           * **必须看返回值。**
           *
           * `openProactive` 有三道闸（主动发言未开 / 今日上限 / 安静时段），
           * 被拦时它会返回 `{ ok: false, reason }` 而不是抛错 ——
           * 早先它静默 return，这里就以为"唤起成功了"，
           * 用户看到的是"点了没反应"，日志里一个字都没有。
           */
          const r = await neo.openProactive(key, { hint: hint(topic) })
          if (r && r.ok === false) {
            problems.push(r.reason || r.skipped || '被内核拦下')
          }
        } catch (err) {
          log('warn', `qdash-neo-plugin-bili: 唤起 ${key} 失败 msg=${err?.message}`)
          problems.push(`唤起失败：${err?.message}`)
        }
      }
      return {
        ok: problems.length === 0,
        reason: problems.join('；'),
        count: keys.length,
      }
    } finally {
      // 把这一轮的耗时传进去，让间隔从"开始"算而不是"结束"算
      schedule(Date.now() - startedAt)
    }
  }

  /* ---------------- 工具 ---------------- */

  /**
   * 给模型看的候选形状。
   *
   * `desc` 截 120 字：够它判断「这条到底讲什么」，又不至于 6 条加起来
   * 占掉半屏 prompt。想细看的可以调 `bili_comments`，那个会带完整简介。
   */
  const shape = list =>
    list.map(v => {
      /**
       * **简介可能没有，得说清楚。**
       *
       * 实测热门榜里 `desc` 大多是完整的（一百多字），但有一部分是空串或
       * 单个 `"-"` —— 那种条目模型只看得到标题，判断不了内容，就会犹豫着不发。
       *
       * 模型的原话："Title only + no desc. I'm not sure it's AI. Risky to assert."
       * 它宁可跳过也不愿瞎猜。
       *
       * 所以：desc 太短时补上**分区**（`tname`），并显式标注"无简介" ——
       * 让它知道这是"信息不全"，而不是"我漏看了"。
       */
      const desc = String(v.desc ?? '').trim()
      const useful = desc.length >= 8 && desc !== '-'
      return {
        aid: v.aid,
        title: v.title,
        desc: useful ? desc.slice(0, 120) : `（无简介${v.tname ? `，分区：${v.tname}` : ''}）`,
        up: v.up,
        url: v.url,
        cover: v.pic,
        view: v.view > 10000 ? `${Math.round(v.view / 10000)}万` : String(v.view),
      }
    })

  /**
   * **把看过/发过的条目排到后面。**
   *
   * 问题：热门榜几小时内基本不变，而每次唤起都会推同一批。模型自己也记得
   * （"万字复盘AL惨败 (already done)"），于是越看越没得挑，最后跳过。
   *
   * 做法上**不硬删**——如果榜单真没变化，删完就是空列表，它反而更没法发。
   * 改成「标注 + 重排」：没看过的在前，看过的标 `seen`，让它优先挑新的；
   * 真没新的，它至少知道"这些我都看过"，可以理直气壮地这轮不发。
   *
   * 只留最近 100 个 aid：热门榜的重复周期就几轮，久远的应该允许再推。
   */
  /**
   * **只记最近 2 轮，而不是最近 100 个 aid。**
   *
   * 原来是累加保留 100 个：热门榜本身只有几十条，几轮下来**整个榜都被标成
   * 「看过」**，于是每轮都是"整页 seen"，而引导里写着"整页 seen 就不发" ——
   * 结果就是 1 分钟唤起一次，8~11 分钟才发一条。
   *
   * 改成按轮次记：只保留最近 2 轮看到过的 aid。榜单不变时，第 3 轮那些条目
   * 重新变成"没看过"，它又能挑了。
   *
   * 代价：可能重复推几天前的同一条。但热门榜本来就几小时才换，
   * "完全不重复"和"一直不发"之间只能选后者更糟。
   */
  const SEEN_KEY = 'seenRounds'
  const seenRounds = () => {
    const v = store.get(SEEN_KEY)
    return Array.isArray(v) ? v.filter(Array.isArray) : []
  }
  const markSeen = list => {
    const rounds = seenRounds()
    const seen = new Set(rounds.flat().map(String))
    const shaped = shape(list).map(x => ({ ...x, seen: seen.has(String(x.aid)) }))
    // 没看过的在前；同组内保持原顺序（榜单本身就是按热度排的）
    shaped.sort((a, b) => (a.seen ? 1 : 0) - (b.seen ? 1 : 0))
    // 本轮 + 上一轮，最多两轮
    const ids = list.map(v => String(v.aid))
    store.set(SEEN_KEY, [ids, ...rounds].slice(0, 2))
    return shaped
  }

  ctx.effect(() =>
    neo.tools.register({
      name: 'bili_hot',
      owner: NS,
      description:
        '看 B 站热门榜或某个分区的排行榜。' +
        '**这是"刷 B 站"的入口**：想知道最近有什么火的、或者某个分区在聊什么，就调它。' +
        '不传 rid 是总热门；传分区名（游戏/科技/动画/搞笑/影视…）看那个分区。',
      params: {
        rid: '可选：分区名或数字编号；不传就是总热门榜',
        limit: '可选：要几条，默认 6',
      },
      async execute(args) {
        const n = Math.max(1, Math.min(15, Number(args?.limit) || conf.get().limit || 6))
        const rid = String(args?.rid ?? '').trim()
        const list = rid ? await bili.ranking(rid, { limit: n }) : await bili.popular({ limit: n })
        // `markSeen` = shape + 标注「看过」+ 把新的排前面
        const items = markSeen(list)
        return { ok: true, count: items.length, items }
      },
    }),
  )

  ctx.effect(() =>
    neo.tools.register({
      name: 'bili_find',
      owner: NS,
      description:
        '按关键词搜 B 站视频。**群里刚聊到什么，就去搜什么** —— 比如聊到太刀就搜太刀。' +
        (loggedIn() ? '' : '（当前没登录，搜不了；要么先让主人去控制台扫码，要么改用 bili_hot 看热门）'),
      params: { keyword: '搜索关键词', limit: '可选：要几条，默认 6' },
      async execute(args) {
        const kw = String(args?.keyword ?? '').trim()
        if (!kw) throw new Error('keyword 不能为空')
        if (!loggedIn()) {
          throw new Error('B 站没登录，搜不了。这次改用 bili_hot 看热门榜吧；想让搜索可用，让主人去控制台「B 站」扫码。')
        }
        const n = Math.max(1, Math.min(15, Number(args?.limit) || conf.get().limit || 6))
        const list = await bili.search(kw, { cookie: cookie(), limit: n })
        // `markSeen` = shape + 标注「看过」+ 把新的排前面
        const items = markSeen(list)
        return { ok: true, count: items.length, items }
      },
    }),
  )

  ctx.effect(() =>
    neo.tools.register({
      name: 'bili_comments',
      owner: NS,
      /**
       * **评论是「理解素材」，不是「评价对象」。**
       *
       * 早先写的是"评论区在吵什么"，结果模型分享视频时顺带点评评论区的
       * 人怎么吵 —— 那不是在分享视频，是在当评论区解说员。
       *
       * 用户的原话：「评论是用来帮助理解视频的，不要变成评论评论的人」。
       */
      description:
        '读一条视频的热门评论，**用来读懂这条视频**：它实际讲了什么、哪里出彩、哪里翻车。' +
        '标题和简介只有 UP 主自己那套说法，评论能反映"做出来到底怎么样"。' +
        '**读完你心里有数就行** —— 你的任务是判断它值不值得分享，' +
        '不是去点评评论区里的人和话。' +
        '拿不准再看；随手转一下就省了这一步。',
      params: {
        aid: '视频的 aid（bili_hot / bili_find 返回的 items 里带 aid）',
        limit: '可选：要几条，默认 8',
      },
      async execute(args) {
        const aid = String(args?.aid ?? '').trim()
        if (!aid) throw new Error('缺少 aid：bili_hot / bili_find 的结果里每条都带 aid')
        const n = Math.max(1, Math.min(20, Number(args?.limit) || 8))
        const list = await bili.comments(aid, { cookie: cookie(), limit: n })
        return { ok: true, count: list.length, comments: list }
      },
    }),
  )

  /* ---------------- 引导 ---------------- */

  ctx.effect(() =>
    neo.instructions.register({
      key: 'bili',
      owner: NS,
      text:
        '有人排了时间让你去逛 B 站时，用 bili_hot（热门/分区）或 bili_find（按关键词搜）看看。' +
        '列表里每条都带简介（desc）—— **先看简介判断它到底讲什么**，光看标题容易猜错。' +
        /**
         * **评论的定位：帮助理解视频，不是拿来评价的。**
         *
         * 之前写"评论区在吵什么"，模型就真的去转述评论区怎么吵 ——
         * 分享视频变成了点评评论区，跑偏了。
         */
        '拿不准它到底怎么样时，用 aid 调 bili_comments 读几条热评 —— ' +
        '**评论是用来看懂视频的**：它实际做得好不好、哪里被夸哪里被骂。读完心里有数就够了。' +
        '只是随手转一下就不必读评论了。' +
        /**
         * **一轮只分享一条。**
         *
         * 试过"允许多条、但要求每条都发卡片"，结果是它一次甩两个 ——
         * 而定时分享这个场景，一天好几轮，每轮都发两个就太密了。
         *
         * 一次一个也更像人：没人会攒着三条一次性甩进群里。
         */
        '**一轮只分享一条**。看到好几条都值得发的，挑最有意思的那条，' +
        '剩下的留到下次 —— 一次给两个，别人反而看不过来。' +
        '分享时先调 qq_send_card 发卡片，**再单独发一条 qq_send_message 说你的看法** —— ' +
        '卡片里只有标题和封面，群里看不到你的态度。' +
        /**
         * **那条文字不要再贴链接。**
         *
         * 卡片本来就带跳转，再贴一遍等于同一个视频出现两次（实测发生过）。
         * 模型这么写的心思是"怕对方找不到"，但它不知道卡片是能点的。
         */
        '**那条文字只写看法，不要把链接再贴一遍** —— 卡片本身就能点开，' +
        '重复贴出来，群里看到的是同一个视频响了两回。' +
        /**
         * **评价落在视频本身，别点评评论区。**
         *
         * 模型很容易把"我读了评论"当成素材，于是分享时说的是
         * "评论区都在吵 XX" —— 群里看到的是一个人在解说评论区，
         * 而不是在分享一个视频。
         */
        '评价落在**视频本身**：它讲什么、你看到哪觉得有意思，一两句具体的就够。' +
        '别只写"这个不错"，也别转述或点评评论区 —— 你是分享视频的人，不是评论区的解说员。' +
        /**
         * **"群里没人说话"不是不发理由。**
         *
         * 模型的原话："Group is silent since midnight. Don't spam."
         * 它把"安静"读成了"别打扰"，于是主动分享变成了等别人先开口 ——
         * 而主动分享的时机本来就只有没人说话的时候。
         *
         * 另外：简介为空时（列表里标成「（无简介，分区：xx）」）不代表这条没意思，
         * 想确认就调 bili_comments 看几条，别只因为看不到简介就跳过。
         */
        '群里安静是正常的 —— **主动分享本来就是在没人说话的时候开口**，不用等别人先聊。' +
        '候选里标着「（无简介）」的，想确认就调 bili_comments 看一眼，别只因为看不到简介就跳过。' +
        /**
         * `seen` 字段要说清，否则模型看到 true 不知道什么意思。
         *
         * **但不能再写"整页都是 seen 就不发"。**
         *
         * 那句话配上"累加保留 100 个"的记忆，热门榜几轮就被标满，
         * 之后每轮都是"整页 seen"→ 直接跳过。实测表现是
         * **1 分钟唤起一次、8~11 分钟才发一条**，看起来像定时器坏了。
         *
         * 现在 `seen` 只记最近两轮，整页标满的情况偶尔还会有（榜单真的没变），
         * 所以允许它从见过的里面挑一个 —— 宁可重复，也别一直不出声。
         */
        '列表里 `seen: true` 的是**最近两轮给你看过的** —— ' +
        '优先挑没标的；**整页都标了也没关系**，挑一个你最有话说的就行。' +
        '但确实翻下来都一般，就什么都不做，不用为了完成任务硬发一条。',
    }),
  )

  /* ---------------- 控制台 ---------------- */

  const qrImage = () => {
    if (!qr?.dataUrl) return ''
    return qr.dataUrl
  }

  const buildTab = () => ({
    id: 'bili',
    title: 'B 站',
    owner: NS,
    layout: [
      {
        type: 'status',
        items: [
          { label: '登录', value: loggedIn() ? '已登录' : '未登录（只能看热门/分区榜）', tone: loggedIn() ? 'ok' : 'warn' },
          {
            label: '下次闲逛',
            value: nextAt ? new Date(nextAt).toLocaleString('zh-CN', { hour12: false }) : '未排期',
          },
          { label: '间隔', value: `${conf.get().minMinutes}–${conf.get().maxMinutes} 分钟` },
          { label: '目标群', value: targets().join('、') || '（没配，不会发）' },
        ],
      },
      {
        type: 'form',
        title: '登录',
        fields: [
          {
            path: 'qr',
            label: '扫码登录',
            type: 'image',
            value: qrImage(),
            description: qr
              ? `二维码 ${qr.state === 'scanned' ? '已扫描，请在手机上确认' : '等待扫描'}`
              : '点下面的「生成二维码」，用手机 B 站 App 扫。**登录后搜索才可用**',
          },
        ],
      },
      /**
       * **`actions` 是独立的块类型，不能挂在 `form` 下面。**
       *
       * `tabs.js` 的 `BLOCK_TYPES` 里 `form` / `table` / `status` / `actions` 平级，
       * 而 `#block()` 只处理 `block.type === 'actions'`。写成 `form.actions`
       * 会被**静默忽略** —— 界面上一个按钮都没有，插件侧也收不到任何报错。
       */
      {
        type: 'actions',
        title: '登录操作',
        actions: [
          {
            id: 'gen',
            label: '生成二维码',
            run: async () => {
              const { url, qrcodeKey } = await bili.qrcode()
              const dataUrl = qrDataUrl(url)
              /**
               * 诊断：点了按钮显示 200、图却是空的 —— 那说明 `run` 跑通了，
               * 但 `dataUrl` 是空串（`qrDataUrl` 的 catch 分支）。
               * 这两行能直接分清是"没生成"还是"生成了但没渲染"。
               */
              console.log(
                `qdash-neo-plugin-bili: 二维码 url长度=${url.length} ` +
                  `dataUrl长度=${dataUrl.length} 前缀=${dataUrl.slice(0, 30)}`,
              )
              qr = { qrcodeKey, state: 'waiting', dataUrl }
              startPolling()
              refreshTab()
              return {
                ok: true,
                message: dataUrl ? '二维码已生成，请用手机 B 站扫' : '二维码生成失败（见日志）',
              }
            },
          },
          {
            id: 'logout',
            label: '退出登录',
            run: async () => {
              store.set('cookie', '')
              qr = null
              refreshTab()
              return { ok: true, message: '已清除本地登录态' }
            },
          },
        ],
      },
      {
        type: 'form',
        title: '设置',
        fields: [
          { path: 'enabled', label: '启用定时闲逛', type: 'boolean', value: conf.get().enabled === true },
          {
            path: 'chatKeys',
            label: '目标群（留空 = 跟随群白名单）',
            type: 'string',
            value: (conf.get().chatKeys ?? []).join(','),
            description:
              '填 `g:<群号>`，多个用逗号分隔。**留空就用内核的群白名单** —— ' +
              '那是你已经表达过"这些群我允许它说话"的地方，不必再配一遍',
          },
          { path: 'minMinutes', label: '最短间隔（分钟）', type: 'number', value: conf.get().minMinutes },
          { path: 'maxMinutes', label: '最长间隔（分钟）', type: 'number', value: conf.get().maxMinutes },
          {
            path: 'topics',
            label: '想刷的方向（留空 = 随便逛）',
            type: 'string',
            value: (conf.get().topics ?? []).join(','),
            description:
              '逗号分隔。**分区名**（游戏、科技、动画、搞笑…）走排行榜，' +
              '**其它词**（太刀、装机、猫）当关键词搜 —— 搜索要登录。' +
              '每轮随机取一个，尽量不连着重复。留空就让它自己看热门榜',
          },
          { path: 'limit', label: '每次给几条候选', type: 'number', value: conf.get().limit },
        ],
        submit: {
          id: 'save',
          label: '保存设置',
          run: async ({ values }) => {
            /** 逗号/空格/中文逗号都认 —— 用户手打的时候不会统一 */
            const split = v =>
              String(v ?? '')
                .split(/[,，、\s]+/)
                .map(s => s.trim())
                .filter(Boolean)

            const keys = split(values.chatKeys)
            const topics = split(values.topics)
            conf.set({
              enabled: values.enabled === true,
              chatKeys: keys,
              topics,
              minMinutes: Number(values.minMinutes) || 180,
              maxMinutes: Number(values.maxMinutes) || 480,
              limit: Number(values.limit) || 6,
            })
            schedule()
            refreshTab()
            return { ok: true, message: '已保存，排期已重算' }
          },
        },
      },
      {
        type: 'actions',
        title: '试运行',
        actions: [
          {
            id: 'once',
            label: '立刻试一次',
            run: async () => {
              /**
               * **把内核拦下的原因原样报出来。**
               *
               * 早先这里只看 `targets()` 非空就返回「已唤起 N 个会话」，
               * 而 `openProactive` 可能因为「主动发言没开 / 今日上限 / 安静时段」
               * 直接跳过 —— 于是按钮点了、横幅说成功、群里什么都没发生。
               *
               * 这几道闸都在内核侧，插件唯一能做的就是**让它可见**。
               */
              const r = await tick()
              if (r?.ok === false) {
                return { ok: false, message: r.reason || '没发出去' }
              }
              return { ok: true, message: `已唤起 ${r?.count ?? 0} 个会话（模型会自行判断要不要发）` }
            },
          },
        ],
      },
    ],
  })

  /** 轮询扫码状态；成功后落 cookie */
  const startPolling = () => {
    if (qrTimer) clearInterval(qrTimer)
    qrTimer = setInterval(async () => {
      if (!qr?.qrcodeKey) {
        clearInterval(qrTimer)
        qrTimer = null
        return
      }
      try {
        const r = await bili.poll(qr.qrcodeKey)
        if (r.state === 'ok' && r.cookie) {
          store.set('cookie', r.cookie)
          const who = await bili.me(r.cookie)
          log('info', `qdash-neo-plugin-bili: 登录成功 ${who.name || who.mid || ''}`)
          qr = null
          clearInterval(qrTimer)
          qrTimer = null
          // 登录状态变了，界面要跟着变（否则还显示着旧二维码）
          refreshTab()
          return
        }
        if (r.state === 'scanned' && qr.state !== 'scanned') {
          qr.state = 'scanned'
          refreshTab()
        }
        if (r.state === 'expired') {
          qr = null
          clearInterval(qrTimer)
          qrTimer = null
          log('warn', 'qdash-neo-plugin-bili: 二维码过期，需要重新生成')
        }
      } catch (err) {
        log('warn', `qdash-neo-plugin-bili: 轮询扫码状态失败 msg=${err?.message}`)
      }
    }, 3000)
    qrTimer.unref?.()
  }

  /**
   * 选项卡**每次状态变化都要重新注册**。
   *
   * 控制台拿到的是注册那一刻的快照 —— 二维码生成、扫码成功、排期变化
   * 都不会自动反映过去。表现出来就是"点了生成二维码没反应"，
   * 而实际上二维码已经存在内存里了。
   */
  let disposeTab = null
  const refreshTab = () => {
    try {
      disposeTab?.()
    } catch {
      /* 旧 disposer 抛错不该挡住重注册 */
    }
    disposeTab = neo.console.registerTab(buildTab())
  }

  ctx.effect(() => {
    refreshTab()

    /**
     * 配置一变就重建选项卡 —— 「间隔 / 目标群 / 方向」都会显示在状态块里，
     * 而选项卡是注册时的快照，不重建就一直是旧值。
     *
     * 内核的 `onConfigChange` **注册即回调一次**，所以挂载时也会跑一遍。
     */
    const offConfig =
      typeof neo.onConfigChange === 'function'
        ? neo.onConfigChange(() => {
            try {
              refreshTab()
            } catch (err) {
              log('warn', `qdash-neo-plugin-bili: 配置变更后重建选项卡失败 msg=${err?.message}`)
            }
          })
        : null

    return () => {
      try {
        offConfig?.()
      } catch {
        /* 退订失败不该连带别的事 */
      }
      try {
        disposeTab?.()
      } catch {
        /* 注销失败不该连带别的事 */
      }
      disposeTab = null
    }
  })

  /* ---------------- 启动 ---------------- */

  /**
   * **延迟一拍再做首次排期**：插件 `apply` 时内核的 `applyConfig` 还没跑，
   * 此刻 `neo.config.policy.groupWhitelist` 是空的 —— 直接排期会把
   * 「目标群 = 空」这个结论固化下来（选项卡一整天都显示"没配，不会发"）。
   *
   * 3 秒足够 `applyConfig` 落地（它同步跑完就结束了），又不至于让用户等。
   */
  setTimeout(() => {
    try {
      schedule()
      refreshTab()
      /**
       * 预热 wbi 缓存。不预热的话**第一次搜索必定 412** ——
       * 因为 `mixinKey` 得先请求 `nav`，紧接着再请求 `search`，
       * 两次几十毫秒内连着发，B 站判定爬虫。
       */
      bili.warmup?.().catch(() => {})
      console.log(
        `qdash-neo-plugin-bili: 已启动 ${loggedIn() ? '（已登录）' : '（未登录）'} ` +
          `间隔 ${conf.get().minMinutes}–${conf.get().maxMinutes} 分钟，目标 ${targets().length} 个会话`,
      )
    } catch (err) {
      log('warn', `qdash-neo-plugin-bili: 首次排期失败 msg=${err?.message}`)
    }
  }, 3000).unref?.()

  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
    if (qrTimer) clearInterval(qrTimer)
    timer = null
    qrTimer = null
  })
}

/**
 * 把文本画成二维码，返回 `data:image/svg+xml;base64,…`。
 *
 * ## 为什么本地画而不是调转图服务
 *
 * 早先用的是 `api.qrserver.com`，结果服务器上 `code=000`（连不上）——
 * 境内访问那个域名基本不通，而**二维码生成失败时界面只是空白**，
 * 用户只会说"点了没反应"。
 *
 * ## 为什么用 SVG 而不是 PNG
 *
 * PNG 要自己实现 zlib deflate + CRC + 分块，代码量比 QR 编码本身还大。
 * SVG 只需要 `<path>` 一段，文字几十 KB 的 QR 库就够了。
 *
 * 失败返回空串 —— 界面显示"(无图片)"，登录不了但不崩。
 */
function qrDataUrl(text) {
  try {
    // typeNumber=0：自动选版本；'M' 纠错（约 15%，屏幕扫码足够）
    const qr = qrcode(0, 'M')
    qr.addData(String(text))
    qr.make()

    const n = qr.getModuleCount()
    const cell = 6
    const quiet = 4 * cell // 静区，扫码器需要
    const size = n * cell + quiet * 2

    let path = ''
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue
        const x = quiet + c * cell
        const y = quiet + r * cell
        path += `M${x} ${y}h${cell}v${cell}h-${cell}z`
      }
    }

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<rect width="${size}" height="${size}" fill="#fff"/>` +
      `<path d="${path}" fill="#000"/></svg>`

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  } catch (err) {
    console.log(`qdash-neo-plugin-bili: 二维码生成失败 msg=${err?.message}`)
    return ''
  }
}
