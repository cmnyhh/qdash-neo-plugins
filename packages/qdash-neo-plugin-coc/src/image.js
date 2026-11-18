/**
 * 生图客户端。**后端缺席时完全隐形。**
 *
 * 服务器没有 GPU，本地跑推理不现实，所以这里只负责调外部服务。
 * 没配 `endpoint` 时 `ready` 为 false —— 调用方据此**跳过整段逻辑**：
 * 建卡照常、切场景照常，不写 `image` 字段、不发消息、不报错、不刷日志。
 *
 * 三种协议归一化成同一个出口（`{ bytes, ext }`），上层不需要知道接的是什么。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 默认风格前缀。1920 年代 + 宇宙恐怖，和 COC 的调性一致 */
const DEFAULT_STYLE = '1920s cosmic horror, muted palette, film grain, oil painting'

/** 保留多少张，超出删最旧的 */
const KEEP_FILES = 50

function sha1(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 8)
}

/** `1024x1024` → `{ width, height }`；认不出就用 512 */
function parseSize(size) {
  const m = /^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i.exec(String(size ?? '').trim())
  if (!m) return { width: 512, height: 512 }
  return {
    width: Math.min(2048, Math.max(128, Number(m[1]))),
    height: Math.min(2048, Math.max(128, Number(m[2]))),
  }
}

/** 去掉 `data:image/png;base64,` 前缀 */
function stripDataUrl(s) {
  const str = String(s ?? '')
  const i = str.indexOf('base64,')
  return i >= 0 ? str.slice(i + 7) : str
}

/** 按点路径取值：`data.0.b64_json` */
function pickPath(obj, path) {
  if (!path) return undefined
  let cur = obj
  for (const seg of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[seg]
  }
  return cur
}

export class ImageClient {
  /**
   * @param {{
   *   config?: object,
   *   dir?: string,
   *   log?: Function,
   *   fetchImpl?: Function,
   * }} deps
   *   `config` 是 `Config.image` 那块；`dir` 是 `storage.dir('coc','img')`
   */
  constructor({ config = {}, dir = '', log = () => {}, fetchImpl = null } = {}) {
    this.config = config ?? {}
    this.dir = String(dir ?? '')
    this.log = log
    this.fetchImpl = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)

