# Docker Infrastructure

This directory is reserved for infrastructure files that grow beyond the root
`docker-compose.yml`, such as database initialization scripts, MinIO bootstrap
jobs, and local observability configuration.

The current foundation runs with:

```bash
docker compose up --build
```
