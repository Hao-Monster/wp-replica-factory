# 显式交互状态完整性与组件原资源交接说明

面向角色：**A（Integrator）**、**B（Header / Hero / 国家选择器）**、**C（首页区块 / 分类原图）**、**D（Catalog / 站点 fixture）**

---

## 1. 目标与定位

本能力由通用框架提供，用于在采集参考页面时保证：
1. **真实状态完整性**：严格按输入的**状态合同**（State Contract）执行动作和前置/后置断言（包括挂载到 `document.body` 的 Portal 弹窗、二级展开内容的真实可见性、关闭后状态复原）。杜绝“按钮未打开面板却虚假标记通过”或“漏了状态却缩小集合”。
2. **组件原资源交接**：提取组件在各个交互状态下真实渲染与请求的资源清单（图片 `currentSrc`/`srcset`、CSS 背景图、原始 inline SVG），完成本地文件存在性与 SHA256 校验，输出结构化的交接清单 `reports/component-handoff.json`。
3. **独立性与不侵入**：A/B/C/D 无需等待框架 PR 合并到 main，即可在独立目录复用此合同模式和交接产物。框架不硬编码具体商城业务网址、国家列表或商业素材。

---

## 2. 框架版本与安装准备

- **基线版本**：WordPress Replica Factory v0.1.1（工作分支 `feat/reference-state-handoff-mvp`）
- **运行环境**：Node 22+ (推荐 Node 24.12.0), Python 3.13
- **安装依赖**（在框架根目录下执行）：

```bash
npm ci --prefix tools/downloader --ignore-scripts --no-audit --no-fund
```

---

## 3. 完整采集策略与状态合同规范（Policy Specification）

Downloader 通过完整的 Policy JSON 文件驱动。状态合同必须内嵌于策略对象中，包含显式源站与资源白名单：

```json
{
  "mode": "owned-fixture",
  "url": "http://127.0.0.1:8765/index.html",
  "pageOrigins": ["http://127.0.0.1:8765"],
  "assetOrigins": ["http://127.0.0.1:8765"],
  "component": "region-selector",
  "viewports": [
    { "width": 1440, "height": 1000 },
    { "width": 390, "height": 844 }
  ],
  "required_states": [
    "region-closed",
    "region-open",
    "language-expanded",
    "region-closed-again"
  ],
  "states": [
    {
      "state_id": "region-closed",
      "path": "/index.html",
      "actions": [],
      "assertions": [
        { "selector": "#region-trigger-btn", "visible": true },
        { "selector": "#region-portal", "visible": false }
      ]
    },
    {
      "state_id": "region-open",
      "path": "/index.html",
      "preconditions": [
        { "selector": "#region-portal", "visible": false }
      ],
      "actions": [
        { "type": "click", "selector": "#region-trigger-btn" }
      ],
      "assertions": [
        { "selector": "#region-portal", "visible": true },
        { "selector": "#region-portal .region-title", "visible": true, "text": "Select Region" },
        { "selector": "#region-portal .flag-img", "visible": true },
        { "selector": "#region-portal #lang-list", "visible": false }
      ],
      "required_resources": [
        { "type": "image", "selector": "#region-portal .flag-img" },
        { "type": "css-background", "selector": "#region-portal .dialog-header" },
        { "type": "inline-svg", "selector": "#region-portal .close-icon" }
      ]
    },
    {
      "state_id": "language-expanded",
      "path": "/index.html",
      "preconditions": [
        { "selector": "#region-portal", "visible": false }
      ],
      "actions": [
        { "type": "click", "selector": "#region-trigger-btn" },
        { "type": "click", "selector": "#lang-dropdown-btn" }
      ],
      "assertions": [
        { "selector": "#region-portal", "visible": true },
        { "selector": "#lang-list", "visible": true },
        { "selector": "#lang-list .lang-item", "visible": true, "min_count": 2 }
      ],
      "required_resources": [
        { "type": "image", "selector": "#region-portal .flag-img" },
        { "type": "css-background", "selector": "#region-portal .dialog-header" },
        { "type": "inline-svg", "selector": "#region-portal .close-icon" }
      ]
    },
    {
      "state_id": "region-closed-again",
      "path": "/index.html",
      "preconditions": [
        { "selector": "#region-portal", "visible": false }
      ],
      "actions": [
        { "type": "click", "selector": "#region-trigger-btn" },
        { "type": "click", "selector": "#region-close-btn" }
      ],
      "assertions": [
        { "selector": "#region-portal", "visible": false },
        { "selector": "#region-trigger-btn", "visible": true }
      ],
      "restores_state": "region-closed"
    }
  ]
}
```

### 关键字段说明
- `preconditions`：执行动作前检查，确保页面处于约定前置状态（如弹窗尚未打开）。
- `actions`：有序操作序列（支持 `click`、`hover`、`scroll`）。
- `assertions`：动作后置判定。`visible: true` 经由 Playwright locator wait 判定元素真实可见（尺寸大于 0，未被 `display: none`/`visibility: hidden` 隐藏）；`min_count` 校验满足真实可见性的元素数量。
- `required_states`：必须达成的状态定义清单。
- `restores_state`：转换断言，确认关闭动作执行后确实恢复到初始状态的全部不变式。
- `required_resources`：指定该状态依赖的关键元素，若未找到对应元素或资源未落盘直接报错。

