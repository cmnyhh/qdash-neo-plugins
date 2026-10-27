import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { StickerStore, normalizeTags } from '../src/store.js'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sticker-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 一张"图"：内容不同就是不同的图 */
const png = tag => Buffer.from(`fake-png:${tag}`)

test('表情包库：同一张图存两次要合并标签，不是多存一份', () =>
  withDir(dir => {
    const s = new StickerStore({ dir })
    const a = s.add({ bytes: png('a'), tags: ['笑死'] })
    const b = s.add({ bytes: png('a'), tags: ['无语', '笑死'] })

    assert.equal(a.created, true)
    assert.equal(b.created, false, '内容 hash 相同就是同一张')
    assert.equal(b.id, a.id)
    assert.deepEqual(b.tags.sort(), ['无语', '笑死'].sort(), '标签要合并，不是覆盖')
    assert.equal(s.list().length, 1)
  }))

test('表情包库：按标签找，匹配词多的优先', () =>
  withDir(dir => {
    const s = new StickerStore({ dir })
    s.add({ bytes: png('1'), tags: ['笑死'], note: '对方说蠢话时' })
    s.add({ bytes: png('2'), tags: ['笑死', '嘲讽'] })
    s.add({ bytes: png('3'), tags: ['晚安'] })

    const one = s.find({ query: '晚安' })
    assert.equal(one.length, 1)

    const two = s.find({ query: '笑死 嘲讽' })
    assert.equal(two[0].tags.includes('嘲讽'), true, '两个词都命中的排前面')

    assert.deepEqual(s.find({ query: '不存在的标签' }), [], '找不到就是空数组，不抛错')
  }))

test('表情包库：超上限淘汰最久没用的，用过的留下', () =>
  withDir(dir => {
    const s = new StickerStore({ dir, maxFiles: 2 })
    const a = s.add({ bytes: png('a'), tags: ['旧'] })
    const b = s.add({ bytes: png('b'), tags: ['中'] })
    // 让 a 变成"用过的"，b 从没被用
    s.markUsed(a.id)

    const c = s.add({ bytes: png('c'), tags: ['新'] })

    assert.equal(s.list().length, 2, '上限 2 就是 2')
    const ids = s.list().map(x => x.tags[0]).sort()
    /**
     * b 从没被用过（按入库时间算最旧），c 是最新的，a 被用过
     * → 淘汰 b，留下 a 和 c。
     */
    assert.deepEqual(ids, ['新', '旧'].sort(), '从没用过的最先被淘汰')
    assert.ok(!s.list().some(x => x.id === b.id))
    assert.ok(s.list().some(x => x.id === c.id))
  }))

test('表情包库：文件被手工删掉时 read 返回 null，不抛错', () =>
  withDir(dir => {
    const s = new StickerStore({ dir })
    const a = s.add({ bytes: png('x'), tags: ['t'] })

    rmSync(join(dir, a.id + '.png'), { force: true })

    assert.equal(s.read(a.id), null, '调用方要能据此降级成"改说文字"')
    assert.equal(s.missingFiles().length, 1)
  }))

test('标签归一：去空、去重、限长', () => {
  assert.deepEqual(normalizeTags('笑死, 无语,笑死 ,, '), ['笑死', '无语'])
  assert.deepEqual(normalizeTags(['a', 'a', 'b']), ['a', 'b'])
  assert.deepEqual(normalizeTags(''), [])
})
