/**
 * 角色卡与派生值的测试。
 *
 * 派生值错了不会报错，只会让团里每个人的血量都算错一点 ——
 * 所以这里逐条对着规则书核：HP/MP 向下取整、DB 与体格查同一张表、
 * 闪避是 DEX/2 而不是固定值。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ATTRS,
  damageBonus,
  derive,
  moveRate,
  rollAttr,
  createSheet,
  skillBase,
  skillPoints,
} from '../src/sheet.js'

/* ---------------- 属性生成 ---------------- */

test('属性：3d6×5 落在 15–90', () => {
  assert.equal(rollAttr({ kind: '3d6', rng: () => 0 }), 15, '三个 1')
  assert.equal(rollAttr({ kind: '3d6', rng: () => 0.99 }), 90, '三个 6')
})

test('属性：(2d6+6)×5 落在 40–90', () => {
  assert.equal(rollAttr({ kind: '2d6+6', rng: () => 0 }), 40, '两个 1 + 6')
  assert.equal(rollAttr({ kind: '2d6+6', rng: () => 0.99 }), 90, '两个 6 + 6')
})

/* ---------------- 伤害加成与体格 ---------------- */

test('伤害加成：每个档位的上下边界都对', () => {
  /**
   * 规则书的区间是**闭区间**：`2–64` 是 -2，`65–84` 是 -1，`85–124` 是 0……
   * 所以 64 仍是 -2、84 仍是 -1、164 仍是 +1D4。差一个数就会让半个团的人算错。
   */
  const cases = [
    [30, 30, '-2', -2], // 60
    [32, 32, '-2', -2], // 64 ← 上边界
    [33, 32, '-1', -1], // 65 ← 下边界
    [42, 42, '-1', -1], // 84 ← 上边界
    [43, 42, '0', 0], // 85
    [62, 62, '0', 0], // 124 ← 上边界
    [63, 62, '+1D4', 1], // 125
    [82, 82, '+1D4', 1], // 164 ← 上边界
    [83, 82, '+1D6', 2], // 165
    [102, 102, '+1D6', 2], // 204 ← 上边界
    [103, 102, '+2D6', 3], // 205
    [142, 142, '+2D6', 3], // 284 ← 上边界
    [143, 142, '+3D6', 4], // 285
    [182, 182, '+3D6', 4], // 364 ← 上边界
    [183, 182, '+4D6', 5], // 365
  ]

  for (const [str, siz, db, build] of cases) {
    const r = damageBonus(str, siz)
    assert.equal(r.db, db, `STR+SIZ=${str + siz} 的伤害加成`)
    assert.equal(r.build, build, `STR+SIZ=${str + siz} 的体格`)
  }
})

/* ---------------- 移动力 ---------------- */

test('移动力：三条比较规则', () => {
  assert.equal(moveRate({ str: 50, dex: 50, siz: 80 }), 7, '都低于体型 → 7')
  assert.equal(moveRate({ str: 90, dex: 50, siz: 60 }), 8, '力量够 → 8')
  assert.equal(moveRate({ str: 50, dex: 90, siz: 60 }), 8, '敏捷够 → 8')
  assert.equal(moveRate({ str: 90, dex: 90, siz: 60 }), 9, '两者都高 → 9')
})

test('移动力：年龄递减，但不低于 1', () => {
  const base = { str: 50, dex: 50, siz: 60 }
  assert.equal(moveRate({ ...base, age: 25 }), 7)
  assert.equal(moveRate({ ...base, age: 45 }), 6)
  assert.equal(moveRate({ ...base, age: 65 }), 4)
  assert.equal(moveRate({ ...base, age: 85 }), 2)
  // 极端情况下不能算出 0 或负数，否则「移动力 0」会让模型编出荒谬描述
  assert.equal(moveRate({ str: 10, dex: 10, siz: 90, age: 90 }), 2)
})

/* ---------------- 派生值 ---------------- */

test('派生：HP/MP 向下取整，SAN 直接等于 POW', () => {
  const d = derive({ str: 50, con: 55, siz: 45, dex: 50, pow: 60 })
  assert.equal(d.hp, 10, '(55+45)/10 = 10')
  assert.equal(d.mp, 12, '60/5 = 12')
  assert.equal(d.san, 60)

  // 89 的组合：floor 是 8，round 会变成 9
  const d2 = derive({ str: 50, con: 44, siz: 45, dex: 50, pow: 44 })
  assert.equal(d2.hp, 8, '(44+45)/10 = 8.9 → 向下取整 8，不是 9')
  assert.equal(d2.mp, 8, '44/5 = 8.8 → 8')
})

