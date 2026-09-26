name: wp-rebuild
description: 将已冻结的页面规格实现为可运行的 WordPress 与 WooCommerce 定制主题及必要插件，不生成脱离后端的假商城。
---

# WordPress Rebuild
读取 AGENTS.md 与冻结规格，确认已安装 WordPress/WooCommerce 版本，不强制升级现有服务。
可引入 WordPress/agent-skills 中相关规则，但必须固定并审阅实际版本，避免全量冲突导入。
主题负责布局、字体和组件；WooCommerce 负责真实商品、变体、购物车和订单。
不能从前端观察推断原站的供应商、库存、保修或退货业务规则。没有业务规格的功能记录待实现。
先设计 tokens 和基础布局，再构建共享组件与模板；禁止先 React 整站再临时改为 WordPress，除非项目明确选择 headless。
商品与内容通过稳定 SKU / 外部键幂等导入，只对明确归属该项目的数据更新。
对比用固定 fixture 数据；自己的真实商品不同于参考站时，分离“参考复现验收”和“真实商品接入验收”，不宣称两者截图完全相等。
不改核心文件，不在线编辑生产，不覆盖数据库、uploads、客户、订单、密钥或生产配置。
每次生成候选后交给独立测试，不能自己把缺少的断言补成 pass。

## Staging MVP boundary

When a validated Downloader reference bundle is available, build only through the
WP-CLI staging adapter (`adapters/wordpress-staging`). Treat the bundle as read-only
evidence: use manifest/routes/resources/pages/site and never copy raw HAR, cookies,
authorization headers, or business APIs into a theme. The adapter requires an explicit
staging marker and `production=false` before every write. Use the generic WooCommerce
theme scaffold and isolated fixture products for pilot smoke; production release,
visual evaluation and unrelated host adapters remain out of scope.
