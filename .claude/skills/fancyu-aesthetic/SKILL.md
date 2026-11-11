---
name: fancyu-aesthetic
description: FancyU（中意你）站点统一审美规范 —— 以首页 index.html / home.css 为唯一标准。改任何页面前先读本文件；新增或重写页面必须套用 web/fancyu.css 的 .fu-* 结构。Use when building, restyling or reviewing any page of the sysudate/FancyU web app.
---

# FancyU 首页审美 skill

**唯一标准是首页**：`web/index.html` + `web/home.css`（`.homepage` 层）。
其它页面长什么样，一律向首页看齐；不要发明第二套配色或字重。

## 1. 落地方式（不用改框架，不用引组件库）

```html
<html lang="zh-CN" data-ui="fancyu">
<head>
  <link rel="stylesheet" href="fancyu.css?v=1">   <!-- 唯一共享样式表 -->
  <style>/* 只放首页不提供的排版细节，颜色/字号继续用 var(--fu-*) */</style>
</head>
<body>
  <svg ...><symbol id="leaf"/></svg>              <!-- 品牌标记，见下 -->
  <header class="fu-header fu-wrap">…</header>
  <main class="fu-main">…</main>
  <footer class="fu-footer">…</footer>
</body>
```

`web/fancyu.css` 里所有规则都挂在 `[data-ui="fancyu"]` / `.fu-*` 上，
所以只要 `<html data-ui="fancyu">` 就生效，**不会污染还没迁移的旧页面**。
新页面必须 `data-ui="fancyu"`；已迁移页面保留它。

## 2. 设计令牌（改颜色只改这里）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--fu-paper` | `#faf9f5` | 页面底色（暖象牙白），body 上再叠一层极淡暖色径向光 |
| `--fu-paper-2` / `--fu-card` | `#f4f6ef` | 次级底色 / 卡片基色 |
| `--fu-card-grad` | `linear-gradient(120deg,#f6f8f1,#f8f7f0)` | 卡片背景（必须用渐变，不是纯白） |
| `--fu-ink` | `#073b32` | 主文字（深墨绿），**不要用纯黑** |
| `--fu-ink-2` | `#173d2c` | 次级正文 |
| `--fu-muted` / `--fu-muted-2` | `#55726a` / `#84968c` | 次要 / 更弱文字 |
| `--fu-line` | `#dedfd6` | 发丝线（表头分隔、页脚上边框、1px 通栏） |
| `--fu-line-2` | `#cad8c8` | 卡片描边（1px） |
| `--fu-pill` / `--fu-block` | `#e5ebdf` / `#e4ebe0` | 胶囊标签 / 浅色提示块 |
| `--fu-green` → `--fu-green-deep` | `#265a48` → `#00362f` | 主按钮绿渐变 `--fu-green-grad` |
| `--fu-danger` / `--fu-danger-soft` | `#a6372d` / `#fbefec` | 错误、失效徽章 |
| `--fu-serif` | `"Noto Serif SC","Songti SC","SimSun",serif` | **所有大标题** |
| `--fu-sans` | `Inter,"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui` | 正文 |
| `--fu-radius` / `-sm` / `-pill` | `20px` / `14px` / `999px` | 卡片 / 输入框·提示块 / 按钮·徽章 |
| `--fu-wrap` | `min(1468px,calc(100% - 12%))` | 内容宽度（手机端自动变 `100% - 32px`） |

## 3. 排版规则（最重要的三条）

1. **大标题 = 衬线 + 900 字重**：`.fu-title{font-family:var(--fu-serif);font-weight:900;font-size:clamp(34px,3.4vw,52px)}`。
   正文、按钮、表单用无衬线。衬线只给「标题 + 价格数字 + ok 状态」，用多就不高级了。
2. **标题区三段式**：`.fu-eyebrow`（小字眉标，自带 48px 发丝线）→ `.fu-title` → `.fu-sub`（19px `--fu-muted` 说明）。
   任何内容页都从这三件套开始，不要一上来堆卡片。
3. **字色只用令牌**：正文 `--fu-ink`，说明 `--fu-muted`；禁止 `#000`、`#333`、`#666` 硬编码（旧页面遗留的 `#f5f5f5`/`#00552E` 属于未迁移，改到哪页就删哪页）。

## 4. 页面骨架配方（复制即用）

