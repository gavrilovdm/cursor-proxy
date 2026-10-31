# cursor-proxy: setup instructions for an agent

Give this file to a coding agent (Claude Code, Cursor agent, and so on) with a
request such as "Install cursor-proxy following AGENT_SETUP.md, part A" or
"...part B on this server, then part C for project X". Part A is a local Mac,
part B is a Linux server, part C connects a project to an installed proxy.

## Rules for the agent

- Never print, log, or commit the `cpx_...` key or the files in
  `~/.cursor-proxy/`. `node dist/cli.js key` prints the key once: show it to
  the user and save it only where they say (a `.env` file that git ignores, a
  secret manager, or Cursor settings).
- Check that a step worked before going to the next one. The check is given
  under each step.
- Run one proxy per machine. If `curl -s http://127.0.0.1:8787/healthz`
  already returns `{"status":"ok",...}`, the proxy is installed: skip to
  part C, and run `node dist/cli.js update` first if the version is older
  than the project needs.
- Do not open port 8787 to the internet. Public access goes through ngrok
  (part A) or a TLS reverse proxy (part B).
- Ask the user before any step that needs them: logging in to Claude Code,
  choosing a domain, changing DNS, or entering settings in Cursor.

## Part A. Local machine (macOS + ngrok)

ngrok is only for a local machine. Its URL changes on every restart, and it
only works while your laptop is on.

1. **Prerequisites.** `node -v` is 22 or higher. Claude Code is logged in on
   this Mac (`claude` starts without asking to log in). Otherwise ask the user
   to log in.
2. **Install.**
   ```sh
   git clone https://github.com/gavrilovdm/cursor-proxy ~/cursor-proxy
   cd ~/cursor-proxy && npm install && npm run build
   ```
   Check: `ls dist/cli.js`.
3. **Session and key.**
   ```sh
   node dist/cli.js import-claude-code
   node dist/cli.js key          # give the cpx_... key to the user
   ```
   Check: `node dist/cli.js status` shows `loggedIn true` and
   `proxyKeyConfigured true`.
4. **Run as a service** (starts at login, restarts if it dies):
   ```sh
   node dist/cli.js install-service   # log: ~/.cursor-proxy/logs/proxy.log
   ```
   Check: `curl -s http://127.0.0.1:8787/healthz` returns `"status":"ok"`.
5. **Public URL (only needed for Cursor).** `ngrok http 8787`, then use the
   `https://....ngrok-free.app` URL it prints.
   Check: `curl -s https://<ngrok-host>/v1/models -H "Authorization: Bearer <cpx_key>"`
   lists `cpxopus`, `cpxsonnet` and `cpxhaiku`.

On macOS the proxy keeps the token in sync with Claude Code through Keychain.
If you get `revoked` or `login_required`, run `node dist/cli.js import-claude-code`,
then `node dist/cli.js uninstall-service && node dist/cli.js install-service`.

## Part B. Server (Linux, systemd, HTTPS)

On a server the proxy listens on `127.0.0.1:8787`. A reverse proxy with a TLS
certificate makes it public. This gives a stable URL and runs without your
laptop. There is no Keychain on Linux, so the session is copied once from a
Mac. Nothing keeps it in sync after that.

1. **Prerequisites on the server:** Node 22 or higher, git, and a domain whose
   DNS A or AAAA record points to the server (ask the user for it, for example
   `proxy.example.com`). Ports 80 and 443 must be open. Port 8787 must stay
   closed.
2. **Install as a dedicated user:**
   ```sh
   sudo useradd --system --create-home --shell /usr/sbin/nologin cursorproxy
   sudo -u cursorproxy git clone https://github.com/gavrilovdm/cursor-proxy /home/cursorproxy/cursor-proxy
   cd /home/cursorproxy/cursor-proxy && sudo -u cursorproxy sh -c 'npm ci && npm run build'
   ```
3. **Copy the session from a Mac.** On the Mac, run part A steps 1–3 if that
   has not been done, then:
   ```sh
   scp ~/.cursor-proxy/config.json ~/.cursor-proxy/credentials.json <server>:/tmp/
   ```
   On the server:
   ```sh
   sudo install -d -m 700 -o cursorproxy /home/cursorproxy/.cursor-proxy
   sudo install -m 600 -o cursorproxy /tmp/config.json /tmp/credentials.json /home/cursorproxy/.cursor-proxy/
   rm /tmp/config.json /tmp/credentials.json
   ```
   The session has one rotating refresh token. Whichever side refreshes it
   second gets logged out, and the server cannot follow the Mac through
   Keychain. To avoid this, give the server its own session: after copying,
   log in to Claude Code on the Mac again (`/logout`, then `/login`) and do not
   import into the server again. If the server reports `revoked`, repeat this
   step.

   Fallback without a Mac (marked experimental in the README): on the server,
   run `sudo -u cursorproxy node dist/cli.js configure claude-code --manual`,
   then `sudo -u cursorproxy node dist/cli.js login`. Open the printed URL in
   any browser, then paste the callback URL or the `code#state` value it shows
   back into the terminal.
