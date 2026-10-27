import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 表情包库：一份索引 + 一堆图片文件。
 *
 * ## 为什么用 JSON 而不是数据库
 *
 * 量级小（上限几百条）、只被一个进程读写、要能人工打开看。
 * `storage.forFeature()` 是 KV，做不了"按标签模糊查"；建表又得处理迁移。
 *
 * 写入用**临时文件 + rename**：中途崩溃不会留下半截 JSON ——
 * 那种文件下次启动会整体解析失败，等于整个库丢了。
 */
export class StickerStore {
  /**
   * @param {{ dir: string, maxFiles?: number, log?: Function }} opts
   */
  constructor({ dir, maxFiles = 300, log = () => {} }) {
    this.dir = String(dir ?? '').trim()
    this.maxFiles = Number(maxFiles) > 0 ? Math.round(Number(maxFiles)) : 300
    this.log = log
    this.indexFile = join(this.dir, 'index.json')
    /** @type {Array<{id:string,file:string,ext:string,tags:string[],note:string,from:string,at:number,usedAt:number,bytes:number}>} */
    this.items = []
    this.loaded = false
  }

  ensureDir() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  load() {
    if (this.loaded) return this
    this.loaded = true
    try {
      const raw = readFileSync(this.indexFile, 'utf8')
      const parsed = JSON.parse(raw)
      this.items = Array.isArray(parsed?.items) ? parsed.items.filter(it => it && it.id && it.file) : []
    } catch {
      // 不存在 = 空库；解析失败 = 也当空库，但要说一声（下面 prune 会清孤立文件）
      this.items = []
    }
    return this
  }

  save() {
    this.ensureDir()
    const tmp = `${this.indexFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 2), 'utf8')
    renameSync(tmp, this.indexFile)
  }

  /**
   * 存一张图。**按内容 hash 去重**：同一张图被反复存时合并标签，而不是多存一份。
   *
   * @param {{ bytes: Buffer, ext?: string, tags?: string[], note?: string, from?: string }} d
   * @returns {{ id: string, created: boolean, tags: string[] }}
   */
  add({ bytes, ext = 'png', tags = [], note = '', from = '' }) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('图片内容为空')
    this.load()

    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const clean = normalizeTags(tags)
    const exist = this.items.find(it => it.id === id)

    if (exist) {
      /**
       * 已存在：**合并标签**，保留较早的 `at`。
       *
       * 覆盖会让"这张图第二次被存时给的标签"变成唯一真相，
       * 而两次的标签往往互补（一次记画面、一次记用法）。
       */
      const merged = [...new Set([...(exist.tags ?? []), ...clean])]
      exist.tags = merged.slice(0, 20)
      if (note && !exist.note) exist.note = String(note).slice(0, 200)
      this.save()
      return { id, created: false, tags: exist.tags }
    }

    this.ensureDir()
    const file = `${id}.${ext}`
    writeFileSync(join(this.dir, file), bytes)

    this.items.push({
      id,
      file,
      ext,
      tags: clean.slice(0, 20),
      note: String(note ?? '').slice(0, 200),
      from: String(from ?? '').slice(0, 60),
      at: Date.now(),
      usedAt: 0,
      bytes: bytes.length,
    })

    this.prune()
    this.save()
    return { id, created: true, tags: clean }
  }

  /**
   * 按关键词找。**不叫 search 是因为它很朴素**：子串匹配 + 用频排序。
   *
   * 没做向量检索：标签是人（模型）手写的短词，子串够用，
   * 而引入 embedding 要把每张图的标签再送一遍模型 —— 成本和延迟都不划算。
   *
   * @param {{ query?: string, limit?: number }} [opts]
   */
  find({ query = '', limit = 3 } = {}) {
    this.load()
    const q = String(query ?? '').trim().toLowerCase()
    const words = q ? q.split(/[\s,，、]+/).filter(Boolean) : []

    const score = it => {
      if (!words.length) return 0
      const hay = `${(it.tags ?? []).join(' ')} ${it.note ?? ''}`.toLowerCase()
      let n = 0
      for (const w of words) if (hay.includes(w)) n += 1
      return n
    }

    const scored = this.items
      .map(it => ({ it, n: score(it) }))
      .filter(x => (words.length ? x.n > 0 : true))
      /**
       * 排序：匹配词数 → **用过的优先**（用过的说明真的合用）→ 新的优先。
       *
       * 不能只按时间排：库里越攒越多之后，老的好图永远排不到前面。
       */
      .sort((a, b) => b.n - a.n || (b.it.usedAt ?? 0) - (a.it.usedAt ?? 0) || (b.it.at ?? 0) - (a.it.at ?? 0))
      .slice(0, Math.max(1, Math.min(20, limit)))
      .map(x => x.it)

    return scored
  }

  /** 读文件内容；文件丢了返回 null（不抛：调用方要能降级成"改说文字"） */
  read(id) {
    this.load()
    const it = this.items.find(x => x.id === String(id))
    if (!it) return null
    try {
      const bytes = readFileSync(join(this.dir, it.file))
      return { item: it, bytes }
    } catch {
      return null
    }
  }

  markUsed(id) {
    this.load()
    const it = this.items.find(x => x.id === String(id))
    if (!it) return
    it.usedAt = Date.now()
    try {
      this.save()
    } catch {
      /* 用频回写失败不该影响发图 */
    }
  }

  list() {
    this.load()
    return this.items.map(it => ({ ...it }))
  }

  /**
   * 淘汰：超过上限时删**最久没被用**的。
   *
   * 排序键是 `usedAt || at` —— 从没被用过的按入库时间算，
   * 这样"存进来就没动过"的会先被清掉，而不是把刚存的新图删了。
   */
  prune() {
    if (this.items.length <= this.maxFiles) return 0
    const sorted = [...this.items].sort((a, b) => (a.usedAt || a.at) - (b.usedAt || b.at))
    const drop = sorted.slice(0, this.items.length - this.maxFiles)
    for (const it of drop) {
      try {
        rmSync(join(this.dir, it.file), { force: true })
      } catch {
        /* 文件已经不在就跳过 */
      }
    }
    const dead = new Set(drop.map(it => it.id))
    this.items = this.items.filter(it => !dead.has(it.id))
    return drop.length
  }

  /** 索引里有、磁盘上没有的条目（手工删文件之后会这样） */
  missingFiles() {
    this.load()
    return this.items.filter(it => !existsSync(join(this.dir, it.file)))
  }

  /** 控制台用 */
  describe() {
    this.load()
    return {
      dir: this.dir,
      count: this.items.length,
      maxFiles: this.maxFiles,
      bytes: this.items.reduce((n, it) => n + (Number(it.bytes) || 0), 0),
      missing: this.missingFiles().length,
    }
  }
}

/** 标签归一：去空、去重、限长 */
export function normalizeTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、\s]+/)
  const seen = new Set()
  const out = []
  for (const t of list) {
    const s = String(t ?? '').trim().slice(0, 24)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}
