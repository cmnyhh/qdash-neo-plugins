# qdash-neo-plugins

[qdash-neo](https://github.com/cmnyhh/qdash) 的官方插件。

## 插件

### qdash-neo-plugin-voice

把文字合成语音（TTS）。三种接口形式、按内容与音色缓存、失败时降级为文字。

```bash
npm i qdash-neo-plugin-voice
```

它只负责产出一个音频文件——发送、路径校验、体积体检、频率限流、`[语音] xxx` 落库
仍由主包完成。不装它时主包的语音功能照常可用（发语音库里现成的音频）。

配置示例见 [`packages/qdash-neo-plugin-voice/README.md`](packages/qdash-neo-plugin-voice/README.md)。

## 写自己的插件

先读 [插件开发规范](docs/plugin-development.md)。

**建议从 §0.1「现在到底能用什么」看起**——它列出了哪些能力真的实现了、哪些还是设计稿。
照设计稿写会撞空：`outbox.sendText(...)` 这类方法在代码里不存在。

现在可用的能力面：

| 能力 | 用途 |
|---|---|
| `console.registerTab()` | 声明式选项卡（状态卡 / 表格 / 表单 / 按钮） |
| `tools.register()` | 给模型注册工具 |
| `settings.register()` | 运行时配置（用户能在控制台改，立即生效） |
| `storage.forFeature()` | 键值存储（只给 KV，不给建表） |
| `storage.dir()` | 插件自己的目录，跟着 `DSH_HOME` 走 |
| `judgeApi.registerProvider()` | 在判定链里插一段自己的判定 |
| `voice.send()` | 发语音（走主包的完整检查链） |

## 许可

MIT