test('派生：全 90 的极端卡', () => {
  const attrs = {}
  for (const k of ATTRS) attrs[k] = 90
  const d = derive({ ...attrs, age: 25 })
  assert.equal(d.hp, 18)
  assert.equal(d.mp, 18)
  assert.equal(d.san, 90)
  assert.equal(d.mov, 8, 'STR/DEX 都等于 SIZ，走 >= 那条')
  assert.equal(d.db, '+1D6', '180 落进 165–204')
  assert.equal(d.build, 2)
})

/* ---------------- 技能点 ---------------- */

test('技能点：EDU×4 与 INT×2 分开算', () => {
  assert.deepEqual(skillPoints(60, 50), { occupational: 240, interest: 100 })
  assert.deepEqual(skillPoints(0, 0), { occupational: 0, interest: 0 })
})

/* ---------------- 技能基础值 ---------------- */

test('技能基础：闪避是 DEX/2，母语是 EDU', () => {
  assert.equal(skillBase('闪避', { dex: 65 }), 32, '65/2 向下取整')
  assert.equal(skillBase('闪避', { dex: 50 }), 25)
  assert.equal(skillBase('母语', { edu: 70 }), 70)
})

test('技能基础：静态表里的值直接取，没有的返回 0', () => {
  assert.equal(skillBase('侦查'), 25)
  assert.equal(skillBase('聆听'), 20)
  assert.equal(skillBase('斗殴'), 25)
  assert.equal(skillBase('不存在的技能'), 0)
  assert.equal(skillBase(''), 0)
})

/* ---------------- 建卡 ---------------- */

test('建卡：全满 rng 得到一张自洽的卡', () => {
  const s = createSheet({ name: '测试员', rng: () => 0.99 })

  for (const k of ATTRS) assert.equal(s.attrs[k], 90, `${k} 应该是 90`)
  assert.equal(s.luck, 90)
  assert.equal(s.maxHp, 18)
  assert.equal(s.maxMp, 18)
  assert.equal(s.maxSan, 90)
  assert.equal(s.mov, 8)
  assert.equal(s.db, '+1D6')
  assert.equal(s.build, 2)
  assert.equal(s.occupationalPoints, 360, 'EDU 90 × 4')
  assert.equal(s.interestPoints, 180, 'INT 90 × 2')
  assert.deepEqual(s.skills, {})
  assert.equal(s.image, '')
})

test('建卡：全 0 rng 得到一张低属性的卡', () => {
  const s = createSheet({ rng: () => 0 })
  for (const k of ATTRS) {
    const expect = k === 'int' || k === 'edu' ? 40 : 15
    assert.equal(s.attrs[k], expect, `${k} 应该是 ${expect}`)
  }
  assert.equal(s.luck, 15)
  assert.equal(s.maxHp, 3, '(15+15)/10')
  assert.equal(s.maxMp, 3, '15/5')
  /**
   * **STR/DEX 与 SIZ 相等时算 8，不是 7。**
   * 规则书那条是「都**小于**体型才 7」，相等已经满足 `>=`。
   */
  assert.equal(s.mov, 8)
  assert.equal(s.db, '-2')
})

test('建卡：当前值与上限一致，名字会截断，年龄会夹住', () => {
  const s = createSheet({ name: '一'.repeat(100), age: 5, rng: () => 0.5 })
  assert.equal(s.hp, s.maxHp)
  assert.equal(s.mp, s.maxMp)
  assert.equal(s.san, s.maxSan)
  assert.equal(s.name.length, 40, '名字截到 40 字')
  assert.equal(s.age, 15, '年龄下限 15')
})

test('建卡：属性全落在规则书范围内', () => {
  for (let i = 0; i < 50; i += 1) {
    const s = createSheet()
    for (const k of ATTRS) {
      const isIntOrEdu = k === 'int' || k === 'edu'
      assert.ok(s.attrs[k] >= (isIntOrEdu ? 40 : 15), `${k} 不该低于下限`)
      assert.ok(s.attrs[k] <= 90, `${k} 不该超过 90`)
    }
    assert.ok(s.luck >= 15 && s.luck <= 90)
    assert.ok(s.mov >= 1 && s.mov <= 9)
  }
})
