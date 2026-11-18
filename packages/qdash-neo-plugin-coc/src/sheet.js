/**
 * COC 7 版角色卡：属性生成、派生值、技能基础表。
 *
 * **纯函数，不碰 `ctx`。** 派生值的表是规则书上的，不是拍的 —— 改之前先对一遍书。
 */

import { rollDie } from './dice.js'

/** 九项属性，按规则书顺序 */
export const ATTRS = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu']

/**
 * **点数分配法的三个硬数值**（规则书原文）。
 *
 * 掷骰法没有总点数限制，期望约 445；点数分配固定 480，
 * 且**单项下限是 40 不是 15** —— 因为 `(2d6+6)×5` 的最低值就是 40，
 * 规则书拿它当全表下限。
 */
export const POINT_TOTAL = 480
export const POINT_MIN = 40
export const POINT_MAX = 90

/**
 * **掷骰法的保底**：总和低于这个就重掷一次。
 *
 * 规则书没写这条，但桌上五个人掷出 380 和 520 是常事，
 * 低的那个整场都在看别人表演。420 是常见的房规线。
 */
export const MIN_ROLL_TOTAL = 420

/** 属性上限：COC 里没有超过 99 的属性 */
const ATTR_CAP = 99

/** 属性中文名，给卡面渲染用 */
export const ATTR_LABEL = {
  str: '力量',
  con: '体质',
  siz: '体型',
  dex: '敏捷',
  app: '外貌',
  int: '智力',
  pow: '意志',
  edu: '教育',
}

/**
 * 掷一项属性。`3d6 × 5` 得 15–90，`(2d6+6) × 5` 得 40–90。
 *
 * 规则书对八项属性是分开的：INT 与 EDU 用 (2d6+6)×5，其余六项用 3d6×5。
 * 这不是"随便挑一个"，INT/EDU 决定技能点，用 3d6 会出现技能点个位数的角色。
 *
 * @param {{ kind?: '3d6'|'2d6+6', rng?: () => number }} [opts]
 * @returns {number}
 */
export function rollAttr({ kind = '3d6', rng = Math.random } = {}) {
  if (kind === '2d6+6') {
    return (rollDie(6, rng) + rollDie(6, rng) + 6) * 5
  }
  return (rollDie(6, rng) + rollDie(6, rng) + rollDie(6, rng)) * 5
}

/** 伤害加成与体格查的是同一张表（STR+SIZ 的区间） */
const BUILD_TABLE = [
  { max: 64, db: '-2', build: -2 },
  { max: 84, db: '-1', build: -1 },
  { max: 124, db: '0', build: 0 },
  { max: 164, db: '+1D4', build: 1 },
  { max: 204, db: '+1D6', build: 2 },
  { max: 284, db: '+2D6', build: 3 },
  { max: 364, db: '+3D6', build: 4 },
  { max: Infinity, db: '+4D6', build: 5 },
]

/**
 * 伤害加成与体格。
 *
 * @param {number} str
 * @param {number} siz
 * @returns {{ db: string, build: number }}
 */
export function damageBonus(str, siz) {
  const sum = Math.max(0, Number(str) || 0) + Math.max(0, Number(siz) || 0)
  const row = BUILD_TABLE.find(r => sum <= r.max) ?? BUILD_TABLE[BUILD_TABLE.length - 1]
  return { db: row.db, build: row.build }
}

/**
 * 移动力。先看 STR/DEX 与 SIZ 的关系，再按年龄扣。
 *
 * 规则书原文是三条比较，不是"取最大值" —— DEX 和 STR 都低于 SIZ 的角色
 * 跑得更慢，这一条容易被简化掉。
 *
 * @param {{ str: number, dex: number, siz: number, age?: number }} p
 * @returns {number} 5–9
 */
