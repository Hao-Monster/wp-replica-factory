# A 消费者交接文档：参考包流水线 MVP 与页面入口去向表

> **对接核验状态**：`CONSUMER_NOT_YET_VERIFIED`  
> **框架维护者验证**：`NEW_DIRECTORY_SMOKE: PASSED`（已在干净独立目录完成 E1-E10 离线端测试与真实 PDP 资料适配）  
> **固定框架可用 SHA**：通过 `git rev-parse HEAD` 动态读取（本轮交付基准提交：`5fe5dc4fd54d06dc8fbf9131b2dd4d55b4d65006` 或本分支最新 HEAD）  
> **交接目标**：Agent A（WordPress 全站页面创建与导航连通）与 Agent C（产品目录与事实核对）

---

## 1. 适用模式与能力边界说明

- **流水线 MVP 当前核心验证**：`owned-fixture`（自有受控参考包流水线，无外部网络依赖）。
- **公网目标模式状态**：下载器底层已支持有限的 `authorized-public` 模式（要求显式 HTTPS 域名、单一 page origin、严格 network guard，自动阻断非法外部请求与写方法）。
- **边界与非目标**：本框架不进行 WAF 绕过、验证码破解或代理池轮换，不默认依赖用户后台登录或私有会话。
- **定位**：为 WooCommerce 前端主题与组件还原提供高保真离线参考证据（HTML、截图、CSS、真实字体、图片/SVG及交互状态快照），非黑盒克隆器。

---

## 2. 真实 PDP 入口去向与路由缺口分析（协助 A/C 补齐页面）

框架维护者（E）已根据已取得的 iPhone 15 详情页 DOM 片段与状态数据，提取出以下**入口去向表**，协助 A 与 C 排查页面遗漏：

### 2.1 铁律与概念区分（必读）
1. **“缺本地参考文件”不等于“线上 404”**：
   - 缺本地参考（`MISSING_LOCAL_REFERENCE_PAGE` / `MISSING_LOCAL_REFERENCE_STATE`）表示采集包中尚未包含该目标页面或展开状态的离线快照，**绝不能推定线上目标就是 404**。
2. **无 href 按钮不判 404**：
   - 带有点击事件但无静态 href 的按钮（如展开成色说明、Trade-in 弹层），静态数据无法确定的标记为 `UNKNOWN`，交由 A/C 在具备浏览器上下文时核对，禁止无端猜测为首页或死链。
3. **职责划分**：
   - 本表协助 A/C 明确哪些页面还缺采集资料；
   - WordPress 站内的真实 Page 创建、URL 永久链接（Permalinks）配置、菜单挂载与点击验收继续由 Agent A 负责。