    if (this.dir) {
      try {
        mkdirSync(this.dir, { recursive: true })
      } catch (err) {
        this.log('warn', `qdash-neo-plugin-coc: 创建图片目录失败 msg=${err?.message}`)
      }
    }
  }

  /**
   * **只认 `endpoint`。** `apiKey` 可以为空 —— 局域网里的 SD WebUI 不需要。
   *
   * 也不能要求 `fetchImpl`：老版本 Node 没有全局 fetch，但那种环境下
   * 应该由调用方报"环境不支持"，而不是让整个插件看起来像"没配置"。
   */
  get ready() {
    return Boolean(String(this.config?.endpoint ?? '').trim()) && Boolean(this.fetchImpl) && Boolean(this.dir)
  }

  /** 拼 prompt：风格前缀 + 主体 + 负面词（负面词交给协议自己去用） */
  buildPrompt(subject) {
    const style = String(this.config?.stylePrefix ?? DEFAULT_STYLE).trim()
    const body = String(subject ?? '').trim()
    const suffix = String(this.config?.promptSuffix ?? '').trim()
    return [style, body, suffix].filter(Boolean).join(', ')
  }

  /**
   * 生成并落盘。
   *
   * **失败返回 null，不抛错** —— 生图失败不该让跑团卡住，
   * 也不该让模型看到一串 HTTP 细节去跟玩家解释。
   *
   * @param {{ subject: string, kind?: 'portrait'|'scene'|'npc' }} opts
   * @returns {Promise<{ file: string, bytes: number } | null>}
   */
  async generate({ subject, kind = 'portrait' } = {}) {
    if (!this.ready) return null

    const prompt = this.buildPrompt(subject)
    if (!prompt) return null

    try {
      const got = await this.#request(prompt, kind)
      if (!got?.bytes?.length) {
        this.log('warn', 'qdash-neo-plugin-coc: 生图返回空内容')
        return null
      }

      const file = join(this.dir, `coc-${Date.now()}-${sha1(prompt)}.${got.ext}`)
      writeFileSync(file, got.bytes)
      this.prune(KEEP_FILES)
      return { file, bytes: got.bytes.length }
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 生图失败 msg=${err?.message}`)
      return null
    }
  }

  /**
   * 按协议发请求，归一化成 `{ bytes, ext }`。
   *
   * @param {string} prompt
   * @param {string} kind
   * @returns {Promise<{ bytes: Buffer, ext: string } | null>}
   */
  async #request(prompt, kind) {
    const endpoint = String(this.config?.endpoint ?? '').trim()
    const protocol = String(this.config?.protocol ?? 'openai').trim().toLowerCase()
    const apiKey = String(this.config?.apiKey ?? '').trim()
    const { width, height } = parseSize(this.config?.size)
    const timeoutMs = Math.max(5000, Number(this.config?.timeoutMs) || 120_000)

    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    let body
    if (protocol === 'sdapi') {
      body = {
        prompt,
        negative_prompt: String(this.config?.negativePrompt ?? '').trim(),
        width,
        height,
        steps: Math.max(1, Number(this.config?.steps) || 24),
      }
    } else if (protocol === 'custom') {
      const tpl = this.config?.bodyTemplate
      body =
        tpl && typeof tpl === 'object'
          ? JSON.parse(
              JSON.stringify(tpl)
                .replaceAll('{{prompt}}', prompt.replaceAll('"', '\\"'))
                .replaceAll('{{width}}', String(width))
                .replaceAll('{{height}}', String(height)),
            )
          : { prompt, width, height, kind }
    } else {
      // openai 兼容
      body = {
        model: String(this.config?.model ?? 'dall-e-3'),
        prompt,
        n: 1,
        size: `${width}x${height}`,
        response_format: 'b64_json',
      }
    }

    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })

    if (!res?.ok) {
      throw new Error(`HTTP ${res?.status ?? '?'}`)
    }

    const json = await res.json()
    const payload =
      protocol === 'sdapi'
        ? json?.images?.[0]
        : protocol === 'custom'
          ? pickPath(json, this.config?.resultPath || 'image')
          : (json?.data?.[0]?.b64_json ?? json?.data?.[0]?.url)

    if (!payload) throw new Error('响应里没有图片字段')

    const text = String(payload)

    // URL 形态要再取一次
    if (/^https?:\/\//i.test(text)) {
      const r2 = await this.fetchImpl(text, { signal })
      if (!r2?.ok) throw new Error(`下载图片失败 HTTP ${r2?.status ?? '?'}`)
      const buf = Buffer.from(await r2.arrayBuffer())
      return { bytes: buf, ext: guessExt(text, buf) }
    }

    const buf = Buffer.from(stripDataUrl(text), 'base64')
    return { bytes: buf, ext: guessExt('', buf) }
  }

  /**
   * 只保留最近 `keep` 张。**生成后才调**，不在启动时扫盘。
   *
   * @param {number} keep
   * @returns {number} 删了几张
   */
  prune(keep = KEEP_FILES) {
    if (!this.dir) return 0
    try {
      const files = readdirSync(this.dir)
        .filter(f => /^coc-.*\.(png|jpg|jpeg|webp)$/i.test(f))
        .map(f => {
          const p = join(this.dir, f)
          return { p, mtime: statSync(p).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)

      let removed = 0
      for (const f of files.slice(Math.max(0, keep))) {
        try {
          rmSync(f.p, { force: true })
          removed += 1
        } catch {
          /* 单张删不掉不影响别的 */
        }
      }
      return removed
    } catch (err) {
      this.log('warn', `qdash-neo-plugin-coc: 清理旧图失败 msg=${err?.message}`)
      return 0
    }
  }

  /** 文件还在不在（发图前兜一下，避免内核拿到一个已被删的路径） */
  exists(file) {
    try {
      return Boolean(file) && existsSync(file)
    } catch {
      return false
    }
  }
}

/** 按 magic bytes 猜扩展名，猜不出按 png */
function guessExt(url, buf) {
  if (buf?.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf?.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf?.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') return 'webp'
  const m = /\.(png|jpe?g|webp)(?:\?|$)/i.exec(String(url ?? ''))
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'png'
}
