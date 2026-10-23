/**
 * Тест «не переводить то, что уже на целевом языке».
 *
 *   node test-skiplang.cjs <путь-к-папке-расширения> [страница.html]
 *
 * Проверяем весь путь целиком: настройка → service worker → статистика →
 * надпись в уведомлении → текст статьи. Юнит-тесты отдельно проверяют сам
 * определитель языка, здесь важно, что пользователь видит обещанное.
 *
 * Сети не нужно: в копию расширения дописываем подставной движок перевода.
 * Патчим именно копию, исходники не трогаем.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-skip");
const USER_DATA = PATHS.testProfile("skip");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock.html";
const PORT_HTTP = 8796;
const CHROME = PATHS.CHROME;

// подставной перевод: по нему однозначно видно, ходили в движок или нет
const STUB = "ПЕРЕВЕДЕНО:";

const RU =
  "Автомобиль оснащён опозитным двигателем и новыми амортизаторами, " +
  "которые были разработаны специально для этой модели и доступны с завода.";
const EN =
  "The car has a boxer engine and the new dampers, which were developed " +
  "for this model and are available from the factory.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}
function note(text) {
  console.log("  · " + text);
}

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

  // Подменяем движок перевода в КОПИИ. googleTranslate — обычная функция
  // верхнего уровня, её можно переприсвоить, дописав строчку в конец файла.
  fs.appendFileSync(
    path.join(TEST_EXT, "background.js"),
    `\n// --- подставной движок для теста ---\ngoogleTranslate = async (t) => ${JSON.stringify(STUB)} + " " + t;\n`
  );

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
      })
  };
}

async function main() {
  prepareTestExtension();
  const server = await startServer();

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
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
  );

  const c = pipeCdp(chrome);
  try {
    let extId = null;
    for (let i = 0; i < 40; i++) {
      try { const r = await c.send("Extensions.loadUnpacked", { path: TEST_EXT }); extId = r.id; break; }
      catch (e) { if (i === 39) throw e; await sleep(400); }
    }
    await PATHS.clearStorage(c, extId, TEST_EXT);
    console.log("расширение: %s", extId);

    // настройки: без предпросмотра, только перевод (рерайт здесь не нужен и мешал бы)
    const setSettings = async (patch) => {
      const pv = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
      const s2 = await c.send("Target.attachToTarget", { targetId: pv.targetId, flatten: true });
      await c.send("Runtime.enable", {}, s2.sessionId);
      const ev = async (expression) => {
        const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, s2.sessionId);
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
      };
      // Попап открывается в новом таргете, и сначала в нём живёт пустой документ:
      // помощник, определённый до перехода на popup.html, теряется вместе с ним.
      for (let i = 0; i < 30; i++) {
        if (await ev(`!!document.getElementById('save')`)) break;
        await sleep(200);
      }
      await ev(
        `window.__send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, ` +
          `(r) => res(r || { ok: false, error: String(((chrome.runtime.lastError || {}).message) || "нет ответа") }))); true`
      );
      let ok = false;
      const want = Object.keys(patch);
      for (let i = 0; i < 8; i++) {
        const res = await ev(`__send({ type: 'saveSettings', settings: ${JSON.stringify(patch)} })`);
        const raw = await ev(`__send({ type: 'getSettings' }).then((r) => JSON.stringify((r || {}).settings || {}))`);
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (e) {}
        if (res && res.ok && want.every((k) => parsed[k] === patch[k])) { ok = true; break; }
        await sleep(400);
      }
      await c.send("Target.closeTarget", { targetId: pv.targetId });
      if (!ok) throw new Error("не удалось применить настройки: " + JSON.stringify(patch));
    };

    await setSettings({ preview: false, mode: "translate", skipSameLang: true });

    let targetId = null;
    let sessionId = null;

    const evalJs = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };

    /**
     * Открывает страницу заново. Именно заново, а не через location.reload():
     * после перезагрузки синтетические клики по CDP доходят через раз, и тест
     * падает «не дождался уведомления», хотя код в порядке.
     */
    const openPage = async () => {
      if (targetId) {
        try { await c.send("Target.closeTarget", { targetId }); } catch (e) {}
        await sleep(200);
      }
      const t = await c.send("Target.createTarget", { url: `http://localhost:${PORT_HTTP}/${PAGE}` });
      targetId = t.targetId;
      const at = await c.send("Target.attachToTarget", { targetId, flatten: true });
      sessionId = at.sessionId;
      await c.send("Runtime.enable", {}, sessionId);
      await c.send("Page.enable", {}, sessionId);
      for (let i = 0; i < 40; i++) {
        if (await evalJs(`!!document.getElementById('dzr-bar') && document.documentElement.getAttribute('data-dzr-settings') === 'ready'`)) return;
        await sleep(250);
      }
      throw new Error("панель не появилась на странице");
    };

    await openPage();

    const clickEl = async (selector) => {
      const rect = await evalJs(`(() => {
        const b = document.querySelector(${JSON.stringify(selector)});
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!rect) throw new Error("нет элемента " + selector);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    };

    const paraText = () => evalJs(`document.querySelector('.body p').innerText.replace(/\\s+/g,' ').trim()`);
    const toastText = () => evalJs(`(document.getElementById('dzr-toast') || {}).innerText || ''`);
    const resetToast = () => evalJs(`(() => {
      const t = document.getElementById('dzr-toast');
      if (t) { t.innerHTML = ''; t.classList.remove('dzr-show'); }
      return true;
    })()`);

    /** Ставит в абзац нужный текст, выделяет его и жмёт кнопку панели. */
    const runOn = async (text) => {
      await resetToast();
      await evalJs(`(() => {
        const p = document.querySelector('.body p');
        p.textContent = ${JSON.stringify(text)};
        const r = document.createRange();
        r.selectNodeContents(p);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(r);
      })()`);
      await clickEl("#dzr-bar .dzr-go");
      for (let i = 0; i < 40; i++) {
        if (/Готово/.test(await toastText())) return true;
        await sleep(150);
      }
      return false;
    };

    // ==================== 1. русский текст при цели «русский» ====================
    console.log("\n=== русский текст, цель «русский» ===");
    if (!(await runOn(RU))) throw new Error("не дождался уведомления «Готово»");
    let toast = await toastText();
    let text = await paraText();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    console.log("  абзац: %j", text.slice(0, 60) + "…");
    check("в движок не ходили", !text.includes(STUB), JSON.stringify(text.slice(0, 40)));
    check("текст статьи остался прежним", text === RU, JSON.stringify(text.slice(0, 50)));
    check("в уведомлении сказано, что уже на русском", /уже на русском/.test(toast), toast.replace(/\n/g, " | "));
    check("указано, сколько фрагментов пропущено", /1 фрагм\./.test(toast), toast.replace(/\n/g, " | "));
    check("сказано, что не отправляли", /не отправлял/.test(toast), toast.replace(/\n/g, " | "));

    // ==================== 2. английский текст при цели «русский» ====================
    console.log("\n=== английский текст, цель «русский» ===");
    if (!(await runOn(EN))) throw new Error("не дождался второго уведомления");
    toast = await toastText();
    text = await paraText();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    check("английский абзац переведён", text.startsWith(STUB), JSON.stringify(text.slice(0, 50)));
    check("про пропуск ничего не написано", !/уже на русском/.test(toast), toast.replace(/\n/g, " | "));

    // ==================== 3. настройка выключена ====================
    console.log("\n=== настройка выключена ===");
    await setSettings({ skipSameLang: false });
    await openPage();
    if (!(await runOn(RU))) throw new Error("не дождался третьего уведомления");
    toast = await toastText();
    text = await paraText();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    check("с выключенной настройкой русский абзац тоже переводится", text.startsWith(STUB), JSON.stringify(text.slice(0, 50)));
    check("и про пропуск не сообщается", !/уже на русском/.test(toast), toast.replace(/\n/g, " | "));

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения:");
      errs.slice(-6).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 300)));
    }
    check("в странице нет исключений", errs.length === 0, errs.length + " шт.");

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const p = path.join(TMP, "shot-skiplang.png");
    fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот: %s", p);

    console.log("\n=== ИТОГ ===");
    const bad = results.filter((r) => !r.ok);
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
    bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
    void ROOT;
  } finally {
    try { server.close(); } catch (e) {}
    try { execSync("taskkill /F /T /PID " + chrome.pid, { stdio: "ignore" }); } catch (e) {}
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });
