# dsh-sidebar-browser-control

[![npm version](https://img.shields.io/npm/v/dsh-sidebar-browser-control?color=2563eb)](https://www.npmjs.com/package/dsh-sidebar-browser-control)
[![CI](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/actions/workflows/ci.yml/badge.svg)](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/LICENSE)
[![DSH](https://img.shields.io/badge/verified%20on-DSH%20Desktop%200.2.0--rc.2-4b5563.svg)](#兼容性)

**让 Agent 直接驱动 DSH 自带的内置浏览器**（右侧栏的「浏览器」tab），而不是再开一个 Chromium。

[English →](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/README.md)

```
你 › 在内置浏览器里打开文档页，告诉我 API 那一节讲了什么
AI › browser_control { action: "open", url: "https://example.com/docs" }
     browser_page   { action: "text" }
```

## 为什么不用 CDP / Playwright 方案

npm 上已有一个走 CDP 的 DSH 浏览器插件（`dsh-browser-control`）。本插件是它的**应用内对照物**，
差别就是价值所在：

| | 本插件 | CDP / Playwright 封装 |
|---|---|---|
| 驱动对象 | DSH 已经自带的那只浏览器 tab | 另起的浏览器进程 |
| 你在哪看到 | 右侧栏，就在会话旁边 | 另一个窗口 |
| 额外运行时 | 无 | 浏览器 + driver |
| 登录态 | 该 tab 已在用的工作区分区 | 你自己另外配 |
| 能力边界 | 只有这个 tab | 任意页面、无头、截图 |

想和 AI **一起看着同一个页面**做事，用这个；要无头自动化、下载、截图，用 CDP 方案。

## 能做什么

| 工具 | 动作 |
|---|---|
| `browser_tabs` | 列出内置浏览器已打开的标签：id、实时标题、URL、所属会话、面板状态、是否支持页面级控制 |
| `browser_control` | `open` · `navigate` · `back` · `forward` · `reload` · `close` · `focus` · `expand` · `collapse` · `fullscreen` · `split` · `float` · `dock` · `external` |
| `browser_page` | `text` · `links` · `elements` · `eval` · `click` · `type` · `scroll` · `wait`（**仅 Desktop**） |
| `/browser` | `open <url>` · `tabs` · `back` · `forward` · `reload` · `close` · `focus` · `expand` · `collapse` · `fullscreen` · `split` · `float` · `dock` · `external` · `read` |

工具和斜杠命令**共用同一份实现**，所以 `/browser open …` 不花模型轮次，行为与工具完全一致。

## 安装

它就是一个普通 DSH bundle，plugin manager 接受的任何 spec 都能用。

**从 npm 安装**（已发布为 `dsh-sidebar-browser-control`）。让 Agent 装，无需重启：

```
plugin_manager { action: install_bundle, target: "dsh-sidebar-browser-control" }
```

或用 CLI：

```sh
dsh plugin --profile desktop add dsh-sidebar-browser-control
```

**从 GitHub 安装**（想跟 `main` 分支时用）：

```
plugin_manager { action: install_bundle, target: "github:XUFENGCHINA/dsh-sidebar-browser-control" }
```

**从本地 checkout 安装**（开发用）：

```sh
dsh plugin --profile desktop add link:/绝对路径/到/本仓库
```

卸载：`plugin_manager { action: "remove_bundle", target: "dsh-sidebar-browser-control" }`。

本地开发时改完 `client.js` 要请 Host 重新扫描 bundle（`set_bundle` 关一次再开一次）——
客户端产物是按快照提供的，光改文件不会生效。

## 用法

直接说就行（右侧栏要有屏幕上的会话）：

- 「在内置浏览器打开 `https://news.ycombinator.com`，总结前 5 条」
- 「在内置浏览器里点 *Sign in*，告诉我表单要填什么」
- 「在内置浏览器用 Bing 搜 DeepSeek Harness，给我前三条结果」
- `/browser open https://example.com` —— 输入框直接敲，不经过模型

驱动它时值得知道的两条实际行为：

- **新窗口打开的链接会变成一个**新的侧栏标签**：DSH 把 popup 请求转成了独立的 tab。
  `browser_page click` 会把它报成 `opened_tab`/`opened_url`，请接着用那个 id——
  原标签仍停在原来的页面上。
- **加载失败的页面会明确报出来**：DNS、网络、证书、以及反爬挑战失败时，标签里是
  Chromium 错误页；页面级动作会明确说明这一点，而不是返回空内容让你误以为"页面是空的"。

## 工作原理

浏览器活在 Web 渲染进程里，工具活在 Host 进程里，而 DSH 没有面向第三方插件的
Host → Client 调用。于是插件拆成两半，用 4 条回环路由相连（Host → Client 走**长轮询**，
两个方向都没有定时轮询）；导航与布局全部走公开的 `ctx.sidebarRight`，
所以内置地址栏、历史、重启恢复逻辑始终是权威。

完整协议、设计取舍、以及它依赖的 DSH 内部细节见
[docs/architecture.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/docs/architecture.md)。

## 安全

`browser_page eval` 会在该 tab 的页面里执行任意 JavaScript，并带着那个页面的 Cookie——
你在里面登录过什么，Agent 就能以你的身份在那个 tab 里做什么。工具调用会连同参数进会话日志，
但请把这三个工具当作「允许对方看你的屏幕」来对待。4 条路由只放行 DSH 自身来源（跨站 CSRF 打不进来），
且只有本插件自己的工具能下发命令。细节见
[SECURITY.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/SECURITY.md)。

## 兼容性

已在 **DSH Desktop 0.2.0-rc.2 / Electron 44 / Windows x64** 上端到端实测：
列出、打开、导航、前进后退、刷新、读取正文、`eval`、列出元素、点击、输入并提交、
浮窗/停靠、关闭、展开/收起。Web profile 只能做标签与布局控制（sandbox iframe 读不到页面内容）。

插件只依赖公开服务（`ctx.sidebarRight`、`ctx.webServer`、`ctx.tools`、`ctx.commands`）
以及若干由随包 Sidebar 拥有的 DOM 标记。标记一旦变化，页面级动作会**明确报错**，
而标签与布局控制照常可用；依赖清单见
[docs/architecture.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/docs/architecture.md#dsh-internals-this-plugin-depends-on)。

## 已知限制

- **没有截图。** `webview.capturePage()` 在实测环境下让 Electron 渲染进程**原生崩溃**，
  因此该能力被移除，调用会明确拒绝并说明原因。证据与可行替代方案见
  [docs/architecture.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/docs/architecture.md#why-there-is-no-screenshot)。
- 页面级操作**仅 Desktop**。
- tab id 只在会话内唯一；重名时以 `<会话id>#<tabN>` 形式给出并接受。
- 动作为选择器式（无坐标点击、上传、下载），且作用于**屏幕上显示的会话**（`ctx.sidebarRight` 的语义）。

## 开发

无构建步骤、无依赖：`client.js` 就是交付产物，按 loader 的 classic-script 格式手写。

```sh
npm test        # 离线协议测试：stub context + 真实 HTTP + 假 Client 半
npm run verify  # 语法 + 协议测试 + 打包产物自足性检查
```

`npm test` 不需要运行中的 DSH，因此在 CI 和全新 checkout 上都能跑。
规范与「保证可加载」的几条硬约束见
[CONTRIBUTING.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/CONTRIBUTING.md)，
发布流程见
[RELEASING.md](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/RELEASING.md)。

## 许可

[MIT](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control/blob/main/LICENSE)
