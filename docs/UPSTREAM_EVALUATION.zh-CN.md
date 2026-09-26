# 开源模块调研、复用选型矩阵与可执行 Spike 报告

> **环境与角色**：Antigravity E — Framework Maintainer  
> **分支**：`spike/upstream-reuse-poc`（标记：`EXPERIMENTAL`）  
> **审查基准**：`origin/main` (`d1a2d6e`)  
> **核心原则**：复用优先、禁止重复造轮子、仅补必要适配层与独立门禁验收、不以自我优化为由突破网络与安全边界。

---

## 一、调研背景与复用优先级规则

在 WordPress / WooCommerce 高保真复刻平台建设中，底层能力的开发遵循以下优先级阶梯：

```text
本仓库已有模块 → 已安装依赖 → 上游官方库/标准 API → 有合规许可证的源码子集/固定 fork → 最小必要自研适配
```

本轮调研对 6 个目标开源项目进行了深度源码与架构审查，明确区分以下复用类型：
- **`RUNTIME_REUSED`**：在正式执行路径中直接 import / 调用的上游模块；
- **`EXPERIMENTAL_SPIKE`**：在独立实验分支中验证可行性并提供真实调用的 PoC 依赖；
- **`REFERENCE_ONLY`**：仅阅读架构设计、行为逻辑或数据模型，不引入其运行态代码；
- **`REJECTED`**：因许可证冲突、依赖沉重、违反网络边界或产物不可用而明确拒绝的候选。

---

## 二、六大候选开源项目深度评估矩阵

| 候选项目 | 许可证 / NOTICE | 固定版本 / Commit | 具体上游模块 / 函数 | 可直接复用的能力 | 需要的适配 | 已知限制 | 选择 / 拒绝依据与复用类型 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. microsoft/playwright** | Apache-2.0 | `1.55.0` (当前环境) | `chromium.launch`, `BrowserContext`, `Page`, `Route` (`page.route`), `Locator` (`waitFor`, `click`, etc.) | 浏览器底层驱动、CDP 通信、网络请求精确拦截、页面事件监听、确定性视口渲染与整页截图 | 统一代理网关、网络守卫路由规则、资源白名单过滤 | 属于底层驱动，不自带状态队列、去重策略或抓取生命周期调度 | **`RUNTIME_REUSED`**<br>核心浏览器自动化底座，完全复用官方标准 API，绝不自研浏览器驱动。 |
| **2. apify/crawlee** | Apache-2.0 | `@crawlee/core@3.18.1` | `RequestQueue`, `RequestQueue.open`, `addRequest`, `fetchNextRequest`, `markRequestHandled`, `Configuration` | 请求队列磁盘持久化、断点恢复（`purgeOnStart: false`）、全局去重、深度优先 / 广度优先调度 | 构建复合 `uniqueKey`（`URL + state_id + viewport`）以防状态被错误归一化抹平；剥离其自带的默认下载网络，仅使用其队列引擎驱动 Playwright | 默认 `uniqueKey` 仅基于 URL 归一化，会误将同 URL 的不同交互面板去重；其高级爬虫包含指纹模拟和代理轮换 | **`EXPERIMENTAL_SPIKE`**<br>许可证友好（Apache-2.0），模块化程度高，可单独提取 `RequestQueue` 解决抓取队列持久化与中断恢复。本轮已完成可执行 Spike。 |
| **3. gildas-lormeau/SingleFile** | **AGPL-3.0-or-later** | `single-file-core@1.6.15` | `single-file-core` (`getPageData`, `processStylesheets`, etc.) | 将已完成交互突变的当前 DOM 树、内联 CSS、字体及图片内联为单文件 HTML 快照 | 需以子进程 CLI 方式隔离执行；剥离网络拉取，仅读取本地已有缓存素材，避免二次外链请求 | **许可证为强传染性 AGPL-3.0**；产物为 Base64 内嵌单文件，不提供独立的组件模板、CSS 类分离或原始资源目录，无法直接交付给 WordPress 开发 | **`REFERENCE_ONLY`**<br>许可证存在合规分发风险；单文件快照适合作为衍生可查看预览件，不能替代独立的页面和原始资产清单。 |
| **4. webrecorder/browsertrix-crawler** | **AGPL-3.0-or-later** | `main` | Docker 容器编排、Screencast、WACZ 归档引擎 | 完整全站自动化爬取、多容器协作、WACZ/WARC 标准数字档案生成 | 需要完整的 Docker 守护进程与独立网络环境；无法轻量嵌入 Node.js CLI 工具链 | **AGPL-3.0 许可证**；环境依赖极其沉重；输出为不可直读的二进制 WACZ 归档包，而非 WordPress 开发者需要的 HTML/CSS/PHP 模板与干净资产文件 | **`REJECTED`**<br>偏离商用二次开发与轻量 CI/CD 目标，环境侵入性过大，生成物不可开发。 |
| **5. webrecorder/browsertrix-behaviors** | **AGPL-3.0-or-later** | `browsertrix-behaviors@0.14.1` | `autoscroll`, `clickElements`, `expandMenu` 等行为脚本 | 自动寻找页面中的“加载更多”、“展开二级菜单”、“无限滚动”并执行试探性点击与等待 | 需在页面上下文中注入；需要重写其选择器启发式算法以符合合同预期 | 启发式穷举缺乏可预测性，容易陷入无限点击或误触离开页面；**AGPL-3.0 许可证限制**；无法提供 `restores_state` 不变量验证 | **`REFERENCE_ONLY`**<br>可借鉴其滚动与延迟加载等待逻辑，但不直接引入其运行代码，交互状态必须坚持显式合同声明。 |
| **6. nexu-io/open-design (子集)** | MIT / Apache-2.0 | `1b47e60bd46641469fcd8b69c496c4e3a548bc28` (已固定) | `route-crawl.mjs` (`collectPage`), `recon-site.mjs` (`collectSignals`), `mirror-site.mjs` (`boundedScroll`) | 页面链接提取、计算样式提取、响应式图片信号采集、有边界的视口动态滚动 | 已完成框架适配：剥离其外部下载器与未授权 CLI，只复用其纯解析与信号采集函数，受框架 Network Guard 严格约束 | 上游部分文件依赖桌面环境或 CDP daemon，已在引入时被完全排除 | **`RUNTIME_REUSED`**<br>已完成固定 Commit 和 SHA-256 审计，保留版权与 NOTICE，在当前 Downloader 中正常运行。 |

