/**
 * ============================================================================
 *  cf-proxy — универсальный обратный прокси на Cloudflare Workers
 *  HTTP/HTTPS (все методы) · SSE-стриминг · WebSocket · очистка заголовков
 * ----------------------------------------------------------------------------
 *  Один файл, ноль зависимостей. Работает на бесплатном тарифе Workers
 *  (100 000 запросов/сутки). Домен НЕ обязателен — хватает *.workers.dev.
 *
 *  Маршрутизация цели:
 *    1) явный таргет:   https://<worker>/proxy/https://api.example.com/v1/...
 *    2) таргет по умолч: если задан TARGET_ORIGIN, то любой путь
 *                       https://<worker>/v1/... -> TARGET_ORIGIN/v1/...
 *
 *  Конфигурация — через переменные окружения (Settings → Variables and Secrets)
 *  либо через блок [vars] в wrangler.toml. Секрет PROXY_TOKEN задаётся только
 *  как Secret (wrangler secret put PROXY_TOKEN).
 * ============================================================================
 */

const DEFAULTS = {
  // Пусто -> прокси работает без токена. НАСТОЯТЕЛЬНО рекомендуется задать.
  PROXY_TOKEN: "",
  // Список разрешённых хостов-целей через запятую. "*" -> любой.
  // Пример: "api.openai.com,www.workbuddy.ai"
  ALLOWED_HOSTS: "*",
  // Источник для CORS-ответа.
  CORS_ALLOW_ORIGIN: "*",
  // Белый список IP клиентов (точные адреса и IPv4 CIDR). Пусто -> все.
  // Пример: "1.2.3.4,10.0.0.0/8"
  IP_WHITELIST: "",
  // "clean" — вычищаем браузерные/CF-заголовки; "passthrough" — как есть.
  HEADER_MODE: "clean",
  // UA, которым подменяются все запросы в режиме "clean".
  DEFAULT_USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  // Если задан — проксирует ВСЁ на этот origin (режим «чистого шлюза»).
  // Пример: "https://www.workbuddy.ai"
  TARGET_ORIGIN: "",
};

const PREFIX = "/proxy/";

// Заголовки, которые нельзя пробрасывать (hop-by-hop, RFC 7230 §6.1).
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// Заголовки, которые Cloudflare-край добавляет сам. Их нельзя тащить наверх:
// они раскрывают, что за прокси стоит Cloudflare, и ломают часть API-фильтров.
const CF_EDGE_HEADERS = [
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "cf-ew-via",
  "cdn-loop",
  "x-forwarded-proto",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-real-ip",
  "true-client-ip",
  "forwarded",
];

function readConfig(env) {
  const c = { ...DEFAULTS, ...(env || {}) };
  return c;
}

function corsHeaders(request, conf) {
  const origin = request.headers.get("origin") || conf.CORS_ALLOW_ORIGIN;
  return {
    "Access-Control-Allow-Origin": conf.CORS_ALLOW_ORIGIN === "*" ? "*" : origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(obj, conf, status = 200, request) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(request ? corsHeaders(request, conf) : {}),
    },
  });
}

/* ----------------------------- access control ----------------------------- */

function ip4ToInt(ip) {
  const p = String(ip).split(".").map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function inCidr4(ip, cidr) {
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const ipi = ip4ToInt(ip);
  const ni = ip4ToInt(net);
  if (ipi === null || ni === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipi & mask) === (ni & mask);
}

function ipAllowed(request, conf) {
  const list = String(conf.IP_WHITELIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return true; // fail-open, когда список не задан

  // CF-Connecting-IP пишет сам край Cloudflare — подделать снаружи нельзя.
  const ip = request.headers.get("cf-connecting-ip") || "";
  if (!ip) return false; // fail-closed: нет IP -> отказ

  return list.some((rule) =>
    rule.includes("/") ? inCidr4(ip, rule) : rule === ip
  );
}

function tokenAllowed(request, conf) {
  const expected = String(conf.PROXY_TOKEN || "");
  if (!expected) return true; // токен не задан -> открытый доступ

  const header = request.headers.get("x-proxy-token") || "";
  if (header && timingSafeEqual(header, expected)) return true;

  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && timingSafeEqual(m[1].trim(), expected)) return true;

  return false;
}

// Постоянное по времени сравнение, чтобы не утекала длина совпадающего префикса.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hostAllowed(target, conf) {
  const list = String(conf.ALLOWED_HOSTS || "*")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0 || list.includes("*")) return true;
  const host = target.hostname.toLowerCase();
  return list.some((h) => host === h || host.endsWith("." + h));
}

/* ------------------------------- routing ---------------------------------- */

