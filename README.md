# cursor-proxy

An OpenAI-compatible proxy that sends chat requests to Anthropic using a Claude
Code OAuth session instead of an Anthropic API key. It works for Cursor and for
any OpenAI-compatible client in your own code.

```text
client (OpenAI shape) -> cursor-proxy :8787 -> api.anthropic.com/v1/messages
                         checks the cpx_... key, converts the request, adds the OAuth token
```

**Installing with an agent:** give it [`AGENT_SETUP.md`](AGENT_SETUP.md). It
covers installing locally (macOS + ngrok), installing on a server (systemd +
HTTPS), and connecting a project.

## Quick start (macOS, local)

Requires Node >= 22 and Claude Code logged in on this Mac.

```sh
git clone https://github.com/gavrilovdm/cursor-proxy ~/cursor-proxy
cd ~/cursor-proxy && npm install && npm run build
node dist/cli.js import-claude-code   # copies the OAuth session from Keychain
node dist/cli.js key                  # prints the cpx_... key once
node dist/cli.js install-service      # launch agent; or `start` to run in the foreground
curl http://127.0.0.1:8787/healthz    # {"status":"ok","version":"..."}
```

Your own code can use `http://127.0.0.1:8787/v1` directly. **Cursor cannot**:
it calls custom base URLs from its own servers, which refuse private
addresses. It needs a public HTTPS URL:

- **Local machine:** `ngrok http 8787`. The URL changes when ngrok restarts.
- **Server:** keep the proxy on `127.0.0.1` and put a reverse proxy with TLS
  in front of it (Caddy, or Cloudflare Tunnel). See
  [AGENT_SETUP.md, part B](AGENT_SETUP.md#part-b--server-linux-systemd-https).

## Cursor

Settings -> Models:

1. `OpenAI API Key` = the `cpx_...` key. Do not put it in the Anthropic field.
2. Turn on `Override OpenAI Base URL` and set it to `https://<public-host>/v1`.
3. Add the custom models `cpxopus`, `cpxsonnet`, `cpxhaiku` and pick one in chat.

| Alias | Upstream model |
| --- | --- |
| `cpxopus` | `claude-opus-5` |
| `cpxsonnet` | `claude-sonnet-5` |
| `cpxhaiku` | `claude-haiku-4-5-20251001` |

Use the aliases, not `claude-*` names: Cursor sends `claude-*` names to its own
Anthropic provider. While the override is on, Cursor's `gpt-*` models also go
to the proxy. Tab completion keeps using Cursor's own models.

## Your own code

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1   # or https://<public-host>/v1
OPENAI_API_KEY=cpx_...
model: cpxsonnet                           # claude-* names also work outside Cursor
```

The proxy handles the OAuth upstream's differences from a plain API key:
system text is moved into the first user turn, `temperature` is dropped for
`claude-opus-5`, empty text blocks are removed, and `response_format` becomes a
forced tool whose arguments are returned as `message.content`. These need
version >= 0.2.0; check `GET /healthz` when your project starts.

## Commands

| Command | Purpose |
| --- | --- |
| `import-claude-code` | Import the Claude Code session from macOS Keychain |
| `key` | Create a new `cpx_...` key; the old one stops working |
| `start [--host] [--port]` | Run in the foreground (binds `127.0.0.1:8787`) |
| `install-service` / `uninstall-service` | macOS launch agent |
| `update` | Fast-forward `main`, `npm ci`, rebuild, restart the agent |
| `status [--json]` | Show what is configured, without secrets |
| `logout` | Delete the stored tokens |

State lives in `~/.cursor-proxy` (override with `CURSOR_PROXY_HOME`). Run one
proxy per machine; all projects share it.

## Token usage

Every OpenAI-format chat request adds a line to the proxy log once the answer
is complete (for a stream, when it ends):

```text
usage model=cpxsonnet in=2480 out=212 cache_read=0 cache_write=0
```

`in` is uncached input; `cache_read` and `cache_write` are prompt-cache tokens
counted separately. Sum the lines by `model` to see what each project spends.
Requests sent in Anthropic's own format (`/v1/messages`) are passed through as
is and do not get this line. Needs version >= 0.2.1.

## Troubleshooting

- **Cursor answers but the proxy log shows nothing:** Cursor is not using the
  proxy. Check the base URL and that you picked a `cpx*` model.
- **`revoked` / `login_required`:** the proxy and Claude Code share one
  rotating refresh token. On macOS the proxy picks up Claude Code's newer token
  from Keychain on its own. If it does not, run `import-claude-code` and restart
  the proxy.
- **The URL or key leaked:** run `key`, update the clients, restart the proxy.

## Security

The public URL plus the `cpx_...` key give access to your Anthropic session.
Cursor sends your prompts through its own servers before they reach the proxy.
Tool calls and streaming are translated, but behaviour may not exactly match
Cursor's built-in models.

Development: `npm run build && npm run typecheck && npm test`.
