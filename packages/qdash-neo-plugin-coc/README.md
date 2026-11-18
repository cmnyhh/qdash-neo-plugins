# @cmnyhh/qdash-neo-plugin-coc

COC 7 版跑团插件：机器人当守秘人（KP）带团。

## 它做什么

- **骰子与检定**：`3d6`、`2d6+3`、`1d6+1d4`；d100 技能检定自动判六档（大成功／极难／困难／普通／失败／大失败），支持奖励骰与惩罚骰
- **角色卡**：一次成型生成九项属性，自动算 HP／MP／SAN／MOV／伤害加成／体格／技能点
- **剧情存档**：当前场景、线索、NPC、时间线
- **战斗回合**：按敏捷排先攻、逐轮推进、扣血扣理智
- **跑团记录**：逐条写入 JSONL，可回顾、可导出 Markdown
- **插图**：可接外部生图服务画头像与场景（**不配也能用**）

## 装

```bash
pnpm add @cmnyhh/qdash-neo-plugin-coc
```

挂载后在控制台「工具」页授予插件，在「引导」页授予它的常驻引导 —— **两处都要点**，只授工具的话模型不知道什么时候该用。

## 生图（可选）

`cordis.patch.yml` 里留了空位，填上就能用：

```yaml
- insert:
    - id: qdash-neo-plugin-coc
      name: '@cmnyhh/qdash-neo-plugin-coc'
      config:
        image:
          endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img'
          apiKey: ''
          protocol: 'sdapi'
```

三种协议：

| protocol | 接口形态 |
|---|---|
| `openai` | `POST /v1/images/generations`，返回 `data[0].b64_json` 或 `url` |
| `sdapi` | SD WebUI 的 `/sdapi/v1/txt2img`，返回 `images[]`（base64） |
| `custom` | 按 `endpoint` 原样 POST，用 `resultPath` 取 base64 或图片 URL |

**不填就完全不画图**，建卡和切场景照常完成，不报错、不刷日志。

服务器没有 GPU 的话，本地跑推理不现实（模型动辄 4G 显存起），建议指向局域网里另一台机器。

## 两种模式

模式是**这一局**的属性，开团时定：

```
qq_coc_scene({ act: 'new', title: '谁在敲墙', mode: 'narrative' })
```

| 模式 | 插件返回 | 群里看到 |
|---|---|---|
| `classic`（默认） | 完整数据 + 一行可转述文案 | 骰点 + 叙事 |
| `narrative` | 完整数据 + 「别提数字」的提示 | 纯叙事 |

**仿真模式下插件仍然把数字给模型** —— 它要靠数字推算后续（剩多少血、困难阈值多少）。只是明确告诉它别往群里说。

## 记录

写在 `<DSH_HOME>/qdash-plugins/coc/log/<会话>-<场次>.jsonl`，一行一条：

```json
{"ts":1793583468460,"kind":"check","who":"草莓","skill":"侦查","value":34,"level":"hard"}
{"ts":1793583469000,"kind":"in","who":"草莓","text":"我下去看看"}
{"ts":1793583471000,"kind":"out","text":"你顺着台阶下去，空气里有铁锈味…"}
```

`in` 来自 `message/inbound`，`out` 来自 `message/outbound`（主框架 2026-11 新增的事件）。

**开新团会开新文件**，旧的留档，不删。

## 不做

- 逐步问答式车卡（建卡一次成型，之后靠改卡）
- 规则书全文检索（规则知识靠模型自己）
- 跨会话共享角色卡（群里那场团，在私聊里查不到别人的卡）
