#!/usr/bin/env node
/**
 * ============================================================================
 *  cf-domain.mjs — помощник по привязке БЕСПЛАТНОГО домена к Cloudflare Worker
 * ----------------------------------------------------------------------------
 *  Автоматизирует всю часть Cloudflare. От вас — только регистрация домена
 *  (e-mail + подтверждение) и запуск этих команд.
 *
 *  Требуемые переменные окружения:
 *    CF_API_TOKEN   — токен Cloudflare с правами Zone:Edit и Workers:Edit
 *    CF_ACCOUNT_ID  — ID аккаунта Cloudflare (правый сайдбар dash.cloudflare.com)
 *    DOMAIN         — ваш бесплатный домен, например myproxy.eu.org
 *    WORKER_NAME    — имя воркера, например cf-proxy
 *
 *  Команды:
 *    create-zone     создать зону в Cloudflare и ПОКАЗАТЬ NS (их вписать в eu.org)
 *    status          проверить, стала ли зона Active (после одобрения eu.org)
 *    attach          привязать домен к воркеру как Custom Domain
 *    list-domains    показать все кастомные домены аккаунта
 *    delete-domain   отвязать домен от воркера
 *
 *  Запуск:
 *    CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy DOMAIN=myproxy.eu.org WORKER_NAME=cf-proxy \
 *      node tools/cf-domain.mjs create-zone
 * ============================================================================
 */

const API = "https://api.cloudflare.com/client/v4";

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DOMAIN = process.env.DOMAIN;
const WORKER = process.env.WORKER_NAME || "cf-proxy";

const cmd = process.argv[2] || "help";

function need(cond, msg) {
  if (!cond) {
    console.error(`\u2717 ${msg}`);
    process.exit(2);
  }
}

async function cf(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const detail = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Cloudflare API ${res.status} ${path} -> ${detail || "unknown error"}`);
  }
  return data.result;
}

function printUsage() {
  console.log(`cf-domain.mjs — привязка бесплатного домена к Cloudflare Worker

Переменные окружения:
  CF_API_TOKEN   токен с правами Zone:Edit + Workers:Edit
  CF_ACCOUNT_ID  ID аккаунта Cloudflare
  DOMAIN         ваш домен, напр. myproxy.eu.org
  WORKER_NAME    имя воркера (по умолчанию cf-proxy)

Команды:
  create-zone    создать зону и получить NS (вписать в eu.org)
  status         проверить статус зоны
  attach         привязать домен к воркеру
  list-domains   список кастомных доменов
  delete-domain  отвязать домен
`);
}

async function getZone() {
  const zones = await cf(`/zones?name=${encodeURIComponent(DOMAIN)}`);
  return Array.isArray(zones) ? zones[0] : null;
}

async function createZone() {
  let zone = await getZone();
  if (zone) {
    console.log(`Зона уже существует: ${zone.name} (${zone.status})`);
  } else {
    zone = await cf("/zones", {
      method: "POST",
      body: JSON.stringify({
        name: DOMAIN,
        account: { id: ACCOUNT },
        jump_start: true,
      }),
    });
    console.log(`Зона создана: ${zone.name}`);
  }

  console.log("\n=== ВПИШИТЕ ЭТИ NS В ЗАЯВКУ eu.org ===");
  for (const ns of zone.name_servers || []) console.log("  " + ns);
  console.log("=====================================");
  console.log(`\nТекущий статус зоны: ${zone.status}`);
  if (zone.status !== "active") {
    console.log(
      "Зона станет active, когда eu.org одобрит домен и подтвердит NS.\n" +
        "После одобрения выполните:  node tools/cf-domain.mjs status"
    );
  } else {
    console.log("Зона активна — можно привязывать:  node tools/cf-domain.mjs attach");
  }
}

async function status() {
  const zone = await getZone();
  need(zone, `Зона ${DOMAIN} не найдена в аккаунте. Сначала: create-zone`);
  console.log(`Зона:   ${zone.name}`);
  console.log(`Статус: ${zone.status}`);
  console.log(`NS:     ${(zone.name_servers || []).join(", ")}`);
  console.log(`Zone ID: ${zone.id}`);
}

async function attach() {
  const zone = await getZone();
  need(zone, `Зона ${DOMAIN} не найдена. Сначала: create-zone`);
  need(
    zone.status === "active",
    `Зона ещё не active (сейчас "${zone.status}"). Дождитесь одобрения eu.org и подтверждения NS.`
  );

  const result = await cf(`/accounts/${ACCOUNT}/workers/domains`, {
    method: "POST",
    body: JSON.stringify({
      zone_id: zone.id,
      hostname: DOMAIN,
      service: WORKER,
      environment: "production",
    }),
  });

  console.log("\u2713 Домен привязан к воркеру!");
  console.log(`  Хост:    https://${result.hostname}`);
  console.log(`  Воркер:  ${result.service} (${result.environment})`);
  console.log(
    "\nСертификат SSL выпускается автоматически, обычно за 1–5 минут.\n" +
      `Проверка:  https://${DOMAIN}/health`
  );
}

async function listDomains() {
  const list = await cf(`/accounts/${ACCOUNT}/workers/domains`);
  if (!list || list.length === 0) {
    console.log("Кастомных доменов нет.");
    return;
  }
  console.log("ID | hostname | service | zone");
  for (const d of list) console.log(`${d.id} | ${d.hostname} | ${d.service} | ${d.zone_name}`);
}

async function deleteDomain() {
  const list = await cf(`/accounts/${ACCOUNT}/workers/domains`);
  const target = (list || []).find((d) => d.hostname === DOMAIN);
  need(target, `Домен ${DOMAIN} не привязан к воркерам.`);
  await cf(`/accounts/${ACCOUNT}/workers/domains/${target.id}`, { method: "DELETE" });
  console.log(`\u2713 Домен ${DOMAIN} отвязан.`);
}

const ACTIONS = {
  "create-zone": createZone,
  status,
  attach,
  "list-domains": listDomains,
  "delete-domain": deleteDomain,
};

(async () => {
  if (cmd === "help" || !ACTIONS[cmd]) {
    printUsage();
    process.exit(cmd === "help" ? 0 : 2);
  }
  need(TOKEN, "не задан CF_API_TOKEN");
  need(ACCOUNT, "не задан CF_ACCOUNT_ID");
  if (cmd !== "list-domains") need(DOMAIN, "не задан DOMAIN");
  try {
    await ACTIONS[cmd]();
  } catch (e) {
    console.error(`\u2717 ${e.message}`);
    process.exit(1);
  }
})();
