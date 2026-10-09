# Развёртывание cf-proxy (для проекта BIMO)

Три пути. **Путь 1 — рекомендуемый** (полностью автоматический, без установки чего-либо).
Путь 2 — веб-панель (без локальных инструментов). Путь 3 — классический CLI (wrangler).

Свой домен **не нужен** — хватает бесплатного `https://cf-proxy.<логин>.workers.dev`.

---

## ✅ Статус: УЖЕ РАЗВЁРНУТО (09.10.2026)

- **URL:** https://cf-proxy.iliamih09.workers.dev
- **Проверено:**
  - `/health` → `{"ok":true, ...}`
  - без токена → **401**; чужой хост → **403**
  - `workbuddy.ai/docs/...` через прокси → **200, 71 933 байта** (реальная страница WorkBuddy,
    `<title>常见问题 | WorkBuddy</title>`)
  - доступность прокси **из РФ**: все 3 узла check-host (Москва ×2, СПб) → **200 OK**
- **`PROXY_TOKEN`** — в `.dev.vars`.
- **Найденные ранее CF-токены** (для перевыпуска/повторного деплоя) — в `.cf-tokens-found.txt`.

Повторный деплой после правок `src/index.js`:

```bash
CF_API_TOKEN=<из .cf-tokens-found.txt> CF_ACCOUNT_ID=1846b68d7d549f332dd93213bad1fb39 \
  node tools/cf-deploy.mjs deploy
```

---

## Что уже подготовлено в этой папке

- `src/index.js` — сам воркер (протестирован: 17/17).
- `wrangler.toml` — `ALLOWED_HOSTS` сужен до `www.workbuddy.ai,www.codebuddy.ai,api.openai.com`.
- `.dev.vars` — **сгенерированный `PROXY_TOKEN`** для локальной отладки (в git не попадает).
- `tools/cf-deploy.mjs` — деплой через **REST API без wrangler** (для сред, где npm/wrangler недоступны).

> Свой аккаунт Cloudflare у вас уже есть: **Account ID `1846b68d7d549f332dd93213bad1fb39`**,
> субдомен **`iliamih09.workers.dev`** (там уже развёрнуты `nvidia-api-proxy` и др.).

---

## Путь 1 (рекомендуемый): REST-деплой скриптом `cf-deploy.mjs`

Нужен только **API-токен** Cloudflare.

1. Создайте токен: <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
   шаблон **Edit Cloudflare Workers** (или вручную: `Workers Scripts:Edit` + `Account Settings:Read`).
2. Запустите (в обычном терминале, из папки `cloudflare-proxy`):

```bash
# PowerShell / cmd / bash
set CF_API_TOKEN=<ваш_токен>
set CF_ACCOUNT_ID=1846b68d7d549f332dd93213bad1fb39
node tools/cf-deploy.mjs deploy
```

В bash:

```bash
CF_API_TOKEN=<ваш_токен> CF_ACCOUNT_ID=1846b68d7d549f332dd93213bad1fb39 \
  node tools/cf-deploy.mjs deploy
```

Скрипт сам: загрузит `src/index.js`, установит секрет `PROXY_TOKEN` (из `.dev.vars`),
включит `*.workers.dev` и напечатает готовый URL.

Проверить токен и аккаунт заранее:

```bash
node tools/cf-deploy.mjs whoami
```

---

## Путь 2: веб-панель Cloudflare (без инструментов)

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Worker** → имя `cf-proxy` → **Deploy**.
2. **Edit code** → удалить шаблон → вставить **весь** `src/index.js` → **Deploy**.
3. **Settings → Variables and Secrets** добавить:
   - `PROXY_TOKEN` — тип **Secret** (значение — из `.dev.vars`);
   - `ALLOWED_HOSTS` = `www.workbuddy.ai,www.codebuddy.ai,api.openai.com`;
   - `HEADER_MODE` = `clean`; `CORS_ALLOW_ORIGIN` = `*`.
4. Готово. Адрес: `https://cf-proxy.<логин>.workers.dev`.

---

## Путь 3: CLI (wrangler) — вне этой песочницы

> ⚠️ В текущей среде CLI-путь недоступен: npm-установка блокируется sandbox-guard'ом
> (`SAFE_DELETE_BULK_GUARD_ERROR`), `node_modules` частично установлен. Запускайте в обычном терминале.

```bash
cd cloudflare-proxy
rm -rf node_modules && npm install     # свежая установка (в обычном терминале)
npx wrangler login                     # откроет браузер, войти в Cloudflare
npx wrangler secret put PROXY_TOKEN    # вставить токен из .dev.vars
npx wrangler deploy
```

---

## Проверка после развёртывания

```bash
# 1) health
curl -s https://cf-proxy.<логин>.workers.dev/health

# 2) доступ к WorkBuddy БЕЗ VPN (главная цель)
curl -N "https://cf-proxy.<логин>.workers.dev/proxy/https://www.workbuddy.ai/" \
  -H "x-proxy-token: <PROXY_TOKEN>"
```

Ожидается: `/health` → `{"ok":true,...}`; второй запрос возвращает HTML сайта WorkBuddy
(запрос к `workbuddy.ai` делает **край Cloudflare**, а не ваш ПК → обход маршрутной блокировки).

---

## Использование

**Path-proxy (любая цель из allowlist):**
```
https://cf-proxy.<логин>.workers.dev/proxy/https://www.workbuddy.ai/<путь>
```

**Gateway-режим** (если задать `TARGET_ORIGIN=https://www.workbuddy.ai`):
```
https://cf-proxy.<логин>.workers.dev/v2/chat/completions  →  https://www.workbuddy.ai/v2/chat/completions
```

**OpenAI SDK:**
```python
from openai import OpenAI
client = OpenAI(
    base_url="https://cf-proxy.<логин>.workers.dev/proxy/https://www.workbuddy.ai/v2",
    api_key="<реальный ключ апстрима>",
    default_headers={"x-proxy-token": "<PROXY_TOKEN>"},
)
```

---

## Безопасность (обязательно)

- `PROXY_TOKEN` задавать **только Secret**; в `wrangler.toml` его нет.
- `ALLOWED_HOSTS` уже сужен — не возвращайте `"*"` в проде.
- Включите WAF → Rate limiting (1 правило на бесплатном тарифе).
- Ротация токена раз в N дней (`cf-deploy.mjs deploy` перезапишет секрет).

## Ограничение (важно)

`cf-proxy` решает **сетевую доступность** к `workbuddy.ai` из РФ, но **не обходит** серверный
детект WorkBuddy по отсутствию телеметрии устройства (коды `11128`/`11140`). Для **сайта** и
**API-доступа из браузера** прокси работает; для **официального приложения** используйте его
встроенный туннель; для **своих API-задач** — локальные шлюзы `nvidia-proxy`/`vibe-proxy`.
