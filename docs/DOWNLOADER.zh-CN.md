# 下载器 v0.1：真实文件与独立本地预览

这是 Issue #2 的下载子阶段，不是整个 G1、完整状态采集器或商城接入。
入口均已实现：`node tools/downloader/cli.mjs download|verify|preview|compare`。
可执行模式仅为自有精确环回 fixture。`authorized-public` 明确返回 blocked/3；
不能用 DNS 预检查或浏览器路由拦截冒充公共网页的强网络隔离。

## 1. 安装与固定测试依赖

Node 22+，本地和 CI 固定验证 Node 24.12.0；Python 3.13 用于 PR #5 fixture。
项目依赖及传递依赖由 `tools/downloader/package-lock.json` 固定。
浏览器仅使用 Playwright 1.55.0 / Chromium 140.0.7339.16，build 1187。
不选择系统 Chrome、不连接日常浏览器、不安装 OpenDesign 桌面平台。

在仓库根目录运行（PowerShell）：

```powershell
npm ci --prefix tools/downloader --ignore-scripts --no-audit --no-fund
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.replica/browsers'
node tools/downloader/node_modules/playwright/cli.js install chromium
git fetch origin
git worktree add --detach .replica/dependencies/fixture 66e30c9fa6fa5977f088c380e22838648399e2e1
node tools/downloader/cli.mjs --help
```

已有该依赖工作树时不重复创建。PR #5 固定 head
`66e30c9fa6fa5977f088c380e22838648399e2e1` 是只读测试依赖，下载分支基于 main，
不合并 PR #5、不复制其整套文件。运行态产品 JSON 位于独立临时目录。
启动器检查固定 head、已修改文件的实际 Git blob 字节与 fixture 自带清单。
PR #5 的通用 `text` 属性会将 TTF 误报为脏文件；仅当实际字节与固定 blob
完全一致时接受，不改其属性、不归一化二进制文件。

Linux CI 使用同一 lockfile、浏览器 build 和 fixture SHA；浏览器系统依赖只在
临时 CI runner 安装。Windows 不修改系统权限或全局 Python/Node 包。

## 2. 完整自有站验收：一次命令获得镜像

```powershell
node --test tests/downloader/unit.test.mjs
node tests/downloader/acceptance.mjs
Get-Content -Encoding UTF8 .replica/downloader-acceptance.json
```

验收程序启动原 PR #5 fixture，从单个 `/grid.html` 入口独立采集两次，
再停止源服务、确认它不可连接，启动不同 origin 的隔离预览并运行实际 DOM
断言。预期页面与 selector 仅在验收代码，不作为下载种子。
主下载目录是报告的 `primary_download`；第二份为 `repeat_download`。
报告 `status=complete` 才说明整套验收成功；外层同时验证子进程状态、退出码及
真实文件，不能靠 exit 0、空 JSON 或上传成功变绿。

## 3. 单独下载、验证与打开

先在终端 A 启动固定自有 fixture（保持终端/stdin 开启；Enter 或 EOF 停服）：

```powershell
python -B -X utf8 tests/downloader/serve_fixture.py --port 8765
```

终端 B 从一个入口下载，输出目录必须尚不存在：

```powershell
node tools/downloader/cli.mjs download --url http://127.0.0.1:8765/grid.html --public-get http://127.0.0.1:8765/data/products.json --viewport 1440x1000 --viewport 390x844 --har --out .replica/downloads/my-owned-run
node tools/downloader/cli.mjs verify .replica/downloads/my-owned-run
```

停止终端 A 的服务，再验证并在隔离 Chromium 中打开：

```powershell
node tools/downloader/cli.mjs verify .replica/downloads/my-owned-run --browser
node tools/downloader/cli.mjs preview .replica/downloads/my-owned-run --port 8124 --open
```

完整验收生成的主目录还含 `reports/approved-preview-checks.json`，可重放其
菜单、筛选、跳转、字体和懒加载检查：

```powershell
$r = Get-Content -Encoding UTF8 .replica/downloader-acceptance.json -Raw | ConvertFrom-Json
node tools/downloader/cli.mjs verify $r.primary_download --browser --checks (Join-Path $r.primary_download 'reports/approved-preview-checks.json')
node tools/downloader/cli.mjs preview $r.primary_download --port 8124 --open
node tools/downloader/cli.mjs compare $r.primary_download $r.repeat_download
```

可打开路径为 `/grid.html`、`/lazy.html`、`/filters.html`；菜单链接保持这些
原路径。`preview` 前台运行，Ctrl+C 停止。服务停止后重新运行以上命令。
`--open` 打开全新、非持久的 Chromium context，通过只允许预览 origin 的代理
和浏览器拦截器运行；不要将未经审查的镜像脚本直接放进日常登录浏览器。

本地文件采用安全散列名，`site/route-map.json` 提供原路径与 query 的虚拟映射。
必须使用本工具的 `preview`，不能用普通目录服务器代替该 query/路由映射。
它不是在线源站代理，也不是业务 API 回放服务。

## 4. 策略和状态

`--policy examples/downloader.policy.example.json` 读取完整策略。
CLI 可覆盖 `--page-origin`、`--asset-origin`、`--public-get`（可多次）、
`--max-pages`、`--max-depth`、`--viewport`、`--timeout`、`--budget`、`--har`。
策略支持显式 `readySelector` 和获准的 `states[].actions`（scroll/hover/click），
每个状态独立新 page，同一采集 context；不自动发现或盲点按钮。

