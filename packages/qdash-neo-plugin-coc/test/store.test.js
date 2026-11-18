/**
 * KV 封装的测试。用内存假 store，不碰真 sqlite。
 *
 * 重点在**键名清洗**：`who` 可能是 `草莓(1704)`、`1704` 或 `草莓`，
 * 三种写法必须是同一张卡 —— 否则玩家会发现自己"多了一个角色"，
 * 而且怎么查都查不出为什么。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CocStore, chatKeyOf, whoKey } from '../src/store.js'

/** 和内核 `storage.forFeature()` 同形状的假实现 */
function fakeKv() {
  const m = new Map()
  return {
    get: (k, d) => (m.has(k) ? m.get(k) : d),
    set: (k, v) => {
      m.set(k, v)
    },
    del: k => m.delete(k),
    list: () => [...m.entries()].map(([key, value]) => ({ key, value })),
    clear: () => m.clear(),
    /** 测试用：看原始键 */
    _keys: () => [...m.keys()],
  }
}

/* ---------------- 键名清洗 ---------------- */

test('whoKey：优先取括号里的 QQ 号', () => {
  assert.equal(whoKey('草莓(1704)'), '1704')
  assert.equal(whoKey('1704'), '1704', '直接传号也是同一个键')
  assert.equal(whoKey('  草莓(1704)  '), '1704', '两边空格要去掉')
})

test('whoKey：没有 QQ 号时用昵称', () => {
  assert.equal(whoKey('草莓'), '草莓')
})

test('whoKey：洗掉冒号和百分号，避免破坏键结构', () => {
  assert.equal(whoKey('a:b'), 'a-b', '冒号是分隔符，必须洗')
  assert.equal(whoKey('100%'), '100-', '百分号会让 kvList 的 LIKE 前缀失效')
})

test('whoKey：空值不崩', () => {
  assert.equal(whoKey(''), '')
  assert.equal(whoKey(null), '')
  assert.equal(whoKey(undefined), '')
})

test('chatKeyOf：g:123 洗成 g-123', () => {
  assert.equal(chatKeyOf('g:123'), 'g-123')
  assert.equal(chatKeyOf('u:1704'), 'u-1704')
})

/* ---------------- 角色卡 ---------------- */

test('角色卡：没建过返回 null', () => {
  const s = new CocStore({ kv: fakeKv() })
  assert.equal(s.getSheet('g:1', '1704'), null)
})

test('角色卡：存取往返，且会把 who 一起存下来', () => {
  const s = new CocStore({ kv: fakeKv() })
  s.setSheet('g:1', '草莓(1704)', { name: '草莓', hp: 12 })

  const got = s.getSheet('g:1', '1704')
  assert.equal(got.name, '草莓')
  assert.equal(got.hp, 12)
  assert.equal(got.who, '草莓(1704)', 'listSheets 靠它显示，不用解析键')
  assert.ok(got.updatedAt > 0)
})

test('角色卡：三种 who 写法指向同一张卡', () => {
  const s = new CocStore({ kv: fakeKv() })
  s.setSheet('g:1', '草莓(1704)', { name: '草莓' })

  assert.ok(s.getSheet('g:1', '1704'), '传纯 QQ 号能查到')
  assert.ok(s.getSheet('g:1', '草莓(1704)'), '传完整渲染也能查到')
  assert.equal(s.listSheets('g:1').length, 1, '不该变成两张卡')
})

test('角色卡：listSheets 只返回本会话的', () => {
  const s = new CocStore({ kv: fakeKv() })
  s.setSheet('g:1', '1704', { name: '草莓' })
  s.setSheet('g:1', '1705', { name: '白绫' })
  s.setSheet('g:2', '1706', { name: '别人' })

  const list = s.listSheets('g:1')
  assert.equal(list.length, 2)
  assert.deepEqual(list.map(x => x.name).sort(), ['白绫', '草莓'])
})

/* ---------------- 场景 ---------------- */

test('场景：没建过返回默认值，mode 是 classic', () => {
  const s = new CocStore({ kv: fakeKv() })
  const sc = s.getScene('g:1')
  assert.equal(sc.mode, 'classic')
  assert.deepEqual(sc.clues, [])
  assert.deepEqual(sc.npcs, [])
  assert.equal(sc.sessionId, '')
})

test('场景：setScene 是浅合并，不清掉其他字段', () => {
  const s = new CocStore({ kv: fakeKv() })
  s.setScene('g:1', { title: '谁在敲墙', location: '波士顿' })
  s.setScene('g:1', { time: '凌晨两点' })

  const sc = s.getScene('g:1')
  assert.equal(sc.title, '谁在敲墙', '前一次写的要保留')
  assert.equal(sc.location, '波士顿')
  assert.equal(sc.time, '凌晨两点')
})

/* ---------------- 开新团 ---------------- */

test('开新团：重置场景与战斗，角色卡保留', () => {
  const s = new CocStore({ kv: fakeKv() })

  s.setSheet('g:1', '1704', { name: '草莓' })
  s.setScene('g:1', { title: '上一场', clues: ['旧线索'] })
  s.setCombat('g:1', { round: 3, active: true })

  const scene = s.newSession('g:1', { title: '谁在敲墙', mode: 'narrative', location: '波士顿' })

  assert.equal(scene.title, '谁在敲墙')
  assert.equal(scene.mode, 'narrative')
  assert.deepEqual(scene.clues, [], '旧线索要清掉')
  assert.ok(scene.sessionId, '要生成新的场次 id')

  const combat = s.getCombat('g:1')
  assert.equal(combat.active, false, '战斗要重置')
  assert.equal(combat.round, 0)

  assert.ok(s.getSheet('g:1', '1704'), '**角色卡必须保留** —— 连跑一个战役不该重开卡')
})

