# cursor-proxy

Родитель: [hub/projects/non-work/agents-ai](https://github.com/gavrilovdm/hub/blob/main/domains/projects/non-work/agents-ai/AGENTS.md)

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
npm start                # scripts/up.sh: недостающие шаги (install, build, импорт сессии, ключ) и запуск на переднем плане
```

## Структура

- `src/cli.ts` — CLI: `import-claude-code`, `key`, `start`, `install-service`, `update`
- `src/proxy/` — HTTP-сервер и маршрутизация; `telemetry.ts` — спан и метрики OpenTelemetry на каждый чат-запрос (только API, без SDK — no-op)
- `src/dashboard/` — дашборд `/dashboard`: `usage-file.ts` (журнал вызовов `~/.cursor-proxy/usage.jsonl`), `aggregate.ts` (сводка для страницы), `routes.ts` (страница без ключа, API с ключом), `page.ts` (сама страница, без внешних запросов)
- `src/telemetry-sdk.ts` — включает экспорт OTLP в `start`, если задан `OTEL_EXPORTER_OTLP_ENDPOINT` (или в `~/.cursor-proxy/otel.env`)
- `src/adapters.ts` — конвертация OpenAI ↔ Anthropic
- `src/auth/`, `src/keys.ts` — OAuth-сессия и ключи `cpx_`; redirect URI логина — `http://localhost:<порт>/callback` (Anthropic не принимает `127.0.0.1`), слушаем при этом только `127.0.0.1`
- `src/service/` — launchd / systemd
- `AGENT_SETUP.md` — пошаговая установка для агента (Mac, сервер, подключение проекта)

## Соглашения и подводные камни

- Никогда не печатай, не логируй и не коммить ключ `cpx_...` и содержимое `~/.cursor-proxy/`.
- Порт 8787 наружу не открывать: публичный доступ только через ngrok или reverse proxy с TLS.
- Строка `usage project=… model=… in=… out=…` в логе и атрибуты спанов — формат для потребителей (дашборд, разбор логов); менять осознанно.
- Один прокси на машину; при смене формата API проверь потребителей из «Связей».