export function moveRate({ str, dex, siz, age = 25 }) {
  const s = Number(str) || 0
  const d = Number(dex) || 0
  const z = Number(siz) || 0

  let mov = 7
  if (s > z && d > z) mov = 9
  else if (s >= z || d >= z) mov = 8

  const a = Number(age) || 25
  if (a >= 80) mov -= 5
  else if (a >= 70) mov -= 4
  else if (a >= 60) mov -= 3
  else if (a >= 50) mov -= 2
  else if (a >= 40) mov -= 1

  return Math.max(1, mov)
}

/**
 * 派生值。**HP/MP 用 floor 不是 round** —— 规则书写的是向下取整，
 * 用 round 会让 CON+SIZ=89 的角色多出 1 点血。
 *
 * @param {{ str: number, con: number, siz: number, dex: number, pow: number, age?: number }} attrs
 * @returns {{ hp: number, mp: number, san: number, mov: number, db: string, build: number }}
 */
export function derive(attrs) {
  const con = Number(attrs?.con) || 0
  const siz = Number(attrs?.siz) || 0
  const pow = Number(attrs?.pow) || 0

  const { db, build } = damageBonus(attrs?.str ?? 0, siz)

  return {
    hp: Math.floor((con + siz) / 10),
    mp: Math.floor(pow / 5),
    san: pow,
    mov: moveRate({
      str: attrs?.str ?? 0,
      dex: attrs?.dex ?? 0,
      siz,
      age: attrs?.age ?? 25,
    }),
    db,
    build,
  }
}

/**
 * 技能点：职业点 = EDU×4，兴趣点 = INT×2。
 *
 * 两笔是**分开花**的，不能混着用 —— 职业点只能加职业技能，
 * 混用会让"我的格斗为什么能点到 90"没法解释。
 *
 * @param {number} edu
 * @param {number} int
 * @returns {{ occupational: number, interest: number }}
 */
export function skillPoints(edu, int) {
  return {
    occupational: Math.max(0, Math.trunc(Number(edu) || 0)) * 4,
    interest: Math.max(0, Math.trunc(Number(int) || 0)) * 2,
  }
}

/**
 * 技能基础值。**只收常用的那些**，不是全部规则书技能。
 *
 * 为什么不全收：全表六十多项，角色卡塞进 prompt 会挤掉别的内容，
 * 而跑团实际用到的往往就这二十来个。要加就在这儿加，别在别处硬编码。
 *
 * `dex` 与 `edu` 参与的两项（闪避、母语）在 `skillBase()` 里算。
 */
export const SKILL_BASE = {
  会计: 5,
  人类学: 1,
  估价: 5,
  考古学: 1,
  /** 技艺/手艺：规则书是"任一"，取最低档 */
  技艺: 5,
  魅惑: 15,
  攀爬: 20,
  /** 信用评级基础是 0，只能用职业点加 —— 这是规则，不是遗漏 */
  信用评级: 0,
  克苏鲁神话: 0,
  乔装: 5,
  汽车驾驶: 20,
  电气维修: 10,
  电子学: 1,
  话术: 5,
  斗殴: 25,
  刀剑: 20,
  斧: 15,
  矛: 20,
  鞭: 5,
  手枪: 20,
  步枪: 25,
  冲锋枪: 15,
  弓: 15,
  急救: 30,
  历史: 5,
  恐吓: 15,
  跳跃: 20,
  外语: 1,
  法律: 5,
  图书馆使用: 20,
  聆听: 20,
  锁匠: 1,
  机械维修: 10,
  医学: 1,
  博物学: 10,
  导航: 10,
  神秘学: 5,
  操作重型机械: 1,
  说服: 10,
  精神分析: 1,
  心理学: 10,
  骑术: 5,
  科学: 1,
  妙手: 10,
  侦查: 25,
  潜行: 20,
  生存: 10,
  游泳: 20,
  投掷: 20,
  追踪: 10,
}

