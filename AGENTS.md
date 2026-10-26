# cursor-proxy

Родитель: [hub/agents-ai](https://github.com/gavrilovdm/hub/blob/main/agents-ai/AGENTS.md)

Связи: через него ходят в LLM [ai-agent-layer](https://github.com/gavrilovdm/ai-agent-layer) и [vacancy-parser](https://github.com/gavrilovdm/vacancy-parser) (`127.0.0.1:8787`)

## Что это

OpenAI-совместимый прокси к Anthropic: принимает запросы в формате OpenAI, проверяет ключ `cpx_...`, конвертирует их в Messages API и подставляет OAuth-токен сессии Claude Code вместо API-ключа. Работает для Cursor и любого OpenAI-клиента.

## Команды

```bash
npm install
npm run build       # tsc → dist/
npm test            # vitest
npm run typecheck
node dist/cli.js start   # прокси на 127.0.0.1:8787, healthz: /healthz
```

## Структура

- `src/cli.ts` — CLI: `import-claude-code`, `key`, `start`, `install-service`, `update`
- `src/proxy/` — HTTP-сервер и маршрутизация
- `src/adapters.ts` — конвертация OpenAI ↔ Anthropic
- `src/auth/`, `src/keys.ts` — OAuth-сессия и ключи `cpx_`
- `src/service/` — launchd / systemd
- `AGENT_SETUP.md` — пошаговая установка для агента (Mac, сервер, подключение проекта)

## Соглашения и подводные камни

- Никогда не печатай, не логируй и не коммить ключ `cpx_...` и содержимое `~/.cursor-proxy/`.
- Порт 8787 наружу не открывать: публичный доступ только через ngrok или reverse proxy с TLS.
- Один прокси на машину; при смене формата API проверь потребителей из «Связей».
