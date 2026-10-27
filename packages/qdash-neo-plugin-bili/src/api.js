import { createHash } from 'node:crypto'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }

/**
 * wbi 签名用的置换表。B 站硬编码在前端，改版才换。
 *
 * 签名算法：从 `nav` 拿两个 png 文件名，拼起来按这张表重排、取前 32 位当
 * `mixin_key`；再把参数按 key 排序拼接，末尾加 `wts` 和时间戳，md5 后即 `w_rid`。
 *
 * **搜索接口没有它一律 412**（就算带了 cookie）—— 这是实测过的。
 */
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57,
  62, 11, 36, 20, 34, 44, 52,
]

/** 分区表：模型用名字指路，转成 rid */
export const RIDS = {
  总榜: 0,
  动画: 1,
  番剧: 13,
  国创: 168,
  音乐: 3,
  舞蹈: 129,
  游戏: 4,
  知识: 36,
  科技: 188,
  运动: 234,
  汽车: 223,
  生活: 160,
  美食: 211,
  动物: 217,
  搞笑: 138,
  影视: 181,
  电影: 23,
  电视剧: 11,
  纪录片: 177,
}

/**
 * 拿 wbi 的 mixin key。**缓存 10 分钟** —— 每搜一次都请求 `nav` 很浪费，
 * 而这两个 png 文件名一天都不会变。
 */
let cache = { key: '', at: 0 }

async function mixinKey(cookie = '') {
  if (cache.key && Date.now() - cache.at < 10 * 60 * 1000) return cache.key

  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
  })
  const j = await res.json()
  const img = String(j?.data?.wbi_img?.img_url ?? '').split('/').pop().split('.')[0]
  const sub = String(j?.data?.wbi_img?.sub_url ?? '').split('/').pop().split('.')[0]
  if (!img || !sub) throw new Error('拿不到 wbi 素材（nav 接口异常）')

  const raw = img + sub
  cache = { key: MIXIN_TABLE.map(i => raw[i]).join('').slice(0, 32), at: Date.now() }
  return cache.key
}