---

## 三、五大关键架构问题专门核对

### 1. 哪个模块适合链接发现、队列持久化与恢复？
* **结论**：`apify/crawlee` 的 `@crawlee/core` (`RequestQueue`)。
* **原因**：
  - 原生支持磁盘存储（`CRAWLEE_STORAGE_DIR`），可安全地跨进程、跨任务保存队列状态。
  - 通过 `purgeOnStart: false` 即可无缝实现断点恢复，无需自研复杂的 SQLite/JSON 文件队列锁机制。
  - 具备清晰的 `fetchNextRequest()`、`markRequestHandled()` 和 `getInfo()` 生命周期 API。
  - Apache-2.0 许可证，无商业分发法律隐患。

### 2. 哪个模块适合保存已打开弹窗的当前页面？
* **结论**：Playwright `page.content()` + 组件级 DOM 抽取（配合现有 `state-handoff` 引擎）；SingleFile 可作为衍生的“只读全页离线快照”。
* **特别强调**：
  - 保存当前已突变的 DOM **不等于** 自动探测并找到了所有潜在状态。
  - 真正的状态交付必须依赖**显式状态合同**（Preconditions -> Actions -> PostAssertions -> `restores_state`）。
  - 单纯的静态 HTML 快照丢弃了事件绑定与交互逻辑，不能冒充“交互重放”。

### 3. 哪个能输出原资源与可复用 HTML，而不只是截图/WACZ？
* **结论**：本仓库现有的 Downloader 架构 + `open-design` 提取逻辑。
* **原因**：
  - Browsertrix 输出的是 WACZ/WARC 二进制归档，无法拆分为 `assets/css`、`assets/images` 等独立文件；
  - SingleFile 输出的是内联了所有资源的巨大 HTML（包含数兆的 Base64 字符串），完全不具备二次拆解开发 WooCommerce 主题的可用性；
  - 只有受控 Downloader 能同时输出：**原始哈希去重资产文件**、**组件级原资源清单 (`component-handoff.json`)**、**独立保存的内联 SVG 文件** 以及 **原始请求响应镜像**。

