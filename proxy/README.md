# cf-proxy — обратный прокси на Cloudflare Workers

Универсальный реверс-прокси, который живёт на краю Cloudflare. Один файл,
ноль зависимостей, бесплатный тариф (100 000 запросов/сутки).

**Зачем:** Cloudflare-край доступен из РФ напрямую, без VPN. Worker принимает
запрос, **сам** идёт на целевой сервер (уже со своей стороны, где нет блокировок),
и стримит ответ обратно. Так «серые» для РФ адреса открываются через один
рабочий `*.workers.dev`-адрес.

**Что умеет**

| Возможность | Детали |
|---|---|
| HTTP/HTTPS, все методы | GET/POST/PUT/PATCH/DELETE/HEAD, тело стримится как есть |
| SSE-стриминг | ответ не буферизуется — поток идёт байт-в-байт (LLM-ответы) |
| WebSocket | `wss://` проксируется, двусторонний обмен |
| Очистка заголовков | убирает `cf-*`, `x-forwarded-*`, подменяет User-Agent |
| Контроль доступа | IP-белый список (CIDR) → токен → белый список хостов |
| CORS | preflight и заголовки настраиваются |

---

## 1. Развёртывание

Собственный домен **не нужен**. По умолчанию Worker получает бесплатный
адрес вида `https://cf-proxy.<ваш-логин>.workers.dev`.

### Способ A — через веб-панель (без установки чего-либо)

1. Зарегистрируйтесь на <https://dash.cloudflare.com> (бесплатно, карта не нужна).
2. **Workers & Pages → Create → Worker** → дайте имя (например `cf-proxy`) → **Deploy**.
3. **Edit code** → удалите шаблон → вставьте **весь** текст `src/index.js` → **Deploy**.
4. **Settings → Variables and Secrets** → добавьте:
   - `PROXY_TOKEN` = ваш секретный токен (**тип Secret**),
   - `ALLOWED_HOSTS` = список целевых хостов через запятую (например `api.openai.com,www.workbuddy.ai`),
   - `TARGET_ORIGIN` = `https://www.workbuddy.ai` (если нужен режим «чистого шлюза»).
5. Готово. Ваш адрес: `https://cf-proxy.<логин>.workers.dev`.

> Проверка: откройте `https://cf-proxy.<логин>.workers.dev/health` — вернётся JSON со статусом.

### Способ B — через Wrangler CLI (автоматизация, удобно обновлять)

```bash
cd cloudflare-proxy
npm install                     # поставит wrangler
npx wrangler login              # откроет браузер, войти в Cloudflare
npx wrangler secret put PROXY_TOKEN   # ввести токен (в файлы не попадёт)
npx wrangler deploy             # задеплоит по wrangler.toml
```

Правьте параметры в `wrangler.toml` → `[vars]`, затем снова `npm run deploy`.

### Способ C — REST API без wrangler (когда CLI недоступен)

Если npm/wrangler не работают (или не хочется ставить Node-инструменты), деплой делается
скриптом [`tools/cf-deploy.mjs`](tools/cf-deploy.mjs) напрямую через Cloudflare REST API:

```bash
CF_API_TOKEN=<токен> CF_ACCOUNT_ID=<account_id> node tools/cf-deploy.mjs deploy
node tools/cf-deploy.mjs whoami      # проверить токен и узнать account_id
```

Скрипт загрузит `src/index.js`, установит секрет `PROXY_TOKEN` и включит `*.workers.dev`.
Пошаговая инструкция по всем трём путям (включая веб-панель) — в [`DEPLOY.md`](DEPLOY.md).

---

## 2. Про домен: нужен ли и как получить бесплатно

**Для работы — не нужен.** `*.workers.dev` выдаётся бесплатно и доступен из РФ.

> **Полный пошаговый комплект — в [`DOMAIN.md`](DOMAIN.md)**, включая готовый текст
> заявки eu.org и скрипт [`tools/cf-domain.mjs`](tools/cf-domain.mjs), который
> автоматизирует всю часть Cloudflare (создание зоны, вывод NS, привязку Custom Domain):
>
> ```bash
> node tools/cf-domain.mjs create-zone   # создать зону, получить NS -> вписать в eu.org
> node tools/cf-domain.mjs status        # проверить, стала ли зона active
> node tools/cf-domain.mjs attach        # привязать домен к воркеру
> ```

Свой домен имеет смысл, только если вы хотите красивый адрес или чтобы
`workers.dev` не был отключён в вашем аккаунте. Бесплатные варианты (проверено 2026):

| Провайдер | Что даёт | Плюсы | Минусы |
|---|---|---|---|
| **eu.org** ⭐ | `ваше-имя.eu.org` | некоммерческий с 1996 г., разрешает свои NS → Cloudflare, «живёт» дольше всех | ручная проверка заявки: от нескольких дней до 2–3 недель |
| **us.kg** | `ваше-имя.us.kg` | быстро, NS меняются | сервис молодой, есть лимиты |
| **pp.ua** | `ваше-имя.pp.ua` | стабильный | нужен номер телефона |
| **CloudDNS** | `*.cloud-ip.cc` и т.п. | мгновенно | поддомен платформы, NS менять нельзя → в Cloudflare напрямую не заведёшь |

### Подключение eu.org к Cloudflare (самый надёжный путь)

1. Зарегистрироваться на <https://nic.eu.org>, подтвердить e-mail.
2. **New domain** → запросить, например, `myproxy.eu.org`. В поле Name servers
   указать NS, которые Cloudflare выдаст на следующем шаге (обычно
   `xxx.ns.cloudflare.com` / `yyy.ns.cloudflare.com`).
