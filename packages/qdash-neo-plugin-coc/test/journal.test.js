/**
 * 跑团记录的测试。用真实临时目录，不碰 DSH_HOME。
 *
 * 重点：
 *   - **没开团时不该产生文件**（否则每个聊过天的群都会多一个空 log）
 *   - 大文件只读尾部（跑一个月的团，`readFileSync` 整读会把内存吃掉）
 *   - 坏行跳过而不是整份读失败
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Journal, isOoc } from '../src/journal.js'

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'coc-log-'))
  return {
    dir,
    journal: new Journal({ dir }),
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('记录：没指定场次时不写文件', () => {
  const s = mk()
  try {
    const ok = s.journal.append('g:1', { kind: 'in', who: '草莓', text: '在吗' })
    assert.equal(ok, false, '没开团就不该产生记录')
    assert.equal(existsSync(join(s.dir, 'g-1-.jsonl')), false)
  } finally {
    s.dispose()
  }
})

test('记录：指定场次后能写能读', () => {
  const s = mk()
  try {
    s.journal.useSession('g:1', '1700000000')
    assert.equal(s.journal.sessionOf('g:1'), '1700000000')

    s.journal.append('g:1', { kind: 'check', who: '草莓', skill: '侦查', value: 34, level: 'hard' })
    s.journal.append('g:1', { kind: 'in', who: '草莓', text: '我下去看看' })
    s.journal.append('g:1', { kind: 'out', text: '你顺着台阶下去，空气里有铁锈味。' })

    const rows = s.journal.recent('g:1', 10)
    assert.equal(rows.length, 3)
    assert.equal(rows[0].kind, 'check')
    assert.equal(rows[1].text, '我下去看看')
    assert.equal(rows[2].kind, 'out')
    assert.ok(rows[0].ts > 0, 'ts 自动补上')
  } finally {
    s.dispose()
  }
})

test('记录：recent 只取最后 n 条', () => {
  const s = mk()
  try {
    s.journal.useSession('g:1', 's1')
    for (let i = 0; i < 20; i += 1) s.journal.append('g:1', { kind: 'in', text: `第${i}条` })

    const rows = s.journal.recent('g:1', 3)
    assert.equal(rows.length, 3)
    assert.equal(rows[0].text, '第17条')
    assert.equal(rows[2].text, '第19条')
  } finally {
    s.dispose()
  }
})

test('记录：坏行被跳过，不影响其他行', () => {
  const s = mk()
  try {
    s.journal.useSession('g:1', 's1')
    s.journal.append('g:1', { kind: 'in', text: '好行一' })

    const file = join(s.dir, 'g-1-s1.jsonl')
    // 手工塞一行坏数据
    writeFileSync(file, `${readFileSync(file, 'utf8')}{这不是JSON}\n`, 'utf8')

    s.journal.append('g:1', { kind: 'in', text: '好行二' })

    const rows = s.journal.recent('g:1', 10)
    assert.equal(rows.length, 2, '坏的那行跳过，好的两行都在')
    assert.deepEqual(rows.map(r => r.text), ['好行一', '好行二'])
  } finally {
    s.dispose()
  }
})

test('记录：大文件只读尾部，不整份读进来', () => {
  const s = mk()
  try {
    s.journal.useSession('g:1', 'big')
    const file = join(s.dir, 'g-1-big.jsonl')

    // 造 4MB 左右：40000 行 × 约 100 字节
    const lines = []
    for (let i = 0; i < 40000; i += 1) {
      lines.push(JSON.stringify({ ts: 1700000000000 + i, kind: 'in', who: 'x', text: 'y'.repeat(50), i }))
    }
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')

    const rows = s.journal.recent('g:1', 5)
    assert.equal(rows.length, 5, '尾部 5 条要读得出来')
    assert.ok(
      rows[0].i > 30000,
      `应该只读尾部（拿到的是 i=${rows[0].i}），从 0 开始说明整份读了`,
    )
  } finally {
    s.dispose()
  }
})

test('导出：Markdown 带标题、时间与分类标签', () => {
  const s = mk()
  try {
    s.journal.useSession('g:1', 's1')
    s.journal.append('g:1', { kind: 'check', who: '草莓', skill: '侦查', skillValue: 65, value: 34, level: '困难成功' })
    s.journal.append('g:1', { kind: 'in', who: '草莓', text: '我下去看看' })
    s.journal.append('g:1', { kind: 'out', text: '你顺着台阶下去。' })
    s.journal.append('g:1', { kind: 'damage', who: '草莓', delta: -3, hp: 9, maxHp: 12 })

    const { markdown, count } = s.journal.exportMarkdown('g:1', { title: '谁在敲墙' })

    assert.equal(count, 4)
    assert.match(markdown, /^# 谁在敲墙/)
    assert.match(markdown, /共 4 条/)
    assert.match(markdown, /`检定`/)
    assert.match(markdown, /\*\*草莓\*\*：我下去看看/, '玩家发言带粗体名字')
    assert.match(markdown, /\*\*KP\*\*：你顺着台阶下去。/, 'KP 的叙述用固定标签')
    assert.match(markdown, /生命 -3 → 9\/12/)
    assert.match(markdown, /\d{2}:\d{2}/, '每条前面要有时间')
  } finally {
    s.dispose()
  }
})

test('导出：没记录时返回空，不报错', () => {
  const s = mk()
  try {
    const r = s.journal.exportMarkdown('g:999')
    assert.equal(r.count, 0)
    assert.equal(r.markdown, '')
  } finally {
    s.dispose()
  }
})

test('记录：换场次后写新文件，旧文件还在', () => {
  const s = mk()
  try {
    s.journal.useSession('g:1', 's1')
    s.journal.append('g:1', { kind: 'in', text: '第一场' })

    s.journal.useSession('g:1', 's2')
    s.journal.append('g:1', { kind: 'in', text: '第二场' })

    assert.ok(existsSync(join(s.dir, 'g-1-s1.jsonl')))
    assert.ok(existsSync(join(s.dir, 'g-1-s2.jsonl')))

    assert.equal(s.journal.recent('g:1', 10).length, 1, 'recent 只看当前场次')
    assert.equal(s.journal.recent('g:1', 10)[0].text, '第二场')
  } finally {
    s.dispose()
  }
})

/* ---------------- 桌外话（OOC） ---------------- */

