> **对接核验状态**：`CONSUMER_NOT_YET_VERIFIED`  
> **框架维护者验证**：`NEW_DIRECTORY_SMOKE: PASSED` (已在独立全新临时目录验证锁版本依赖安装、CLI入口、22任务采集、静态导出与离线浏览器端 E1-E9 测试)  
> **固定框架审查锚点 SHA**：`a3a7d6094871c40cbb8cf919d34e06ff28c7be6d`  
> 框架维护者（E）已在干净环境完成全套质量闭环；尚未在具体商业站点（如 Reebelo）由 A 实际运行。待 A 回传真实调用环境与错误后，再进行最小接口适配。

---

## 1. 适用模式与能力边界说明

- **当前支持模式**：`owned-fixture`（自有受控参考包流水线）。
- **商业目标站状态**：`NOT_YET_ENABLED_FOR_COMMERCIAL_TARGET`。
  当前流水线执行严格的同源安全守卫（`network guard`），禁止未经沙箱配置的外部公网探测，严禁将未受控网页当作指令执行。
- **定位**：为 WooCommerce 前端主题与组件还原提供高保真离线参考证据（HTML、截图、CSS、真实字体、图片/SVG及交互状态快照），非黑盒克隆器。

---

## 2. 干净环境安装与依赖规范

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

## 3. 命令行调用参考

### 3.1 启动正式采集
```bash
node tools/pipeline/cli.mjs run <contract.json> \
  --output <output-dir> \
  --storage <crawlee-storage-dir> \
  [--budget 50]
```

### 3.2 中断后恢复续跑 (Resume)
保持相同的 `contract.json` 配置版本（`configVer`），传入原 `run-id`：
```bash
node tools/pipeline/cli.mjs resume <contract.json> \
  --output <output-dir> \
  --storage <crawlee-storage-dir> \
  --run-id <run-id> \
  [--budget 50]
```

### 3.3 检查当前状态
```bash
node tools/pipeline/cli.mjs status \
  --output <output-dir> \
  --run-id <run-id>
```

### 3.4 导出静态预览站点
将采集输出导出为可直接静态查看的网页（供本地浏览器或 GitHub Pages 部署）：
```bash
node tools/pipeline/export-preview.mjs \
  --input <output-dir>/<run-id> \
  --output dist-preview \
  --contract <contract.json>
```

---

## 4. 输入合同（Contract）格式规范

参考 `tests/fixtures/pipeline-site/pipeline-contract.json`：

```json
{
  "schema": 1,
  "contractVersion": "v1",
  "configVer": "v1",
  "seed": "http://127.0.0.1:8080/",
  "pageOrigins": ["http://127.0.0.1:8080"],
  "assetOrigins": ["http://127.0.0.1:8080"],
  "viewports": [
    { "width": 1440, "height": 1000 },
    { "width": 390, "height": 844 }
  ],
  "required_pages": [
    "/",
    "/catalog.html",
    "/about.html",
    "/catalog.html?sale=1"
  ],
  "required_states": [
    "country-closed",
    "country-open",
    "lang-expanded"
  ],
  "states": [
    {
      "state_id": "country-open",
      "path": "/",
      "preconditions": [{ "selector": "#country-portal", "visible": false }],
      "actions": [{ "type": "click", "selector": "#country-trigger-btn" }],
      "assertions": [{ "selector": "#country-portal", "visible": true }]
    }
  ]
}
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

---

## 6. 已知限制与后续工作

1. **商业目标站模式适配**：当前仅开放 `owned-fixture`；若需接入商业站点采集，需补充代理池、认证沙箱与更严格的脱敏策略。
2. **字体真实性要求**：所有引用的自定义字体必须是合法有效的 TTF/WOFF/WOFF2 字体文件，浏览器必须真正完成 FontFace 解码（HTTP 200 或占位文件将触发门禁阻断）。
3. **缺口核销**：未访问的同源页面依赖在单页采集时暂存为 pending，但在流水线完成前必须有对应已访问路由予以核销，否则判定为 `EVIDENCE_INCOMPLETE`。
