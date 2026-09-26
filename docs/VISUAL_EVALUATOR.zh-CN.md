# 独立视觉评估器

`tools/visual-evaluator/` 对候选截图和获准 baseline 做确定性的 RGBA 逐像素比较。baseline 是只读输入；普通 evaluate 没有更新 baseline 的入口。候选与 baseline 都必须通过 manifest 声明页面、route、viewport、state、图片路径、SHA256、尺寸和 capture timestamp。

```bash
node tools/visual-evaluator/cli.mjs evaluate \
  --baseline baseline \
  --candidate candidate \
  --policy tools/visual-evaluator/visual-policy.example.json \
  --out reports/run
node tools/visual-evaluator/cli.mjs verify-report reports/run
```

policy 的 `pixel.maxDifferentRatio` 和 `pixel.maxMeanAbsoluteError` 必须是有限数；比例必须在 0 到 1，不能使用 NaN、Infinity、负数或静默 clamp。requiredStates、regions、字体证据和 missing image 规则由 policy 声明。

报告包含输入 manifest/policy SHA、逐张比较、尺寸、不同像素、比例、MAE、最大通道误差、区域结果、差异 PNG、状态缺失、重复 state、stale candidate、font fallback 和 missing asset。`verify-report` 会重新读取输入摘要并检查 diff 文件，不能通过手改 `overall_status` 伪造成功。

退出码：`0=pass`、`2=visual mismatch`、`3=invalid input/integrity failure`、`4=incomplete capture`。本轮不实现 baseline 自动批准、AI 视觉评分、阈值自动调整、WordPress 部署或真实商业站截图评估。
