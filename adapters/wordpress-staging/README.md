# WordPress staging adapter

This is the single WP-CLI adapter used by the staging pilot. It supports local and SSH transports and requires an explicit `environment=staging`, `production=false`, and the remote `replica_staging_marker` before every command. Secrets stay in the environment or SSH agent.
