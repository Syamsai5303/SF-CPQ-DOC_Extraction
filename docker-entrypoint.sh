#!/bin/sh
set -e

# Apply pending Prisma migrations on boot (idempotent). Set RUN_MIGRATIONS=false
# when migrations are run as a separate one-off task (e.g. an ECS run-task).
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Running database migrations…"
  npx --no-install prisma migrate deploy
fi

exec "$@"
