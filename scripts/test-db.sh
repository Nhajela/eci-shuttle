#!/usr/bin/env bash
# Persistent local Postgres for tests: in memory (tmpfs), no fsync. Data is disposable by design.
# Only the cached postgres:18 image is used (Docker Hub is not reachable); never pull another image.
set -e
NAME=shuttle-test-pg
PORT=5547
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then docker start "$NAME" >/dev/null; else
  MSYS_NO_PATHCONV=1 docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:5432" \
    -e POSTGRES_HOST_AUTH_METHOD=trust --tmpfs /var/lib/postgresql:rw postgres:18 \
    -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=300 >/dev/null
fi
for _ in $(seq 1 30); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
echo "test db: postgres://postgres@localhost:$PORT"