3. В Cloudflare: **Add a site** → ввести `myproxy.eu.org` → тариф **Free**.
   Cloudflare покажет пару NS-серверов — скопировать их в заявку eu.org.
4. Дождаться одобрения eu.org (дни–недели). После этого домен активен в Cloudflare.
5. В Cloudflare: **Workers & Pages → cf-proxy → Settings → Domains & Routes →
   Add → Custom domain** → ввести `myproxy.eu.org`. SSL-сертификат выпустится сам.

Теперь прокси доступен по `https://myproxy.eu.org`. NS менять в любой момент
можно, домен остаётся за вами.

> Видео-гайды по eu.org + Cloudflare есть на YouTube — ищите «eu.org Cloudflare
> 2026», «免费域名 Cloudflare». Логика везде одна: получить домен → сменить NS
> на Cloudflare → добавить Custom Domain к Worker.

---

## 3. Использование

### Режим path-proxy (цель в пути)

```
https://cf-proxy.<логин>.workers.dev/proxy/https://api.example.com/v1/chat
```

### Режим gateway (цель задана в TARGET_ORIGIN)

Если `TARGET_ORIGIN=https://www.workbuddy.ai`, то путь на воркере = путь на цели:

```
https://cf-proxy.<логин>.workers.dev/v2/chat/completions
     ->  https://www.workbuddy.ai/v2/chat/completions
```

### curl

```bash
curl -N https://cf-proxy.<логин>.workers.dev/proxy/https://api.example.com/v1/chat \
  -H "x-proxy-token: $PROXY_TOKEN" \
  -H "authorization: Bearer $REAL_UPSTREAM_KEY" \
  -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

`-N` отключает буферизацию curl — сразу видно стриминг.

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://cf-proxy.<логин>.workers.dev/proxy/https://api.example.com/v1",
    api_key="<реальный ключ апстрима>",
    default_headers={"x-proxy-token": "<PROXY_TOKEN>"},  # токен прокси — отдельно
)
print(client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "hi"}],
).choices[0].message.content)
```

### n8n (узел HTTP Request)

| Поле | Значение |
|---|---|
| Method | `POST` |
| URL | `https://cf-proxy.<логин>.workers.dev/proxy/https://<цель>/v1/chat/completions` |
| Header | `x-proxy-token: <PROXY_TOKEN>` |
| Header | `Authorization: Bearer <ключ апстрима>` |
| Body | JSON, `stream: true` (если апстрим это поддерживает) |

---

## 4. Конфигурация

Все параметры — через переменные окружения (Secret приоритетнее `[vars]`).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PROXY_TOKEN` | `""` | токен доступа. Пусто = открытый прокси (**не оставляйте так**). Задавать Secret'ом |
| `ALLOWED_HOSTS` | `*` | цели через запятую; `*` = любой. **Обязательно сузьте** в проде |
| `TARGET_ORIGIN` | `""` | если задан — режим «чистого шлюза» на этот origin |
| `IP_WHITELIST` | `""` | IP клиентов (точные + `a.b.c.d/n`). Пусто = все |
| `HEADER_MODE` | `clean` | `clean` = чистим CF/браузерные заголовки; `passthrough` = как есть |
| `DEFAULT_USER_AGENT` | Chrome | UA, которым подменяются запросы в режиме `clean` |
| `CORS_ALLOW_ORIGIN` | `*` | источник для CORS-ответа |

---

## 5. Безопасность (важно прочитать)

Открытый прокси — это подарок для чужих ботов: они будут гонять через вас
трафик, а лимит запросов и репутация вашего аккаунта — ваши.

Минимум для продакшена:
1. **Задайте `PROXY_TOKEN`** (Secret).
2. **Сузьте `ALLOWED_HOSTS`** до конкретных доменов, которые вам нужны.
3. По желанию — `IP_WHITELIST`.
4. В панели Cloudflare включите WAF → Rate limiting (на бесплатном тарифе 1 правило).

Что прокси **не** делает: не скрывает сам факт Cloudflare — край всегда добавляет
`Cf-Worker`, `Cdn-Loop`, а исходящий IP принадлежит Cloudflare. Это инструмент
доступности, а не анонимизации.

---

## 6. Проверка работоспособности

```bash
npm test        # 17 проверок на реальном локальном апстриме
```

Тест поднимает настоящий HTTP-сервер и проверяет: health, отказ без токена,
маршрутизацию и тело, очистку `cf-*`/UA, отсутствие утечки токена наверх,
SSE-стриминг, запрет чужого хоста, `Bearer`, IP-whitelist (CIDR) и gateway-режим.

Ожидаемый результат: `17 passed, 0 failed`.

Локальный запуск живого воркера: `npm run dev` → <http://127.0.0.1:8787>.
Логи в проде: `npm run tail`.

---

## 7. Честная оговорка по WorkBuddy

Этот прокси **решает сетевую доступность** к `www.workbuddy.ai` из РФ (уходит
проблема `getaddrinfo ENOENT`): запрос делает край Cloudflare, а не ваш ПК.

Но он **не обходит** серверный детект WorkBuddy. Их бэкенд отклоняет запросы
«не из официального клиента» по **отсутствию телеметрии устройства**
(Galileo OTLP, `machineId`, `qimei36`) — код `11128`/`11140`, а не по токену.
Прокси эту телеметрию не создаёт, поэтому API-вызовы могут всё равно
отклоняться. Для доступа к самому приложению WorkBuddy используйте его
встроенный туннель; для своих API-задач — локальные шлюзы
`nvidia-proxy` (`:8787`) и `vibe-proxy` (`:8317`), которым прокси не нужен.

---

## Лицензия

MIT.
