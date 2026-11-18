/**
 * 跑团记录：一场团一个 JSONL 文件，只追加、读尾部。
 *
 * **为什么不用 KV 存**：KV 没有配额也没有分页，跑一个月的团能塞几万条，
 * 每次读都要 `JSON.parse` 整块。文件追加是 O(1)，而且导出直接就是文本。
 *
 * **为什么一场一个文件**：翻本场记录不用扫几十万行；导出时也不用先过滤。
 * `act=new` 时开新文件，旧的留档不删。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

/** 超过这个大小就只读尾部，避免一次 `readFileSync` 把几十 MB 读进内存 */
const BIG_FILE_BYTES = 2 * 1024 * 1024
/** 大文件读尾部时取多少 */
const TAIL_BYTES = 256 * 1024

const KIND_LABEL = {
  check: '检定',
  roll: '掷骰',
  in: '发言',
  out: '叙述',
  damage: '伤害',
  sanity: '理智',
  scene: '场景',
  combat: '战斗',
  art: '插图',
}

function safeName(s) {
  return String(s ?? '').trim().replace(/[:%/\\]/g, '-').slice(0, 48)
}

function hhmm(ts) {
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Shanghai',
    })
  } catch {
    return '--:--'
  }
}

export class Journal {
  /**
   * @param {{ dir: string, log?: Function }} deps
   *   `dir` 通常是 `storage.dir('coc', 'log')`，那个方法已经 mkdir 过了，
   *   但测试里会传临时目录，所以这里再兜一次
   */
  constructor({ dir, log = () => {} } = {}) {
    this.dir = String(dir ?? '')
    this.log = log
    /** @type {Map<string, string>} chatKey → 当前场次 id */
    this.sessions = new Map()
    if (this.dir) {
      try {
        mkdirSync(this.dir, { recursive: true })
      } catch (err) {
        this.log('warn', `qdash-neo-plugin-coc: 创建日志目录失败 msg=${err?.message}`)
      }
    }
  }

  /**
   * 指定当前场次。`act=new` 时调，之后的 `append` 都写这个文件。
   *
   * 没有场次时 `append` 直接跳过 —— 还没开团时的群聊不该产生记录文件。
   */
  useSession(chatKey, sessionId) {
    const key = String(chatKey ?? '').trim()
    const sid = safeName(sessionId)
    if (!key || !sid) return
    this.sessions.set(key, sid)
  }

  /** 当前场次 id（没开团返回空串） */
  sessionOf(chatKey) {
    return this.sessions.get(String(chatKey ?? '').trim()) ?? ''
  }

  /**
   * 停止记录当前场次。之后 `append` 会因为找不到文件而返回 false。
   *
   * **为什么不复用 `useSession(chatKey, '')`**：那个一进函数就 `if (!sid) return`，
   * 传空串等于什么都没做。就算放开这个检查，`sessions` 里存 `''` 也会让
   * `sessionOf` 的语义变糊 —— 空串既表示"没有"，又表示"空值"，
   * 调用方要同时写 `if (!x)` 和 `if (x === '')` 两种判断。
   */
  endSession(chatKey) {
    const key = String(chatKey ?? '').trim()
    if (key) this.sessions.delete(key)
  }

