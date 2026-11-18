/**
 * KV 封装：角色卡 / 场景 / 战斗三份状态。
 *
 * **只碰 `ctx.qdashNeo.storage.forFeature('coc')`**，不碰文件 —— 文件那半在
 * `journal.js`。分开是因为两者的读写模式完全不同：状态是"整份读、整份写"，
 * 记录是"只追加、读尾部"。
 */

/**
 * 把 `who` 洗成稳定的键名。
 *
 * **优先取括号里的 QQ 号**：模型可能传 `草莓(1704)`、也可能传 `1704`、
 * 还可能传 `草莓`。如果三种都各存一张卡，玩家会发现自己"多了一个角色"。
 *
 * 取数字做键之后，昵称改了也不影响；昵称只用来显示。
 *
 * @param {string} who
 * @returns {string}
 */
export function whoKey(who) {
  const s = String(who ?? '').trim()
  const m = /\((\d{4,})\)\s*$/.exec(s)
  const core = m ? m[1] : s
  // `:` 是键的分隔符，`%` 会破坏内核 kvList 的 LIKE 前缀匹配
  return core.replace(/[:%]/g, '-').slice(0, 48)
}

/** chatKey 也含冒号（`g:123`），同样要洗 */
export function chatKeyOf(chatKey) {
  return String(chatKey ?? '').trim().replace(/[:%]/g, '-').slice(0, 48)
}

const DEFAULT_SCENE = () => ({
  /** 'classic' | 'narrative'，开团时定 */
  mode: 'classic',
  title: '',
  location: '',
  /** 游戏内时间，如「1923 年冬，凌晨两点」 */
  time: '',
  summary: '',
  clues: [],
  npcs: [],
  /** 本场的记录文件名片段，`act=new` 时生成 */
  sessionId: '',
  image: '',
  updatedAt: 0,
})

const DEFAULT_COMBAT = () => ({
  round: 0,
  /** [{ who, dex, acted }]，按 dex 降序 */
  order: [],
  current: 0,
  active: false,
})

/** 归档最多保留多少场。超出丢最旧的，否则存储只增不减 */
const CHRONICLE_LIMIT = 50

/**
 * 每场摘要最多多少字。
 *
 * 归档是**给模型看**的：开新团时会把上一场摘要塞进返回里。
 * 写到两千字，一次开团就吃掉小半个上下文，反而挤掉玩家真正的输入。
 */
const SUMMARY_MAX = 800

/** 每场只留这么多条线索。完整线索在 JSONL 里，归档只要脉络 */
const CLUES_MAX = 20

/**
 * `campaign:<chatKey>` 的默认形状。
 *
 * **为什么不塞进 `scene`**：`scene` 是「这一场」的快照，`act=new` 会整份重置。
 * 归档放进去会被下一次开团冲掉。
 */
const DEFAULT_CAMPAIGN = () => ({ chronicles: [], updatedAt: 0 })

export class CocStore {
  /**
   * @param {{ kv: object, log?: Function }} deps
   *   `kv` 是 `storage.forFeature('coc')` 返回的句柄
   */
  constructor({ kv, log = () => {} } = {}) {
    this.kv = kv
    this.log = log
  }

