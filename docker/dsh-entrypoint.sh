#!/usr/bin/env bash
set -euo pipefail

# Resolve the container's own IPv4 address without relying on tools that a
# minimal image may not ship (hostname, awk). The listener never accepts a
# wildcard, so bind a concrete address.
resolve_bind_host() {
  node -e '
    const os = require("node:os")
    for (const list of Object.values(os.networkInterfaces()))
      for (const a of list ?? [])
        if (a.family === "IPv4" && !a.internal) { process.stdout.write(a.address); process.exit(0) }
    process.exit(1)
  '
}

if [[ "${1:-}" == "web" ]]; then
  shift
  bind_host="${DSH_BIND_HOST:-}"
  if [[ -z "$bind_host" || "$bind_host" == "0.0.0.0" || "$bind_host" == "::" ]]; then
    bind_host="$(resolve_bind_host)" || {
      echo "dsh-entrypoint: no non-internal IPv4 address to bind; set DSH_BIND_HOST to a concrete address" >&2
      exit 1
    }
  fi
  port="${DSH_PORT:-3080}"
  public_url="${DSH_PUBLIC_URL:-http://localhost:${port}/}"
  args=(--profile web --no-open --host "$bind_host" --port "$port" --public-url "$public_url")
  for host in ${DSH_TRUSTED_HOSTS:-}; do
    args+=(--trusted-host "$host")
  done
  exec node /app/lib/bin.js "${args[@]}" "$@"
fi

if [[ "${1:-}" == "headless" ]]; then
  shift
  exec node /app/lib/bin.js --profile headless "$@"
fi

exec node /app/lib/bin.js "$@"
