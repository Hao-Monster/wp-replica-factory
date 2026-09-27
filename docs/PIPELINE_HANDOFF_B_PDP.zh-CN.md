# B 消费者交接文档：iPhone 15 商品详情页 (PDP) 参考包与输入缺口

> **对接目标**：B（商品详情页 / PDP 负责人）  
> **目标页面**：`https://reebelo.com/collections/apple-iphone-15?skuId=sku-mi9d1pbuqmCzWzvrogXTHX0`  
> **对接状态**：`TARGET_INPUT_NEEDED`  
> **消费者核验状态**：`CONSUMER_NOT_YET_VERIFIED`  
> **框架维护者验证**：`NEW_DIRECTORY_SMOKE: PASSED`（已在干净环境验证 E1-E10 离线端视觉比较与导出流水线）  
> **固定框架可用 SHA**：`f8ae46f501dfd0ae15fd979f8f53e91b9f303d32`

---

## 1. 目标与定位

1. **定位**：为 B 还原 iPhone 15 商品详情页（PDP）前端模板提供高保真离线结构、CSS、真实字体与媒体素材参考。
2. **职责边界**：
   - 本交接仅交付**前端模板与结构素材**，**不为 D 伪造商品业务事实**（如真实库存、价格、型号配置事实由 C/D 负责核实与上架）。
   - 不操作目标商城购物车、表单、登录与付款。
   - 不进入 WordPress 后台，不执行 SSH，不读取认证会话。

---

## 2. 公开采集尝试与诊断结果

框架维护者（E）使用 Downloader 正式 `authorized-public` 入口，在显式域名限制与小预算条件下进行了探测：

```bash
node tools/downloader/cli.mjs download \
  --url "https://reebelo.com/collections/apple-iphone-15?skuId=sku-mi9d1pbuqmCzWzvrogXTHX0" \
  --policy .replica/pdp-iphone15-policy.json \
  --out .replica/pdp-test
```

### 诊断结论
- **HTTP 响应**：目标端返回 AWS WAF 浏览器安全校验页面（`https://*.token.awswaf.com/.../challenge.js`）。
- **合规处置**：按平台安全铁律，**立即停止采集，不轮换 User-Agent、不使用代理池绕过、不尝试验证码破解**。
- **诊断存档**：脱敏诊断元数据已留存于 `.replica/pdp-test/manifest.json`。
- **状态标记**：`TARGET_INPUT_NEEDED`（拿不到目标真实 DOM，不使用自有 fixture 冒充商城）。

---

## 3. 当前交付给 B 的精确输入缺口 (Input Gaps)

若 B 需在本地生成该页面的离线参考包，需由具备合法授权的浏览环境补齐以下 4 项原始素材（放至 `captures/reebelo-pdp-iphone15/`）：

1. **真实渲染 DOM (`rendered.html`)**：
   - 包含 iPhone 15 商品标题、主图画廊（Gallery）、变体选择器（颜色、存储容量）、成色等级说明展开块、以及底部规格折叠面板（Accordion）。
2. **核心样式与字体 (`site/objects/`)**：
   - 目标页引用的外部 CSS 文件与关键字体（TTF/WOFF2）。
3. **商品图片与图标资源**：
   - 高清主图、成色示意图与 SVG 图标。
4. **SKU 配置真实性核对**：
   - 请 B 核验 `skuId=sku-mi9d1pbuqmCzWzvrogXTHX0` 对应的实际配置（如是否为 128GB 黑色/粉色、成色为 Excellent），避免重定向至默认随机变体。

---

## 4. B 在本地打开与复用参考包的步骤

一旦上述原始素材放置到位，B 可通过框架的 `export-preview` 薄适配层一键导出离线预览包，并在本地离线查看：

### 4.1 安装与环境验证
```bash
# 1. 检出框架代码
git checkout feat/reference-pipeline-mvp

# 2. 锁版本安装依赖
npm ci --prefix tools/downloader --ignore-scripts --no-audit --no-fund
node tools/downloader/node_modules/playwright/cli.js install --with-deps chromium

# 3. 验证 CLI 入口
node tools/pipeline/cli.mjs --help
```

### 4.2 导出离线静态包
```bash
node tools/pipeline/export-preview.mjs \
  --input captures/reebelo-pdp-iphone15 \
  --output dist-preview \
  --contract tests/fixtures/pipeline-site/pipeline-contract.json
```

### 4.3 启动本地静态服务并查看
```bash
# 启动轻量静态服务器（禁止任何上游回源）
npx serve dist-preview
```
- **查看器特性**：
  - 严格保持 1440×1000（桌面）与 390×844（移动端）真实视口排版。
  - 支持 `100% / 75% / 50% / Fit` 等比无损缩放。
  - 视图内部无任何插入的横幅污染，画布完全纯净。

---

## 5. 交接核验指引（针对 B）

需要 B 在收到资料后核对的一个具体操作：
- **核对项**：在移动端视口（390×844）下，查看成色选择器（Condition Picker）与图片轮播（Gallery Carousel）的 DOM 结构与层级关系，确认其 CSS 变量与字体加载正常。
- **反馈回执**：B 验证后，在 PR #16 回帖确认 `CONSUMER_VERIFIED` 或提交缺少样式的具体清单。
