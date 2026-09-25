# 自有测试站与可重复测试数据

本仓库的 G1 基础 fixture 是一个**仅本地环回**的静态测试站，不是商城实现、WooCommerce 集成或外站复刻。源码在 `tests/fixtures/owned-site/`，生命周期入口在 `scripts/fixture_site.py`。

## 环境准备

- Python 3.10+；本次验证使用 Python 3.13.7。
- Playwright Python 版本固定在 `requirements-fixture.txt`，首次安装浏览器：

```powershell
py -3 -m pip install -r requirements-fixture.txt
py -3 -m playwright install chromium
```

CI 使用 Ubuntu runner，并安装同一锁定版本的 Chromium。

## 命令

从仓库根目录执行：

```powershell
py -3 -X utf8 scripts/fixture_site.py seed
py -3 -X utf8 scripts/fixture_site.py serve --port 8765
py -3 -X utf8 scripts/fixture_site.py health --url http://127.0.0.1:8765
py -3 -X utf8 scripts/fixture_site.py reset
py -3 -X utf8 scripts/fixture_site.py test
```

`serve` 只绑定 `127.0.0.1`，端口 `0` 会自动选择空闲端口并打印实际地址；前台进程用 Ctrl+C 停止。`test` 自己启动临时服务、创建两个全新的浏览器上下文并在结束时关闭服务和浏览器。

`seed` 和 `reset` 将可变运行状态写入被忽略的 `.replica/owned-site/`。它们不会修改版本化 fixture。`reset` 重建种子副本；测试浏览器不使用持久化 storage，因此每次新建上下文即完成浏览器状态重置。

## 页面与状态

- `/grid.html`：4 个固定商品，桌面 4 列、手机 2 列。
- `/lazy.html`：滚动到区域后才切换加载背景并显示 SVG 标记。
- `/filters.html`：可访问的菜单开关，以及 all/home/stationery/bags/no-match/clear 筛选状态。

固定设置为 desktop `1440x1000`、mobile `390x844`、DPR 1、`en-US`、UTC，详见 `tests/fixtures/owned-site/STATE_MATRIX.md`。

资源清单在 `tests/fixtures/owned-site/RESOURCE_MANIFEST.json`，包含相对路径、SHA-256、类型、来源和许可证。商品图与背景图为本项目自造 SVG；字体为 Google Fonts Inter，SIL Open Font License 1.1，运行时只从本地测试站加载。

浏览器摘要来自真实页面，包含商品 ID/顺序、筛选结果、懒加载状态和外部请求清单。两次独立上下文都必须各自通过断言并生成相同的规范化摘要；这不是逐像素视觉评估。

## 故障排查与清理

- `health` 失败：确认 `serve` 仍运行且 URL/端口一致。
- 浏览器未安装：执行 `py -3 -m playwright install chromium`；未安装时不得将验收标记为通过。
- 运行状态异常：执行 `reset`，或删除被忽略的 `.replica/owned-site/` 后重新 `seed`。
- 页面请求外部 origin、路径穿越、重复商品 ID、损坏资源或缺状态均应使检查失败。

本 Issue 不实现通用采集器、视觉评估器、WooCommerce 预览闭环、生产发布、支付、订单、邮件或 webhook。下游使用者为 Issue #2、#3、#4。
