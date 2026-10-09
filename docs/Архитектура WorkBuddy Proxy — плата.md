# Архитектура подключения WorkBuddy Proxy к плате (BIMO)

> Контекст: плата — одноплатный компьютер (Raspberry Pi 5, проект BIMO, см. документ 20).
> WorkBuddy Proxy — слой доступа к API WorkBuddy AI и моделям, построенный на
> `cf-proxy` (Cloudflare Workers) и локальных шлюзах `nvidia-proxy` (:8787) /
> `vibe-proxy` (:8317). Документ описывает, как плата получает доступ к сервисам
> из РФ без VPN на самой плате.

---

## 1. Назначение и границы системы

**Цель:** дать плате BIMO надёжный, легитимный и стриминговый доступ к
интеллектуальным API (WorkBuddy AI, NVIDIA/Claude/Gemini через шлюзы) при
минимальной нагрузке на саму плату (8 ГБ RAM, SD-накопитель).

**Границы:**
- Сама плата — тонкий клиент: не хранит тяжёлые модели, не терминирует VPN-туннели
  (если не требуется), только потребляет стриминг-ответы.
- Прокси-слой развязывает плату с проблемами сетевой доступности в РФ и с
  биллингом/детектом клиента.

**Две топологии (выбираются по сценарию):**
- **Топология А (публичная, РФ-дружественная):** Плата → Cloudflare edge → `cf-proxy`
  → `workbuddy.ai`. Не требует VPN на плате.
- **Топология Б (локальная):** Плата → LAN/Tailnet → ПК-шлюз (`nvidia-proxy` /
  `vibe-proxy`) → апстрим-модели. Для легального доступа к тяжёлым моделям.

Рекомендуется **гибрид**: А для API WorkBuddy, Б для тяжёлых моделей; плата
переключается по правилам маршрутизации.

---

## 2. Состав системы (компоненты)

| № | Компонент | Где живёт | Роль |
|---|---|---|---|
| C1 | **Edge Board (плата BIMO)** | Raspberry Pi 5 | Тонкий клиент: собирает запрос, консьюмит стрим, локальный агент/UI |
| C2 | **Client SDK / Proxy Abstraction Layer** | Плата (Node/Python) | OpenAI-совместимый клиент + маршрутизатор endpoint'ов + health-check |
| C3 | **cf-proxy (Worker)** | Cloudflare edge | Публичный реверс-прокси: auth, allowlist хостов, очистка заголовков, SSE/WS |
| C4 | **Local Gateway** (`nvidia-proxy`, `vibe-proxy`) | ПК пользователя | Локальный шлюз к моделям (550B, Claude, Gemini) без токен-банов |
| C5 | **Connectivity plane** | Плата ↔ ПК/Cloudflare | Tailscale / Cloudflare Tunnel / прямой egress; разрешает приватность и маршрут |
| C6 | **Upstream services** | Интернет | `workbuddy.ai` (v2 API), NVIDIA, Claude, Gemini |
| C7 | **Config & Secret store** | Плата + Cloudflare | `PROXY_TOKEN`, `ALLOWED_HOSTS`, API-ключи апстрима (только Secret/key_env) |

---

## 3. Топология подключения

