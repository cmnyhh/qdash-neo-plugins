/**
 * 文案渲染。**纯函数，不碰 `ctx`。**
 *
 * 这里承载「两种模式」的差异：传统模式给一行可直接转述的骰点，
 * 仿真模式只给"该怎么写"的提示，一个数字都不给玩家看。
 */

/** 六档的中文名。传统模式直接用，仿真模式只给模型参考、不让它转述 */
export const LEVEL_LABEL = {
  critical: '大成功',
  extreme: '极难成功',
  hard: '困难成功',
  regular: '成功',
  fail: '失败',
  fumble: '大失败',
}

/**
 * **传统模式：一行可以直接发出去的文案。**
 *
 * 格式是 `[技能] 值 → 掷骰 · 等级`，跑团圈里通用的写法。
 * 带奖励/惩罚骰时会标出来，因为"为什么这次是 34"需要能复盘。
 *
 * @param {{ name?: string, skill?: number, value: number, level: string, bonus?: number }} p
 * @returns {string}
 */
export function checkSummary({ name = '检定', skill = 0, value, level, bonus = 0 }) {
  const label = LEVEL_LABEL[level] ?? String(level)
  const b = Number(bonus)
  const bonusTag = b > 0 ? ` 奖励${b}` : b < 0 ? ` 惩罚${-b}` : ''
  return `[${name}] ${skill} → ${value}${bonusTag} · ${label}`
}

/**
 * **仿真模式：不说数字，只说"这段该写成什么样"。**
 *
 * 为什么还分档而不是一句"成功了"：不同档位的叙事张力完全不同 ——
 * 极难成功该给额外信息、大失败该有后果，混成一句会让 KP 写得很平。
 *
 * @param {string} level
 * @returns {{ tone: string, text: string }}
 */
export function narrativeHint(level) {
  switch (level) {
    case 'critical':
      return { tone: 'triumph', text: '远超预期。可以写意外的顺利，或者额外发现点什么' }
    case 'extreme':
      return { tone: 'great', text: '做得很漂亮，细节到位，可以多给一点信息' }
    case 'hard':
      return { tone: 'good', text: '成功，但过程有点吃力' }
    case 'regular':
      return { tone: 'ok', text: '达成目的，不要渲染得太过' }
    case 'fail':
      return { tone: 'fail', text: '没成。别直接说「失败」，写他做了，但没得到想要的结果' }
    case 'fumble':
      return { tone: 'bad', text: '严重失手。可以加一个后果，但别让角色当场送命' }
    default:
      return { tone: 'ok', text: '' }
  }
}

/**
 * **伤势分级。** 仿真模式下用它替掉「HP 9/14」。
 *
 * 阈值不是规则书上的，是按"读起来有没有区别"定的：
 * 每档的写法要能让玩家感到状态在恶化，而不是四个同义词。
 *
 * @param {number} hp
 * @param {number} maxHp
 * @returns {{ tone: string, text: string }}
 */
export function healthTone(hp, maxHp) {
  const h = Number(hp)
  const m = Number(maxHp)
  const cur = Number.isFinite(h) ? Math.max(0, h) : 0
  const max = Number.isFinite(m) && m > 0 ? m : 1

  if (cur <= 0) return { tone: 'down', text: '失去意识' }

  const r = cur / max
  if (r <= 0.25) return { tone: 'critical', text: '只剩半口气，每动一下都撕着疼' }
  if (r <= 0.5) return { tone: 'bad', text: '伤得不轻，动作明显迟滞' }
  if (r <= 0.8) return { tone: 'warn', text: '有明显外伤，还在渗血' }
  return { tone: 'ok', text: '基本完好，只有几处擦伤' }
}

/**
 * **精神状态分级。** 仿真模式下用它替掉「SAN 32/60」。
 *
 * @param {number} san
 * @param {number} maxSan
 * @returns {{ tone: string, text: string }}
 */
export function sanityTone(san, maxSan) {
  const s = Number(san)
  const m = Number(maxSan)
  const cur = Number.isFinite(s) ? Math.max(0, s) : 0
  const max = Number.isFinite(m) && m > 0 ? m : 1

  if (cur <= 0) return { tone: 'down', text: '理智已经崩了' }

  const r = cur / max
  if (r <= 0.25) return { tone: 'critical', text: '站在崩溃边缘，随时会失控' }
  if (r <= 0.5) return { tone: 'bad', text: '手一直在抖，能听见不存在的声音' }
  if (r <= 0.8) return { tone: 'warn', text: '神经绷得很紧' }
  return { tone: 'ok', text: '还算镇定' }
}

/**
 * 通用骰表达式的可读描述，如 `3d6+2 → 15 (4+5+6+2)`。
 *
 * 传统模式要它，因为玩家会想看每一颗骰子；仿真模式用不着。
 *
 * @param {{ expr: string, total: number, terms: object[] }} r
 * @returns {string}
 */
export function exprSummary(r) {
  const parts = []
  for (const t of r?.terms ?? []) {
    const sign = t.sign < 0 ? '-' : '+'
    if (t.kind === 'dice') parts.push(`${sign}(${t.rolls.join('+')})`)
    else parts.push(`${sign}${t.value}`)
  }
  // 首项前面的 `+` 是多余的，去掉
  const detail = parts.join('').replace(/^\+/, '')
  return `${r?.expr ?? ''} → ${r?.total ?? 0}${detail ? ` (${detail})` : ''}`
}