  #fileOf(chatKey, sessionId) {
    return join(this.dir, `${safeName(chatKey)}-${safeName(sessionId)}.jsonl`)
  }

  #currentFile(chatKey) {
    const sid = this.sessionOf(chatKey)
    if (!sid || !this.dir) return ''
    return this.#fileOf(chatKey, sid)
  }

  /**
   * 追加一条。
   *
   * **同步写**：事件回调里没有合适的地方 await，而且丢一条记录比慢几毫秒更糟。
   * QQ 群的消息频率下，`appendFileSync` 完全够用。
   *
   * @param {string} chatKey
   * @param {object} entry `{ kind, ... }`，`ts` 会自动补
   * @returns {boolean} 有没有真的写进去（没开团时是 false）
   */
  append(chatKey, entry) {
    const file = this.#currentFile(chatKey)
    if (!file) return false
    try {
      const line = JSON.stringify({ ts: Date.now(), ...entry })
      appendFileSync(file, `${line}\n`, 'utf8')
      return true
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 写记录失败 msg=${err?.message}`)
      return false
    }
  }

  /**
   * 读最近 n 条。
   *
   * 文件超过 2MB 时只读尾部 256KB，并**丢掉第一个可能被截断的残行** ——
   * 不丢的话 `JSON.parse` 会报错，而那个错看起来像是"记录文件坏了"。
   *
   * @param {string} chatKey
   * @param {number} [n]
   * @returns {object[]}
   */
  recent(chatKey, n = 30) {
    const file = this.#currentFile(chatKey)
    if (!file || !existsSync(file)) return []

    const lines = this.#readLines(file, { tailOnly: true })
    const out = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj === 'object') out.push(obj)
      } catch {
        /* 单行坏了跳过，不要让整份记录读不出来 */
      }
    }
    return out.slice(-Math.max(1, Math.trunc(Number(n) || 30)))
  }

  /**
   * 导出整场为 Markdown。
   *
   * 导出是低频操作，整份读进来；但坏行照样跳过。
   *
   * @param {string} chatKey
   * @param {{ title?: string }} [opts]
   * @returns {{ markdown: string, count: number }}
   */
  exportMarkdown(chatKey, { title = '', sessionId = '' } = {}) {
    /**
     * **支持显式指定场次。**
     *
     * `endSession` 之后内存里就没有当前场次了，但文件还在磁盘上 ——
     * 收场后想导出刚跑完那一场，必须能指回它。
     * 调用方从 `campaign.chronicles` 最后一条取 `sessionId` 传进来。
     */
    const sid = String(sessionId ?? '').trim() || this.sessionOf(chatKey)
    const file = sid ? this.#fileOf(chatKey, sid) : ''
    if (!file || !existsSync(file)) return { markdown: '', count: 0 }

    const lines = this.#readLines(file, { tailOnly: false })
    const rows = []
    let count = 0

    for (const line of lines) {
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (!e || typeof e !== 'object') continue
      count += 1

      const time = hhmm(e.ts)
      const label = KIND_LABEL[e.kind] ?? e.kind ?? '记录'
      const body = this.#renderEntry(e)
      if (body) rows.push(`- **${time}** \`${label}\` ${body}`)
    }

    const head = [`# ${title || '跑团记录'}`, '']
    head.push(`> 导出时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)
    head.push(`> 共 ${count} 条`, '')

    return { markdown: [...head, ...rows].join('\n'), count }
  }

  #renderEntry(e) {
    if (e.kind === 'in') return `**${e.who || '某人'}**：${e.text ?? ''}`
    if (e.kind === 'out') return `**KP**：${e.text ?? ''}`
    if (e.kind === 'check') {
      const bonus = e.bonus > 0 ? ` 奖励${e.bonus}` : e.bonus < 0 ? ` 惩罚${-e.bonus}` : ''
      const who = e.who ? `（${e.who}）` : ''
      return `[${e.skill ?? '检定'}] ${e.skillValue ?? '?'} → ${e.value ?? '?'}${bonus} · ${e.level ?? ''}${who}`
    }
    if (e.kind === 'roll') return `${e.expr ?? ''} → ${e.total ?? '?'}${e.who ? `（${e.who}）` : ''}`
    if (e.kind === 'damage') {
      const delta = Number(e.delta) || 0
      const sign = delta > 0 ? '+' : ''
      return `${e.who ?? '某人'} 生命 ${sign}${delta} → ${e.hp ?? '?'}/${e.maxHp ?? '?'}`
    }
    if (e.kind === 'sanity') {
      const delta = Number(e.delta) || 0
      const sign = delta > 0 ? '+' : ''
      return `${e.who ?? '某人'} 理智 ${sign}${delta} → ${e.san ?? '?'}/${e.maxSan ?? '?'}`
    }
    if (e.kind === 'scene') return `场景 → ${e.title || e.location || '(未命名)'}`
    if (e.kind === 'combat') return `战斗：${e.text ?? ''}`
    if (e.kind === 'art') return `插图：${e.text ?? e.file ?? ''}`
    return String(e.text ?? '')
  }

  /**
   * 读文件里的非空行。
   *
   * @param {string} file
   * @param {{ tailOnly: boolean }} opts
   * @returns {string[]}
   */
  #readLines(file, { tailOnly }) {
    try {
      const size = statSync(file).size
      if (!tailOnly || size <= BIG_FILE_BYTES) {
        return readFileSync(file, 'utf8')
          .split('\n')
          .filter(l => l.trim())
      }

      const len = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buf, 0, len, size - len)
      } finally {
        closeSync(fd)
      }
      let text = buf.toString('utf8')
      // 起点大概率落在某一行中间，切掉残行
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
      return text.split('\n').filter(l => l.trim())
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 读记录失败 msg=${err?.message}`)
      return []
    }
  }
}