```
                          ┌──────────────────────────────┐
              ТОПОЛОГИЯ А │      INTERNET (РФ)           │
                          │       (Cloudflare reachable) │
                          └──────────────┬───────────────┘
                                         │ HTTPS / SSE / WSS
                         ┌───────────────▼───────────────┐
                         │   Cloudflare EDGE (WAF/TLS)   │
                         │   cf-proxy Worker              │
                         │   • token auth (x-proxy-token) │
                         │   • host allowlist            │
                         │   • header scrub + UA replace  │
                         │   • SSE/WS passthrough         │
                         └───────────────┬───────────────┘
                                         │ fetch (server-side)
                                         ▼
                                  workbuddy.ai  (v2)

   ┌─────────────────────────── ПЛАТА BIMO ───────────────────────────┐
   │  C2 Client SDK  ───►  C1 Edge Board (Pi 5, Pi OS 64-bit)          │
   │       │                                                         │
   │       ├── маршрут А: https://cf-proxy.<login>.workers.dev/...    │
   │       └── маршрут Б: http://<ПК>:8787/v1  (через C5)            │
   └──────────────────────────────────────────────────────────────────┘
              │                                  │
              │  ТОПОЛОГИЯ Б                     │ LAN / Tailnet (C5)
              ▼                                  ▼
        ┌──────────────┐                 Local Gateway C4 (ПК)
        │  Broadband   │                 nvidia-proxy :8787
        │  router      │◄──────────────── vibe-proxy  :8317
        └──────────────┘   Tailscale Serve / Tunnel
```

**Пояснение маршрутов:**
- **Маршрут А** использует то, что край Cloudflare доступен из РФ напрямую — плата
  стучится в `*.workers.dev`, а уже Cloudflare (со своей стороны) ходит на `workbuddy.ai`.
  Это снимает ошибку `getaddrinfo ENOENT`.
- **Маршрут Б** — плата ходит на ПК в локалке или через Tailscale. На ПК уже
  подняты `nvidia-proxy`/`vibe-proxy` к апстрим-моделям. Tailscale Serve
  выставляет их без проброса портов; в РФ Tailscale может требовать обхода —
  см. раздел 10.

---

## 4. Интерфейсы и протоколы связи

| Интерфейс | Протокол | Назначение |
|---|---|---|
| Плата ↔ Proxy | **HTTPS (REST/JSON)** | базовые вызовы chat/completions |
| Плата ↔ Proxy | **SSE** (`text/event-stream`) | стриминг токенов LLM (обязателен `stream:true`) |
| Плата ↔ Proxy | **WebSocket (WSS)** | голос/живые сессии, двусторонний обмен |
| Клиент API | **OpenAI-compatible schema** | `POST /v1/chat/completions` (или `/v2/...` для WorkBuddy) |
| Аутентификация | **Bearer** (апстрим-ключ) + **`x-proxy-token`** (токен прокси) | разделены: бизнес-ключ直达 апстрим, токен прокси — отдельно |
| Плата ↔ ПК | **Tailscale/WireGuard** (опц.) | приватный оверлей, шифрованный канал |
| Плата ↔ Интернет | **TLS 1.3 / HTTP/2** | транспорт до Cloudflare |
| Discovery | **mDNS / статический IP** | нахождение ПК-шлюза в LAN |
| Управление | **Cloudflare API v4** | создание зоны, custom domain, права (см. `tools/cf-domain.mjs`) |

**Формат запроса (маршрут А, OpenAI SDK):**

```python
from openai import OpenAI
client = OpenAI(
    base_url = "https://cf-proxy.<login>.workers.dev/proxy/https://www.workbuddy.ai/v2",
    api_key = "<реальный ключ апстрима>",                 # WorkBuddy-аккаунт
    default_headers = {"x-proxy-token": "<PROXY_TOKEN>"},  # токен прокси
)
```

---

## 5. Поток данных (sequence)

```
[1] Плата: Client SDK формирует chat/completions (JSON, stream=true)
        + Authorization: Bearer <апстрим-ключ>
        + x-proxy-token: <PROXY_TOKEN>
            │  HTTPS POST
            ▼
[2] Cloudflare edge (TLS terminate, WAF): передаёт в cf-proxy Worker
            │
            ▼
[3] cf-proxy: ● проверяет x-proxy-token (401 если нет)
             ● проверяет host в ALLOWED_HOSTS (403 если нет)
             ● удаляет cf-*/x-forwarded-*, подменяет UA
             ● строит апстрим-URL, пробрасывает тело СТРИМОМ
            │  server-side fetch
            ▼
[4] Upstream (workbuddy.ai): возвращает SSE-поток
            │  bytes
            ▼
[5] cf-proxy: пересобирает ответ (SSE/WS passthrough, CORS),
             стримит байт-в-байт обратно
            │  HTTPS / SSE
            ▼
[6] Плата: Client SDK консьюмит поток, рендерит токены / гонит TTS/UI
```

