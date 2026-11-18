/**
 * 骰子与 COC 7 版判定。
 *
 * **纯函数，不碰 `ctx`** —— 所以能直接 `node --test`，不需要 DSH 环境。
 * 这是整个插件唯一能被真正测住的部分，判定边界写错一次就要在团里错一晚。
 */

/**
 * 单个骰子。
 *
 * `rng` 可注入是为了测试：真实跑团用 `Math.random`，
 * 测试里给一个固定序列就能断言"奖励骰取的是小的那个"。
 *
 * @param {number} sides 骰面（2–1000）
 * @param {() => number} [rng] 返回 [0,1) 的随机源
 * @returns {number} 1..sides
 */
export function rollDie(sides, rng = Math.random) {
  const n = Math.floor(Number(rng()) * sides) + 1
  // rng 理论上可能返回 1（某些实现不严谨），兜一下免得越界
  return Math.min(sides, Math.max(1, n))
}

/**
 * **d100，支持奖励骰与惩罚骰。**
 *
 * 规则：个位骰只掷一次，十位骰掷 `1 + |bonus|` 次。
 * 奖励（`bonus > 0`）取**最小**十位，惩罚（`bonus < 0`）取**最大** ——
 * 因为 d100 是掷低为好。
 *
 * `00` 记为 100：掷出 `picked=0, unit=0` 时结果是 0，而 COC 里那是 100。
 *
 * @param {{ bonus?: number, rng?: () => number }} [opts]
 *   `bonus` 正数是奖励骰、负数是惩罚骰，绝对值超过 9 会被夹住
 * @returns {{ value: number, unit: number, tens: number[], picked: number }}
 *   `tens` 是每一颗十位骰的面值（0–9），`picked` 是最终采用的那颗
 */
export function rollD100({ bonus = 0, rng = Math.random } = {}) {
  const raw = Number(bonus)
  const b = Number.isFinite(raw) ? Math.max(-9, Math.min(9, Math.trunc(raw))) : 0

  const unit = rollDie(10, rng) - 1
  const count = 1 + Math.abs(b)
  const tens = []
  for (let i = 0; i < count; i += 1) tens.push(rollDie(10, rng) - 1)

  const picked = b > 0 ? Math.min(...tens) : b < 0 ? Math.max(...tens) : tens[0]

  let value = picked * 10 + unit
  // `00` 在 COC 里是 100，不是 0
  if (value === 0) value = 100

  return { value, unit, tens, picked }
}

/**
 * **COC 7 版六档判定。**
 *
 * ```
 * value === 1                                  → critical  大成功
 * skill < 50 ? value >= 96 : value === 100     → fumble    大失败
 * value <= floor(skill / 5)                    → extreme   极难成功
 * value <= floor(skill / 2)                    → hard      困难成功
 * value <= skill                               → regular   普通成功
 * 其余                                          → fail      失败
 * ```
 *
 * **两个容易写错的点**：
 *
 * 1. **大失败必须先判**。`skill = 30` 时掷出 96 既满足「> skill」也满足「>= 96」，
 *    顺序反了就会判成普通失败。
 * 2. **阈值随技能值变**。`skill = 50` 时 95 只是普通失败，只有 100 才是大失败。
 *
 * @param {number} skill 技能值（0–100，超过按 100 算的语义由调用方决定，这里不夹）
 * @param {number} value 掷出的 d100（1–100）
 * @returns {'critical'|'extreme'|'hard'|'regular'|'fail'|'fumble'}
 */
export function gradeSkill(skill, value) {
  const s = Math.max(0, Math.trunc(Number(skill) || 0))
  const v = Math.max(1, Math.min(100, Math.trunc(Number(value) || 1)))

  if (v === 1) return 'critical'

  // 大失败：技能 < 50 时 96–100，技能 >= 50 时只有 100
  if (s < 50 ? v >= 96 : v === 100) return 'fumble'

  if (v <= Math.floor(s / 5)) return 'extreme'
  if (v <= Math.floor(s / 2)) return 'hard'
  if (v <= s) return 'regular'
  return 'fail'
}

/**
 * 通用骰表达式：`3d6` / `2d6+3` / `1d6+1d4` / `d20` / `2d6-1`。
 *
 * 支持多个骰组相加，也支持常数项。上下限是防呆不是规则：
 * 一次掷 100 个 1000 面骰没有意义，只会让日志爆炸。
 *
 * @param {string} expr
 * @param {{ rng?: () => number }} [opts]
 * @returns {{ expr: string, total: number, terms: object[] }}
 */
export function rollExpr(expr, { rng = Math.random } = {}) {
  const src = String(expr ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()

  if (!src) throw new Error('骰子表达式不能为空，比如 3d6 或 1d100')
  if (src.length > 64) throw new Error(`骰子表达式太长（${src.length} 字符）`)

  /**
   * **连续符号当笔误拒掉**（`1d6++2`）。
   *
   * 正则会把第二个 `+` 当成项符号，于是 `++2` 被解析成 `+2`，结果看起来"正常" ——
   * 用户以为自己写错了，实际却生效了，下次就更敢瞎写。
   */
  if (/[+-]{2,}/.test(src)) throw new Error(`表达式不完整「${expr}」：有连续的 + 或 -`)

  const parts = src.match(/[+-]?[^+-]+/g) ?? []
  if (parts.length === 0) throw new Error(`看不懂骰子表达式「${expr}」`)

  let total = 0
  const terms = []

  for (const raw of parts) {
    const sign = raw.startsWith('-') ? -1 : 1
    const body = raw.replace(/^[+-]/, '')
    if (!body) throw new Error(`表达式不完整「${expr}」：有连续的 + 或 -`)

    const dice = /^(\d*)d(\d+)$/.exec(body)
    if (dice) {
      const count = dice[1] ? Number(dice[1]) : 1
      const sides = Number(dice[2])
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new Error(`骰子个数要在 1–100 之间，收到「${body}」`)
      }
      if (!Number.isInteger(sides) || sides < 2 || sides > 1000) {
        throw new Error(`骰面要在 2–1000 之间，收到「${body}」`)
      }
      const rolls = []
      for (let i = 0; i < count; i += 1) rolls.push(rollDie(sides, rng))
      const sum = rolls.reduce((a, b) => a + b, 0)
      total += sign * sum
      terms.push({ kind: 'dice', count, sides, rolls, sign, sum })
      continue
    }

    if (/^\d+$/.test(body)) {
      const n = Number(body)
      if (n > 10000) throw new Error(`常数太大「${body}」，上限 10000`)
      total += sign * n
      terms.push({ kind: 'flat', value: n, sign })
      continue
    }

    throw new Error(`看不懂这一段「${body}」，只支持 NdM 和整数`)
  }

  return { expr: src, total, terms }
}
