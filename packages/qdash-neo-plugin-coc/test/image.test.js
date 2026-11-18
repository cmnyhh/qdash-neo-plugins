/**
 * 生图客户端的测试。用假 fetch，不真的发请求。
 *
 * 最重要的一条是**未配置时完全不行为**（`ready=false`）：
 * 服务器没有 GPU，生图后端大概率长期空着，插件不能因为"没配图"就报错或刷日志。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ImageClient } from '../src/image.js'

/** 1×1 透明 PNG */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function mk(config = {}, fetchImpl = null) {
  const dir = mkdtempSync(join(tmpdir(), 'coc-img-'))
  return {
    dir,
    client: new ImageClient({ config, dir, fetchImpl }),
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/* ---------------- 未配置时完全隐形 ---------------- */

test('未配置：ready 为 false，generate 直接返回 null 且不发请求', async () => {
  let called = 0
  const s = mk({}, async () => {
    called += 1
    return { ok: true, json: async () => ({}) }
  })
  try {
    assert.equal(s.client.ready, false)
    assert.equal(await s.client.generate({ subject: '地下室' }), null)
    assert.equal(called, 0, '没配置就一次请求都不该发')
  } finally {
    s.dispose()
  }
})

test('未配置：只有 endpoint 没有 apiKey 也算就绪（本地 SD 不需要 key）', () => {
  const s = mk({ endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img' })
  try {
    assert.equal(s.client.ready, true)
  } finally {
    s.dispose()
  }
})

/* ---------------- prompt 拼装 ---------------- */

test('prompt：默认带 COC 风格前缀', () => {
  const s = mk({ endpoint: 'http://x' })
  try {
    const p = s.client.buildPrompt('一个佝偻的老人')
    assert.match(p, /1920s cosmic horror/, '默认风格前缀')
    assert.match(p, /一个佝偻的老人/, '主体要在里面')
  } finally {
    s.dispose()
  }
})

test('prompt：自定义风格会覆盖默认', () => {
  const s = mk({ endpoint: 'http://x', stylePrefix: '水墨', promptSuffix: '高清' })
  try {
    const p = s.client.buildPrompt('地下室')
    assert.equal(p, '水墨, 地下室, 高清')
    assert.doesNotMatch(p, /1920s/)
  } finally {
    s.dispose()
  }
})

/* ---------------- openai 协议 ---------------- */

test('openai：b64_json 能落盘', async () => {
  const s = mk(
    { endpoint: 'http://api/v1/images/generations', protocol: 'openai', apiKey: 'k' },
    async () => ({ ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG_B64 }] }) }),
  )
  try {
    const r = await s.client.generate({ subject: '地下室', kind: 'scene' })
    assert.ok(r, '应该成功')
    assert.ok(existsSync(r.file), '文件要真的写出来')
    assert.ok(r.bytes > 0)
    assert.match(r.file, /\.png$/, '按 magic bytes 判出 png')
  } finally {
    s.dispose()
  }
})

test('openai：请求体带 model / size / b64 格式', async () => {
  let seen = null
  const s = mk({ endpoint: 'http://api', protocol: 'openai', size: '768x512', model: 'my-model' }, async (_u, init) => {
    seen = JSON.parse(init.body)
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG_B64 }] }) }
  })
  try {
    await s.client.generate({ subject: '场景' })
    assert.equal(seen.model, 'my-model')
    assert.equal(seen.size, '768x512')
    assert.equal(seen.response_format, 'b64_json')
  } finally {
    s.dispose()
  }
})

test('openai：返回 url 形态时会再取一次', async () => {
  let calls = 0
  const s = mk({ endpoint: 'http://api', protocol: 'openai' }, async url => {
    calls += 1
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ data: [{ url: 'http://img/a.png' }] }) }
    }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(PNG_B64, 'base64') }
  })
  try {
    const r = await s.client.generate({ subject: 'x' })
    assert.ok(r)
    assert.equal(calls, 2, '一次拿 url，一次取图片本体')
  } finally {
    s.dispose()
  }
})

/* ---------------- sdapi 协议 ---------------- */

test('sdapi：images 数组取第一张，请求带 negative_prompt', async () => {
  let seen = null
  const s = mk(
    { endpoint: 'http://sd', protocol: 'sdapi', negativePrompt: 'blurry', size: '512x512' },
    async (_u, init) => {
      seen = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ images: [PNG_B64] }) }
    },
  )
  try {
    const r = await s.client.generate({ subject: '老人' })
    assert.ok(r)
    assert.equal(seen.negative_prompt, 'blurry')
    assert.equal(seen.width, 512)
    assert.equal(seen.height, 512)
  } finally {
    s.dispose()
  }
})

/* ---------------- 失败处理 ---------------- */

test('失败：HTTP 非 200 返回 null，不抛错', async () => {
  const s = mk({ endpoint: 'http://x' }, async () => ({ ok: false, status: 500, json: async () => ({}) }))
  try {
    assert.equal(await s.client.generate({ subject: 'x' }), null)
  } finally {
    s.dispose()
  }
})

test('失败：网络异常返回 null，不抛错', async () => {
  const s = mk({ endpoint: 'http://x' }, async () => {
    throw new Error('ECONNREFUSED')
  })
  try {
    assert.equal(await s.client.generate({ subject: 'x' }), null, '生图失败不该让跑团卡住')
  } finally {
    s.dispose()
  }
})

test('失败：响应里没有图片字段返回 null', async () => {
  const s = mk({ endpoint: 'http://x' }, async () => ({ ok: true, status: 200, json: async () => ({}) }))
  try {
    assert.equal(await s.client.generate({ subject: 'x' }), null)
  } finally {
    s.dispose()
  }
})

/* ---------------- 清理 ---------------- */

test('prune：只保留最近 N 张', () => {
  const s = mk({ endpoint: 'http://x' })
  try {
    for (let i = 0; i < 5; i += 1) {
      const f = join(s.dir, `coc-${i}.png`)
      writeFileSync(f, 'x')
      // 手动错开 mtime，否则同一毫秒写出来的顺序不确定
      const t = 1700000000 + i
      utimesSync(f, t, t)
    }
    const removed = s.client.prune(2)
    assert.equal(removed, 3)
    assert.equal(readdirSync(s.dir).filter(f => f.endsWith('.png')).length, 2)
  } finally {
    s.dispose()
  }
})

test('prune：目录里有非本插件的文件时不误删', () => {
  const s = mk({ endpoint: 'http://x' })
  try {
    writeFileSync(join(s.dir, 'other.txt'), 'x')
    s.client.prune(0)
    assert.ok(existsSync(join(s.dir, 'other.txt')), '只清 coc-*.png')
  } finally {
    s.dispose()
  }
})
