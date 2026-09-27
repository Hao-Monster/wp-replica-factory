# B 消费者交接文档：iPhone 15 商品详情页 (PDP) 真实参考包与交接说明

> **对接目标**：Agent B（商品详情页 / PDP 负责人）  
> **目标页面**：`https://reebelo.com/collections/apple-iphone-15?skuId=sku-mi9d1pbuqmCzWzvrogXTHX0`  
> **目标 SKU**：`sku-mi9d1pbuqmCzWzvrogXTHX0` (128GB / Pink / Good / Unlocked)  
> **对接状态**：`PARTIAL`（已完成基于原站实际 DOM、生产 CSS、真实字体与原图的真实适配）  
> **消费者核验状态**：`CONSUMER_NOT_YET_VERIFIED`（等待 Agent B 独立实跑回执，框架不代为验收）  
> **框架维护者验证**：`NEW_DIRECTORY_SMOKE: PASSED`（已在干净独立目录执行 `adapt-evidence` → `export-preview`，经 V1-V4 测试与 Chromium 离线渲染验证）  
> **固定框架可用 SHA**：通过 `git rev-parse HEAD` 动态读取（严禁手工伪造）  

---

## 1. 重要澄清：已停止并移出自行生成的假参考

**特别说明与交接更正**：
上一轮中 `adapt-evidence.mjs` 通过 `generateComponentHtml()` 自行编写的静态示意页面（包含自写 CSS 变量、自设字体栈、自填价格 `$415.30` / `$799.00` 及伪造选项）**已彻底从正式参考索引和“原站渲染”标签中移出**，不得作为目标视觉基准。

本次交付给 B 的参考是**来自原站实际运行 DOM 与原资源的真实参考**：
1. **原站真实 DOM 片段**：提取自 `target-pdp-data.json` 中的 `htmlSnippet`，100% 保持原始节点结构、Tailwind 类名、SVG 与文案，绝不手工换标签、换文案或造选项；
2. **原站生产端 CSS**：`reebelo-363ffbdf87260b23.css`（162.5KB）与 `reebelo-9bfb110ce66798bf.css`（6.5KB），从生产环境直接获取；
3. **原站真实字体**：Manrope 系列字体文件（`Manrope-Regular.ttf`、`Manrope-SemiBold.ttf`、`Manrope-ExtraBold.ttf`），避免回退到操作系统默认字体；
4. **5 张高清商品原图（无需重复下载）**：`PIN-image-0.jpg` 至 `PIN-image-4.jpg`，已在 `site/objects/` 就绪，附带原始 SHA-256 校验；
5. **生产素材**：原版翻新认证标（`certified-refurbished.png`）、美国国旗 SVG（`US.63eb09ff.svg`）；
6. **原目标截图**：桌面 1440×1000（`target-pdp-desktop-1440.png`）与移动端 390×844（`target-pdp-mobile-390.png`）。

---

## 2. 成果清单与资产哈希表

| 资产类型 | 文件名 | 本地存放路径 | 字节数 | SHA256 (首12位) | 真实来源 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **商品图 0** | `PIN-image-0.jpg` | `site/objects/PIN-image-0.jpg` | 144,079 B | `2adeaa2085e1` | Reebelo CDN 正面粉色 |
| **商品图 1** | `PIN-image-1.jpg` | `site/objects/PIN-image-1.jpg` | 113,436 B | `b7fd1c04f82f` | Reebelo CDN 背面粉色 |
| **商品图 2** | `PIN-image-2.jpg` | `site/objects/PIN-image-2.jpg` | 57,147 B | `3a6d7588a6f2` | Reebelo CDN 边框视图 |
| **商品图 3** | `PIN-image-3.jpg` | `site/objects/PIN-image-3.jpg` | 106,037 B | `fdfa86ab59d9` | Reebelo CDN 底部接口 |
| **商品图 4** | `PIN-image-4.jpg` | `site/objects/PIN-image-4.jpg` | 52,210 B | `45789a8ad9e0` | Reebelo CDN 成色细节 |
| **生产样式 1** | `reebelo-363ffbdf87260b23.css` | `site/objects/reebelo-363ffbdf87260b23.css` | 162,570 B | `70570b5ee67b` | Reebelo 生产样式打包 |
| **生产样式 2** | `reebelo-9bfb110ce66798bf.css` | `site/objects/reebelo-9bfb110ce66798bf.css` | 6,521 B | `f179c3d4f40d` | Reebelo 关键样式 |
| **字体 Regular** | `Manrope-Regular.ttf` | `site/objects/Manrope-Regular.ttf` | 96,832 B | `022949704e68` | Reebelo 生产字体 |
| **字体 SemiBold** | `Manrope-SemiBold.ttf` | `site/objects/Manrope-SemiBold.ttf` | 96,936 B | `611599540b6e` | Reebelo 生产字体 |
| **字体 ExtraBold** | `Manrope-ExtraBold.ttf` | `site/objects/Manrope-ExtraBold.ttf` | 97,524 B | `368ae82138e9` | Reebelo 生产字体 |
| **翻新标牌** | `certified-refurbished.png` | `site/objects/certified-refurbished.png` | 66,835 B | `ae29910d68b9` | Reebelo 生产角标 |
| **国旗图标** | `US.63eb09ff.svg` | `site/objects/US.63eb09ff.svg` | 19,384 B | `a902df5ea36d` | Reebelo 生产 SVG |
| **桌面截图** | `target-pdp-desktop-1440.png` | `pages/pdp-desktop/screenshot.png` | 240,062 B | `fd8f58514a3f` | 目标站 1440×1000 截图 |
| **移动截图** | `target-pdp-mobile-390.png` | `pages/pdp-mobile/screenshot.png` | 106,501 B | `76f406a297d0` | 目标站 390×844 截图 |