### 2.2 详细入口去向清单 (Outbound Links & Entry Points)
| 所在位置 | 可见文字 / 可访问名称 | 原始动作 / href | 解析目标 URL | 入口类型 | 是否有本地参考 | 缺口状态 | 处置与核对建议 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `pdp/header` | **EN** | `button.fancy-underline` | `UNKNOWN` | `Modal` | ❌ 否 | `STATIC_DATA_UNKNOWN_JS_ACTION` | 语言/国家切换浮层，A/C 需在浏览器确认其唤起的弹层 DOM |
| `pdp/buy-box` | **Flash Sale** | `div.bg-[#fee9e8]` | `https://reebelo.com/collections/flash-sale` | `Page navigation` | ❌ 否 | `MISSING_LOCAL_REFERENCE_PAGE` | 特卖集合页，A 需确认本站是否需建对应促销分类页 |
| `pdp/buy-box` | **Trustpilot (281 reviews)** | `svg Trustpilot + text` | `https://www.trustpilot.com/review/reebelo.com` | `External link` | ❌ 否 | `EXTERNAL_DEPENDENCY` | 第三方评价平台外链，WordPress 模板应保留外链属性（`rel="noopener"`） |
| `pdp/buy-box` | **Unlocked device info** | `button[aria-label="Unlocked..."]` | `UNKNOWN` | `Modal` | ❌ 否 | `STATIC_DATA_UNKNOWN_JS_ACTION` | 网络锁说明 Tooltip / 弹层，需确认是否为内嵌模态框 |
| `pdp/buy-box` | **before trade-in** | `button#e2e-pdp-before-trade-in` | `UNKNOWN` | `Modal` | ❌ 否 | `STATIC_DATA_UNKNOWN_JS_ACTION` | 以旧换新估价弹窗，业务逻辑需 D/A 评估是否接入 |
| `pdp/buy-box` | **Color Selector** | `color-chips (Pink/Black/Blue...)` | `?color=...` | `Business action` | ⚠️ 部分 | `PARTIAL_LOCAL_REFERENCE` | 粉色（Pink）为当前选中且具备主图的变体，其余颜色缺对应图 |
| `pdp/buy-box` | **Storage Selector** | `storage-buttons (128GB/256GB...)` | `?storage=...` | `Business action` | ⚠️ 部分 | `PARTIAL_LOCAL_REFERENCE` | 128GB 为当前核验事实，256GB/512GB 为待售变体 |
| `pdp/buy-box` | **Condition Selector** | `condition-cards (Good/Like New...)` | `?condition=...` | `Business action` | ⚠️ 部分 | `PARTIAL_LOCAL_REFERENCE` | Good 为当前选定成色 |
| `pdp/gallery` | **Gallery Carousel** | `Swiper buttons (Thumb 0..4)` | `javascript:void(0)` | `Carousel` | ✅ 是 | `NONE` | **5 张高清原图已完全在本地就绪**，B/A 可直接引用 |
| `pdp/buy-box` | **Add to Cart** | `button#e2e-pdp-bottom-bar-add-to-cart` | `https://reebelo.com/cart` | `Business action` | ❌ 否 | `LIVE_BUSINESS_TRANSACTION` | WooCommerce 标准加购行为，禁止框架伪造支付流程 |
| `pdp/accordion` | **Specifications** | `accordion toggle button` | `#specs` | `Tab` | ❌ 否 | `MISSING_LOCAL_REFERENCE_STATE` | 规格列表展开态，缺展开后 DOM 证据 |
| `pdp/accordion` | **Customer Reviews** | `accordion toggle button` | `#reviews` | `Tab` | ❌ 否 | `MISSING_LOCAL_REFERENCE_STATE` | 评价列表展开态，缺展开后 DOM 证据 |
| `pdp/accordion` | **Frequently Asked Questions** | `accordion toggle button` | `#faq` | `Tab` | ❌ 否 | `MISSING_LOCAL_REFERENCE_STATE` | 常见问题展开态，缺展开后 DOM 证据 |

---

## 3. 干净环境安装与依赖规范

框架运行要求 Node.js >= 22，采用锁定的 Crawlee 3.18.1 与 Playwright 1.55.0。

```bash
# 1. 检出框架代码至干净工作目录
git checkout feat/reference-pipeline-mvp

# 2. 锁定安装 Downloader 与 Crawlee 依赖
npm ci --prefix tools/downloader --ignore-scripts --no-audit --no-fund

# 3. 安装受控 Chromium 运行时
node tools/downloader/node_modules/playwright/cli.js install --with-deps chromium

# 4. 验证 CLI 入口
node tools/pipeline/cli.mjs --help
```

---

## 4. 命令行调用参考

### 4.1 启动正式采集
```bash
node tools/pipeline/cli.mjs run <contract.json> \
  --output <output-dir> \
  --storage <crawlee-storage-dir> \
  [--budget 50]
```

### 4.2 导出静态预览站点
将采集输出导出为可直接静态查看的网页（严格多状态与视口精确对应，禁止静默替代）：
```bash
node tools/pipeline/export-preview.mjs \
  --input <output-dir>/<run-id> \
  --output dist-preview
```

---

## 5. 产物目录与状态映射

采集完成后，输出目录结构如下：

```
<output-dir>/<run-id>/
├── reference-index.json         # 核心映射索引：[url|state|viewport] -> 产物路径
├── _pipeline_checkpoint.json    # 运行断点与任务统计状态
└── captures/
    └── <capture-id>/
        ├── manifest.json        # 采集元数据、Playwright版本、哈希与失败记录
        ├── resources.json       # 依赖资源清单（MIME、字节、哈希）
        ├── routes.json          # 页面路由发现状态（visited/pending）
        ├── pages/
        │   └── <page-id>/
        │       ├── rendered.html  # 原生捕获的完整 DOM
        │       ├── screenshot.png # 全屏/视口渲染截图
        │       └── signals.json   # 页面计算信号（H1、字体加载状态等）
        └── site/
            └── objects/         # 去重本地化的静态资源（CSS/JS/图片/字体）
```

- **Query 参数页面隔离**：例如 `/catalog.html?sale=1` 与 `/catalog.html` 为完全独立的任务和产物目录，绝不互相覆盖。
- **状态身份标识**：每个交互状态（如 `country-open`、`filter-open`）独立保存在各自的 captureId 下。
- **精确状态/视口匹配**：若缺少某一端状态（如缺少移动端展开态），导出器严格标红呈现缺口，禁止静默用桌面图填充。
