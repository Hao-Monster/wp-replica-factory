# WooCommerce staging MVP

本轮提供单一 WP-CLI staging adapter，支持 `local` 与 `ssh` transport，共用同一安全契约。

```bash
python scripts/replica.py init-site --output site-project --project-id pilot --reference-bundle .replica/downloads/owned
python adapters/wordpress-staging/build.py --reference-bundle .replica/downloads/owned
python adapters/wordpress-staging/adapter.py --config examples/wordpress-staging.example.json doctor
python adapters/wordpress-staging/adapter.py --config examples/wordpress-staging.example.json seed
python adapters/wordpress-staging/adapter.py --config examples/wordpress-staging.example.json health
python adapters/wordpress-staging/adapter.py --config examples/wordpress-staging.example.json cleanup
```

配置必须明确 `environment=staging`、`production=false`，目标 WordPress 必须返回
`replica_staging_marker=replica-fixture`，否则所有命令在写入前 BLOCKED。CI 使用固定
WordPress 6.8.2、WooCommerce 10.0.4、PHP 8.3、MariaDB 11.4 的隔离 Compose 环境。
真实远程 staging smoke 仍为 `PENDING_USER_STAGING`。