---

## 3. 目录与环境隔离说明（严禁混淆两个仓库）

- **框架代码目录**（通用仓库）：`E:\CodeWorkstation\wp-replica-factory-E`  
  只读通用框架，负责流水线编排、证据适配器、导出器与门禁。
- **资料输入目录**（商品材料仓库或交接目录）：例如 `.replica/intake/pdp-iphone15/raw` 或 B 本地材料目录。
- **适配输出目录**：例如 `.replica/intake/pdp-iphone15/adapted`。
- **查看导出目录**：`dist-preview/`。
- **查看入口**：
  - 桌面端：`dist-preview/views/pdp-desktop/index.html`
  - 移动端：`dist-preview/views/pdp-mobile/index.html`

> **视口隔离保证**：桌面端和移动端绑定独立输出路径（`pdp-desktop` 与 `pdp-mobile`），同一采集目录共享 `site/objects/` 资源，但彼此绝对不会相互覆盖。移动端若未采集完整 DOM，如实输出已有的移动端片段，绝不把桌面 DOM 更改 `isMobile` 冒充移动端证据。

---

## 4. B 在本地快速运行与查看的操作说明

### 4.1 锁版本安装依赖（在框架目录下）
```bash
git checkout feat/reference-pipeline-mvp
npm ci --prefix tools/downloader --ignore-scripts --no-audit --no-fund
node tools/downloader/node_modules/playwright/cli.js install --with-deps chromium
```

### 4.2 运行资料适配（使用真实资料路径）
```bash
# 步骤 A：将原始证据适配为标准参考包
node tools/pipeline/adapt-evidence.mjs \
  --input .replica/intake/pdp-iphone15/raw \
  --output .replica/intake/pdp-iphone15/adapted

# 步骤 B：使用框架导出器生成可查看的离线预览包
node tools/pipeline/export-preview.mjs \
  --input .replica/intake/pdp-iphone15/adapted \
  --output dist-preview
```

### 4.3 离线启动与查看
```bash
npx serve dist-preview
```
- 打开浏览器访问服务端口；
- 桌面端查看：`http://localhost:<port>/views/pdp-desktop/index.html`
- 移动端查看：`http://localhost:<port>/views/pdp-mobile/index.html`
- 画布中展示的是真实原站 DOM 节点及渲染效果，左侧可对照原站目标截图。

---

## 5. 尚缺资料清单 (Input Gaps)

1. **移动端展开交互态 (`mobile-expanded-state`)**：Accordion 展开状态的 DOM 与截图（`Specifications`、`Customer Reviews`、`FAQs`）。
2. **全页外层包裹 DOM**：页头导航条（Header）与全站页脚（Footer）。目前由 Agent A 分别在对应模块完成。

---

## 6. 请 B 核对的具体检查点

1. 打开 `dist-preview/views/pdp-desktop/index.html`，确认购买区、主图、缩略图、评分、标签及属性选择器完整渲染且无外部网络请求；
2. 打开 `dist-preview/views/pdp-mobile/index.html`，确认吸底栏与移动端布局独立生效，未被桌面端覆盖；
3. 核验完毕后，请在 PR #16 提交回执或标记 `CONSUMER_VERIFIED`。
