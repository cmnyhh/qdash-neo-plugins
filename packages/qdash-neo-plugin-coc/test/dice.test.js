/**
 * 骰子与判定的测试。
 *
 * 重点在**边界**：COC 的大失败阈值随技能值变（<50 时 96 起，>=50 时只有 100），
 * 而且必须先于「普通失败」判断。这一条写错，团里所有人都会在 96 上少挨一次。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gradeSkill, rollD100, rollDie, rollExpr } from '../src/dice.js'
import { checkSummary, exprSummary, healthTone, narrativeHint, sanityTone } from '../src/format.js'

/** 固定序列的随机源：依次吐出给定值，用完循环 */
function seq(...vals) {
  let i = 0
  return () => {
    const v = vals[i % vals.length]
    i += 1
    return v
  }
}

/* ---------------- rollDie ---------------- */

test('rollDie：0.0 出 1，0.99 出最大面', () => {
  assert.equal(rollDie(6, () => 0), 1)
  assert.equal(rollDie(6, () => 0.99), 6)
  assert.equal(rollDie(100, () => 0), 1)
  assert.equal(rollDie(100, () => 0.99), 100)
})

test('rollDie：rng 不严谨返回 1 时也不越界', () => {
  assert.equal(rollDie(6, () => 1), 6)
})

/* ---------------- rollD100 ---------------- */

test('d100：00 记为 100，不是 0', () => {
  // 个位 1→0，十位 1→0，合起来是 00
  const r = rollD100({ rng: seq(0, 0) })
  assert.equal(r.value, 100)
  assert.equal(r.unit, 0)
  assert.equal(r.picked, 0)
})

test('d100：普通一掷，个位十位拼起来', () => {
  // 个位 0.5→6→5；十位 0.3→4→3 → 35
  const r = rollD100({ rng: seq(0.5, 0.3) })
  assert.equal(r.value, 35)
})

test('d100：奖励骰取最小的十位', () => {
  // 个位 0；十位两颗：0.9→9，0.5→5 → 取 5 → 50
  const r = rollD100({ bonus: 1, rng: seq(0, 0.9, 0.5) })
  assert.deepEqual(r.tens, [9, 5])
  assert.equal(r.picked, 5)
  assert.equal(r.value, 50)
})

test('d100：惩罚骰取最大的十位', () => {
  const r = rollD100({ bonus: -1, rng: seq(0, 0.9, 0.5) })
  assert.deepEqual(r.tens, [9, 5])
  assert.equal(r.picked, 9)
  assert.equal(r.value, 90)
})

test('d100：奖励两颗就掷三颗十位', () => {
  const r = rollD100({ bonus: 2, rng: seq(0, 0.9, 0.7, 0.1) })
  assert.equal(r.tens.length, 3)
  assert.equal(r.picked, 1, '取最小的一颗')
})

test('d100：bonus 会被夹在 ±9 内，NaN 当 0', () => {
  assert.equal(rollD100({ bonus: 999, rng: () => 0.5 }).tens.length, 10)
  assert.equal(rollD100({ bonus: Number.NaN, rng: () => 0.5 }).tens.length, 1)
})

/* ---------------- gradeSkill：六档 ---------------- */

test('判定：skill=65 的六档都能命中', () => {
  assert.equal(gradeSkill(65, 1), 'critical', '01 是大成功')
  assert.equal(gradeSkill(65, 13), 'extreme', '65/5=13')
  assert.equal(gradeSkill(65, 14), 'hard', '14 > 13，落进困难')
  assert.equal(gradeSkill(65, 32), 'hard', '65/2=32')
  assert.equal(gradeSkill(65, 33), 'regular', '33 > 32，落进普通')
  assert.equal(gradeSkill(65, 65), 'regular', '等于技能值仍算成功')
  assert.equal(gradeSkill(65, 66), 'fail')
  assert.equal(gradeSkill(65, 100), 'fumble')
})

/* ---------------- 边界：大失败阈值随技能值变 ---------------- */

test('大失败：skill=49 时 96 起算', () => {
  assert.equal(gradeSkill(49, 95), 'fail', '95 还只是失败')
  assert.equal(gradeSkill(49, 96), 'fumble', 'skill<50，96 就是大失败')
  assert.equal(gradeSkill(49, 100), 'fumble')
})

test('大失败：skill=50 时只有 100 算', () => {
  assert.equal(gradeSkill(50, 96), 'fail', 'skill>=50，96 只是普通失败')
  assert.equal(gradeSkill(50, 99), 'fail')
  assert.equal(gradeSkill(50, 100), 'fumble', '只有 100')
})

test('大失败必须先于普通失败判断', () => {
  // skill=30 时 96 既满足 >30 也满足 >=96，顺序反了会判成 fail
  assert.equal(gradeSkill(30, 96), 'fumble')
  assert.equal(gradeSkill(0, 100), 'fumble', '技能 0 也能大失败')
})

/* ---------------- 边界：大成功优先 ---------------- */

test('大成功优先于极难：01 永远是大成功', () => {
  assert.equal(gradeSkill(99, 1), 'critical', '1 同时满足 <= 99/5，但仍是大成功')
  assert.equal(gradeSkill(5, 1), 'critical')
  assert.equal(gradeSkill(0, 1), 'critical', '技能 0 掷出 01 也是大成功')
})

