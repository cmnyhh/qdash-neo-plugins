import { StickerStore, normalizeTags } from './store.js'

/** 命名空间：存储键、工具 owner 都用它。**不能带连字符**（详见 §0.2） */
const NS = 'qdash_neo_sticker'

export const name = '@cmnyhh/qdash-neo-plugin-sticker'

/**
 * 插件自己的名字（队列来源标记用）—— 和 `owner` 分开是有意的：
 * owner 是"工具归属"的短名，`name` 是"这个包叫什么"，两者在别处语义不同。
 */
export const inject = ['qdashNeo']

/** 声明用到的能力面（见 §2.8） */
export const capabilities = {
  tools: true,
  storage: true,
  events: true,
  instructions: true,
}

/** 单张图上限 2MB：表情包远小于这个，超了多半是误传的原图 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/** 内存里记多少条「图片标识 → 下载地址」。够覆盖一次长对话，也不会吃内存 */
const RECENT_IMAGE_CAP = 200

/**
 * 表情包库。
 *
 * 核心判断交给模型：它看到图、看到上下文，比任何启发式都清楚
 * "这张图以后用不用得上"。插件只负责**存得下、找得到、发得出去**。
 */
export function apply(ctx, config = {}) {
  const neo = ctx.qdashNeo
  /**
   * **不能用 `ctx.log`** —— 它要 `inject: ['log']` 才拿得到，
   * 直接访问会抛 `cannot get property "log" without inject`，
   * 而那个错误在插件加载期抛出，整个 `apply` 都不执行。
   *
   * 这就是 §0.2 第 1 条坑。`console.log` 一样进 journalctl。
   */
  const log = (...a) => console.log(...a)

  const cfg = {
    enabled: config?.enabled !== false,
    maxFiles: Number(config?.maxFiles) > 0 ? Number(config.maxFiles) : 300,
    maxSendBytes: Number(config?.maxSendBytes) > 0 ? Number(config.maxSendBytes) : MAX_IMAGE_BYTES,
  }

  /** 语音/图片这类能力关闭时整个插件不干活 */
  if (!cfg.enabled) {
    log('qdash-neo-plugin-sticker: 已禁用（enabled=false），不注册工具')
    return
  }

  let dir = ''
  try {
    dir = neo.storage?.dir?.('stickers') ?? ''
  } catch (err) {
    log(`qdash-neo-plugin-sticker: 存储目录不可用 msg=${err?.message}`)
    return
  }
  if (!dir) {
    log('qdash-neo-plugin-sticker: 拿不到存储目录，插件不启动')
    return
  }

  const store = new StickerStore({ dir, maxFiles: cfg.maxFiles, log })

  /**
   * `图片标识 → 下载地址`。
   *
   * 模型在 prompt 里看到的是 `[图片:abc123]`，而下载要用 OneBot 给的 `url`；
   * 插件拿不到 `client`，只能靠 `message/inbound` 把这两者对上。
   *
   * **只留最近 200 条**：腾讯的图片地址有时效，太老的本来也下不动了。
   */
  const recentImages = new Map()

  ctx.effect(() =>
    neo.on('message/inbound', ev => {
      try {
        const file = String(ev?.imageFile ?? '').trim()
        const url = String(ev?.imageUrl ?? '').trim()
        if (!file || !url) return
        recentImages.set(file, { url, at: Date.now() })
        while (recentImages.size > RECENT_IMAGE_CAP) {
          const oldest = recentImages.keys().next().value
          recentImages.delete(oldest)
        }
      } catch {
        /* 记地址失败不该影响消息处理 */
      }
    }),
  )

  /**
   * 下载一张图。
   *
   * 只接受 http(s)：`base64://` 由模型直接传给工具没意义（它也没有内容），
   * 而 `file://` 会变成读本机任意文件 —— 那是个不该开的口子。
   */
  async function download(url) {
    let u
    try {
      u = new URL(url)
    } catch {
      throw new Error('图片地址不合法')
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`不支持的图片地址协议 ${u.protocol}`)
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15000)
    try {
      const res = await fetch(u, { signal: ac.signal })
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)

      const len = Number(res.headers.get('content-length') ?? 0)
      if (len > cfg.maxSendBytes) {
        throw new Error(`图片太大（${len} 字节，上限 ${cfg.maxSendBytes}）`)
      }

      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > cfg.maxSendBytes) {
        throw new Error(`图片太大（${bytes.length} 字节，上限 ${cfg.maxSendBytes}）`)
      }
      if (!bytes.length) throw new Error('下载到空内容')

      const ct = String(res.headers.get('content-type') ?? '')
      const ext = ct.includes('gif') ? 'gif' : ct.includes('webp') ? 'webp' : ct.includes('jpeg') ? 'jpg' : 'png'
      return { bytes, ext }
    } finally {
      clearTimeout(timer)
    }
  }

  /* ---------------- sticker_save ---------------- */

  const disposeSave = neo.tools.register({
    name: 'sticker_save',
    owner: NS,
    description:
      // 不写"表情包库"：这个描述会进 prompt，模型会照着说「库里没有」
      '把当前对话里的一张图收起来，以后可以用 qq_send_sticker 找出来发。' +
      '**只存"以后还用得上"的**：好笑、能表达某种情绪、是常见的梗。' +
      '一般的截图、自己拍的日常照片、一次性的图不用存。' +
      '标签写**这张图表达什么**（笑死、无语、嘲讽、雀跃），不是"画面里有什么"。',
    params: {
      file: '图片标识。就是消息里 [#数字] 后面的 [图片:xxx] 里那个 xxx',
      tags: '标签，逗号分隔。写这张图表达的情绪/场合，2-5 个就够',
      note: '可选：什么场合用。比如"对方说蠢话时"',
    },
    async execute(args) {
      const file = String(args?.file ?? '').trim()
      if (!file) throw new Error('file 不能为空（图片标识见消息里的 [图片:xxx]）')

      const hit = recentImages.get(file)
      if (!hit?.url) {
        throw new Error(
          `找不到这张图的下载地址（${file}）。可能是消息太早、图片链接已过期 —— ` +
            '这次就不用存了。',
        )
      }

      const { bytes, ext } = await download(hit.url)
      const tags = normalizeTags(args?.tags)
      if (!tags.length) {
        throw new Error('tags 不能为空：至少给一个标签，否则以后搜不到')
      }

      const res = store.add({
        bytes,
        ext,
        tags,
        note: String(args?.note ?? '').trim(),
        from: `#${file}`,
      })

      log(
        `qdash-neo-plugin-sticker: 收藏 ${res.id}（${res.created ? '新增' : '合并标签'}）` +
          ` 标签=${res.tags.join('/')} 共 ${store.describe().count} 张`,
      )
      return {
        ok: true,
        id: res.id,
        created: res.created,
        tags: res.tags,
        total: store.describe().count,
      }
    },
  })
  ctx.effect(() => disposeSave)

  /* ---------------- qq_send_sticker ---------------- */

  const disposeSend = neo.tools.register({
    name: 'qq_send_sticker',
    owner: NS,
    description:
      '找一张合适的表情发到当前会话。' +
      '**聊天里想用表情包时用它**：比说话更有力、或者懒得打字的时候。' +
      '找不到合适的标签就改说文字，**不要硬找一个不相关的发出去**。',
    params: { query: '要找什么。写你想表达的情绪或场合，比如"笑死""无语"' },
    async execute(args, exec) {
      const chatKey = String(exec?.chatKey ?? '').trim()
      if (!chatKey) throw new Error('拿不到会话标识（主框架未注入 chatKey）')

      const query = String(args?.query ?? '').trim()
      const hits = store.find({ query, limit: 3 })
      if (!hits.length) {
        return {
          ok: false,
          reason: 'no-match',
          // 这句会回给模型，"库"同样不要说 —— 它会转述成「库里没有」
      hint: `没有「${query}」相关的图。这次改说文字吧，别硬凑。`,
          total: store.describe().count,
        }
      }

      // 取最匹配的那张；文件丢了就往后再试一张
      for (const it of hits) {
        const got = store.read(it.id)
        if (!got) continue
        if (got.bytes.length > cfg.maxSendBytes) continue

        /**
         * 是 `outboxApi`，不是 `outbox`。
         *
         * `neo.outbox` 是内核自己的出站队列（没有 `forPlugin`）；
         * 给插件的是 `outboxApi.forPlugin(name)` —— 它会给消息打上来源标记，
         * 而那个标记不可伪造。文档 §0.1 写的也是 `outboxApi`。
         */
        await neo.outboxApi.forPlugin(NS).sendSegments({
          chatKey,
          segments: [{ type: 'image', data: { file: `base64://${got.bytes.toString('base64')}` } }],
          text: `[表情包] ${(it.tags ?? []).join('/')}`,
        })
        store.markUsed(it.id)
        log(`qdash-neo-plugin-sticker: 发出 ${it.id} 标签=${(it.tags ?? []).join('/')}`)
        return { ok: true, id: it.id, tags: it.tags, note: it.note || '' }
      }

      return {
        ok: false,
        reason: 'file-missing',
        hint: '匹配到的图文件不见了。这次改说文字吧。',
      }
    },
  })
  ctx.effect(() => disposeSend)

  /* ---------------- 引导 ---------------- */

  /**
   * 这段是整个插件能不能用起来的关键。
   *
   * 不写的话模型根本想不起来存 —— 和 `memory_add` 一样：工具在那儿，
   * 但它没有"看到 X 就该做 Y"的条件反射。
   *
   * **存和发都要写**：只写存，它会存一堆却从不使用。
   */
  const disposeHint = neo.instructions.register({
    key: 'sticker',
    owner: NS,
    text:
      '看到群友发的图或表情包，如果以后还可能用得上（好笑、能表达某种情绪、是常见的梗），' +
      '就调 sticker_save 存下来，顺手给几个标签。' +
      '标签写**这张图表达什么**（笑死、无语、嘲讽、雀跃），不是画面里有什么 —— ' +
      '你以后是按"想表达什么"来找图的，不是按"画了什么"。' +
      '一般的截图、自己拍的日常照片、一次性的图不用存。\n' +
      '聊天里想用表情包的时候（比说话更有力，或者懒得打字），' +
      '调 qq_send_sticker 按标签找一张发出去。' +
      '找不到合适的就改说文字，不要硬凑一张不相关的。',
  })
  ctx.effect(() => disposeHint)

  /* ---------------- 控制台 ---------------- */

  const disposeTab = neo.console.registerTab({
    id: 'sticker',
    title: '表情包库',
    layout: [
      {
        type: 'status',
        items: [
          { label: '目录', value: dir },
          { label: '已存', value: `${store.describe().count} 张` },
          { label: '上限', value: `${cfg.maxFiles} 张` },
        ],
      },
      {
        type: 'table',
        title: '最近收藏',
        columns: ['标签', '场合', '大小'],
        rows: store
          .list()
          .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
          .slice(0, 30)
          .map(it => [
            (it.tags ?? []).join(' / '),
            it.note || '—',
            `${Math.round((Number(it.bytes) || 0) / 1024)} KB`,
          ]),
      },
      /**
       * 只读表单（不带 `submit` 就渲染成静态文本）。
       *
       * 这里**不能用 `paragraph`** —— 内核只认 `form` / `table` / `status` 三种块，
       * 写别的会在注册期抛错，而错误信息只提"未知类型"，不会告诉你该用哪个。
       */
      {
        type: 'form',
        title: '说明',
        fields: [
          {
            path: 'how-it-works',
            label: '怎么工作',
            type: 'string',
            value: '收藏由模型自己判断：看到图觉得以后用得上就会存。要删就删目录里的文件，索引会自愈。',
          },
        ],
      },
    ],
  })
  ctx.effect(() => disposeTab)

  log(`qdash-neo-plugin-sticker: 已启动 目录=${dir} 现有 ${store.describe().count} 张`)
}