Для **маршрута Б** шаги [2]–[5] происходят на ПК-шлюзе (без Cloudflare), а плата
соединяется с ПК напрямую или через Tailscale.

---

## 6. Ключевые модули и взаимодействие

### На плате (C1/C2)
- **Proxy Abstraction Layer (PAL)** — держит список endpoint'ов
  (`cf-proxy`, `nvidia-proxy`, `vibe-proxy`), их health, latency; выбирает
  активный по правилу (WorkBuddy→A, тяжёлые модели→Б) и переключается при сбое.
- **Request Builder** — собирает OpenAI-совместимый JSON, проставляет заголовки,
  включает `stream:true` для SSE.
- **Stream Consumer** — парсит SSE/WS, отдаёт токены в UI/голос.
- **Connectivity Monitor** — пингует endpoint'ы, детектит потерю канала.
- **Local Cache / Light model (опц.)** — кэш частых ответов, либо лёгкая локальная
  модель (на Pi 5 8 ГБ — только совсем маленькая, для офлайн-заглушки).

### На прокси (C3 / C4)
- **Router** — `/proxy/<url>` или `TARGET_ORIGIN` gateway-режим.
- **Auth & ACL** — `x-proxy-token`, IP-whitelist (CIDR), `ALLOWED_HOSTS`.
- **Header Scrubber** — убирает `cf-*`, `x-forwarded-*`, подменяет UA (снимает
  браузерные отпечатки для апстрим-фильтров).
- **Streamer** — прозрачный проброс SSE/WS без буферизации.
- **CORS** — preflight + `Access-Control-*`.

### Плоскость связности (C5)
- **Tailscale Serve / Tunnel** — выставляет ПК-шлюз плате без публичного IP.
- **Cloudflare Tunnel** — альтернатива для ПК-шлюза, если Tailscale заблокирован.

---

## 7. Требования к аппаратной части

**Плата BIMO (минимум / рекоменд):**
- SoC: Raspberry Pi 5 (BCM2712, 4-neon/8 ГБ).
- Память: 4 ГБ (достаточно для тонкого клиента) / **8 ГБ** (рекоменд, запас).
- Накопитель: microSD **A2 High-Endurance** ИЛИ NVMe HAT (защита от износа SD —
  см. документ 20). Поток логов/кэша — только на tmpfs или NVMe.
- Питание: USB-C PD **5V/5A** (официальный БП), с запасом на периферию.
- Сеть: Gigabit Ethernet **или** Wi-Fi 5/6 (стабильный broadband).
- Периферия (опц., под голос): USB-микрофон + динамик, активное охлаждение
  (heatsink + fan) — при длительном стриминге Pi 5 греется.
- Энергобюджет: тонкий клиент ~3–6 Вт; шлюз-модели НЕ на плате (иначе 8 ГБ не хватит).

**Сеть:**
- Для маршрута А — обычный broadband; VPN на плате **не нужен**.
- Для маршрута Б — ПК в той же LAN ИЛИ Tailscale-туннель (с учётом доступности в РФ).

**ПК-шлюз (опц., для Б):**
- Любой x86 с доступом к моделям (NVIDIA GPU — плюс для локального инференса, но не
  обязательно: `nvidia-proxy`/`vibe-proxy` могут ходить на удалённые модели).
- Аккаунт Cloudflare (бесплатный) — для `cf-proxy` и custom domain.

---

## 8. Требования к программной части

