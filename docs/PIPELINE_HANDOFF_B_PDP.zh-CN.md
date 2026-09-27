# B 消费者交接文档：iPhone 15 商品详情页 (PDP) 参考包与输入缺口

> **对接目标**：Agent B（商品详情页 / PDP 负责人）  
> **目标页面**：`https://reebelo.com/collections/apple-iphone-15?skuId=sku-mi9d1pbuqmCzWzvrogXTHX0`  
> **目标 SKU**：`sku-mi9d1pbuqmCzWzvrogXTHX0` (128GB / Pink / Good / Unlocked)  
> **对接状态**：`PARTIAL`（已完成组件级真实资料适配，缺失全页完整 outer DOM 与外部生产 CSS）  
> **消费者核验状态**：`CONSUMER_NOT_YET_VERIFIED`  
> **框架维护者验证**：`NEW_DIRECTORY_SMOKE: PASSED`（已在全新隔离目录完整实跑 `adapt-evidence` → `export-preview` → Chromium 离线渲染验证）  
> **固定框架可用 SHA**：通过 `git rev-parse HEAD` 动态读取（本轮交付基准提交：`5fe5dc4fd54d06dc8fbf9131b2dd4d55b4d65006` 或本分支最新 HEAD，严禁手工伪造）  

---

## 1. 成果交接：已取得并整理的真实 PDP 资料

框架维护者（E）已通过受控通道读取 Agent B（commit `acaa0abc647abd7c3ec513f55ee119d843a5aa70`）与 Agent C（commit `3ac81c0a61e7201d266d79a0af52533d201b60a2`）提交的真实资料，完成组件级适配。**B 无需再猜测结构，也严禁重复下载已有原图**：

### 1.1 已整理到位的 5 张高清商品原图（无需重复下载）
| 文件名 | 本地位置 | 字节数 | SHA256 (首12位) | 来源说明 |
| :--- | :--- | :--- | :--- | :--- |
| `PIN-image-0.jpg` | `site/objects/PIN-image-0.jpg` | 144,079 B | `2adeaa2085e1` | iPhone 15 粉色主图 (正面) |
| `PIN-image-1.jpg` | `site/objects/PIN-image-1.jpg` | 113,436 B | `b7fd1c04f82f` | iPhone 15 粉色背板/双摄 |
| `PIN-image-2.jpg` | `site/objects/PIN-image-2.jpg` | 57,147 B | `3a6d7588a6f2` | 侧面边框视图 |
| `PIN-image-3.jpg` | `site/objects/PIN-image-3.jpg` | 106,037 B | `fdfa86ab59d9` | 底部接口/扬声器孔 |
| `PIN-image-4.jpg` | `site/objects/PIN-image-4.jpg` | 52,210 B | `45789a8ad9e0` | 成色细节放大图 |

### 1.2 已整理到位的页面截图与组件数据
- **桌面视口目标截图 (1440×1000)**：`pages/pdp-desktop/screenshot.png` (240,062 B, SHA256: `fd8f58514a3f`)
- **移动端视口目标截图 (390×844)**：`pages/pdp-mobile/screenshot.png` (106,501 B, SHA256: `76f406a297d0`)
- **核心购买区 DOM 片段**：包含标题 `iPhone 15 - Unlocked`、Trustpilot 评分 `4.7 ★ (281 reviews)`、成色说明、变体选项选择器（颜色、容量、成色）、价格块（现价 `$415.30` / 划线 `$799.00` / 节省 `$383.70`）、加购按钮（`id="e2e-pdp-bottom-bar-add-to-cart"`）及规格折叠面板。
- **关联索引与资源表**：已严格映射在 `reference-index.json`、`manifest.json` 与 `resources.json` 中。
- **入口去向分析表**：已输出至 `entry-points.json` 及 `entry-points-report.md`，详见第 5 节。

---

## 2. 框架导出合同与标准目录规范

`export-preview` 严格要求以下标准结构（不能只给零散散落的 4 个文件）：