4. **Key.**
   ```sh
   cd /home/cursorproxy/cursor-proxy && sudo -u cursorproxy node dist/cli.js key
   ```
   Give the key to the user.
   Check: `sudo -u cursorproxy node dist/cli.js status` shows `loggedIn true`
   and `proxyKeyConfigured true`.
5. **systemd service.** Create `/etc/systemd/system/cursor-proxy.service`:
   ```ini
   [Unit]
   Description=cursor-proxy
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=cursorproxy
   WorkingDirectory=/home/cursorproxy/cursor-proxy
   ExecStart=/usr/bin/env node dist/cli.js start --host 127.0.0.1 --port 8787
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
   ```sh
   sudo systemctl daemon-reload && sudo systemctl enable --now cursor-proxy
   ```
   Check: `curl -s http://127.0.0.1:8787/healthz` returns `"status":"ok"`.
   Logs: `journalctl -u cursor-proxy -f`.
6. **HTTPS with Caddy** (it gets the certificate automatically). Install Caddy
   following caddyserver.com/docs/install, then write `/etc/caddy/Caddyfile`:
   ```text
   proxy.example.com {
       reverse_proxy 127.0.0.1:8787 {
           flush_interval -1
       }
   }
   ```
   `flush_interval -1` passes streamed responses (SSE) through without
   buffering. Run `sudo systemctl reload caddy`.
   Check: `curl -s https://proxy.example.com/v1/models -H "Authorization: Bearer <cpx_key>"`
   lists the `cpx*` models. The same request without the header returns 401.

   **No domain, or no open ports:** use a named Cloudflare Tunnel
   (`cloudflared tunnel create`, then route a hostname to
   `http://127.0.0.1:8787`). `cloudflared tunnel --url ...` creates a temporary
   URL, which has the same problem as ngrok and is not suitable for a server.
7. **Update:**
   ```sh
   cd /home/cursorproxy/cursor-proxy && sudo -u cursorproxy node dist/cli.js update && sudo systemctl restart cursor-proxy
   ```

## Part C. Connecting a project

Projects use the installed proxy. They do not vendor it, start their own copy,
or install their own service, because two proxies fight over port 8787.

### From code (any OpenAI-compatible client)

1. Pick the base URL. If the code runs on the same machine as the proxy, use
   `http://127.0.0.1:8787/v1`. Otherwise use `https://<public-host>/v1`.
2. Add the settings to the project's `.env` (make sure `.env` is in
   `.gitignore`) and to `.env.example` without the values:
   ```text
   OPENAI_BASE_URL=http://127.0.0.1:8787/v1
   OPENAI_API_KEY=cpx_...
   LLM_MODEL=cpxsonnet
   ```
   Most SDKs (`openai` for Python and JS, LangChain, LiteLLM with the `openai/`
   prefix) read `OPENAI_BASE_URL` and `OPENAI_API_KEY`, or accept
   `base_url`/`baseURL` and `api_key`/`apiKey`. Models are `cpxopus`,
   `cpxsonnet` and `cpxhaiku`. Outside Cursor, `claude-*` names also work.
3. Name the project: send the header `x-cpx-project: <repo-name>` with every
   request (most SDKs take default headers: `default_headers` in Python,
   `defaultHeaders` in JS). The proxy log then attributes token usage to it:
   `usage project=<repo-name> model=... in=... out=...`.
4. Startup check (recommended): `GET /healthz` on the proxy root (for example
   `http://127.0.0.1:8787/healthz`, without `/v1`) returns `{"status":"ok","version":"x.y.z"}`. If the version is below
   0.2.0, stop with a clear error, because the fixes below were added in 0.2.0.
5. Do not add workarounds for these in the project. The proxy already handles
   them: `system`/`developer` messages, `temperature` on `claude-opus-5`, empty
   text next to `tool_calls`, and `response_format` (`json_schema` and
   `json_object`), whose result comes back in `message.content`.
6. Smoke test: send
   `[{"role":"system","content":"Reply with exactly: GLOKAYA"},{"role":"user","content":"2+2?"}]`.
   The answer must be `GLOKAYA`, and the proxy log shows
   `POST /v1/chat/completions -> 200`.

### Cursor

Ask the user to do this (it is in Cursor's settings UI, Settings -> Models):

1. `OpenAI API Key` = `cpx_...`. Do not use the Anthropic field.
2. `Override OpenAI Base URL` = `https://<public-host>/v1`: the ngrok URL from
   part A or the domain from part B. `127.0.0.1` does not work in Cursor.
3. Add the models `cpxopus`, `cpxsonnet` and `cpxhaiku`, then pick one in chat.
4. Check: a chat message adds `chat model=cpx... ` and `-> 200` lines to the
   proxy log (`~/.cursor-proxy/logs/proxy.log` or `journalctl -u cursor-proxy`).
   If the log does not change, Cursor did not use the proxy.
