#!/bin/sh
set -e
npx prisma migrate deploy
if [ -f dist/main.js ]; then
  exec node dist/main.js
fi
exec node dist/src/main.js