### 4. 哪些上游能力会另外发起网络请求？
* **风险点排查**：
  - **SingleFile**：在解析 CSS 或处理懒加载时，默认会尝试二次发起 `fetch` 拉取外部字体或图片。如果直接调用，会击穿我们的离线 / 受限沙箱。
  - **Crawlee 高级爬虫**：`PlaywrightCrawler` 自带代理池轮换、Session 池维持、甚至向 Apify 云端报告指标的逻辑。
  - **Browsertrix**：包含行为追踪与动态外部脚本加载。
* **控制策略**：
  - **绝不整包安装高级爬虫框架**。
  - 只引入纯内存/磁盘数据结构的 `@crawlee/core`，网络抓取 100% 交由受 Playwright `page.route` 和 `NetworkGuard` 锁死的主进程执行。所有未授权域名一律 `blockedbyclient`。

### 5. 如何保证它们仍遵守我们已有的 origin / 方法 / 预算边界？
* **架构隔离原则**：
  ```text
  [Crawlee RequestQueue (状态调度与去重)]
           │ (纯数据对象: url, uniqueKey, userData)
           ▼
  [wp-replica-factory 调度层] ── 预算检查 (PageBudget, HandledBudget, TimeBudget)
           │
           ▼
  [Playwright Browser Context]
           │
           ├── page.route('**/*') ──► [NetworkGuard] (强制限制 GET, 仅允许授权域名)
           │                                 │
           │                                 ├── 拦截外部请求 -> blockedbyclient
           │                                 └── 记录网络事件 -> network-sanitized.json
           ▼
  [受控目标页面 / Fixture]
  ```
  - **去重隔离**：Crawlee 仅用于管理待抓取 URL 队列和标记处理状态，不直接触碰网络。
  - **网络锁定**：所有实际网络通信只能经过 Playwright 路由拦截器与框架内置的 `scopedProxy` / `restrictContext`。
  - **预算熔断**：一旦 `handledCount >= budget`，调度器立即终止循环，并显式报告 `status: BUDGET_PAUSED, isFinished: false`，绝不虚报全站已完成。

---

## 四、特别核对点结论

1. **Crawlee 默认 URL 归一化与交互状态防丢失**：
   - Crawlee 默认按标准 URL 去重，会导致 `https://example.com/catalog` 的默认态与打开筛选面板态被去重合并。
   - **解决方案**：实现 `buildCompositeKey({ url, stateId, viewport })`，注入自定义 `uniqueKey`（如 `http://.../catalog.html#state=filter_opened@1440x1000`）。实测证明 Crawlee 完全尊重显式 `uniqueKey`，同 URL 不同状态 100% 保留。
2. **反爬虫绕过与代理轮换禁令**：
   - 严禁引入上游的指纹伪装、浏览器特征注入或代理池切换机制。授权复刻只采集已获许可的资产与自有沙箱，遇到挑战或阻断一律返回 `BLOCKED` 并记录证据。
3. **许可证隔离与商用安全性**：
   - 核心仓库维持 MIT / Apache-2.0 宽松协议。
   - 对 AGPL 项目（SingleFile、Browsertrix）严禁直接复制代码进主工程源码树；如有快照需求，仅限外部独立容器或独立 CLI 工具间接调用，并单独列入许可审查项。

---

## 五、可执行复用样例 (Spike PoC) 运行报告

### 1. 样例设计规格
* **分支**：`spike/upstream-reuse-poc`
* **上游依赖**：`@crawlee/core@3.18.1`（已锁定于 `tools/downloader/package.json`）
* **测试用例**：`tests/spike/crawlee-queue.test.mjs`
* **自建测试站点**（`tests/fixtures/spike-crawler/`）：
  - 包含 3 个自有页面：`index.html`（首页）、`catalog.html`（目录页）、`about.html`（关于页）；
  - 包含点击后才出现的面板：`#filter-btn` -> `#filter-panel`；
  - 包含二级展开：`#expand-category-btn` -> `#category-panel`；
  - 包含懒加载图片（`lazy-home.png`, `lazy-catalog.png`, `lazy-about.png`）及 CSS 外部背景（`style.css` + `bg.svg`）；
  - 覆盖两个真实视口：Desktop (`1440x1000`) 与 Mobile (`390x844`)。