test('开新团：mode 只认 narrative，其余一律 classic', () => {
  const s = new CocStore({ kv: fakeKv() })
  assert.equal(s.newSession('g:1', { mode: 'narrative' }).mode, 'narrative')
  assert.equal(s.newSession('g:1', { mode: '随便写的' }).mode, 'classic')
  assert.equal(s.newSession('g:1', {}).mode, 'classic')
})

/* ---------------- 战斗 ---------------- */

test('先攻：按敏捷降序，同敏捷按名字稳定排序', () => {
  const order = CocStore.rollInitiative([
    { who: '草莓', dex: 50 },
    { who: '白绫', dex: 70 },
    { who: '阿澈', dex: 50 },
  ])
  assert.deepEqual(
    order.map(x => x.who),
    ['白绫', '阿澈', '草莓'],
    '同 50 的两个人顺序要稳定，不能每次刷新都变',
  )
  assert.ok(order.every(x => x.acted === false), '开场都还没行动')
})

test('先攻：空名字的被剔除，dex 非数字当 0', () => {
  const order = CocStore.rollInitiative([
    { who: '', dex: 50 },
    { who: '草莓', dex: 'abc' },
    { who: '白绫', dex: 30 },
  ])
  assert.deepEqual(order.map(x => x.who), ['白绫', '草莓'])
  assert.equal(order[1].dex, 0)
})

/* ---------------- 归档（campaign） ---------------- */

test('归档：没归档过返回空数组', () => {
  const s = new CocStore({ kv: fakeKv() })
  assert.deepEqual(s.getCampaign('g:1').chronicles, [])
  assert.deepEqual(s.listChronicles('g:1'), [])
})

test('归档：closeSession 追加一条，字段齐全', () => {
  const s = new CocStore({ kv: fakeKv() })
  const e = s.closeSession('g:1', {
    summary: '你们在地下室找到日记，但理智掉了不少',
    title: '谁在敲墙',
    mode: 'narrative',
    clues: ['日记停在 1919 年'],
    players: ['草莓', '阿澈'],
    sessionId: 's1',
  })

  assert.ok(e)
  assert.equal(e.title, '谁在敲墙')
  assert.equal(e.mode, 'narrative')
  assert.equal(e.summary, '你们在地下室找到日记，但理智掉了不少')
  assert.deepEqual(e.clues, ['日记停在 1919 年'])
  assert.deepEqual(e.players, ['草莓', '阿澈'])
  assert.ok(e.closedAt > 0)
  assert.equal(s.getCampaign('g:1').chronicles.length, 1)
})

test('归档：空摘要拒绝写入', () => {
  const s = new CocStore({ kv: fakeKv() })
  assert.equal(s.closeSession('g:1', { summary: '   ' }), null)
  assert.equal(s.closeSession('g:1', {}), null)
  assert.equal(
    s.getCampaign('g:1').chronicles.length,
    0,
    '**不该留下空条目** —— 一堆「无摘要」比没有归档更糟',
  )
})

test('归档：摘要在 800 字截断', () => {
  const s = new CocStore({ kv: fakeKv() })
  const e = s.closeSession('g:1', { summary: '啊'.repeat(2000) })
  assert.equal(e.summary.length, 800, '归档是给模型看的，太长会挤占上下文')
})

test('归档：线索只留最近 20 条', () => {
  const s = new CocStore({ kv: fakeKv() })
  const clues = Array.from({ length: 30 }, (_, i) => `线索${i}`)
  const e = s.closeSession('g:1', { summary: 'x', clues })
  assert.equal(e.clues.length, 20)
  assert.equal(e.clues[19], '线索29', '留的是最近那批')
})

test('归档：超过 50 场丢最旧的', () => {
  const s = new CocStore({ kv: fakeKv() })
  for (let i = 0; i < 55; i += 1) s.closeSession('g:1', { summary: `第${i}场`, title: `T${i}` })

  const all = s.getCampaign('g:1').chronicles
  assert.equal(all.length, 50)
  assert.equal(all[0].summary, '第5场', '最早 5 场被丢掉')
  assert.equal(all[49].summary, '第54场')
})

test('归档：listChronicles 按旧→新返回', () => {
  const s = new CocStore({ kv: fakeKv() })
  for (let i = 0; i < 5; i += 1) s.closeSession('g:1', { summary: `第${i}场` })

  const last2 = s.listChronicles('g:1', 2)
  assert.deepEqual(
    last2.map(x => x.summary),
    ['第3场', '第4场'],
    '正序 —— 调用方要直接拼给模型当"前情提要"',
  )
})

test('归档：不同会话互不影响', () => {
  const s = new CocStore({ kv: fakeKv() })
  s.closeSession('g:1', { summary: 'A 的团' })
  s.closeSession('g:2', { summary: 'B 的团' })

  assert.equal(s.listChronicles('g:1').length, 1)
  assert.equal(s.listChronicles('g:1')[0].summary, 'A 的团')
})

test('归档：只追加，不改写已有条目', () => {
  const s = new CocStore({ kv: fakeKv() })
  s.closeSession('g:1', { summary: '第一场', title: 'A' })
  s.closeSession('g:1', { summary: '第二场', title: 'B' })

  const all = s.getCampaign('g:1').chronicles
  assert.equal(all[0].title, 'A', '第一条不能变')
  assert.equal(all[1].title, 'B')
})