**Плата:**
- ОС: Raspberry Pi OS (Debian 12) **64-bit**, минимальная.
- Runtime: **Node.js 22** (или Python 3.11) — под архитектуру `aarch64`.
- Зависимости: `openai` SDK (Python/JS) ИЛИ нативный `fetch` + SSE-парсер.
- Наш агент/тонкий клиент (документ 20) + PAL-модуль.
- Tailscale agent (опц.).

**Прокси:**
- `cf-proxy` (Cloudflare Worker) — развёрнут через Wrangler (`wrangler deploy`),
  переменные: `PROXY_TOKEN` (Secret), `ALLOWED_HOSTS`, `TARGET_ORIGIN`, `HEADER_MODE`.
- `nvidia-proxy` / `vibe-proxy` — запуск на ПК, слушают `:8787`/`:8317`.

**Безопасность (обязательно):**
- TLS везде; `PROXY_TOKEN` — только Secret/key_env, не в репозиторий.
- `ALLOWED_HOSTS` сузить до нужных доменов (`www.workbuddy.ai`, api.openai.com, …).
- WAF Rate-limiting (1 правило на бесплатном тарифе).
- Ротация токена раз в N дней.

---

## 9. Этапы интеграции

| Этап | Действие | Результат |
|---|---|---|
| 1 | Сборка платы: Pi OS 64-bit, сеть, SSH, охлаждение, NVMe/A2 SD | Готовая edge-нода |
| 2 | Развёртывание `cf-proxy` (Workers) + `PROXY_TOKEN` + `ALLOWED_HOSTS` | Публичный прокси (без домена) |
| 3 | Тест коннективности с платы: `curl …/health`, затем реальный вызов | Канал А работает |
| 4 | Установка Client SDK + PAL на плату, конфиг `base_url`, маршрут А | Плата стримит ответы |
| 5 | (опц.) Поднять `nvidia-proxy`/`vibe-proxy` на ПК; прописать маршрут Б в PAL | Тяжёлые модели доступны |
| 6 | (опц.) Tailscale / Cloudflare Tunnel для приватной связи плата↔ПК | Без публичного IP |
| 7 | Fallback-маршрутизация + мониторинг + логирование (tmpfs) | Отказоустойчивость |
| 8 | Сужение `ALLOWED_HOSTS`, WAF rate-limit, ротация токена | Снижение поверхности атаки |
| 9 | Приёмка: нагрузочный тест, латентность стрима, офлайн-сценарий | Готово к эксплуатации |

---

## 10. Безопасность, отказоустойчивость, РФ-специфика

- **Отказоустойчивость:** PAL переключает маршрут А↔Б при таймауте/5xx; SSE не
  буферизируется (нет утечки памяти на плате); логи — в tmpfs.
- **Безопасность:** узкий `ALLOWED_HOSTS`, токен-разделение (прокси-токен ≠ апстрим-ключ),
  WAF; плата не держит секреты апстрима в открытом виде.
- **РФ-специфика:** маршрут А (Cloudflare) доступен без VPN. Tailscale/ WireGuard
  могут быть ограничены — на маршруте Б иметь запасной путь (Cloudflare Tunnel или
  публичный `cf-proxy` с узким allowlist). Напрямую VPN на плате не требуется.

## 11. Ограничения (важно)

Прокси решает **сетевую доступность** к `workbuddy.ai` из РФ, но **не обходит**
серверный детект WorkBuddy: их бэкенд отклоняет запросы «не из официального
клиента» по отсутствию телеметрии устройства (коды `11128`/`11140`, не по токену —
см. документ 21). Для доступа к самому приложению WorkBuddy используйте его
встроенный туннель; для задач по API — локальные шлюзы `nvidia-proxy`/`vibe-proxy`
(маршрут Б), которым телеметрия не нужна.

---

*Связанные артефакты:* `cloudflare-proxy/` (cf-proxy, `tools/cf-domain.mjs`, `DOMAIN.md`),
документ 20 (Pi 5 как тонкий клиент), документ 21 (почему токен WorkBuddy через
сторонний клиент не работает).