### 2. 真实调用链与代码位置
```text
tests/spike/crawlee-queue.test.mjs
  └── tools/spike/crawlee-queue.mjs
        ├── buildCompositeKey() ──────────► 生成 composite uniqueKey (防状态合并)
        ├── createSpikeQueueManager() ────► import('@crawlee/core').RequestQueue.open()
        └── runControlledSpikeCrawler() ──► 驱动 Playwright 页面并按步更新 Crawlee 队列
```

### 3. 两阶段执行验证结果

#### Phase 1: 预算受限与安全中断（证明“按预算结束不得称全站完成”）
* **输入条件**：初始注入首页（2 视口），设定处理预算上限 `maxHandledBudget = 3`。
* **执行过程**：处理首页桌面态、移动态及目录页桌面态后达到预算上限，调度器主动暂停。
* **输出断言**：
  ```json
  {
    "status": "BUDGET_PAUSED",
    "handledCount": 3,
    "pendingCount": 4,
    "isFinished": false
  }
  ```
* **证据证明**：未处理的链接（`about.html`）与交互状态安全保留在磁盘队列中，系统明确输出 `isFinished: false`，杜绝虚报完成。

#### Phase 2: 磁盘无损恢复与状态全量覆盖
* **输入条件**：使用同一存储目录，配置 `purgeOnStart: false` 重新打开队列。
* **执行过程**：队列成功读取此前已处理的 3 条记录，从第 4 条待处理任务无缝续跑；处理目录页交互面板触发与二级展开。
* **输出断言**：
  ```json
  {
    "status": "COMPLETED",
    "totalCount": 10,
    "handledCount": 10,
    "handledStates": ["default", "filter_opened", "secondary_expanded"],
    "isFinished": true
  }
  ```
* **证据证明**：
  1. 页面全部覆盖：`index.html`、`catalog.html`、`about.html` 全部抓取完毕；
  2. 状态完整保留：`catalog.html` 在同一 URL 下共成功处理 3 个独立状态（`default`, `filter_opened`, `secondary_expanded`），且在双视口下互不干扰；
  3. 去重机制生效：重复页面链接被 Crawlee 准确判定为 `wasAlreadyPresent: true`，无死循环。

---

## 六、下一阶段建议组合方案与 REFERENCE_READY 准则

### 1. 建议采纳的最佳组合架构
```text
┌─────────────────────────────────────────────────────────────┐
│ 1. 抓取与状态调度层: @crawlee/core RequestQueue               │
│    - 负责: 深度链接发现、磁盘持久化、复合 Key 状态队列、中断恢复    │
├─────────────────────────────────────────────────────────────┤
│ 2. 受控浏览器与采集层: Playwright + NetworkGuard (已有 Downloader)│
│    - 负责: 视口渲染、网络隔离代理、严格 GET 限制、哈希去重存储     │
├─────────────────────────────────────────────────────────────┤
│ 3. 显式交互合同执行层: state-handoff engine (PR #14 MVP)     │
│    - 负责: 前置条件检查、动作执行、DOM/可见性断言、restores_state 校验 │
├─────────────────────────────────────────────────────────────┤
│ 4. 资产交接与独立门禁层: Verify + Component Catalog           │
│    - 负责: 原始资源对齐、磁盘哈希校验、内联 SVG 归档、双 Run 像素对比│
└─────────────────────────────────────────────────────────────┘
```

### 2. 未来进入 `REFERENCE_READY` 的必备验收标准
在允许商城开发者（A/B/C/D）启动 WooCommerce 模板编写前，参考包必须满足：
1. **页面范围完整（Page Scope Complete）**：所有批准的页面路由均已成功采集，不存在 4xx/5xx 或截断页面。
2. **必需交互已采集（Interactive States Captured）**：所有商业必需的动态交互（国家选择、侧栏筛选、变体弹窗）均有显式合同并录入 `component-handoff.json`。
3. **关键依赖文件齐全（Original Assets Verified）**：HTML、CSS、JS、独立 SVG 及图片均在磁盘上通过 SHA-256 核验，无空占位符或伪造路径。
4. **状态可独立查看（Previewable Isolated States）**：在源站彻底关停后，能在本地预览服务中完整重现各状态的真实渲染与截图。
5. **缺口归零或明确标批（Zero Undocumented Gaps）**：未采集的响应式资源明确标记为 `NOT_CAPTURED` 并经业务确认，不隐瞒缺口。
6. **视觉与证据冻结（Baseline Frozen）**：生成包含清单哈希的不可变报告，作为后续站点开发的比对基准。
