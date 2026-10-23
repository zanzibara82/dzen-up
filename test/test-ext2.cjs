/**
 * Реальный тест расширения в Chrome.
 * Google Chrome игнорирует --load-extension, поэтому грузим расширение
 * официальным путём: CDP Extensions.loadUnpacked (нужен --remote-debugging-pipe
 * + --enable-unsafe-extension-debugging).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-mocks");
const USER_DATA = PATHS.testProfile("mocks");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock.html";
const PORT_HTTP = 8787;
const CHROME = PATHS.CHROME;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function prepareTestExtension() {
  copyDir(SRC_EXT, TEST_EXT);
  const mf = path.join(TEST_EXT, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const origin = `http://localhost:${PORT_HTTP}/*`;
  m.content_scripts.forEach((cs) => { if (!cs.matches.includes(origin)) cs.matches.push(origin); });
  m.host_permissions = (m.host_permissions || []).concat([origin]);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  return TEST_EXT;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(MOCK_DIR, req.url === "/" ? "mock.html" : req.url.split("?")[0]);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("nope"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(PORT_HTTP, "127.0.0.1", () => r(server)));
}

/** CDP поверх stdio-пайпа (--remote-debugging-pipe) */
function pipeCdp(child) {
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  let buf = "";
  let id = 0;
  const pending = new Map();
  const events = [];

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
      } else if (msg.method) events.push(msg);
    }
  });

  return {
    events,
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        const payload = sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params };
        toBrowser.write(JSON.stringify(payload) + "\0");
        setTimeout(() => {
          if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); }
        }, 20000);
      }),
  };
}

