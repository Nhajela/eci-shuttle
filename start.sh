#!/bin/sh
# One image, two roles (SPEC §2b). ROLE=worker runs the scheduler; anything else migrates, then serves web.
set -e
if [ "$ROLE" = "worker" ]; then
  # the worker holds a connection per running job lock, so it needs a bigger pool than web (default 10)
  export DB_POOL_MAX="${DB_POOL_MAX:-20}"
  exec node worker.cjs
fi
node migrate.cjs
# listening on :: throws when IPv6 is disabled; fall back to IPv4 only
if [ "$HOSTNAME" = "::" ] && [ "$(cat /proc/sys/net/ipv6/conf/lo/disable_ipv6 2>/dev/null || echo 1)" != "0" ]; then
  export HOSTNAME=0.0.0.0
fi
exec node apps/web/server.js