function resolveTarget(url, conf) {
  if (url.pathname.startsWith(PREFIX)) {
    let raw = url.pathname.slice(PREFIX.length);
    // URL-нормализация может «съесть» двойной слэш в схеме: "https:/host" -> fix
    raw = raw.replace(/^(https?):\/{0,2}/i, "$1://");
    const candidate = raw + url.search;
    try {
      return new URL(candidate);
    } catch {
      try {
        return new URL(decodeURIComponent(candidate));
      } catch {
        return null;
      }
    }
  }
  if (conf.TARGET_ORIGIN) {
    try {
      const base = new URL(conf.TARGET_ORIGIN);
      return new URL(url.pathname + url.search, base);
    } catch {
      return null;
    }
  }
  return null;
}

/* -------------------------------- proxy ----------------------------------- */

function buildUpstreamHeaders(request, target, conf) {
  const headers = new Headers(request.headers);

  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.delete("x-proxy-token"); // токен прокси наверх не уходит

  if (conf.HEADER_MODE === "clean") {
    for (const h of CF_EDGE_HEADERS) headers.delete(h);
    headers.set("user-agent", conf.DEFAULT_USER_AGENT);
  }

  // host выставит сам fetch из URL цели — руками не трогаем.
  headers.delete("host");
  return headers;
}

export default {
  async fetch(request, env) {
    const conf = readConfig(env);
    const url = new URL(request.url);

    // --- служебные маршруты ---
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse(
        {
          ok: true,
          service: "cf-proxy",
          mode: conf.TARGET_ORIGIN ? "gateway" : "path-proxy",
          target_origin: conf.TARGET_ORIGIN || null,
          allowed_hosts: conf.ALLOWED_HOSTS,
          header_mode: conf.HEADER_MODE,
          auth: conf.PROXY_TOKEN ? "token-required" : "open",
          time: new Date().toISOString(),
        },
        conf,
        200,
        request
      );
    }

    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, conf) });
    }

    // --- контроль доступа ---
    if (!ipAllowed(request, conf)) {
      return jsonResponse({ error: "ip_not_allowed" }, conf, 403, request);
    }
    if (!tokenAllowed(request, conf)) {
      return jsonResponse(
        { error: "invalid_proxy_token", hint: "передайте заголовок x-proxy-token" },
        conf,
        401,
        request
      );
    }

    // --- определение цели ---
    const target = resolveTarget(url, conf);
    if (!target) {
      return jsonResponse(
        {
          error: "no_target",
          hint:
            "Используйте /proxy/<полный-url> или задайте TARGET_ORIGIN в переменных окружения.",
        },
        conf,
        400,
        request
      );
    }
    if (!/^https?:$/.test(target.protocol)) {
      return jsonResponse({ error: "unsupported_protocol", protocol: target.protocol }, conf, 400, request);
    }
    if (!hostAllowed(target, conf)) {
      return jsonResponse(
        { error: "target_host_not_allowed", host: target.hostname, allowed: conf.ALLOWED_HOSTS },
        conf,
        403,
        request
      );
    }

    const isWebSocket =
      (request.headers.get("upgrade") || "").toLowerCase() === "websocket";

    const headers = buildUpstreamHeaders(request, target, conf);

    // WebSocket: отдаём апгрейд напрямую — Cloudflare сам поднимает туннель.
    if (isWebSocket) {
      try {
        const wsRequest = new Request(target.toString(), {
          method: request.method,
          headers,
        });
        return await fetch(wsRequest);
      } catch (e) {
        return jsonResponse({ error: "upstream_ws_failed", detail: String(e) }, conf, 502, request);
      }
    }

    // Обычный HTTP(S): тело запроса стримим как есть.
    const init = {
      method: request.method,
      headers,
      redirect: "follow",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      // Требование спецификации Fetch для стримингового тела запроса.
      // Cloudflare Workers игнорирует это поле, Node/undici — требует.
      init.duplex = "half";
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), init);
    } catch (e) {
      return jsonResponse(
        { error: "upstream_fetch_failed", target: target.toString(), detail: String(e) },
        conf,
        502,
        request
      );
    }

    // Собираем ответ: стрим сохраняем (важно для SSE), заголовки чистим.
    const respHeaders = new Headers(upstream.headers);
    for (const h of HOP_BY_HOP) respHeaders.delete(h);
    // fetch уже распаковал gzip/br — эти заголовки теперь врут, убираем.
    respHeaders.delete("content-encoding");
    respHeaders.delete("content-length");
    for (const [k, v] of Object.entries(corsHeaders(request, conf))) {
      respHeaders.set(k, v);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};
