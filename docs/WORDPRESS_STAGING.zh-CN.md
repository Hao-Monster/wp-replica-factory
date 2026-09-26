# WordPress / WooCommerce Staging Core

本适配器是 G3 的可复用 staging core，不包含具体店铺代码。配置把 transport 与 runtime 分开：

- transport: `local` 或 `ssh`
- runtime: `host-wpcli` 或 `docker-compose-wordpress`

Docker Compose runtime 只使用 `docker compose` 和稳定 service name。需要容器 ID 时动态执行
`docker compose ps -q <service>`；不得把面板产品名或具体 container name 写进契约。

## 写入门禁

配置中的 `environment=staging` 不是授权依据。deploy、activate、seed、cleanup、rollback、
order-test 等写操作必须从目标 WordPress 运行时读取
`wp_get_environment_type()`。只有 `staging`，或 policy 明确允许的 `development` 可以继续；
`production`、空值和未知值均 BLOCKED。

门禁拆分为：
`REMOTE_ACCESS_GATE`、`WORDPRESS_ENVIRONMENT_GATE`、`THEME_DEPLOY_GATE`、
`PRODUCT_SEED_GATE`、`CHECKOUT_GATE`、`ORDER_GATE`。主题部署不依赖支付、邮件或订单门禁。

## WP-CLI runtime

`run_wp_cli(args)` 对调用方隐藏三种实现：host WP-CLI、WordPress container 内的 WP-CLI、
或官方临时 `wordpress:cli`。Compose service 没有 `wp` 时，临时 CLI 共享目标 WordPress
volume 和 Docker network，只接收必要的四个 `WORDPRESS_DB_*` 值。临时 env 文件权限 0600，
在 finally/退出路径删除；不得保存到 CI artifact，也不得输出完整 container env。

## Theme artifact / deploy / rollback

标准制品是 `theme.zip` 与 `manifest.json`。manifest 包含
`theme_slug`、`theme_version`、`git_sha`、`artifact_sha256`、
`framework_version`、`build_timestamp`、`reference_status`。部署前重新计算 SHA256。

部署只处理目标 theme slug：解压到 `<slug>.next`，执行 PHP lint，再用
current/previous/next rename/swap。首次部署只有 policy `activate=true` 才激活；已激活主题更新
只替换文件。部署后从 WordPress 重新读取目标/active theme 与 version，对不上 manifest 即失败并
尝试 rollback。Rollback 仅恢复该主题文件和必要的 active theme，不回滚数据库、订单、uploads 或插件。

## Health 与 HTTPS

doctor 明确区分 CLI runtime 与 Web runtime。CLI 中 `is_ssl()==false` 不是 Web HTTPS 失败证据。
`webRuntimeHealth` 对配置的 `healthPaths` 发真实 HTTP(S) 请求，记录 final URL、redirect chain、
HTTPS、HTTP 状态、WordPress critical error 和 critical mixed-content 失败。doctor 只报告，
不会自动改 `home`、`siteurl` 或 `wp-config.php`。

## Fixture / order

`seed` 与 `cleanup` 必须显式 `--fixture`，使用 marker `replica-fixture` 和稳定 SKU
`replica-fixture-001` 到 `004`。Order test 必须通过独立 `ORDER_GATE`：真实支付禁用、
邮件禁用、active business webhook=0、外部库存同步禁用、fixture marker 有效；否则
`TEST_ORDER_BLOCKED`。这些 side-effect gate 不阻塞 theme deploy 或 visual testing。

示例：

```bash
python3 adapters/wordpress-staging/build.py --reference-status owned
python3 adapters/wordpress-staging/adapter.py --config staging.json doctor
python3 adapters/wordpress-staging/adapter.py --config staging.json deploy --artifact .replica/artifacts/theme/theme.zip
python3 adapters/wordpress-staging/adapter.py --config staging.json seed --fixture
python3 adapters/wordpress-staging/adapter.py --config staging.json health
python3 adapters/wordpress-staging/adapter.py --config staging.json rollback
```

框架 CI 只使用隔离 Compose fixture；不访问用户 staging、真实 SSH、真实 payment/mail 或商业目标站。