async function main() {
  prepareTestExtension();
  const server = await startServer();
  console.log("мок-страница      : http://localhost:%d/mock.html", PORT_HTTP);
  console.log("тестовое расшир.  : %s", TEST_EXT);

  const chrome = spawn(
    CHROME,
    [
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      "--user-data-dir=" + USER_DATA,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
  );

  const c = pipeCdp(chrome);
  try {
    // грузим распакованное расширение
    let extId = null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await c.send("Extensions.loadUnpacked", { path: TEST_EXT });
        extId = r.id;
        break;
      } catch (e) {
        if (i === 39) throw e;
        await sleep(400);
      }
    }
    await PATHS.clearStorage(c, extId, TEST_EXT);
    console.log("расширение загружено, id: %s", extId);

    // Предпросмотр по умолчанию ВКЛючён, а эти моки проверяют немедленную вставку.
    // Пишем и ПРОВЕРЯЕМ: первый запуск поднимает service worker, и его onInstalled
    // пишет настройки по умолчанию, гоняясь с нашей записью.
    {
      const pv = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
      const s2 = await c.send("Target.attachToTarget", { targetId: pv.targetId, flatten: true });
      await c.send("Runtime.enable", {}, s2.sessionId);
      const ev = (expression) =>
        c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, s2.sessionId);
      // Попап открывается в новом таргете: сначала в нём пустой документ, где
      // chrome.storage ещё нет, и запись ушла бы в никуда.
      for (let i = 0; i < 30; i++) {
        const r = await ev(`typeof chrome !== 'undefined' && !!chrome.storage && !!document.getElementById('save')`);
        if (r.result && r.result.value) break;
        await sleep(200);
      }
      for (let i = 0; i < 8; i++) {
        await ev("chrome.storage.sync.set({ preview: false })");
        const got = await ev("chrome.storage.sync.get(['preview']).then(o => JSON.stringify(o))");
        let parsed = {};
        try { parsed = JSON.parse(got.result.value); } catch (e) {}
        if (parsed.preview === false) break;
        await sleep(400);
      }
      await c.send("Target.closeTarget", { targetId: pv.targetId });
    }

    const { targetId } = await c.send("Target.createTarget", { url: `http://localhost:${PORT_HTTP}/${PAGE}` });
    const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
    await c.send("Runtime.enable", {}, sessionId);
    await c.send("Page.enable", {}, sessionId);

    const evalJs = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };

    let barReady = false;
    for (let i = 0; i < 40; i++) {
      if (await evalJs(`!!document.getElementById('dzr-bar') && document.documentElement.getAttribute('data-dzr-settings') === 'ready'`)) { barReady = true; break; }
      await sleep(250);
    }
    console.log("панель появилась  : %s", barReady);
    if (!barReady) { console.log("ПРОВАЛ: контент-скрипт не внедрился"); return; }

    // 1) выделяем фрагмент — второй пункт списка, как в скриншоте
    const selected = process.env.NOSELECT
      ? await evalJs(`(() => { window.getSelection().removeAllRanges(); return ""; })()`)
      : await evalJs(`(() => {
      const li = document.querySelectorAll('.body li')[1];
      const r = document.createRange();
      r.selectNodeContents(li);
      const s = window.getSelection();
      s.removeAllRanges(); s.addRange(r);
      return s.toString();
    })()`);
    console.log("\nВЫДЕЛЕНО (%d симв.): %s", selected.length, JSON.stringify(selected.slice(0, 60) + "…"));
    console.log("статус панели до клика: %s", JSON.stringify(await evalJs(`document.querySelector('#dzr-bar .dzr-status').textContent`)));

    // 1a) Отпускаем кнопку мыши над выделением — как это делает живой человек.
    // Без этого выделение остаётся «программным»: selectionchange приходит
    // асинхронно, и на моках, сбрасывающих выделение на focusout (mock2),
    // панель успевает увидеть уже пустое выделение. Это флейк харнесса,
    // а не расширения: у реального пользователя mouseup есть всегда.
    {
      const liRect = await evalJs(`(() => {
        const li = document.querySelectorAll('.body li')[1];
        const r = li.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: liRect.x, y: liRect.y, button: "none" }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: liRect.x, y: liRect.y, button: "left", clickCount: 1 }, sessionId);
      await sleep(60);
    }

    // 2) координаты кнопки
    const rect = await evalJs(`(() => {
      const b = document.querySelector('#dzr-bar .dzr-go');
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    })()`);

    // 3) настоящий клик мышью
    await evalJs(`document.documentElement.setAttribute("data-dzr-debug","1")`);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" }, sessionId);
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);

    await sleep(2500);

    const after = await evalJs(`(() => ({
      status: document.querySelector('#dzr-bar .dzr-status').textContent,
      toast: (document.getElementById('dzr-toast')||{}).textContent || '',
      selLen: window.getSelection().toString().length,
      sel: window.getSelection().toString().slice(0,80),
      bodyHtml: document.querySelector('.body').innerHTML,
      bodyText: document.querySelector('.body').innerText
    }))()`);

    console.log("\n--- ПОСЛЕ КЛИКА ---");
    console.log("статус панели   : %s", JSON.stringify(after.status));
    console.log("тост            : %s", JSON.stringify(after.toast));
    console.log("выделение сейчас: %d симв. %s", after.selLen, JSON.stringify(after.sel));
    console.log("текст редактора :\n---\n%s\n---", after.bodyText.slice(0, 400));
    console.log("HTML редактора  :\n---\n%s\n---", String(after.bodyHtml).slice(0, 900));

    const dbg = JSON.parse((await evalJs(`document.documentElement.getAttribute("data-dzr-debug-info")`)) || "null");
    if (dbg) {
      console.log("\n[debug] режим : %s (родитель %s)", dbg.mode, dbg.parent);
      console.log("[debug] блоки : %s", JSON.stringify(dbg.blocks));
      console.log("[debug] частей: %s", dbg.parts);
      console.log("[debug] html  : %s", String(dbg.html).slice(0, 500));
    }

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения в странице:");
      errs.slice(-8).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 300)));
    }

    const logs = c.events.filter((e) => e.method === "Runtime.consoleAPICalled");
    if (logs.length) {
      console.log("\nконсоль страницы:");
      logs.slice(-25).forEach((e) => {
        const args = (e.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description)).join(" ");
        console.log("  [%s] %s", e.params.type, String(args).slice(0, 500));
      });
    }

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const shotPath = path.join(TMP, `shot-${path.basename(PAGE, ".html")}.png`);
    fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот: %s", shotPath);
  } finally {
    killChrome(chrome);
    server.close();
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });

/** На Windows chrome.kill() не убивает дерево процессов — добиваем taskkill. */
function killChrome(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      require("child_process").execSync("taskkill /F /T /PID " + child.pid, { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {}
}
