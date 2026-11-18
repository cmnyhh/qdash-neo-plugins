/**
 * `index.js` 的**装配检查**（不是行为测试）。
 *
 * 真正的行为要在 DSH 里跑，但装配错误（漏挂 `ctx.effect`、工具名拼错、
 * 忘打启动日志）能在静态层面查出来 —— 而这几类恰好是"装上去没反应、
 * 日志里又看不出为什么"的主要来源。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js')
const code = readFileSync(SRC, 'utf8')

test('装配：有启动日志（不然「没加载」和「加载了没生效」分不清）', () => {
  assert.match(code, /console\.log\('qdash-neo-plugin-coc: 已加载'\)/)
})

test('装配：inject 只有 qdashNeo', () => {
  const m = /export const inject = (\[[^\]]*\])/.exec(code)
  assert.ok(m, '要声明 inject')
  assert.equal(m[1].replace(/\s+/g, ''), "['qdashNeo']")
})

test('装配：name 与包名一致', () => {
  assert.match(code, /export const name = '@cmnyhh\/qdash-neo-plugin-coc'/)
})

test('装配：七个工具都在，且都用 owner: NS', () => {
  const names = [...code.matchAll(/name: '((?:qq_coc_)[a-z]+)'/g)].map(m => m[1])
  assert.deepEqual(
    [...new Set(names)].sort(),
    ['qq_coc_art', 'qq_coc_check', 'qq_coc_combat', 'qq_coc_log', 'qq_coc_roll', 'qq_coc_scene', 'qq_coc_sheet'],
  )

  for (const n of new Set(names)) {
    const block = code.slice(code.indexOf(`name: '${n}'`))
    assert.match(block.slice(0, 400), /owner: NS/, `${n} 要用 owner: NS`)
  }
})

test('装配：每个注册都挂在 ctx.effect 上', () => {
  const registers = (code.match(/neo\.tools\.register|neo\.instructions\.register/g) ?? []).length
  const effects = (code.match(/ctx\.effect\(/g) ?? []).length
  assert.ok(effects >= registers, `注册 ${registers} 处，但 ctx.effect 只有 ${effects} 处`)
})

test('装配：不直接 import 内核内部模块（只能走 ctx.qdashNeo）', () => {
  assert.doesNotMatch(code, /from '\.\.\/\.\.\/src\//, '不能越过门面去 import 内核源码')
  assert.doesNotMatch(code, /neo\.client/, '不能碰 client')
})

test('装配：订阅了 inbound 与 outbound 两个事件', () => {
  assert.match(code, /on\('message\/inbound'/)
  assert.match(code, /on\('message\/outbound'/)
})

test('装配：不 import schemastery 之外的外部依赖', () => {
  const imports = [...code.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
  for (const spec of imports) {
    assert.ok(
      spec.startsWith('./') || spec === '@deepseek-ai/schemastery',
      `不该依赖 ${spec}`,
    )
  }
})

test('装配：控制台选项卡走 renderTab + ctx.effect（快照要能刷新）', () => {
  assert.match(code, /neo\.console\.registerTab/, '要注册选项卡')
  /**
   * 选项卡是注册那一刻的快照。如果只在 `ctx.effect` 里注册一次，
   * 页面上的"已开团 N 个"就永远停在启动时那个数。
   */
  assert.match(code, /ctx\.effect\(\(\) => \{\s*renderTab\(\)/, '要经 renderTab 才能刷新')
  assert.match(code, /dispose\(\)|tabDispose\?\.\(\)/, '重注册前要 dispose 旧的')
})

test('装配：表单的 run 必须写在 submit 里', () => {
  /**
   * **内核只从 `block.submit.run` 填充 actions 表**，
   * 顶层 `actions: { save }` 一行都不会被读。
   *
   * 写错的症状是点保存报「选项卡「coc」没有动作：save」，
   * 而插件侧看不出任何异常 —— 函数确实传了，只是传错了地方。
   * 这条断言就是防这个回潮。
   */
  // 窗口放宽到 800 字符：submit 里夹着大段注释，300 不够
  assert.match(code, /submit: \{\s*id: 'save',[\s\S]{0,800}?run: async/, '保存按钮要带 run')
  assert.match(code, /submit: \{\s*id: 'saveImage',[\s\S]{0,800}?run: async/, '生图保存也要带 run')

  // 顶层那张表不会被读，出现就是错的
  assert.doesNotMatch(code, /^\s{6,10}actions: \{\s*$/m, '不要写顶层 actions —— 内核不读它')
})
