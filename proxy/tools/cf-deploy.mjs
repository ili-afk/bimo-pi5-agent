#!/usr/bin/env node
/**
 * cf-deploy.mjs — развёртывание cf-proxy в Cloudflare Workers БЕЗ wrangler.
 *
 * Работает через Cloudflare REST API v4, только на встроенном fetch/FormData
 * (Node 18+). Полезно там, где CLI недоступен (в этой среде npm блокируется
 * sandbox-guard'ом и wrangler не запускается).
 *
 * Что делает команда `deploy`:
 *   1) PUT  /accounts/{acc}/workers/scripts/{name}          — загрузка src/index.js
 *      (module-формат + bindings: ALLOWED_HOSTS, TARGET_ORIGIN, HEADER_MODE, CORS_*, IP_WHITELIST)
 *   2) PUT  /accounts/{acc}/workers/scripts/{name}/secrets   — секрет PROXY_TOKEN
 *   3) POST /accounts/{acc}/workers/scripts/{name}/subdomain — включить *.workers.dev
 *   4) печатает публичный URL и готовую curl-команду
 *
 * Требуемые права токена: Workers Scripts:Edit (+ Account Settings:Read для субдомена).
 *
 * Переменные окружения:
 *   CF_API_TOKEN (или CLOUDFLARE_API_TOKEN)   — обязательно
 *   CF_ACCOUNT_ID (или CLOUDFLARE_ACCOUNT_ID) — обязательно (можно взять из `whoami`)
 *   WORKER_NAME                                — имя воркера (по умолчанию cf-proxy)
 *   PROXY_TOKEN                                — секрет прокси (иначе берётся из .dev.vars)
 *   ALLOWED_HOSTS                              — список целей (иначе из .dev.vars)
 *
 * Использование:
 *   node tools/cf-deploy.mjs help
 *   node tools/cf-deploy.mjs whoami      # проверить токен и аккаунт
 *   node tools/cf-deploy.mjs deploy
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const API = "https://api.cloudflare.com/client/v4";

const env = (name, alt) => (process.env[name] || (alt ? process.env[alt] : "") || "").trim();

function readDevVars() {
  const out = {};
  for (const f of [".dev.vars", ".dev.vars.example"]) {
    try {
      const txt = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const line of txt.split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
        if (m && !(m[1] in out)) out[m[1]] = m[2];
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

const dev = readDevVars();
const TOKEN = env("CF_API_TOKEN", "CLOUDFLARE_API_TOKEN");
const ACCOUNT = env("CF_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID");
const WORKER = env("WORKER_NAME") || "cf-proxy";
const PROXY_TOKEN = env("PROXY_TOKEN") || dev.PROXY_TOKEN || "";
const ALLOWED_HOSTS = env("ALLOWED_HOSTS") || dev.ALLOWED_HOSTS || "*";

function die(msg, code = 2) {
  console.error("\n[cf-deploy] " + msg + "\n");
  process.exit(code);
}

async function cf(pathname, init = {}) {
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      Authorization: "Bearer " + TOKEN,
      ...(init.headers || {}),
    },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = { success: false, errors: [{ message: "non-JSON response, HTTP " + res.status }] };
  }
  return { status: res.status, ok: res.ok && body.success !== false, body };
}

function requireAuth() {
  if (!TOKEN) die("нет CF_API_TOKEN. Создайте токен с правами Workers Scripts:Edit и передайте:\n  CF_API_TOKEN=... CF_ACCOUNT_ID=... node tools/cf-deploy.mjs deploy", 2);
  if (!ACCOUNT) die("нет CF_ACCOUNT_ID. Узнайте: node tools/cf-deploy.mjs whoami  (или dash → Workers → Account ID)", 2);
}

async function whoami() {
  if (!TOKEN) die("нет CF_API_TOKEN", 2);
  const v = await cf("/user/tokens/verify");
  console.log("token verify:", v.ok ? "OK" : "FAIL", JSON.stringify(v.body.result || v.body.errors));
  const accs = await cf("/accounts?per_page=20");
  if (accs.ok) {
    for (const a of accs.body.result || []) console.log("account:", a.id, "-", a.name);
  } else {
    console.log("accounts error:", JSON.stringify(accs.body.errors));
  }
  const sub = ACCOUNT ? await cf(`/accounts/${ACCOUNT}/workers/subdomain`) : null;
  if (sub && sub.ok) console.log("workers.dev subdomain:", sub.body.result?.subdomain);
}

async function deploy() {
  requireAuth();
  const src = path.join(ROOT, "src", "index.js");
  if (!fs.existsSync(src)) die("не найден src/index.js", 2);
  const code = fs.readFileSync(src, "utf8");

  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    bindings: [
      { type: "plain_text", name: "ALLOWED_HOSTS", text: ALLOWED_HOSTS },
      { type: "plain_text", name: "TARGET_ORIGIN", text: env("TARGET_ORIGIN") || "" },
      { type: "plain_text", name: "HEADER_MODE", text: env("HEADER_MODE") || "clean" },
      { type: "plain_text", name: "CORS_ALLOW_ORIGIN", text: env("CORS_ALLOW_ORIGIN") || "*" },
      { type: "plain_text", name: "IP_WHITELIST", text: env("IP_WHITELIST") || "" },
    ],
    observability: { enabled: true },
  };

  const fd = new FormData();
  fd.append("metadata", JSON.stringify(metadata));
  fd.append("index.js", new Blob([code], { type: "application/javascript+module" }), "index.js");

  console.log(`[1/3] загрузка воркера "${WORKER}" в аккаунт ${ACCOUNT} …`);
  const up = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}`, { method: "PUT", body: fd });
  if (!up.ok) die("загрузка не удалась: " + JSON.stringify(up.body.errors || up.body, null, 2), 1);
  console.log("      OK — script uploaded");

  if (PROXY_TOKEN) {
    console.log("[2/3] установка секрета PROXY_TOKEN …");
    const sec = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/secrets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "PROXY_TOKEN", text: PROXY_TOKEN, type: "secret_text" }),
    });
    if (!sec.ok) die("секрет не установлен: " + JSON.stringify(sec.body.errors || sec.body, null, 2), 1);
    console.log("      OK — secret set");
  } else {
    console.log("[2/3] PROXY_TOKEN пуст — пропуск (прокси будет ОТКРЫТЫМ, не оставляйте так)");
  }

  console.log("[3/3] включение *.workers.dev …");
  const sub = await cf(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}/subdomain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
  if (!sub.ok) console.log("      предупреждение: " + JSON.stringify(sub.body.errors || sub.body));

  let subdomain = "<ваш-логин>";
  const s = await cf(`/accounts/${ACCOUNT}/workers/subdomain`);
  if (s.ok && s.body.result?.subdomain) subdomain = s.body.result.subdomain;

  const url = `https://${WORKER}.${subdomain}.workers.dev`;
  console.log("\n=== ГОТОВО ===");
  console.log("URL:      " + url);
  console.log("health:   " + url + "/health");
  console.log("\nПример запроса к WorkBuddy через прокси:");
  console.log(`  curl -N "${url}/proxy/https://www.workbuddy.ai/" -H "x-proxy-token: ${PROXY_TOKEN || "<PROXY_TOKEN>"}"`);
}

const cmd = (process.argv[2] || "help").toLowerCase();
if (cmd === "deploy") await deploy();
else if (cmd === "whoami") await whoami();
else {
  console.log(`cf-deploy.mjs — деплой cf-proxy без wrangler

Команды:
  whoami   проверить CF_API_TOKEN и узнать CF_ACCOUNT_ID / субдомен
  deploy   загрузить src/index.js, задать PROXY_TOKEN, включить *.workers.dev

Переменные окружения:
  CF_API_TOKEN / CLOUDFLARE_API_TOKEN   (обязательно)
  CF_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID (обязательно)
  WORKER_NAME                           (по умолчанию cf-proxy)
  PROXY_TOKEN, ALLOWED_HOSTS            (иначе из .dev.vars)

Пример:
  CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node tools/cf-deploy.mjs deploy`);
}