/** 给参数签名，返回 query string */
async function signedQuery(params, cookie = '') {
  const key = await mixinKey(cookie)
  const all = { ...params, wts: Math.floor(Date.now() / 1000) }
  const q = Object.keys(all)
    .sort()
    .map(k => {
      const v = String(all[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  const w_rid = createHash('md5').update(q + key).digest('hex')
  return `${q}&w_rid=${w_rid}`
}

/** 请求并解析 JSON；返回 HTML（风控）时抛一个能看懂的错误 */
async function getJson(url, { cookie = '', timeoutMs = 12000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
      signal: ac.signal,
    })
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      /**
       * B 站被风控时返回的是 HTML 错误页，不是 JSON。
       *
       * 这个错误**必须说清是什么**：否则上层只会看到 "Unexpected token <"，
       * 完全猜不到是风控。
       */
      throw new Error(
        res.status === 412
          ? 'B 站风控（412）：这个接口需要登录，去控制台扫码'
          : `B 站返回了非 JSON（HTTP ${res.status}），多半是风控`,
      )
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 把接口返回揉成插件内部统一的形状 */
function toItem(v) {
  const title = String(v?.title ?? '').replace(/<[^>]+>/g, '').trim()
  const bvid = String(v?.bvid ?? '').trim()
  const pic = String(v?.pic ?? '').trim()
  return {
    bvid,
    title,
    desc: String(v?.desc ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 120),
    up: String(v?.owner?.name ?? v?.author ?? '').trim(),
    view: Number(v?.stat?.view ?? 0),
    pic: pic.startsWith('//') ? `https:${pic}` : pic,
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : String(v?.arcurl ?? '').trim(),
    duration: Number(v?.duration ?? 0),
  }
}

/**
 * 搜视频。**必须要 cookie**（实测：无 cookie 一律 412，加了 wbi 签名也一样）。
 *
 * @param {string} keyword
 * @param {{ cookie?: string, limit?: number }} [opts]
 */
export async function search(keyword, { cookie = '', limit = 8 } = {}) {
  const kw = String(keyword ?? '').trim()
  if (!kw) throw new Error('关键词不能为空')
  if (!cookie) throw new Error('搜索需要登录：去控制台「B 站」选项卡扫码')

  /**
   * **第一次搜大概率 412，必须重试一次。**
   *
   * 实测（同一份 cookie、同一台机器）：
   *
   *   #1 失败 246ms   ← mixin 缓存空，先请求 nav 再请求 search
   *   #2 成功 542ms   ← 缓存热了，不再请求 nav
   *
   * 两次请求间隔几十毫秒，B 站判定为爬虫。重试时 `wts` 会重新生成
   * （签名带时间戳），而 `mixinKey` 已经在缓存里 —— 所以第二次是
   * 一次干净的单请求，不会被拦。
   *
   * 600ms 的间隔是给风控留的冷却；再短可能仍被拦。
   */
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const qs = await signedQuery({ search_type: 'video', keyword: kw }, cookie)
      const j = await getJson(`https://api.bilibili.com/x/web-interface/search/type?${qs}`, { cookie })
      if (j.code !== 0) throw new Error(`搜索失败 code=${j.code} ${j.message ?? ''}`)

      const list = Array.isArray(j.data?.result) ? j.data.result : []
      return list.slice(0, limit).map(toItem).filter(x => x.bvid)
    } catch (err) {
      lastErr = err
      if (attempt === 0) await new Promise(r => setTimeout(r, 600))
    }
  }
  throw lastErr
}

/** 热门榜。**不需要登录** */
export async function popular({ limit = 8 } = {}) {
  const j = await getJson(
    `https://api.bilibili.com/x/web-interface/popular?ps=${Math.max(1, Math.min(20, limit))}&pn=1`,
  )
  if (j.code !== 0) throw new Error(`热门榜失败 code=${j.code}`)
  return (j.data?.list ?? []).slice(0, limit).map(toItem).filter(x => x.bvid)
}

/**
 * 分区排行榜。**不需要登录**。
 *
 * `rid` 可以是数字，也可以是中文分区名（见 `RIDS`）。
 */
export async function ranking(rid = 0, { limit = 8 } = {}) {
  const id = typeof rid === 'string' && RIDS[rid] != null ? RIDS[rid] : Number(rid) || 0
  const j = await getJson(`https://api.bilibili.com/x/web-interface/ranking/v2?rid=${id}&type=all`)
  if (j.code !== 0) throw new Error(`排行榜失败 code=${j.code}`)
  return (j.data?.list ?? []).slice(0, limit).map(toItem).filter(x => x.bvid)
}

/** 生成登录二维码。返回 `{ url, qrcodeKey }` */
export async function qrcode() {
  const j = await getJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
  if (j.code !== 0) throw new Error(`生成二维码失败 code=${j.code}`)
  return { url: String(j.data?.url ?? ''), qrcodeKey: String(j.data?.qrcode_key ?? '') }
}

/**
 * 轮询扫码状态。
 *
 * 返回 `{ state, cookie? }`：
 *   - `waiting` / `scanned` / `expired`
 *   - `ok` 时带 cookie（从 `Set-Cookie` 拼出来）
 */
export async function poll(qrcodeKey) {
  const res = await fetch(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
    { headers: HEADERS },
  )
  const j = await res.json()
  const code = j?.data?.code

  if (code === 0) {
    const jar = (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).filter(Boolean)
    return { state: 'ok', cookie: jar.join('; ') }
  }
  if (code === 86101) return { state: 'waiting' }
  if (code === 86090) return { state: 'scanned' }
  if (code === 86038) return { state: 'expired' }
  return { state: 'unknown', raw: j?.data?.message ?? '' }
}

/** 登录态检查：能拿到 `isLogin: true` 才算真的有效 */
export async function me(cookie) {
  if (!cookie) return { ok: false, name: '', mid: 0 }
  try {
    const j = await getJson('https://api.bilibili.com/x/web-interface/nav', { cookie })
    const d = j?.data ?? {}
    return { ok: d.isLogin === true, name: String(d.uname ?? ''), mid: Number(d.mid ?? 0) }
  } catch {
    return { ok: false, name: '', mid: 0 }
  }
}

/**
 * 预热 wbi 缓存。
 *
 * 插件启动时调一次，让第一次 `search` 不必先请求 `nav` —— 否则那两次
 * 请求挨得太近会被风控（见 `search` 里的说明）。
 *
 * 失败无所谓：`search` 里还有重试兜底。
 */
export async function warmup() {
  try {
    await mixinKey('')
    return true
  } catch {
    return false
  }
}

/** 把秒数转成 `12:34`，卡片和列表里用 */
export function duration(sec) {
  const s = Number(sec) || 0
  if (!s) return ''
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}
