# llm-proxy

Родитель: [hub/projects/non-work/agents-ai](https://github.com/gavrilovdm/hub/blob/main/domains/projects/non-work/agents-ai/AGENTS.md)

Связи: через него ходят в LLM [ai-agent-layer](https://github.com/gavrilovdm/ai-agent-layer), [vacancy-parser](https://github.com/gavrilovdm/vacancy-parser), [job-agent](https://github.com/gavrilovdm/job-agent) и [gavrisalive](https://github.com/gavrilovdm/gavrisalive) (`127.0.0.1:8787`); что каждый из них ждёт от прокси — `tests/consumer-contracts.test.ts`

## Что это

OpenAI-совместимый прокси к Anthropic: принимает запросы в формате OpenAI, проверяет ключ `cpx_...`, конвертирует их в Messages API и подставляет OAuth-токен сессии Claude Code вместо API-ключа. Работает для Cursor и любого OpenAI-клиента.

## Команды

```bash
npm install
npm run build       # tsc → dist/
npm test            # vitest
npm run typecheck
node dist/cli.js start   # прокси на 127.0.0.1:8787, healthz: /healthz
node dist/cli.js report --out ~/reports/llm-$(date +%F).md   # недельный отчёт; --no-llm — только цифры, --proxy <url> — другой прокси
npm start                # scripts/up.sh: недостающие шаги (install, build, импорт сессии, ключ) и запуск на переднем плане
```

## Структура

- `src/cli.ts` — CLI: `import-claude-code`, `key`, `start`, `install-service`, `update`
- `src/proxy/` — HTTP-сервер и маршрутизация; `telemetry.ts` — спан и метрики OpenTelemetry на каждый чат-запрос (только API, без SDK — no-op)
- `src/dashboard/` — дашборд `/dashboard`: `usage-file.ts` (журнал вызовов `~/.llm-proxy/usage.jsonl`), `aggregate.ts` (сводка для страницы), `routes.ts` (страница без ключа, API с ключом), `page.ts` (сама страница, без внешних запросов)
- `src/telemetry-sdk.ts` — включает экспорт OTLP в `start`, если задан `OTEL_EXPORTER_OTLP_ENDPOINT` (или в `~/.llm-proxy/otel.env`)
- `src/adapters.ts` — конвертация OpenAI ↔ Anthropic
- `src/auth/`, `src/keys.ts` — OAuth-сессия и ключи `cpx_`; redirect URI логина — `http://localhost:<порт>/callback` (Anthropic не принимает `127.0.0.1`), слушаем при этом только `127.0.0.1`
- `src/home.ts` — каталог состояния `~/.llm-proxy`; переносит `~/.cursor-proxy` (старое имя проекта) и читает `CURSOR_PROXY_*` как запасные `LLM_PROXY_*`
- `src/service/` — launchd (`com.llm-proxy`; старый `com.cursor-proxy` снимается при `install-service`) / systemd
- `src/report/` — команда `report`: тянет наблюдения из Langfuse (`/api/public/v2/observations`, без полей `io`; из метаданных остаются только нужные атрибуты), считает по `cpx.project` × модель вызовы, ошибки, токены, p50/p95 против прошлого периода, и отдаёт агрегаты (без трейсов) в LLM на короткий разбор. Ключи — `~/.llm-proxy/report.env`: `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `CPX_API_KEY`
- `AGENT_SETUP.md` — пошаговая установка для агента (Mac, сервер, подключение проекта)
- `tests/consumer-contracts.test.ts` — контракты потребителей: по `describe` на репозиторий из «Связей», запросы и читаемые поля ответа взяты из их кода; апстрим — заглушка

## Соглашения и подводные камни

- Никогда не печатай, не логируй и не коммить ключ `cpx_...` и содержимое `~/.llm-proxy/`.
- Порт 8787 наружу не открывать: публичный доступ только через ngrok или reverse proxy с TLS.
- Текст промптов и ответов в спаны — только при `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`: через прокси идут промпты всех проектов, в том числе с личными данными.
- Строка `usage project=… model=… in=… out=…` в логе и атрибуты спанов — формат для потребителей (дашборд, разбор логов); менять осознанно.
- Один прокси на машину. Упавший тест в `consumer-contracts.test.ts` называет потребителя, которого ломает изменение: ломающее изменение — только вместе с задачей в его репозитории. Новый потребитель — новый `describe` там же и строка в «Связях».
- Документация и git: `.claude/kit.json` подключает общие хуки hub. После правки агент получает напоминание про JSDoc у экспортов (`eslint.docs.mjs`, только напоминание, CI его не проверяет); мерж и история основной ветки защищены `merge_gate`.
