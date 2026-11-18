/**
 * COC 7 版角色卡：属性生成、派生值、技能基础表。
 *
 * **纯函数，不碰 `ctx`。** 派生值的表是规则书上的，不是拍的 —— 改之前先对一遍书。
 */

import { rollDie } from './dice.js'

/** 九项属性，按规则书顺序 */
export const ATTRS = ['str', 'con', 'siz', 'dex', 'app', 'int', 'pow', 'edu']

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
  取悦: 15,
  攀爬: 20,
  信用评级: 0,
  克苏鲁神话: 0,
  乔装: 5,
  汽车驾驶: 20,
  电气维修: 10,
  话术: 5,
  斗殴: 25,
  手枪: 20,
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
  说服: 10,
  精神分析: 1,
  心理学: 10,
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
 * 取某项技能的基础值。
 *
 * 闪避 = DEX/2、母语 = EDU，这两项依赖属性，所以不能写进静态表。
 *
 * @param {string} name
 * @param {{ dex?: number, edu?: number }} attrs
 * @returns {number}
 */
export function skillBase(name, attrs = {}) {
  const key = String(name ?? '').trim()
  if (key === '闪避') return Math.floor((Number(attrs.dex) || 0) / 2)
  if (key === '母语') return Math.trunc(Number(attrs.edu) || 0)
  return SKILL_BASE[key] ?? 0
}

/**
 * 建一张卡。**一次成型，不做逐步问答。**
 *
 * 属性按规则书分组掷：STR/CON/SIZ/DEX/APP/POW 用 3d6×5，
 * INT/EDU 用 (2d6+6)×5。幸运单独 3d6×5。
 *
 * @param {{ name?: string, age?: number, rng?: () => number }} [opts]
 * @returns {object} 角色卡
 */
export function createSheet({ name = '无名调查员', age = 25, rng = Math.random } = {}) {
  const attrs = {}
  for (const key of ATTRS) {
    const kind = key === 'int' || key === 'edu' ? '2d6+6' : '3d6'
    attrs[key] = rollAttr({ kind, rng })
  }

  const luck = (rollDie(6, rng) + rollDie(6, rng) + rollDie(6, rng)) * 5
  const d = derive({ ...attrs, age })
  const points = skillPoints(attrs.edu, attrs.int)

  return {
    name: String(name).slice(0, 40),
    age: Math.max(15, Math.min(99, Math.trunc(Number(age) || 25))),
    attrs,
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
    createdAt: Date.now(),
  }
}
