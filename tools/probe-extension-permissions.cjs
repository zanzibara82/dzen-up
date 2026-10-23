/**
 * Разовый разбор: какие права у расширения и что реально может воркер.
 *
 *   node tools/probe-extension-permissions.cjs [путь-к-папке-расширения]
 *
 * Отвечает на «почему расширение не доходит до моего сервиса»: печатает
 * выданные домены и пробует fetch из service worker к чужим адресам. Ничего не
 * меняет — только спрашивает. В общий прогон не входит.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const PATHS = require("../test/paths.cjs");

const TMP = PATHS.SCRATCH;
const TEST_EXT = path.join(TMP, "probe-perm-ext");
const USER_DATA = PATHS.testProfile("probeperm");
const CHROME = PATHS.CHROME;
const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function pipeCdp(child) {
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  let buf = "";
  let id = 0;
  const pending = new Map();
  fromBrowser.setEncoding("utf8");
  fromBrowser.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!raw.trim()) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    }
  });
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        const payload = sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params };
        toBrowser.write(JSON.stringify(payload) + "\0");
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); }
        }, 60000);
      })
  };
}

async function main() {
  copyDir(SRC_EXT, TEST_EXT);
  const chrome = spawn(CHROME, [
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--user-data-dir=" + USER_DATA,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

  const c = pipeCdp(chrome);
  try {
    let extId = null;
    for (let i = 0; i < 40; i++) {
      try { const r = await c.send("Extensions.loadUnpacked", { path: TEST_EXT }); extId = r.id; break; }
      catch (e) { if (i === 39) throw e; await sleep(400); }
    }
    await PATHS.clearStorage(c, extId, TEST_EXT);
    console.log("расширение: %s", extId);

    // Воркер поднимается не сразу — ждём цель.
    let sw = null;
    for (let i = 0; i < 30; i++) {
      const { targetInfos } = await c.send("Target.getTargets");
      sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extId));
      if (sw) break;
      await sleep(300);
    }
    if (!sw) throw new Error("service worker не поднялся");
    const ss = await c.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    const sid = ss.sessionId;
    await c.send("Runtime.enable", {}, sid);
    const ev = async (expr) => {
      const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
      if (r.exceptionDetails) return "ИСКЛЮЧЕНИЕ: " + JSON.stringify(r.exceptionDetails).slice(0, 200);
      return r.result.value;
    };

    console.log("\n--- права ---");
    console.log("все права: %s", await ev(`chrome.permissions.getAll().then(p => JSON.stringify(p.origins || []))`));
    for (const o of ["https://api.z.ai/*", "https://api.openai.com/*", "https://*/*"]) {
      console.log("  %s -> %s", o, await ev(`chrome.permissions.contains({origins:["${o}"]})`));
    }

    console.log("\n--- годные ли шаблоны прав ---");
    // Порт в шаблоне — вопрос не вкуса: на негодном шаблоне contains не отвечает
    // false, а падает, и падение убивает обработчик кнопки целиком.
    const patterns = [
      "https://auto-dom24.ru/*",
      "https://auto-dom24.ru/blog/*",
      "http://localhost:8797/*",
      "http://localhost/*",
      "https://api.z.ai/*",
      "https://Photo: Subaru of America, Inc./*",
      "https://example.com:8443/*"
    ];
    for (const p of patterns) {
      const r = await ev(
        `chrome.permissions.contains({ origins: [${JSON.stringify(p)}] })` +
          `.then((v) => "принят: " + v).catch((e) => "ОТКАЗ: " + e.message)`
      );
      console.log("  %s\n     %s", p, r);
    }

    console.log("\n--- fetch из воркера ---");
    const probe = (url) =>
      ev(`fetch(${JSON.stringify(url)}, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 8, messages: [{ role: "user", content: "ok" }] }) })
          .then(r => r.text().then(t => "HTTP " + r.status + " | " + t.replace(/\\s+/g," ").slice(0, 160)))
          .catch(e => "ОШИБКА СЕТИ: " + e.message)`);
    for (const u of [
      "https://api.z.ai/api/chat/completions",
      "https://api.z.ai/api/paas/v4/chat/completions",
      "https://api.openai.com/v1/models"
    ]) {
      console.log("  %s\n     %s", u, await probe(u));
    }
  } finally {
    try { chrome.kill(); } catch (e) {}
  }
}

main().catch((e) => { console.error("ошибка:", e.message); process.exit(1); });
