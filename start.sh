#!/bin/sh
# One image, two roles (SPEC §2b). ROLE=worker runs the scheduler; anything else migrates, then serves web.
set -e
if [ "$ROLE" = "worker" ]; then
  exec node worker.cjs
fi
node migrate.cjs
exec node apps/web/server.js