```html
<header class="fu-header fu-wrap">
  <a href="/" class="fu-brand" aria-label="FancyU 中意你首页">
    <svg><use href="#leaf"/></svg><span>FancyU · 中意你</span>
  </a>
  <nav class="fu-nav" aria-label="页面导航">
    <a href="/">首页</a>
    <a class="fu-back" href="/dashboard">← 返回用户中心</a>
  </nav>
</header>

<main class="fu-main">
  <p class="fu-eyebrow">账户</p>
  <h1 class="fu-title">支付中心</h1>
  <p class="fu-sub">一句话说明这页干什么。</p>

  <section class="fu-card" aria-labelledby="x">
    <div class="card-head"><h2 id="x">选择商品</h2><span class="muted">补充说明</span></div>
    <div class="fu-list">…</div>
  </section>

  <div class="fu-grid">…两列卡片，自动响应式…</div>
</main>

<footer class="fu-footer">
  <a href="/" class="fu-brand" style="font-size:17px"><svg style="width:25px;height:28px"><use href="#leaf"/></svg><span>FancyU · 中意你</span></a>
  <nav aria-label="网站说明">
    <a href="/">关于我们</a><a href="/terms">用户条款</a><a href="/dashboard">用户中心</a>
  </nav>
</footer>
```

品牌标记（每页内联一次，放 `<body>` 开头）：

```html
<svg class="symbols" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
  <symbol id="leaf" viewBox="0 0 32 32"><path d="M15 28C16 18 10 10 3 6c-1 11 3 16 12 15" fill="currentColor"/><path d="M16 24C15 11 21 5 29 3c1 12-4 19-13 21" fill="#78977D"/><path d="M16 30V20" stroke="currentColor" stroke-width="1.5"/></symbol>
  <symbol id="cap" viewBox="0 0 32 32"><path d="m2 11 14-7 14 7-14 7L2 11Zm5 3v9c6 4 12 4 18 0v-9M29 13v11"/></symbol>
  <symbol id="gift" viewBox="0 0 32 32"><path d="M5 14h22v14H5zM3 9h26v6H3zM16 9v19"/><path d="M16 9C5 10 6 1 10 2c4 0 6 7 6 7Zm0 0C27 10 26 1 22 2c-4 0-6 7-6 7Z"/></symbol>
</svg>
```

## 5. 组件清单

- 卡片 `.fu-card`（渐变底 + 1px `#cad8c8` + 20px 圆角 + `28px 30px` 内边距）；标题 `.fu-card>h2` 衬线 26px。
- 两列自适应 `.fu-grid`（`auto-fit,minmax(280px,1fr)`，gap 22px）。
- 列表 `.fu-list > .item`：左侧 `.t`（19px 700）/ `.d`（14px muted），右侧 `.price`（衬线 900，22px）+ 操作按钮；行间 1px `#dde5da`，首行去上边距、末行去下划线。
- 按钮：普通 `.fu-btn`（白底深绿描边，hover 反色）；主操作 `.fu-btn.primary` 或 `button.primary`（绿色渐变 + 999px 胶囊）；圆形 `.fu-btn-round`（47px）。
- 标签 `.pill` / 徽章 `.badge`，失效用 `.badge.expired`（`--fu-danger-soft` 底 + `--fu-danger` 字）。
- 状态：`.ok`（衬线 900 绿）、`.err`（红 600）、`.muted`、`.fu-empty`（空态灰字）、`.fu-note`（浅色块提示）、`.fu-paybox`（支付/结果区，居中）。
- 表单：`.fu-field`（label + 控件），input/select/textarea 已全局接管（`#fcfdf9` 底、`#b7ccb9` 描边、12px 圆角、16px 字号）。
- 弹窗：`<dialog>` 全局已美化（暖白底 + 20px 圆角 + 毛玻璃遮罩），不要再自造遮罩层。

## 6. 硬性约束

