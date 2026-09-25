# Adapter contracts — 接口设计，尚待实现

本文件定义平台建设目标，不表示这些 adapter 已经存在。

## 1. Source adapter

输入：批准的 origins、routes/states/regions、runtime、授权素材范围、固定 fixture 和采集预算。
输出：baseline 目录、assets-manifest.json、page-spec.json、coverage.json、runtime.json、missing.json。

baseline 中每张图以 page:viewport:state:region 标识；每个用例对应可重放步骤与采集时间。
素材记录 source URL / currentSrc、文件 SHA-256、MIME、原尺寸、显示尺寸、裁剪、页面元素、授权来源及本地位置。
字体记录实际网络文件和加载结果，不只记录 CSS font-family。缺失或跨域读取受限应留痕，不猜数据。
授权素材可以存在私有对象存储中；不得把客户数据、支付信息、登录状态或未脱敏 HAR 混入基准。
同一基准至少重复采集并检查动态漂移；轮播、倒计时、广告、地区与商品价格不稳定需事先固定数据或标明例外。
在 raw_rgba_equal 模式下不允许未经批准掩码；有例外的报告不得称全页逐像素完全一致。

## 2. Runtime / WordPress adapter

开发服务 URL 和所在网络由人工提供。云端 localhost 指云端 runner 自己，不指用户电脑。
若只有 WP REST API 凭据，可以读写被授权内容，但不能假定有主机文件部署权限。
本地目录/容器/SSH/托管平台 API 是不同适配器，先实现实际使用的一种。
记录现有 WP/WooCommerce/PHP/主题与插件版本，避免为了使用模板破坏既有环境。
测试数据要有明确归属和稳定 ID；订单测试仅在隔离测试库。

## 3. Trusted evaluator

评估在独立、固定版本工具环境中进行。报告使用下面结构（值只是结构说明，不是通过报告）：

```json
{
  "schema_version": 1,
  "candidate_id": "候选制品或制品总清单的SHA256",
  "baseline_sha256": "来自受保护基准流程的SHA256",
  "policy_sha256": "受保护project配置的规范化JSON摘要",
  "runner_status": "complete",
  "pixel_mode": "raw_rgba_equal",
  "missing_assets": 0,
  "missing_fonts": 0,
  "skipped": 0,
  "blocked": 0,
  "visuals": [
    {
      "id": "home:desktop:default:header",
      "status": "pass",
      "different_pixels": 0,
      "total_pixels": 144000,
      "same_dimensions": true
    }
  ],
  "checks": [{"id": "wc.cart", "status": "pass"}]
}
```

必须输出 project.json 范围中的所有截图 ID 和 required_checks；上面的部分示例不能通过本包 gate。
PNG 压缩字节不同不一定像素不同；评估器须解码并按 RGBA 比较。不同截图尺寸必定失败。
另外保存可读的差异图和失败证据；不要只输出总相似度。
报告对应制品必须实际部署到隔离测试目标并经 build marker 验证，避免比较另一个工作区或旧缓存。
实际执行时：

```bash
python3 scripts/replica.py gate \
  --project project.json \
  --report reports/evaluation.json \
  --candidate-id "$TRUSTED_CANDIDATE_SHA256" \
  --baseline-sha "$TRUSTED_BASELINE_SHA256" \
  --policy-sha "$TRUSTED_POLICY_SHA256"
```

上述三个期望摘要必须来自独立 CI/受保护配置，不是从待验证报告原样读出。
该脚本仅做契约验证；Agent 可随意改写报告时它没有真实性保证。可信 runner 应重新计算或签名/验证产物来源。

## 4. Scheduler / Agent adapter

任务输入：project_id、run_id、候选 code ref、失败区域和只读证据。
Agent 输出：补丁/候选提交与说明，不输出最终判定。
控制器独立维护累计预算、锁与下一阶段。Agent 退出 0、说“完成”或输出格式合法都不是成功条件。
多站点用独立工作树、浏览器 profile、测试数据库、密钥作用域；同站点发布串行。
本包 init/status 仅为检查点工具，持久化工作队列、lease 和自动重试需要实现。

## 5. Deploy adapter

输入：project_id、不可变制品 ID、可信 gate 结果、批准的 environment 和 release_id。
从控制侧可信映射得到 host/path/credentials，不能接受 Agent 任意指定主机或远程 shell。
制品下载后检查 SHA、来源和 ZIP 路径，拒绝路径穿越/符号链接；不要直接解压未验证归档。
发布主题/允许的插件和批准的内容迁移；不覆盖 wp-config.php、数据库、orders、users 或 uploads。
凭据存在发布环境，不存在编写主题的 Agent 环境。注意 PHP 主题本身具备服务器代码执行能力，生产 PHP 变更仍需审阅。
远端回传真实版本标识、制品摘要、健康结果、previous_release。适配器提供 rollback(previous_release)。
代码回滚不等于数据库无损回滚；数据迁移需采用兼容式或另行批准方案。