/**
 * **常见别名 → 规范名。**
 *
 * 这是"为什么判定出来是 0"的主因：模型写「侦察」而表里是「侦查」，
 * 写「格斗」而表里是「斗殴」—— 差一个字就落到 `?? 0` 那一支，
 * 而 0 技能掷 d100 几乎必失败，看起来像"这人不擅长这个"。
 *
 * `格斗(斗殴)` / `射击(手枪)` 这类带括号的写法则由 `normalizeSkillName` 处理。
 */
const SKILL_ALIASES = {
  侦察: '侦查',
  观察: '侦查',
  搜索: '侦查',
  察觉: '侦查',
  图书馆: '图书馆使用',
  查资料: '图书馆使用',
  格斗: '斗殴',
  拳击: '斗殴',
  武术: '斗殴',
  射击: '手枪',
  枪械: '手枪',
  倾听: '聆听',
  听: '聆听',
  心理分析: '心理学',
  读心: '心理学',
  快速交谈: '话术',
  说服力: '说服',
  驾驶: '汽车驾驶',
  开车: '汽车驾驶',
  机械: '机械维修',
  电工: '电气维修',
  电脑: '电子学',
  计算机: '电子学',
  医疗: '医学',
  治疗: '医学',
  急救术: '急救',
  攀岩: '攀爬',
  藏匿: '潜行',
  躲藏: '潜行',
  跟踪: '追踪',
  骑: '骑术',
  游泳术: '游泳',
}

/**
 * 技能名归一化：去括号内容、去空格标点。
 *
 * `格斗(斗殴)` → `格斗`、`射击（手枪）` → `射击`、` 图书馆使用 ` → `图书馆使用`
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeSkillName(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s·・、,，]/g, '')
}

/**
 * 取某项技能的基础值。
 *
 * 闪避 = DEX/2、母语 = EDU，这两项依赖属性，所以不能写进静态表。
 *
 * @param {string} name
 * @param {{ dex?: number, edu?: number }} attrs
 * @returns {number}
 */
export function skillBase(name, attrs = {}) {
  const key = normalizeSkillName(name)
  if (!key) return 0

  // 这两项依赖属性，不能写进静态表
  if (key === '闪避') return Math.floor((Number(attrs.dex) || 0) / 2)
  if (key === '母语') return Math.trunc(Number(attrs.edu) || 0)

  /**
   * **先查规范名，再查别名。**
   *
   * 顺序不能反：`skillsOf` 生成卡面时用的是规范名，
   * 如果有人给 `SKILL_ALIASES` 加了和 `SKILL_BASE` 重名的键，
   * 反过来查会让规范名被别名覆盖。
   */
  if (SKILL_BASE[key] != null) return SKILL_BASE[key]
  const canonical = SKILL_ALIASES[key]
  return canonical != null ? (SKILL_BASE[canonical] ?? 0) : 0
}

/**
 * 这个技能名是不是规则书里有的（含别名）。
 *
 * 用来区分两种情况：
 *   - 技能存在但基础值就是 0（信用评级、克苏鲁神话）→ 正常
 *   - 技能名压根不存在（"运动"、"感知"）→ 该提醒模型换个说法
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isKnownSkill(name) {
  const key = normalizeSkillName(name)
  if (!key) return false
  if (key === '闪避' || key === '母语') return true
  return SKILL_BASE[key] != null || SKILL_ALIASES[key] != null
}

/* ---------------- 生成：掷骰 ---------------- */

function sumOf(attrs) {
  return ATTRS.reduce((s, k) => s + (Number(attrs?.[k]) || 0), 0)
}

/** 八项各掷一次（INT/EDU 用 (2d6+6)×5） */
function rollAll(rng) {
  const attrs = {}
  for (const key of ATTRS) {
    const kind = key === 'int' || key === 'edu' ? '2d6+6' : '3d6'
    attrs[key] = rollAttr({ kind, rng })
  }
  return attrs
}

/**
 * 掷骰 + 保底重掷。
 *
 * **最多试 5 次**，都不达标就取最高的那一次 —— 不能无限重掷，
 * 否则一个运气不好的人会卡在建卡这一步。
 *
 * @returns {{ attrs: object, sum: number, tries: number, ok: boolean }}
 */