```
<adapted-dir>/
├── reference-index.json      # 核心索引：定义页面 URL、stateId、viewport、关联文件路径
├── manifest.json             # 采集元数据：包含状态（PARTIAL）、来源 commit、精确 captures[] 列表
├── resources.json            # 资源映射：包含原 CDN URL、local_path、MIME、SHA256
├── entry-points.json         # 页面与组件入口去向表
├── entry-points-report.md    # 入口分析人读报告
├── pages/
│   ├── pdp-desktop/
│   │   ├── rendered.html     # 组件 DOM 片段
│   │   ├── screenshot.png    # 1440x1000 目标截图
│   │   └── signals.json      # 视口与属性信号
│   └── pdp-mobile/
│       ├── rendered.html     # 390x844 移动端 DOM 片段
│       ├── screenshot.png    # 390x844 目标截图
│       └── signals.json      # 移动端视口信号
└── site/
    └── objects/              # 本地保存的二进制资源（如 PIN-image-0.jpg..4.jpg）
```

### 2.1 状态与视口精确匹配铁律（无静默替代）
框架在 `export-preview.mjs` 中已严格执行**三元组精确比对** `(url, stateId, viewport)`：
- 严禁把桌面端截图替代移动端视口；
- 严禁把默认态截图替代展开态（如 `mobile-accordion-open`）；
- 若请求了未采集的状态，框架直接输出 `MISSING_EXACT_CAPTURE` 占位并在看板标红，整体标记 `PARTIAL`，绝不拿 `captures[0]` 填充伪造完整。

---

## 3. B 在本地快速运行与查看的操作说明

本说明已在全新干净目录中实测通过（`NEW_DIRECTORY_SMOKE: PASSED`）：

### 3.1 环境检出与依赖安装
```bash
# 1. 检出对应分支
git checkout feat/reference-pipeline-mvp

# 2. 锁版本安装依赖
npm ci --prefix tools/downloader --ignore-scripts --no-audit --no-fund
node tools/downloader/node_modules/playwright/cli.js install --with-deps chromium
```

### 3.2 资料适配与静态导出（不使用自有 pipeline-site 合同）
若 B 手中有零散原始资料（例如在 `my-evidence/`），运行薄适配器自动生成标准索引：
```bash
# 步骤 A：把原始资料适配为标准参考包（保留原文件、SHA与真实来源标注）
node tools/pipeline/adapt-evidence.mjs \
  --input my-evidence \
  --output captures/reebelo-pdp-iphone15

# 步骤 B：使用框架导出器生成可查看的离线预览包（不需要传 pipeline-site 合同）
node tools/pipeline/export-preview.mjs \
  --input captures/reebelo-pdp-iphone15 \
  --output dist-preview
```

### 3.3 离线启动与查看
```bash
# 启动轻量静态服务（严禁外部上游回源）
npx serve dist-preview
```
- 打开浏览器访问提示的本地端口；
- 左侧可切换 Desktop (1440×1000) 与 Mobile (390×844)；
- 中间画布展示真实 DOM 渲染，原图通过 `captures/.../site/objects/` 加载；
- 可随时比对实际 DOM 渲染与 `Screenshot (Visual)` 选项卡。

---

## 4. 尚缺的最小资料清单 (Input Gaps)

当前资料标记为 `PARTIAL`（组件级参考），要达到全页生产级参考，仅缺以下 3 项：

1. **全页外层 DOM (`rendered.html`)**：包含页头全站导航条、面包屑路径、页脚版权与支付图标。
2. **生产端全局样式表 (`external_css`)**：Reebelo 站点的外部打包 CSS 文件（用于百分百还原外层字体与布局变量）。
3. **移动端展开交互态 (`mobile-expanded-state`)**：折叠面板展开态截图（`Specifications`、`Customer Reviews`、`FAQs` 展开后的实际画面）。

> **注意**：上述缺口由采集或浏览器授权环境补齐即可，B 在此之前可直接使用已整理的组件参考包进行商品画廊、变体选择器与价格块的前端开发。

---

## 5. 请 B 核对的具体页面状态

请 B 重点核对以下单项并反馈回执：
- **核对页面**：移动端视口（390×844）默认态。
- **核验路径**：`dist-preview/views/adapted/index.html`。
- **检查要素**：
  1. 确认 5 张主图是否能正常轮播展示且无跨域破损；
  2. 确认颜色选择器（粉色高亮）、容量（128GB）与成色（Good）的选中样式是否清晰；
  3. 确认底部吸底固定栏（`$415.30` 与 `Add to Cart` 按钮）是否在移动端正常吸底；
  4. 确认入口去向表（`entry-points-report.md`）中的字段定义是否满足 WooCommerce 属性映射需求。
- **回执标记**：B 本地实跑无误后，在 PR #16 提交 `CONSUMER_VERIFIED`。
