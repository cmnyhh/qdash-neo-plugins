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
  const targets = () => {
    const own = (conf.get().chatKeys ?? []).map(String).filter(Boolean)
    if (own.length) return own
    const wl = (neo.config?.policy?.groupWhitelist ?? []).map(String).filter(Boolean)
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

  const schedule = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!conf.get().enabled) return

    const min = Math.max(10, Number(conf.get().minMinutes) || 180)
    const max = Math.max(min, Number(conf.get().maxMinutes) || 480)
    const gapMs = Math.round((min + Math.random() * (max - min)) * 60_000)

    nextAt = Date.now() + gapMs
    store.set('nextAt', nextAt)
    timer = setTimeout(tick, gapMs)
    // 不阻止进程退出：这是个后台节奏，不是必须完成的任务
    timer.unref?.()
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
    try {
      const keys = targets()
      if (!keys.length) {
        log('warn', 'qdash-neo-plugin-bili: 没有可发的群（插件 chatKeys 与群白名单都为空），跳过本轮')
        return
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
          await neo.openProactive(key, { hint: hint(topic) })
        } catch (err) {
          log('warn', `qdash-neo-plugin-bili: 唤起 ${key} 失败 msg=${err?.message}`)
        }
      }
    } finally {
      schedule()
    }
  }

  /* ---------------- 工具 ---------------- */

  const shape = list =>
    list.map(v => ({
      title: v.title,
      up: v.up,
      url: v.url,
      cover: v.pic,
      view: v.view > 10000 ? `${Math.round(v.view / 10000)}万` : String(v.view),
    }))

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
        return { ok: true, count: list.length, items: shape(list) }
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
        return { ok: true, count: list.length, items: shape(list) }
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
        '看到真值得分享的，先调 qq_send_card 发卡片，**再单独发一条 qq_send_message 说你的看法** —— ' +
        '卡片里只有标题和封面，群里看不到你的态度。' +
        '没看到什么有意思的就什么都不做，不用为了完成任务硬发一条。',
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
              const keys = targets()
              if (!keys.length) return { ok: false, message: '没有可发的群：先配群白名单' }
              await tick()
              return { ok: true, message: `已唤起 ${keys.length} 个会话` }
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
    return () => {
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