test('桌外话：整句被圆括号包住才算', () => {
  assert.equal(isOoc('（等等，门不是锁着的吗）'), true)
  assert.equal(isOoc('(你刚才说几点？)'), true, '英文括号也认')
  assert.equal(isOoc('  （前后有空格）  '), true)
})

test('桌外话：混着真实动作的不算，否则玩家白说一句', () => {
  assert.equal(isOoc('我去开门（你等我一下）'), false)
  assert.equal(isOoc('（我）去开门'), false, '括号在开头但没包住整句')
})

test('桌外话：空串和普通句子不算', () => {
  assert.equal(isOoc(''), false)
  assert.equal(isOoc('普通的一句话'), false)
  assert.equal(isOoc(null), false)
})

test('导出：桌外话单独标注，不和角色行动混在一起', () => {
  const s = mk()
  try {
    s.journal.useSession('g:1', 's1')
    s.journal.append('g:1', { kind: 'in', who: '草莓', text: '我去开门' })
    s.journal.append('g:1', { kind: 'in', who: '草莓', text: '（门不是锁着的吗）', ooc: true })

    const { markdown } = s.journal.exportMarkdown('g:1', { title: '测试' })
    assert.match(markdown, /草莓\*\*：我去开门/)
    assert.match(markdown, /草莓\*\*（桌外）：（门不是锁着的吗）/)
  } finally {
    s.dispose()
  }
})

test('记录：endSession 之后不再写入，但文件还在', () => {
  const s = mk()
  try {
    s.journal.useSession('g:1', 's1')
    assert.equal(s.journal.append('g:1', { kind: 'in', text: '还在团里' }), true)

    s.journal.endSession('g:1')

    assert.equal(s.journal.sessionOf('g:1'), '', '场次要清掉')
    assert.equal(
      s.journal.append('g:1', { kind: 'in', text: '收场后的闲聊' }),
      false,
      '**收场后群里再聊什么，不该进战报**',
    )

    assert.equal(s.journal.recent('g:1', 10).length, 0, 'recent 看当前场次，已结束就没有')

    /**
     * 但**文件还在磁盘上**。收场后想导出刚跑完那一场，
     * 靠 `campaign.chronicles` 里的 `sessionId` 指回来。
     */
    assert.equal(
      s.journal.exportMarkdown('g:1', { sessionId: 's1' }).count,
      1,
      '显式指定场次仍能导出',
    )
  } finally {
    s.dispose()
  }
})
