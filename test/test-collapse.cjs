/**
 * Тест свёртывания панели в пузырёк.
 *
 *   node test-collapse.cjs <путь-к-папке-расширения>
 *
 * Обещание: панель не мозолит глаза там, где нет редактора (лента, чтение
 * статьи), но обязана быть развёрнутой там, где редактор есть — в том числе
 * если он появился позже (Дзен — SPA). Ручное сворачивание авто-правило
 * не должно отменять.
 *
 * Каждый сценарий — своя вкладка, поэтому запускаем их на разных страницах
 * одного прогона: mock.html (редактор есть), mock-empty.html (нет),
 * mock-late.html (появляется через 1.5 с).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-collapse");
const USER_DATA = PATHS.testProfile("collapse");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PORT_HTTP = 8792;
const CHROME = PATHS.CHROME;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
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
  const toBrowser = child.stdio[3], fromBrowser = child.stdio[4];
  let buf = "", id = 0;
  const pending = new Map(), events = [];
  fromBrowser.setEncoding("utf8");
  fromBrowser.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!raw.trim()) continue;
      let msg; try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) events.push(msg);
    }
  });
  return {
    events,
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const mid = ++id; pending.set(mid, { res, rej });
        toBrowser.write(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }) + "\0");
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error("timeout " + method)); } }, 20000);
      }),
  };
}

async function main() {
  copyDir(SRC_EXT, TEST_EXT);
  const mf = path.join(TEST_EXT, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const origin = `http://localhost:${PORT_HTTP}/*`;
  m.content_scripts.forEach((cs) => { if (!cs.matches.includes(origin)) cs.matches.push(origin); });
  m.host_permissions = (m.host_permissions || []).concat([origin]);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));

  const server = await startServer();
  const chrome = spawn(CHROME, [
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--user-data-dir=" + USER_DATA, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--window-size=1280,900", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

  const c = pipeCdp(chrome);
  try {
    let extId = null;
    for (let i = 0; i < 40; i++) {
      try { const r = await c.send("Extensions.loadUnpacked", { path: TEST_EXT }); extId = r.id; break; }
      catch (e) { if (i === 39) throw e; await sleep(400); }
    }
    await PATHS.clearStorage(c, extId, TEST_EXT);

    const openPage = async (page) => {
      const { targetId } = await c.send("Target.createTarget", { url: `http://localhost:${PORT_HTTP}/${page}` });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      await c.send("Runtime.enable", {}, sessionId);
      await c.send("Page.enable", {}, sessionId);
      const evalJs = async (expression) => {
        const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result.value;
      };
      for (let i = 0; i < 40; i++) {
        if (await evalJs(`!!document.getElementById('dzr-bar') && document.documentElement.getAttribute('data-dzr-settings') === 'ready'`)) break;
        await sleep(200);
      }
      return { evalJs, sessionId };
    };

    // снимок состояния панели
    const stateOf = (evalJs) =>
      evalJs(`(() => {
        const b = document.getElementById('dzr-bar');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const go = b.querySelector('.dzr-go');
        const tg = b.querySelector('.dzr-toggle');
        const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
        return {
          collapsed: b.classList.contains('dzr-collapsed'),
          w: Math.round(r.width), h: Math.round(r.height),
          goVisible: vis(go),
          toggleVisible: vis(tg),
          toggleIcon: tg ? (tg.getAttribute('data-collapsed') === 'true' ? 'wand' : 'chevron') : null
        };
      })()`);

    const clickEl = async (sessionId, selector) => {
      const rect = await c.send("Runtime.evaluate", {
        expression: `(() => { const b=document.querySelector(${JSON.stringify(selector)}); if(!b) return null;
          const r=b.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`,
        returnByValue: true,
      }, sessionId);
      const p = rect.result.value;
      if (!p) throw new Error("нет элемента " + selector);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 }, sessionId);
    };

    // ------------------------------------------------ A: редактор есть ---
    console.log("=== A: страница с редактором — панель развёрнута ===");
    {
      const { evalJs, sessionId } = await openPage("mock.html");
      await sleep(400);
      const s = await stateOf(evalJs);
      check("панель не свёрнута", !!s && s.collapsed === false, JSON.stringify(s));
      check("кнопка действия видна", !!s && s.goVisible === true);
      check("панель широкая, а не пузырёк", !!s && s.w > 300, s ? "ширина " + s.w : "");

      // ручное сворачивание
      console.log("=== B: ручное сворачивание ===");
      await clickEl(sessionId, "#dzr-bar .dzr-toggle");
      await sleep(400);
      const c1 = await stateOf(evalJs);
      check("панель свернулась в пузырёк", !!c1 && c1.collapsed === true, JSON.stringify(c1));
      check("пузырёк круглый и маленький", !!c1 && c1.w <= 60 && c1.h <= 60, c1 ? c1.w + "×" + c1.h : "");
      check("кнопка действия спрятана", !!c1 && c1.goVisible === false);
      check("в пузырьке видна кнопка разворота", !!c1 && c1.toggleVisible === true);

      // авто-правило не должно разворачивать то, что свернул пользователь
      await sleep(2200);
      const c2 = await stateOf(evalJs);
      check("свёрнутое вручную не развернулось само", !!c2 && c2.collapsed === true, JSON.stringify(c2));

      // разворачиваем обратно
      await clickEl(sessionId, "#dzr-bar .dzr-toggle");
      await sleep(400);
      const c3 = await stateOf(evalJs);
      check("клик по пузырьку разворачивает", !!c3 && c3.collapsed === false, JSON.stringify(c3));
      check("кнопка действия вернулась", !!c3 && c3.goVisible === true);

      await c.send("Target.closeTarget", { targetId: (await c.send("Target.getTargets")).targetInfos.find((t) => t.url.includes("mock.html")).targetId });
    }

    // ------------------------------------------------ C: редактора нет ---
    console.log("=== C: страница без редактора — панель свёрнута сама ===");
    {
      const { evalJs, sessionId } = await openPage("mock-empty.html");
      await sleep(600);
      const s = await stateOf(evalJs);
      check("панель свернулась в пузырёк", !!s && s.collapsed === true, JSON.stringify(s));
      check("это действительно пузырёк", !!s && s.w <= 60 && s.h <= 60, s ? s.w + "×" + s.h : "");
      check("кнопка действия не мешает", !!s && s.goVisible === false);
      check("пузырёк влез в экран", await evalJs(`(() => {
        const r = document.getElementById('dzr-bar').getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      })()`));

      // поле поиска не должно считаться редактором
      check("поле поиска не принято за редактор", !!s && s.collapsed === true);

      // скриншот пузырька — для отчёта
      const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.writeFileSync(path.join(TMP, "shot-collapsed.png"), Buffer.from(shot.data, "base64"));

      await clickEl(sessionId, "#dzr-bar .dzr-toggle");
      await sleep(400);
      const c1 = await stateOf(evalJs);
      check("клик по пузырьку разворачивает панель", !!c1 && c1.collapsed === false, JSON.stringify(c1));
    }

    // ------------------------------------------------ D: редактор позже ---
    console.log("=== D: редактор появился позже (SPA) ===");
    {
      const { evalJs } = await openPage("mock-late.html");
      await sleep(500); // редактор ещё не смонтирован (он через 1.5 с)
      const early = await stateOf(evalJs);
      check("до появления редактора панель свёрнута", !!early && early.collapsed === true, JSON.stringify(early));
      check("редактора в DOM пока нет", (await evalJs(`!document.querySelector('.body')`)) === true);

      // ждём появления редактора и авто-разворота
      let expanded = null;
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        const s = await stateOf(evalJs);
        if (s && s.collapsed === false) { expanded = s; break; }
      }
      check("редактор появился", (await evalJs(`!!document.querySelector('.body[contenteditable="true"]')`)) === true);
      check("панель развернулась сама", !!expanded, expanded ? JSON.stringify(expanded) : "осталась пузырьком");
      check("кнопка действия снова доступна", !!expanded && expanded.goVisible === true);
    }

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    check("в страницах нет исключений", errs.length === 0, errs.length ? JSON.stringify(errs[0].params).slice(0, 200) : "");
  } finally {
    try { execSync("taskkill /F /T /PID " + chrome.pid, { stdio: "ignore" }); } catch (e) {}
    try { server.close(); } catch (e) {}
    const bad = results.filter((r) => !r.ok);
    console.log("");
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e && e.message); process.exit(1); });