  #sheetKey(chatKey, who) {
    return `sheet:${chatKeyOf(chatKey)}:${whoKey(who)}`
  }

  /* ---------------- 角色卡 ---------------- */

  /**
   * @returns {object|null} 没建过卡返回 null
   */
  getSheet(chatKey, who) {
    try {
      const v = this.kv?.get?.(this.#sheetKey(chatKey, who), null)
      return v && typeof v === 'object' ? v : null
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 读角色卡失败 msg=${err?.message}`)
      return null
    }
  }

  setSheet(chatKey, who, sheet) {
    try {
      const key = this.#sheetKey(chatKey, who)
      // 把 who 一起存下来：`listSheets` 只拿得到 value，不解析键
      this.kv.set(key, { ...sheet, who: String(who ?? '').trim(), updatedAt: Date.now() })
      return true
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 写角色卡失败 msg=${err?.message}`)
      return false
    }
  }

  /**
   * 本会话的全部角色卡。
   *
   * KV 没有条件查询，只能把整个命名空间 list 出来再按前缀过滤 ——
   * 一个群几十张卡，开销可以接受；但**别在每轮对话里调**。
   *
   * @returns {object[]}
   */
  listSheets(chatKey) {
    const prefix = `sheet:${chatKeyOf(chatKey)}:`
    try {
      const rows = this.kv?.list?.() ?? []
      return rows
        .filter(r => String(r?.key ?? '').startsWith(prefix))
        .map(r => (r?.value && typeof r.value === 'object' ? r.value : null))
        .filter(Boolean)
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 列角色卡失败 msg=${err?.message}`)
      return []
    }
  }

  /* ---------------- 场景 ---------------- */

  getScene(chatKey) {
    try {
      const v = this.kv?.get?.(`scene:${chatKeyOf(chatKey)}`, null)
      if (!v || typeof v !== 'object') return DEFAULT_SCENE()
      return { ...DEFAULT_SCENE(), ...v }
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 读场景失败 msg=${err?.message}`)
      return DEFAULT_SCENE()
    }
  }

  setScene(chatKey, patch = {}) {
    try {
      const next = { ...this.getScene(chatKey), ...patch, updatedAt: Date.now() }
      this.kv.set(`scene:${chatKeyOf(chatKey)}`, next)
      return next
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 写场景失败 msg=${err?.message}`)
      return this.getScene(chatKey)
    }
  }

  /**
   * 开新团：**重置场景与战斗，保留角色卡**。
   *
   * 角色卡属于玩家，跨场次存在 —— 同一群人连跑一个战役时不用重开卡。
   *
   * @param {string} chatKey
   * @param {{ title?: string, mode?: string, location?: string, sessionId?: string }} init
   */
  newSession(chatKey, init = {}) {
    try {
      this.kv?.del?.(`combat:${chatKeyOf(chatKey)}`)
    } catch {
      /* 没有战斗状态也没什么可删的 */
    }
    return this.setScene(chatKey, {
      ...DEFAULT_SCENE(),
      title: String(init.title ?? '').trim(),
      mode: init.mode === 'narrative' ? 'narrative' : 'classic',
      location: String(init.location ?? '').trim(),
      sessionId: String(init.sessionId ?? String(Date.now())),
      updatedAt: Date.now(),
    })
  }

  /* ---------------- 归档（跨场次） ---------------- */

  /**
   * 跨场次的战役档案。没归档过就返回 `{ chronicles: [] }`。
   *
   * @returns {{ chronicles: object[], updatedAt: number }}
   */
  getCampaign(chatKey) {
    try {
      const v = this.kv?.get?.(`campaign:${chatKeyOf(chatKey)}`, null)
      if (!v || typeof v !== 'object') return DEFAULT_CAMPAIGN()
      return {
        ...DEFAULT_CAMPAIGN(),
        ...v,
        chronicles: Array.isArray(v.chronicles) ? v.chronicles : [],
      }
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 读归档失败 msg=${err?.message}`)
      return DEFAULT_CAMPAIGN()
    }
  }

  /**
   * 归档一场。**只追加，永不改写已有条目。**
   *
   * `summary` 为空时返回 `null` —— **不归档空摘要**。允许空的话
   * `chronicles` 里会堆一排「（无摘要）」，比没有归档更糟：模型看到
   * 一堆空条目，反而不知道该信哪一条。
   *
   * @param {{ summary?: string, title?: string, mode?: string,
   *           clues?: string[], players?: string[], sessionId?: string }} p
   * @returns {object|null} 写进去的那一条
   */
  closeSession(chatKey, { summary = '', title = '', mode = 'classic', clues = [], players = [], sessionId = '' } = {}) {
    const text = String(summary ?? '')
      .trim()
      .slice(0, SUMMARY_MAX)
    if (!text) return null

    try {
      const camp = this.getCampaign(chatKey)
      const entry = {
        sessionId: String(sessionId ?? ''),
        title: String(title ?? '').trim().slice(0, 60) || '(未命名)',
        mode: mode === 'narrative' ? 'narrative' : 'classic',
        summary: text,
        clues: (Array.isArray(clues) ? clues : [])
          .map(c => String(c ?? '').trim())
          .filter(Boolean)
          .slice(-CLUES_MAX),
        players: (Array.isArray(players) ? players : [])
          .map(p => String(p ?? '').trim())
          .filter(Boolean)
          .slice(0, 20),
        closedAt: Date.now(),
      }

      const next = {
        chronicles: [...camp.chronicles, entry].slice(-CHRONICLE_LIMIT),
        updatedAt: Date.now(),
      }
      this.kv.set(`campaign:${chatKeyOf(chatKey)}`, next)
      return entry
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 归档失败 msg=${err?.message}`)
      return null
    }
  }

  /**
   * 最近 n 场，**按时间正序**（旧 → 新）。
   *
   * 正序是因为调用方要把它直接拼给模型当"前情提要"，
   * 倒序会让模型以为最近发生的写在最前面。
   *
   * @returns {object[]}
   */
  listChronicles(chatKey, n = 5) {
    const k = Math.max(1, Math.trunc(Number(n) || 5))
    return this.getCampaign(chatKey).chronicles.slice(-k)
  }

  /* ---------------- 战斗 ---------------- */

  getCombat(chatKey) {
    try {
      const v = this.kv?.get?.(`combat:${chatKeyOf(chatKey)}`, null)
      if (!v || typeof v !== 'object') return DEFAULT_COMBAT()
      return { ...DEFAULT_COMBAT(), ...v }
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 读战斗失败 msg=${err?.message}`)
      return DEFAULT_COMBAT()
    }
  }

  setCombat(chatKey, combat) {
    try {
      const next = { ...DEFAULT_COMBAT(), ...combat }
      this.kv.set(`combat:${chatKeyOf(chatKey)}`, next)
      return next
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 写战斗失败 msg=${err?.message}`)
      return this.getCombat(chatKey)
    }
  }

  /**
   * 按敏捷排先攻。
   *
   * 同敏捷时按名字排 —— 只要**稳定**就行，具体按什么排不重要，
   * 但每次刷新顺序变来变去会让玩家以为漏了谁。
   *
   * @param {{ who: string, dex: number }[]} actors
   * @returns {{ who: string, dex: number, acted: boolean }[]}
   */
  static rollInitiative(actors) {
    return [...(actors ?? [])]
      .map(a => ({ who: String(a?.who ?? '').trim(), dex: Number(a?.dex) || 0, acted: false }))
      .filter(a => a.who)
      .sort((a, b) => (b.dex - a.dex) || a.who.localeCompare(b.who, 'zh-Hans-CN'))
  }
}
