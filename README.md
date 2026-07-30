# cursor-proxy

`cursor-proxy` is a local proxy that lets OpenAI-compatible clients call
Anthropic with a Claude Code OAuth session instead of a long-lived Anthropic API
key.

The working Cursor setup is:

1. Cursor sends OpenAI-shaped requests to a public HTTPS tunnel.
2. The tunnel forwards to `http://127.0.0.1:8787`.
3. The proxy validates a local `cpx_...` proxy key.
4. The proxy converts `/v1/chat/completions` (and bare `/chat/completions`) into
   Anthropic `/v1/messages`.
5. The upstream call goes to `https://api.anthropic.com` with the imported Claude
   Code OAuth token.

`claude.ai` is used only for OAuth/login. Model inference does not go to
`https://claude.ai/v1/chat` or `https://claude.ai/v1/code`; those are not the
endpoints used by this proxy.

## Important Cursor Constraints

Cursor does not call custom OpenAI base URLs from the desktop app. It calls them
from Cursor backend servers, so `http://127.0.0.1:8787/v1` is rejected with
`Access to private networks is forbidden`.

Use a public HTTPS URL, for example ngrok:

```sh
ngrok http 8787
```

Then put the generated `https://...ngrok-free.app/v1` URL into Cursor.

While `Override OpenAI Base URL` is enabled, normal OpenAI-family models such as
`gpt-*` are also routed to this proxy. Disable the override when you want to use
Cursor/OpenAI models normally.

Custom API keys in Cursor are chat-model only. Tab completion and some built-in
Cursor features still use Cursor's own models.

## Model Aliases

Cursor routes model names starting with `claude-` to its own Anthropic provider,
not to the OpenAI-compatible custom endpoint. Some custom-provider paths also
rewrite punctuation in model names.

For that reason the proxy exposes short alphanumeric aliases:

| Cursor model | Upstream Anthropic model |
| --- | --- |
| `cpxopus` | `claude-opus-5` |
| `cpxsonnet` | `claude-sonnet-5` |
| `cpxhaiku` | `claude-haiku-4-5-20251001` |

`cpx` means `cursor-proxy`. Use these names in Cursor, not `claude-*`.

Every adapted chat request includes a Claude Code billing marker in the Anthropic
system prompt. Without it the same OAuth token is treated as a generic user API
key and premium models return `429 User API Key Rate limit exceeded`.

## Setup

Install dependencies and build:

```sh
npm install
npm run build
```

Make sure Claude Code is logged in on this machine, then import its OAuth
session from macOS Keychain:

```sh
node dist/cli.js import-claude-code
```

Generate a local proxy key. It is shown once; only its hash is stored:

```sh
node dist/cli.js key
```

Start the proxy:

```sh
node dist/cli.js start
```

Start ngrok in another terminal:

```sh
ngrok http 8787
```

## Cursor Configuration

In Cursor Settings -> Models:

1. Put the `cpx_...` key into `OpenAI API Key`.
2. Enable `Override OpenAI Base URL`.
3. Set the base URL to the ngrok URL with `/v1`, for example:

```text
https://example.ngrok-free.app/v1
```

4. Add custom models:

```text
cpxopus
cpxsonnet
cpxhaiku
```

5. Select `cpxopus` or another `cpx*` model in chat.

Do not put the `cpx_...` key into Anthropic settings. Cursor will validate it as
a real Anthropic API key and reject it.

## Verification

The proxy logs every request:

```text
chat model=cpxopus stream=true
POST /chat/completions -> 200 6377ms
```

If Cursor replies but the proxy log does not change, Cursor did not use this
proxy.

Quick local health check:

```sh
curl http://127.0.0.1:8787/healthz
```

Quick model check through the public tunnel:

```sh
curl https://example.ngrok-free.app/v1/models \
  -H "Authorization: Bearer <cpx_...>"
```

## Maintenance

### Daily Start

```sh
cd ~/cursor-proxy
node dist/cli.js start
ngrok http 8787
```

Copy the new ngrok URL into Cursor if it changed.

### Refresh Claude Code Credentials

If Anthropic returns `OAuth access token has been revoked`, `login_required`, or
premium models start failing after Claude Code refreshes its session:

```sh
node dist/cli.js import-claude-code
```

Then restart the proxy.

### Rotate The Proxy Key

If the public tunnel URL or `cpx_...` key was exposed, rotate the key:

```sh
node dist/cli.js key
```

Update Cursor's OpenAI API key and restart the proxy. The previous key stops
working.

### Stop Services

If they were started in foreground terminals, use `Ctrl+C`.

Otherwise:

```sh
pkill -f "dist/cli.js start"
pkill -f "ngrok http 8787"
```

### Check The Build

```sh
npm run build
npm run typecheck
npm test
```

## Commands

- `node dist/cli.js import-claude-code` imports the signed-in Claude Code OAuth
  session from macOS Keychain. This is the proven path for Cursor.
- `node dist/cli.js key` prints a new local proxy key once and stores only its
  hash.
- `node dist/cli.js start` runs the proxy. It binds to `127.0.0.1` by default.
- `node dist/cli.js status` reports configured pieces without printing secrets.
- `node dist/cli.js logout` deletes stored OAuth tokens.
- `node dist/cli.js configure claude-code` and `node dist/cli.js login` are kept
  for direct browser OAuth experiments. Prefer `import-claude-code` for the
  Cursor setup.

## Known Cursor Quirks

These are quirks the proxy already compensates for:

- **Bare OpenAI paths.** Cursor may call `/chat/completions` or `/models`
  without the `/v1` prefix. The proxy accepts both `/v1/...` and bare paths.
- **Model name routing.** Names starting with `claude-` stay on Cursor's own
  Anthropic provider. Use `cpx*` aliases instead.
- **Tool call ids.** Anthropic requires `tool_use.id` to match
  `^[a-zA-Z0-9_-]+$`. Cursor/OpenAI ids can contain `:`, `/`, `.`, etc. The
  adapter sanitizes them and keeps a stable mapping for matching
  `tool_result` blocks.
- **Streaming tool calls.** Anthropic `stop_reason: "tool_use"` is translated
  to OpenAI `finish_reason: "tool_calls"`.
- **Private network block.** Cursor backends refuse `127.0.0.1` / private IPs,
  so a public HTTPS tunnel is required.

## Limitations And Security

- The ngrok URL exposes the proxy to the internet. The `cpx_...` key is required,
  but anyone with both the URL and key can spend your Anthropic session.
- Cursor still sends prompts/context through Cursor backend before it calls the
  custom provider. This is not a local-only privacy setup.
- The OpenAI-compatible adapter translates text chat, streaming, OpenAI
  `tools`, assistant `tool_calls`, and `role: "tool"` results into Anthropic
  `tool_use` / `tool_result` blocks. It also accepts a small subset of
  Responses API-like `input` payloads. This is still not guaranteed to be full
  parity with Cursor native models; verify real Cursor agent workflows before
  relying on it for long coding sessions.
- Direct Anthropic-shaped `/v1/messages` requests still pass through with the
  OAuth token, which is useful for debugging.
- Make sure this use is permitted for your Anthropic/Claude plan.
