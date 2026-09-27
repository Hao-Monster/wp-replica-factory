# A 消费者交接文档：参考包流水线 MVP 与动态页面入口去向表

> **对接核验状态**：`CONSUMER_NOT_YET_VERIFIED`  
> **框架维护者验证**：`NEW_DIRECTORY_SMOKE: PASSED`（已在干净独立目录完成 V1-V4 及 E1-E10 离线端测试与真实 PDP 资料适配）  
> **固定框架可用 SHA**：通过 `git rev-parse HEAD` 动态读取  
> **交接目标**：Agent A（WordPress 全站页面创建与导航连通）与 Agent C（产品目录与事实核对）

---

## 1. 适用模式与能力边界说明

- **流水线 MVP 当前核心验证**：`owned-fixture`（自有受控参考包流水线，无外部网络依赖）。
- **公网目标模式状态**：下载器底层已支持有限的 `authorized-public` 模式（要求显式 HTTPS 域名、单一 page origin、严格 network guard，自动阻断非法外部请求与写方法）。
- **边界与非目标**：本框架不进行 WAF 绕过、验证码破解或代理池轮换，不默认依赖用户后台登录或私有会话。
- **定位**：为 WooCommerce 前端主题与组件还原提供高保真离线参考证据（HTML、截图、CSS、真实字体、图片/SVG及交互状态快照），非黑盒克隆器。

---

## 2. 动态提取的 PDP 入口去向表 (Dynamic Entry Points)

框架维护者（E）已根据 iPhone 15 详情页原 DOM 节点，通过 `parse5` 动态提取生成以下**入口去向表**（非人工固定 13 项，数量由实际输入节点决定）：

### 2.1 铁律与概念区分（必读）
1. **真实节点事实优先**：
   - 每一个条目严格来自原 DOM 中的实际节点；
   - `Flash Sale` 在原 DOM 中仅为 `div` 标签，没有链接，**严禁自动推定为导航到 `/collections/flash-sale`**；
   - 颜色与规格按钮没有 query 证据，**严禁自行生成 `?color=...` 冒充原站行为**；
   - 无法由静态 DOM 确认的动作统一标记为 `UNKNOWN`，交由 A/C 在具备浏览器上下文时核验。
2. **“缺本地参考文件”不等于“线上 404”**：
   - 缺本地参考（`MISSING_LOCAL_REFERENCE_PAGE` / `MISSING_LOCAL_REFERENCE_STATE`）表示采集包中尚未包含该页面的离线快照，绝不表示线上目标是 404。
3. **职责划分**：
   - 本表协助 A/C 明确哪些页面还缺采集资料；
   - WordPress 站内的真实 Page 创建、URL 永久链接配置、菜单挂载与点击验收继续由 Agent A 负责。

### 2.2 动态入口清单（当前输入共提取 12 项）
| 序号 | 所在位置 | 可见文字 / 名称 | 节点类型 / 动作属性 | 解析目标 URL | 入口类型 | 本地参考 | 缺口状态 | 说明与指引 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `buy-box` | **Unlocked device information** | `button[aria-label="Unlocked..."]` | `UNKNOWN` | `Modal` | ❌ 否 | `STATIC_DATA_UNKNOWN_JS_ACTION` | 解锁说明模态框，需浏览器交互核对 |
| 2 | `buy-box` | **4.7 Trustpilot (281 reviews)** | `button` | `UNKNOWN` | `Button action` | ❌ 否 | `STATIC_DATA_UNKNOWN_JS_ACTION` | 评价弹层或跳转按钮 |
| 3 | `buy-box` | **Trustpilot Button** | `button` | `UNKNOWN` | `Button action` | ❌ 否 | `STATIC_DATA_UNKNOWN_JS_ACTION` | 交互按钮 |
| 4 | `gallery` | **Go to image 1** | `button[aria-label="Go to image 1"]` | `UNKNOWN` | `Carousel` | ❌ 否 | `MISSING_LOCAL_REFERENCE_STATE` | 轮播切图动作，5张原图在本地就绪但未录制动效 |
| 5 | `gallery` | **Go to image 2** | `button[aria-label="Go to image 2"]` | `UNKNOWN` | `Carousel` | ❌ 否 | `MISSING_LOCAL_REFERENCE_STATE` | 轮播切图动作 |
| 6 | `gallery` | **Go to image 3** | `button[aria-label="Go to image 3"]` | `UNKNOWN` | `Carousel` | ❌ 否 | `MISSING_LOCAL_REFERENCE_STATE` | 轮播切图动作 |
| 7 | `gallery` | **Go to image 4** | `button[aria-label="Go to image 4"]` | `UNKNOWN` | `Carousel` | ❌ 否 | `MISSING_LOCAL_REFERENCE_STATE` | 轮播切图动作 |
| 8 | `gallery` | **Go to image 5** | `button[aria-label="Go to image 5"]` | `UNKNOWN` | `Carousel` | ❌ 否 | `MISSING_LOCAL_REFERENCE_STATE` | 轮播切图动作 |
| 9 | `buy-box` | **before trade-in** | `button#e2e-pdp-before-trade-in` | `UNKNOWN` | `Modal` | ❌ 否 | `STATIC_DATA_UNKNOWN_JS_ACTION` | 以旧换新估价弹窗 |
| 10 | `buy-box` | **new $799.00** | `button` | `UNKNOWN` | `Button action` | ❌ 否 | `STATIC_DATA_UNKNOWN_JS_ACTION` | 价格提示按钮 |
| 11 | `buy-box` | **Professionally Refurbished...** | `button` | `UNKNOWN` | `Button action` | ❌ 否 | `STATIC_DATA_UNKNOWN_JS_ACTION` | 翻新质保说明弹层 |
| 12 | `buy-box` | **Add to Cart** | `button#e2e-pdp-add-to-cart` | `UNKNOWN` | `Business action` | ❌ 否 | `LIVE_BUSINESS_TRANSACTION_RESERVED` | WooCommerce 加购事务保留字段 |

---

## 3. 命令行调用参考

```bash
# 1. 运行资料适配
node tools/pipeline/adapt-evidence.mjs \
  --input .replica/intake/pdp-iphone15/raw \
  --output .replica/intake/pdp-iphone15/adapted

# 2. 导出静态预览包（桌面与手机拥有独立 view 路径，绝不相互覆盖）
node tools/pipeline/export-preview.mjs \
  --input .replica/intake/pdp-iphone15/adapted \
  --output dist-preview
```