- **手机触控目标 ≥ 44px**：`[data-ui="fancyu"] button` 已有兜底，自己写控件时也要满足。
- **不能有横向滚动**：`overflow-x:clip` 在 body 上；新增全宽元素（通栏 1px 线用 `.fu-header:after` 的 `left:calc((100vw - 100%)/-2)` 写法）必须复核。
- **响应式断点只有 760px**（首页同款）：760 以下收窄 wrap、缩小标题、列表右侧操作改纵向排列。
- **改 `web/` 即时生效**；改 `api/*.js` 必须 `supervisorctl -c ~/deploy/supervisord.conf restart sysudate`。
- **修样式别动 JS 契约**：迁移页面时保留原有的 id / class（如 `pay.js` 依赖 `#items #paycard #ents #orders`、`.item .t .d .price .badge .paybox .ok .err`），结构美化了但选择器不能变。
- 静态资源换版用 `?v=N` 查询串（脚本 URL 固定，不加版本号会被浏览器缓存卡住）。
- **URL 不带 `.html`**：`/pay`、`/login` 这类干净地址由 `api/index.js` 兜底 —— `/xxx` → 渲染 `web/xxx.html`；`/xxx.html` → `302` 到 `/xxx`（保留查询串）；`/index.html` → `/`。页面内部链接**直接写干净地址**（`href="/pay"`、`href="/"`），不要再写 `.html`（旧链接仍可用，只是多一跳）。
- **一级/二级层级**：`api/index.js` 里有一张**显式路由表** `PAGES2`（`'admin/pay' → 'admin-pay.html'`）+ `FLAT2HIER`（旧一级 `/admin-pay` → `302 /admin/pay`）。新增二级页面：往两张表各加一行，文件名 `<一级>-<名>.html`，内部链接写 `/一级/名`。**别用 `<组>-<名>` 猜**：后端另有裸 `/admin/*` API 命名空间（`/admin/chat-reports`、`/admin/users` …），撞名会被 API 抢走 —— 所以聊天举报页的二级地址是 `/admin/reports`（文件仍叫 `admin-chat-reports.html`）。表外的一级地址不受影响（`/weekly-match`、`/forgot-password` 照旧）。
- **改 `api/*.js` 后重启**：`kubectl -n clouds exec <pod> -- su - cloud -c '/home/cloud/.local/bin/supervisorctl -c /home/cloud/deploy/supervisord.conf restart sysudate'`。

## 7. 迁移一个旧页面的步骤

1. 读该页 `head` 与结构，列出它依赖的 id / 全局函数（`auth-session.js`、页面自己的 `.js`）。
2. `<html data-ui="campus">` → `data-ui="fancyu"`；删掉 `campus-ui.css` 与页面私有 `<style>` 里的配色（背景、卡片、按钮、字色）。
3. 加 `<link rel="stylesheet" href="fancyu.css?v=1">`，套第 4 节骨架（header/main/footer），正文改 `.fu-card` / `.fu-list` / `.fu-grid`。
4. 页面私有 `<style>` 只留首页没有的排版（如 `.card-head` 两端对齐、某列 `white-space:nowrap`）。
5. 用第 8 节脚本自查；桌面 1280px + 手机 390px 各跑一遍。
6. 提交时**只 add 显式路径**（仓库有并发编辑者，绝不 `git add -A`）。

## 8. 验证清单（Playwright，宿主机 python3）

```python
from playwright.sync_api import sync_playwright
for w in (1280, 390):
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={"width": w, "height": 900})
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("https://ssemarket.cn:23028/<page>", wait_until="networkidle")
        assert not pg.evaluate("document.documentElement.scrollWidth>window.innerWidth+1"), "横向溢出"
        print(w, "overflowX ok", errs); b.close()
```
- 需要登录/带数据的页面：`page.route("**/api/**", ...)` 打桩返回 mock JSON。
- 通过标准：**无横向滚动、无 pageerror、关键内容已渲染**（如 `items rows: 3`）。
- 已迁移页面清单：`index.html`（标准本身）、`pay.html` ✅、`profile.html` ✅、以及 21 个 `data-ui="campus"` 页面（共享 `web/campus-ui.css` 已对齐首页标准）。

## 9. 反面例子（不要这么写）

- 通栏绿色渐变 header + 纯白卡片 + `box-shadow:0 2px 8px rgba(0,0,0,.1)`（旧 `dashboard.html` 风格）。
- `body{background:#f5f5f5}`、`.card h2{color:#00552E}`、价格用 `#e4393c`。
- 同页混用两套绿色（`#00552E` 与 `#006b3c` 与 `#073b32`）。
- 大标题用无衬线粗体、正文用衬线。
- 用 `!important` 覆盖共享样式表，而不是把类换成 `.fu-*`。