默认单页串行，25 页、深度 2。origin 必须是完整协议、IP 和端口，不笼统允许
localhost 的任意端口。页面和资源 allowlist 分离。XHR/fetch 只有精确列入
`publicGetFixtures` 的公开 GET URL 可捕获和本地服务；拒绝所有写请求。
采集浏览器不携带既有 cookie/profile；代理移除认证和 cookie 请求头。

| 状态 | 退出码 | 含义 |
| --- | ---: | --- |
| complete | 0 | 本次批准策略内已发现页面处理完毕，文件与映射完整；交互能力仍需 browser verify 的实测范围证明。 |
| partial | 2 | 有页面成功，但仍有待处理页面、依赖缺口、资源失败或响应变体冲突。 |
| failed | 1 | 无页面成功、输入/输出目录非法、验证失败或运行错误。 |
| blocked | 3 | 公共网页模式缺少强网络隔离，或采集中发现认证/挑战阻塞。 |

`verify` 对 partial/blocked/failed 制品返回非零；`preview` 默认拒绝这些制品。
达到页数、深度或总预算不等于“全站成功”。`compare` 同时检查两次产物本身、
策略、浏览器/适配器版本和资源/路由内容，不把实质差异当作元数据忽略。

## 5. 产物职责与安全边界

| 路径 | 内容 |
| --- | --- |
| manifest.json | schema、run/session、策略和源代码摘要、版本、状态、计数、失败和能力限制。 |
| routes.json | 自动发现的路由、来源、深度及 visited/excluded/failed/pending 原因。 |
| resources.json | URL、GET、实际响应 URL、MIME、HTTP 状态、原始和本地 SHA、文件路径、视口/状态观察及引用。 |
| raw/ | 本次浏览器实际收到的响应体，内容寻址保存，不被本地化覆盖。 |
| pages/ | 逐路由/视口/批准状态的运行后 HTML、CSS/布局/字体/图片信号与真实截图。 |
| site/ | 本地化预览文件与虚拟路由表；保留原始 HTML 的客户端脚本，不对运行后 DOM 再次启动原脚本。 |
| reports/ | 下载、结构验证、本地预览、实际请求/断言、截图与引用缺口。 |
| network/ | 仅启用时产生真实 Playwright HAR（full/embed）；敏感，默认不上传。 |

优先保存同次浏览器收到的 body，关闭 context 前等待所有捕获任务；不二次 GET，
不自动补抓，不重放 POST。query 不排序、不删除；文件名用完整 URL 和内容摘要，
避开 Windows 大小写、保留名和路径穿越。不同响应体保留不同文件并标冲突。
HTML、srcset、CSS url()/@import 使用解析器改写；未获取的响应式候选明确报告。
浏览器容忍而严格 CSS 解析器不接受的语法通过容错解析器恢复，并记录警告。

preview 只通过已验证的 `site/` 映射服务文件，绑定 127.0.0.1；拒绝路径穿越、
符号链接/硬链接、错误 Host 与写方法，不暴露 raw/network/仓库根，不代理源站。
响应带 CSP、禁止表单/iframe/object/worker、禁止外源连接等限制。
这是自有 fixture 的本地防护，不是针对任意恶意网站的操作系统级沙箱；
`authorized-public` 仍 blocked，尚不提供 DNS rebinding 防护的公共运行环境。

## 6. 固定验收与复用清单

A–H 均调用正式 download/verify/preview 逻辑：单入口三页、真实文件和校验、
断源双视口交互、query/嵌套 CSS/空格中文 URL、404/损坏/越界/预算反例、
两次核心摘要比较、缺文件/哈希/空对象/内部 failed 但退出 0 的拒绝，以及真实 HAR。
小型 edge fixture 只提供边界 HTTP 响应，未替换或重写 PR #5 测试站。

上游固定 `nexu-io/open-design@1b47e60bd46641469fcd8b69c496c4e3a548bc28`。
执行复用来自 route-crawl 的 collectPage、recon-site 的 collectSignals、
asset-harvest 的 classify、mirror-site 的受限滚动序列及 network-capture 的
响应体采集。完整变更说明、保留许可及被审阅原文件摘要位于
`tools/downloader/vendor/open-design/`；未接入系统浏览器/CDP loader。

哈希路由、iframe、Shadow DOM、Canvas、任意服务端业务、未批准交互和运行时
计算的跨源 URL 不保证支持。必要依赖缺失明确失败；截图仅供人工核对，不是
逐像素视觉评估器。没有 WordPress/WooCommerce、商城、调度平台或生产操作。
素材使用授权独立于下载脚本许可。

## 7. CI、升级与回滚

新增 downloader job 只读权限，Actions、npm lockfile、Node 与 fixture SHA 固定。
执行同一下载—断源预览—验证链；失败不因证据上传成功而被覆盖。
证据收集只复制自有 fixture 的脱敏结构化报告与必要截图，保留 7 天；
raw、site、HAR、字体文件及第三方素材不上传，全部运行产物默认被 Git 忽略。

本次为独立可选 Node 模块，原 Python 控制层接口及旧门禁不变。新项目按以上
步骤安装；现有项目不会自动升级。回滚只需停止预览，回退本 PR 的提交并移除
由操作者确认属于本工具的运行目录；工具不递归删除用户传入的目录。
CI/采集边界的变更需要维护者审阅，不自动合并或关闭 Issue #2。
