#!/usr/bin/env bash
# Bring the proxy up with one command.
#
# Does whatever is still missing and nothing that is already done: installs
# dependencies, rebuilds only when dist is older than src, imports the Claude
# Code OAuth session if there is none, mints a proxy key only if none is
# configured (minting invalidates the previous one), then starts listening.
#
#   npm start              # 127.0.0.1:8787
#   npm start -- --port 9000
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLI="dist/cli.js"

say() { printf '\033[1m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m==> %s\033[0m\n' "$*" >&2; exit 1; }

# Pull one field out of `status --json` without requiring jq.
field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { console.log(String(JSON.parse(s)[process.argv[1]])); }
      catch { console.log("undefined"); }
    });
  ' "$1"
}

status_json() { node "$CLI" status --json 2>/dev/null || echo '{}'; }

command -v node >/dev/null || die "node is not on PATH"

if [ ! -d node_modules ]; then
  say "installing dependencies"
  npm install --silent
fi

needs_build=0
if [ ! -f "$CLI" ]; then
  needs_build=1
elif [ -n "$(find src tsconfig.json package.json -type f -newer "$CLI" 2>/dev/null | head -1)" ]; then
  needs_build=1
fi
if [ "$needs_build" -eq 1 ]; then
  say "building"
  npm run build --silent
fi
[ -f "$CLI" ] || die "build produced no $CLI"

STATUS="$(status_json)"

if [ "$(printf '%s' "$STATUS" | field loggedIn)" != "true" ]; then
  say "no OAuth session stored — importing the one Claude Code uses"
  node "$CLI" import-claude-code \
    || die "import failed. Sign in with \`claude\` on this machine first, then rerun."
  STATUS="$(status_json)"
fi

if [ "$(printf '%s' "$STATUS" | field proxyKeyConfigured)" != "true" ]; then
  say "no proxy key configured — minting one. It is printed once, copy it now:"
  node "$CLI" key
  STATUS="$(status_json)"
fi

PORT="$(printf '%s' "$STATUS" | field port)"
case "$PORT" in
  ''|undefined|null) PORT=8787 ;;
esac

# Ask the port whether a proxy is actually answering. Checking for a socket
# instead was wrong twice over: `lsof -ti tcp:PORT` also matches a client's
# closed outbound connection, and a listener that is not this proxy is a
# failure to report rather than a reason to exit quietly.
health() {
  node -e '
    const http = require("http");
    const req = http.get(
      { host: "127.0.0.1", port: Number(process.argv[1]), path: "/healthz", timeout: 2000 },
      (res) => process.exit(res.statusCode === 200 ? 0 : 1),
    );
    req.on("error", () => process.exit(1));
    req.on("timeout", () => { req.destroy(); process.exit(1); });
  ' "$PORT"
}

if health; then
  say "a proxy is already answering on 127.0.0.1:$PORT — nothing to do"
  exit 0
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "something is listening on $PORT but it is not this proxy. Stop it, or use --port."
fi

say "starting on 127.0.0.1:$PORT"
exec node "$CLI" start "$@"