/* ---------------- gradeSkill：异常入参 ---------------- */

test('判定：技能为负或掷骰越界都不崩', () => {
  assert.equal(gradeSkill(-10, 50), 'fail')
  assert.equal(gradeSkill(Number.NaN, 50), 'fail')
  // value 会被夹进 1–100
  assert.equal(gradeSkill(65, 0), 'critical', '0 被夹成 1')
  assert.equal(gradeSkill(65, 999), 'fumble', '999 被夹成 100')
})

/* ---------------- rollExpr ---------------- */

test('表达式：3d6 全 6 得 18', () => {
  const r = rollExpr('3d6', { rng: () => 0.99 })
  assert.equal(r.total, 18)
  assert.deepEqual(r.terms[0].rolls, [6, 6, 6])
})

test('表达式：2d6+3 与 2d6-1', () => {
  assert.equal(rollExpr('2d6+3', { rng: () => 0.99 }).total, 15)
  assert.equal(rollExpr('2d6-1', { rng: () => 0.99 }).total, 11)
})

test('表达式：多组相加 1d6+1d4', () => {
  const r = rollExpr('1d6+1d4', { rng: () => 0.99 })
  assert.equal(r.total, 10, '6 + 4')
  assert.equal(r.terms.length, 2)
})

test('表达式：省略个数的 d20 等于 1d20', () => {
  const r = rollExpr('d20', { rng: () => 0.99 })
  assert.equal(r.total, 20)
  assert.equal(r.terms[0].count, 1)
})

test('表达式：空格会被忽略', () => {
  assert.equal(rollExpr(' 2d6 + 3 ', { rng: () => 0.99 }).total, 15)
})

test('表达式：非法输入抛可读错误', () => {
  assert.throws(() => rollExpr(''), /不能为空/)
  assert.throws(() => rollExpr('abc'), /看不懂/)
  assert.throws(() => rollExpr('3d'), /看不懂/)
  assert.throws(() => rollExpr('0d6'), /个数要在 1–100/)
  assert.throws(() => rollExpr('101d6'), /个数要在 1–100/)
  assert.throws(() => rollExpr('1d1'), /骰面要在 2–1000/)
  assert.throws(() => rollExpr('1d6++2'), /不完整/)
})

/* ---------------- format：传统模式 ---------------- */

test('传统模式：一行文案带技能、数值、等级', () => {
  assert.equal(
    checkSummary({ name: '侦查', skill: 65, value: 34, level: 'hard' }),
    '[侦查] 65 → 34 · 困难成功',
  )
})

test('传统模式：奖励与惩罚骰要标出来', () => {
  assert.match(checkSummary({ name: '闪避', skill: 40, value: 12, level: 'extreme', bonus: 1 }), /奖励1/)
  assert.match(checkSummary({ name: '闪避', skill: 40, value: 88, level: 'fail', bonus: -2 }), /惩罚2/)
})

/* ---------------- format：仿真模式 ---------------- */

test('仿真模式：提示里不许出现数字', () => {
  for (const level of ['critical', 'extreme', 'hard', 'regular', 'fail', 'fumble']) {
    const h = narrativeHint(level)
    assert.ok(h.text.length > 0, `${level} 要有提示`)
    assert.doesNotMatch(h.text, /\d/, `${level} 的提示不该含数字：${h.text}`)
    assert.doesNotMatch(h.text, /大成功|极难|困难成功/, '仿真模式不该出现术语')
  }
})

test('仿真模式：六档的提示互不相同', () => {
  const texts = ['critical', 'extreme', 'hard', 'regular', 'fail', 'fumble'].map(l => narrativeHint(l).text)
  assert.equal(new Set(texts).size, 6, '六档写成一个样，KP 就写不出层次')
})

/* ---------------- format：伤势与精神状态 ---------------- */

test('伤势：五档分明，且都不含数字', () => {
  const cases = [
    [14, 14, 'ok'],
    [10, 14, 'warn'],
    [6, 14, 'bad'],
    [2, 14, 'critical'],
    [0, 14, 'down'],
  ]
  for (const [hp, max, tone] of cases) {
    const r = healthTone(hp, max)
    assert.equal(r.tone, tone, `HP ${hp}/${max} 应该是 ${tone}`)
    assert.doesNotMatch(r.text, /\d/, `不该出现数字：${r.text}`)
  }
})

test('伤势：maxHp 为 0 或 NaN 时不除零', () => {
  assert.equal(healthTone(0, 0).tone, 'down')
  assert.equal(healthTone(5, Number.NaN).tone, 'ok')
})

test('理智：五档分明，且都不含数字', () => {
  const cases = [
    [60, 60, 'ok'],
    [42, 60, 'warn'],
    [24, 60, 'bad'],
    [9, 60, 'critical'],
    [0, 60, 'down'],
  ]
  for (const [san, max, tone] of cases) {
    const r = sanityTone(san, max)
    assert.equal(r.tone, tone, `SAN ${san}/${max} 应该是 ${tone}`)
    assert.doesNotMatch(r.text, /\d/)
  }
})

/* ---------------- format：表达式摘要 ---------------- */

test('表达式摘要：带表达式、总数与骰面明细', () => {
  const r = rollExpr('2d6+3', { rng: () => 0.99 })
  const s = exprSummary(r)
  assert.match(s, /2d6\+3/)
  assert.match(s, /15/)
})