function rollWithFloor(rng, minTotal) {
  let best = null
  let bestSum = -1

  for (let i = 1; i <= 5; i += 1) {
    const attrs = rollAll(rng)
    const sum = sumOf(attrs)
    if (sum > bestSum) {
      best = attrs
      bestSum = sum
    }
    if (sum >= minTotal) return { attrs, sum, tries: i, ok: true }
  }
  return { attrs: best, sum: bestSum, tries: 5, ok: false }
}

/* ---------------- 生成：点数分配 ---------------- */

/**
 * 解析 `str=70,con=60,...`。
 *
 * 为什么不用 JSON：模型生成 JSON 容易在引号和逗号上出错，
 * 而 `key=数字` 的容错空间大得多（`=` 和 `:`、中文逗号、空格都能吃）。
 *
 * @param {string} raw
 * @returns {{ ok: true, attrs: object } | { ok: false, error: string }}
 */
export function parsePointBuy(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, error: '没给分配方案，格式如 str=70,con=60,...' }

  const out = {}
  for (const part of text.split(/[,，;；\s]+/)) {
    if (!part) continue
    const m = /^([a-z]+)\s*[:=]\s*(\d+)$/i.exec(part)
    if (!m) return { ok: false, error: `看不懂「${part}」，格式是 str=70,con=60` }

    const key = m[1].toLowerCase()
    if (!ATTRS.includes(key)) return { ok: false, error: `没有这个属性：${key}` }

    const v = Number(m[2])
    if (v < POINT_MIN || v > POINT_MAX) {
      return { ok: false, error: `${key} 要在 ${POINT_MIN}–${POINT_MAX} 之间，收到 ${v}` }
    }
    if (out[key] != null) return { ok: false, error: `${key} 写了两遍` }
    out[key] = v
  }

  const missing = ATTRS.filter(k => out[k] == null)
  if (missing.length) return { ok: false, error: `还差这些没分配：${missing.join('、')}` }

  const total = sumOf(out)
  if (total !== POINT_TOTAL) {
    return {
      ok: false,
      error: `总和是 ${total}，要正好 ${POINT_TOTAL}（${total > POINT_TOTAL ? `多了 ${total - POINT_TOTAL}` : `还差 ${POINT_TOTAL - total}`}）`,
    }
  }
  return { ok: true, attrs: out }
}

/* ---------------- 年龄修正 ---------------- */

/**
 * 按年龄改属性，并做教育增强检定。
 *
 * 这是规则书里最容易被跳过的一段，但跳过了就会出现
 * 「七十岁的老教授力量和二十岁一样」这种结果。
 *
 * @param {object} attrs
 * @param {number} age
 * @param {() => number} rng
 * @returns {{ attrs: object, luckTwice: boolean, note: string }}
 */
export function applyAge(attrs, age, rng = Math.random) {
  const out = { ...attrs }
  const a = Math.trunc(Number(age) || 25)
  const notes = []

  if (a < 20) {
    // 15–19：还没长成
    out.str = Math.max(1, out.str - 5)
    out.siz = Math.max(1, out.siz - 5)
    out.edu = Math.max(1, out.edu - 5)
    notes.push('未满二十岁：力量、体型、教育各 −5，幸运掷两次取高')
    return { attrs: out, luckTwice: true, note: notes.join('；') }
  }

  if (a < 40) return { attrs: out, luckTwice: false, note: '' }

  // 40+：每十岁一档，最多五档
  const steps = Math.min(5, Math.floor((Math.min(a, 89) - 40) / 10) + 1)
  const drop = 5 * steps
  for (const k of ['str', 'con', 'dex', 'app']) out[k] = Math.max(1, out[k] - drop)
  notes.push(`年过四十（${steps} 档）：力量、体质、敏捷、外貌各 −${drop}`)

  /**
   * **教育增强**：每档一次检定，`d100 > 当前 EDU` 就让 EDU +1d10。
   *
   * 注意每次都用**当前的** EDU 比 —— 第一次加成之后，第二次更难，
   * 这是规则书的设计，不是笔误。
   */
  let gained = 0
  for (let i = 0; i < steps; i += 1) {
    if (rollDie(100, rng) > out.edu) gained += rollDie(10, rng)
  }
  if (gained > 0) {
    out.edu = Math.min(ATTR_CAP, out.edu + gained)
    notes.push(`教育增强 +${gained}`)
  } else {
    notes.push(`教育增强 ${steps} 次都没过`)
  }

  return { attrs: out, luckTwice: false, note: notes.join('；') }
}