> **边界声明**：本能力执行的是经人工审阅与授权的【显式状态合同】，不是无边界自动化爬虫，也不会自动穷尽目标站点的所有动态交互。测试套件通过代表受控 fixture 验收成功，绝不等于对任意商业站点的状态已自动全量覆盖。

---

## 4. 常用执行与验证命令

### 采集运行
```bash
node tools/downloader/cli.mjs download --policy path/to/my-policy.json --out .replica/downloads/my-component-run
```

### 完整性与资源校验
```bash
node tools/downloader/cli.mjs verify .replica/downloads/my-component-run --require-handoff
```

### 独立离线预览
```bash
node tools/downloader/cli.mjs preview .replica/downloads/my-component-run --port 8124 --open
```

---

## 5. 产物结构与交接清单

采集成功后，运行目录下将生成：

| 文件路径 | 说明 |
| --- | --- |
| `reports/component-handoff.json` | 组件与状态交接清单：记录必须状态定义数、必须用例数（状态×视口）、实际有效用例数、各状态对应的截图、HTML、内联 SVG 独立文件及使用的原资源。 |
| `pages/<capture_id>/screenshot.png` | 对应状态和视口下的全页高保真截图。 |
| `pages/<capture_id>/rendered.html` | 动作执行稳定后的完整 DOM 结构（保留 Portal 挂载节点与 inline SVG 标记）。 |
| `pages/<capture_id>/svg-<idx>-<hash>.svg` | 状态渲染中提取并独立落盘的内联 SVG 原文件。 |
| `site/objects/<hash>.<ext>` | 本地化的原件资源文件（图片、CSS、字体等），已核对 SHA256。 |
| `raw/<hash>.bin` | 浏览器收到的未经改写的原始网络响应体。 |

### `component-handoff.json` 结构示例
```json
{
  "schema": 1,
  "component": "region-selector",
  "contract": {
    "required_states": ["region-closed", "region-open", "language-expanded", "region-closed-again"],
    "required_state_definitions": 4,
    "required_cases": 8,
    "viewports": [{"width": 1440, "height": 1000}, {"width": 390, "height": 844}]
  },
  "counts": {
    "required_state_definitions": 4,
    "required_cases": 8,
    "actual_valid_cases": 8,
    "missing_cases": 0,
    "cataloged_resources": 3,
    "verified_files": 3,
    "missing_files": 0
  },
  "status": "complete",
  "resource_catalog": [
    {
      "id": "res-1",
      "kind": "image",
      "origin": "network",
      "source_url": "http://127.0.0.1:8765/assets/region-flag.svg",
      "source_sha256": "8f5a...",
      "local_path": "site/objects/8f5a....svg",
      "local_sha256": "8f5a...",
      "verified_on_disk": true,
      "states_used": ["http://127.0.0.1:8765/index.html::1440x1000::region-open"]
    },
    {
      "id": "res-2",
      "kind": "css-background",
      "origin": "network",
      "source_url": "http://127.0.0.1:8765/assets/dialog-bg.svg",
      "source_sha256": "b12c...",
      "local_path": "site/objects/b12c....svg",
      "local_sha256": "b12c...",
      "verified_on_disk": true,
      "states_used": ["http://127.0.0.1:8765/index.html::1440x1000::region-open"]
    },
    {
      "id": "res-3",
      "kind": "inline-svg",
      "origin": "inline",
      "source_sha256": "c47d...",
      "local_path": "pages/9a41.../svg-0-c47d....svg",
      "local_sha256": "c47d...",
      "verified_on_disk": true,
      "states_used": ["http://127.0.0.1:8765/index.html::1440x1000::region-open"]
    }
  ]
}
```

---

## 6. 各角色对接使用指引

- **A（Integrator）**：
  在商城仓库集成时，使用 `node tools/downloader/cli.mjs verify <dir> --require-handoff` 验证交接包完整性；检查 `missing_states === 0` 与 `missing_files === 0`。
- **B（Header / Hero / 国家选择器）**：
  直接读取 `reports/component-handoff.json` 中的 `resource_catalog`。将 `verified_on_disk` 为 true 的本地 SVG/图片放置到主题对应资源目录，并在组件模板中直接复用 inline SVG 标记或本地资源路径。
- **C（首页区块 / 分类原图）**：
  核对 `srcset` 候选记录中是否存在 `NOT_CAPTURED`。若有需要更高分辨率版本，在合同中添加对应视口并重新捕获，不手动伪造缩放图片。
- **D（Catalog / 站点 fixture）**：
  可基于相同的状态合同模式，为商品分类与筛选编写交互前置/后置断言。

---

## 7. 如何识别与处理失败状态

1. **`state_not_reached`**：
   - 含义：执行了点击/悬停动作，但断言的目标面板未出现，或二级列表依然隐藏，或路由不符。
   - 排查：检查 selector 是否与参考站实际 DOM 一致；检查面板是否通过 Portal 挂载到了 body（使用全局选择器而非局部子选择器）。
2. **`missing_required_state`**：
   - 含义：合同中声明了该必须状态，但在任一视口下未被成功捕获。
   - 排查：不可通过缩小 `required_states` 强行通过；需补全该状态的前置条件与动作序列。
3. **`missing_files` / `sha mismatch`**：
   - 含义：资源在 DOM 中被引用，但本地文件缺失或内容被意外损坏/转换。
   - 排查：确认资源 origin 在策略的 `assetOrigins` 中，且未被网络防护器拦截。
