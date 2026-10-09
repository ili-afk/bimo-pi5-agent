/**
 * Локальный регрессионный тест cf-proxy.
 * Поднимает настоящий HTTP-апстрим, вызывает worker.fetch() как это делает
 * рантайм Cloudflare, и проверяет: маршрутизацию, токен, очистку заголовков,
 * проброс тела, SSE-стриминг и белый список хостов.
 *
 * Запуск:  node test/local-test.mjs
 */
import http from "node:http";
import worker from "../src/index.js";

const upstream = http.createServer((req, res) => {
  if (req.url.startsWith("/sse")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write("data: first\n\n");
    setTimeout(() => {
      res.write("data: second\n\n");
      res.end();
    }, 40);
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      })
    );
  });
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const port = upstream.address().port;
const base = `http://127.0.0.1:${port}`;

const env = {
  TARGET_ORIGIN: "",
  ALLOWED_HOSTS: "127.0.0.1",
  PROXY_TOKEN: "s3cret",
  CORS_ALLOW_ORIGIN: "*",
  HEADER_MODE: "clean",
  DEFAULT_USER_AGENT: "UA/clean-test",
  IP_WHITELIST: "",
};

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name} ${extra}`);
  }
}

// 1. health
{
  const r = await worker.fetch(new Request("https://w.dev/health"), env);
  const j = await r.json();
  check("health endpoint returns ok", r.status === 200 && j.ok === true);
}

// 2. без токена -> 401
{
  const r = await worker.fetch(
    new Request(`https://w.dev/proxy/${base}/echo`, { method: "POST", body: "x" }),
    env
  );
  check("missing token -> 401", r.status === 401);
}

// 3. с токеном: маршрутизация + тело + очистка заголовков
{
  const r = await worker.fetch(
    new Request(`https://w.dev/proxy/${base}/echo?q=1`, {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: {
        "x-proxy-token": "s3cret",
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.9",
        "cf-ray": "deadbeef",
        "user-agent": "evil-bot",
        origin: "https://app.example",
      },
    }),
    env
  );
  const j = await r.json();
  check("token -> 200", r.status === 200);
  check("path preserved", j.url === "/echo?q=1", `got ${j.url}`);
  check("body forwarded", j.body === JSON.stringify({ hello: "world" }));
  check("cf-connecting-ip stripped", j.headers["cf-connecting-ip"] === undefined);
  check("cf-ray stripped", j.headers["cf-ray"] === undefined);
  check("user-agent replaced", j.headers["user-agent"] === "UA/clean-test", `got ${j.headers["user-agent"]}`);
  check("proxy token not leaked upstream", j.headers["x-proxy-token"] === undefined);
  check("CORS header set", r.headers.get("access-control-allow-origin") === "*");
}

// 4. SSE-стриминг целиком
{
  const r = await worker.fetch(
    new Request(`https://w.dev/proxy/${base}/sse`, {
      headers: { "x-proxy-token": "s3cret" },
    }),
    env
  );
  const text = await r.text();
  check("SSE content-type", (r.headers.get("content-type") || "").includes("text/event-stream"));
  check("SSE streamed both events", text.includes("first") && text.includes("second"), JSON.stringify(text));
}

// 5. чужой хост -> 403
{
  const r = await worker.fetch(
    new Request("https://w.dev/proxy/https://evil.example.com/steal", {
      headers: { "x-proxy-token": "s3cret" },
    }),
    env
  );
  check("disallowed host -> 403", r.status === 403);
}

// 6. Bearer-токен тоже принимается
{
  const r = await worker.fetch(
    new Request(`https://w.dev/proxy/${base}/echo`, {
      headers: { authorization: "Bearer s3cret" },
    }),
    env
  );
  check("Authorization: Bearer accepted", r.status === 200);
}

// 7. IP-whitelist fail-closed
{
  const envIp = { ...env, IP_WHITELIST: "10.0.0.0/8" };
  const r = await worker.fetch(
    new Request(`https://w.dev/proxy/${base}/echo`, {
      headers: { "x-proxy-token": "s3cret", "cf-connecting-ip": "8.8.8.8" },
    }),
    envIp
  );
  check("ip outside whitelist -> 403", r.status === 403);
  const r2 = await worker.fetch(
    new Request(`https://w.dev/proxy/${base}/echo`, {
      headers: { "x-proxy-token": "s3cret", "cf-connecting-ip": "10.1.2.3" },
    }),
    envIp
  );
  check("ip inside whitelist -> 200", r2.status === 200);
}

// 8. режим gateway (TARGET_ORIGIN)
{
  const envGw = { ...env, TARGET_ORIGIN: base };
  const r = await worker.fetch(
    new Request("https://w.dev/echo?via=gateway", {
      headers: { "x-proxy-token": "s3cret" },
    }),
    envGw
  );
  const j = await r.json();
  check("gateway mode rewrites to TARGET_ORIGIN", r.status === 200 && j.url === "/echo?via=gateway", `got ${j.url}`);
}

upstream.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