/* ---------------- 建卡 ---------------- */

/**
 * 建一张卡。**一次成型，不做逐步问答。**
 *
 * 两种生成方式：
 *   - `mode: 'roll'`（默认）—— 掷骰，总和低于 `MIN_ROLL_TOTAL` 自动重掷
 *   - `mode: 'points'` —— 玩家自己分配，八项总和 480、每项 40–90
 *
 * 两种都会走年龄修正与教育增强；幸运永远单独掷（不占点数）。
 *
 * @param {{
 *   name?: string, age?: number, rng?: () => number,
 *   mode?: 'roll'|'points', values?: string,
 * }} [opts]
 * @returns {object} 成功时是角色卡；`mode='points'` 校验失败时返回 `{ ok: false, error }`
 */
export function createSheet({ name = '无名调查员', age = 25, rng = Math.random, mode = 'roll', values = '' } = {}) {
  const a = Math.max(15, Math.min(89, Math.trunc(Number(age) || 25)))
  const byPoints = String(mode ?? 'roll').trim().toLowerCase() === 'points'

  let attrs
  let method = ''

  if (byPoints) {
    const parsed = parsePointBuy(values)
    // **校验失败要如实回给调用方**，不能悄悄退回掷骰 —— 那会让玩家以为自己分配成功了
    if (!parsed.ok) return { ok: false, error: parsed.error }
    attrs = parsed.attrs
    method = '点数分配（480）'
  } else {
    const rolled = rollWithFloor(rng, MIN_ROLL_TOTAL)
    attrs = rolled.attrs
    if (!rolled.ok) {
      // 五次都没达标：**如实说"取最高的"**，别假装达标了
      method = `掷骰（5 次都没到 ${MIN_ROLL_TOTAL}，取最高的 ${rolled.sum}）`
    } else if (rolled.tries > 1) {
      method = `掷骰（第 ${rolled.tries} 次达到 ${MIN_ROLL_TOTAL}，总和 ${rolled.sum}）`
    } else {
      method = `掷骰（总和 ${rolled.sum}）`
    }
  }

  const aged = applyAge(attrs, a, rng)

  const rollLuck = () => (rollDie(6, rng) + rollDie(6, rng) + rollDie(6, rng)) * 5
  const luck = aged.luckTwice ? Math.max(rollLuck(), rollLuck()) : rollLuck()

  const d = derive({ ...aged.attrs, age: a })
  const points = skillPoints(aged.attrs.edu, aged.attrs.int)

  return {
    name: String(name).slice(0, 40),
    age: a,
    attrs: aged.attrs,
    /** 原掷骰值（年龄修正前）—— 玩家会想知道自己"本来"是多少 */
    rawAttrs: attrs,
    luck,
    hp: d.hp,
    maxHp: d.hp,
    mp: d.mp,
    maxMp: d.mp,
    san: d.san,
    maxSan: d.san,
    mov: d.mov,
    db: d.db,
    build: d.build,
    /** 技能只存"加点后的值"，基础值在 `skillBase()` 里现算 */
    skills: {},
    occupationalPoints: points.occupational,
    interestPoints: points.interest,
    image: '',
    /** 这张卡怎么来的（模型转述用） */
    method,
    /** 年龄修正做了什么（模型可以顺口提一句） */
    ageNote: aged.note,
    createdAt: Date.now(),
  }
}
