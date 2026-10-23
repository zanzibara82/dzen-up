/**
 * Тест сохранения картинок и инлайн-разметки.
 * Сценарий A: выделен абзац с <strong>/<em>/<a>  → разметка должна выжить.
 * Сценарий B: ничего не выделено (вся статья)     → картинка/фигура/разметка должны выжить.
 *            Перед обработкой всей статьи панель просит подтверждение — кликаем дважды.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const PATHS = require("./paths.cjs");

const ROOT = PATHS.REPO;
const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-fmt");
// Профиль Chrome — уникальный и в системном temp: чистить его не нужно,
// поэтому тест не делает массовых удалений (они упираются в защиту песочницы).
const USER_DATA = PATHS.testProfile("fmt");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock4.html";
const PORT_HTTP = 8789;
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
        }, 30000);
      }),
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
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
      "about:blank",
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
    console.log("расширение загружено: %s\n", extId);

    // Предпросмотр по умолчанию ВКЛючён, а эти сценарии проверяют «немедленную»
    // вставку — выключаем его через страницу попапа (у неё есть chrome.storage).
    //
    // ВАЖНО: первый запуск расширения поднимает service worker, и его
    // onInstalled пишет настройки по умолчанию — эта запись гоняется с нашей
    // и может её затереть. Поэтому пишем и ПРОВЕРЯЕМ, при затирании повторяем.
    const setSetting = async (patch) => {
      const { targetId } = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      await c.send("Runtime.enable", {}, sessionId);
      const ev = (expression) =>
        c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      // Попап открывается в новом таргете: сначала в нём пустой документ, где
      // chrome.storage ещё нет, и запись ушла бы в никуда.
      for (let i = 0; i < 30; i++) {
        const r = await ev(`typeof chrome !== 'undefined' && !!chrome.storage && !!document.getElementById('save')`);
        if (r.result && r.result.value) break;
        await sleep(200);
      }
      const keys = Object.keys(patch);
      for (let i = 0; i < 8; i++) {
        await ev(`chrome.storage.sync.set(${JSON.stringify(patch)})`);
        const got = await ev(`chrome.storage.sync.get(${JSON.stringify(keys)}).then(o => JSON.stringify(o))`);
        let parsed = {};
        try { parsed = JSON.parse(got.result.value); } catch (e) {}
        if (keys.every((k) => parsed[k] === patch[k])) break;
        await sleep(400);
      }
      await c.send("Target.closeTarget", { targetId });
    };
    // Чистку ссылок выключаем: набор проверяет, что круговой рейс вообще способен
    // пронести разметку, и <a> здесь — представитель инлайн-разметки. Политика
    // «что делать со ссылками из оригинала» проверяется отдельно, в test-strip.cjs.
    await setSetting({ preview: false, stripLinks: "off" });

    const openPage = async () => {
      const { targetId } = await c.send("Target.createTarget", { url: `http://localhost:${PORT_HTTP}/${PAGE}` });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      await c.send("Runtime.enable", {}, sessionId);
      await c.send("Page.enable", {}, sessionId);
      const evalJs = async (expression) => {
        const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
      };
      for (let i = 0; i < 40; i++) {
        if (await evalJs(`!!document.getElementById('dzr-bar') && document.documentElement.getAttribute('data-dzr-settings') === 'ready'`)) break;
        await sleep(250);
      }
      await evalJs(`document.documentElement.setAttribute("data-dzr-debug","1")`);
      return { evalJs, sessionId };
    };

    const clickGo = async (evalJs, sessionId) => {
      const rect = await evalJs(`(() => {
        const b = document.querySelector('#dzr-bar .dzr-go');
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    };

    const snapshot = (evalJs) => evalJs(`(() => {
      const b = document.querySelector('.body');
      return {
        html: b.innerHTML,
        imgs: b.querySelectorAll('img').length,
        figures: b.querySelectorAll('figure').length,
        figcaption: b.querySelectorAll('figcaption').length,
        strong: b.querySelectorAll('strong').length,
        em: b.querySelectorAll('em').length,
        links: Array.from(b.querySelectorAll('a')).map(a => a.getAttribute('href')),
        tags: Array.from(b.children).map(e => e.tagName.toLowerCase()),
        text: b.innerText
      };
    })()`);

    const IS_NESTED = /mock5/.test(PAGE);
    const IS_LONG = /mock6/.test(PAGE);

    if (!IS_NESTED && !IS_LONG) {
    // ---------------------------------------------------------- сценарий A
    console.log("=== A. Выделен абзац с <strong>/<em>/<a> ===");
    {
      const { evalJs, sessionId } = await openPage();
      const before = await snapshot(evalJs);
      console.log("до:   теги=%s img=%d strong=%d em=%d links=%j",
        JSON.stringify(before.tags), before.imgs, before.strong, before.em, before.links);

      await evalJs(`(() => {
        const ps = document.querySelectorAll('.body p');
        const r = document.createRange();
        r.selectNodeContents(ps[ps.length-1]);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        return s.toString();
      })()`);
      await clickGo(evalJs, sessionId);
      await sleep(3000);
      const after = await snapshot(evalJs);
      const dbg = JSON.parse((await evalJs(`document.documentElement.getAttribute("data-dzr-debug-info")`)) || "null");
      console.log("после: теги=%s img=%d strong=%d em=%d links=%j",
        JSON.stringify(after.tags), after.imgs, after.strong, after.em, after.links);
      console.log("текст: %s", after.text.split("\n").filter(Boolean).slice(-1)[0]);
      if (dbg) { console.log("raw:   %s", String(dbg.raw).slice(0, 300)); console.log("токены: %j", dbg.tokens); console.log("html:  %s", String(dbg.html).slice(0, 400)); }
      check("A: жирный сохранён", after.strong >= 1);
      check("A: курсив сохранён", after.em >= 1);
      check("A: ссылка сохранена с href", after.links.includes("https://www.subaru.com/"));
      check("A: абзацев не добавилось", after.tags.length === before.tags.length, JSON.stringify(after.tags));
    }

    // ---------------------------------------------------------- сценарий B
    console.log("\n=== B. Ничего не выделено → вся статья (2 клика) ===");
    {
      const { evalJs, sessionId } = await openPage();
      const before = await snapshot(evalJs);
      console.log("до:   теги=%s img=%d figure=%d strong=%d em=%d links=%j",
        JSON.stringify(before.tags), before.imgs, before.figures, before.strong, before.em, before.links);

      // первый клик — должен только попросить подтверждение
      await clickGo(evalJs, sessionId);
      await sleep(700);
      const st1 = await evalJs(`document.querySelector('#dzr-bar .dzr-status').textContent`);
      const toast1 = await evalJs(`(document.getElementById('dzr-toast')||{}).textContent || ''`);
      const label1 = await evalJs(`document.querySelector('#dzr-bar .dzr-go').textContent`);
      console.log("после 1-го клика: статус=%j кнопка=%j", st1, label1);
      console.log("                  тост=%j", String(toast1).slice(0, 140));
      check("B: 1-й клик просит подтверждение", /всю статью/i.test(String(toast1)));
      check("B: 1-й клик ничего не изменил", (await snapshot(evalJs)).imgs === before.imgs && (await snapshot(evalJs)).strong === before.strong);

      // второй клик — обработка
      await clickGo(evalJs, sessionId);
      await sleep(6000);
      const after = await snapshot(evalJs);
      const dbg = JSON.parse((await evalJs(`document.documentElement.getAttribute("data-dzr-debug-info")`)) || "null");
      console.log("после: теги=%s img=%d figure=%d figcaption=%d strong=%d em=%d links=%j",
        JSON.stringify(after.tags), after.imgs, after.figures, after.figcaption, after.strong, after.em, after.links);
      console.log("текст:\n---\n%s\n---", after.text.slice(0, 500));
      if (dbg) { console.log("raw:   %s", String(dbg.raw).slice(0, 600)); console.log("токены: %j", dbg.tokens); console.log("html:  %s", String(dbg.html).slice(0, 700)); }
      check("B: картинка сохранена", after.imgs === before.imgs && after.imgs >= 1, "img=" + after.imgs);
      check("B: <figure> сохранён", after.figures >= 1);
      check("B: <figcaption> сохранён", after.figcaption >= 1);
      check("B: жирный сохранён", after.strong >= 1, "strong=" + after.strong);
      check("B: курсив сохранён", after.em >= 1, "em=" + after.em);
      check("B: ссылка сохранена с href", after.links.includes("https://www.subaru.com/"), JSON.stringify(after.links));
      check("B: структура блоков сохранена", after.tags.length === before.tags.length, JSON.stringify(after.tags));
      check("B: текст переведён", /[а-яё]/i.test(after.text));

      // откат
      const undoRect = await evalJs(`(() => {
        const b = document.querySelector('#dzr-bar .dzr-icon-btn:not([hidden])');
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`);
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: undoRect.x, y: undoRect.y, button: "left", clickCount: 1 }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: undoRect.x, y: undoRect.y, button: "left", clickCount: 1 }, sessionId);
      await sleep(1200);
      const undone = await snapshot(evalJs);
      const undbg = await evalJs(`document.documentElement.getAttribute("data-dzr-undo")`);
      console.log("откат (debug): %s", undbg);
      console.log("после отката: img=%d strong=%d em=%d, текст:\n---\n%s\n---",
        undone.imgs, undone.strong, undone.em, undone.text.slice(0, 300));
      check("B: откат вернул оригинал", undone.text === before.text);
      check("B: откат не потерял картинку", undone.imgs === before.imgs);
    }

    // скриншот результата обработки всей статьи
    {
      const { evalJs, sessionId } = await openPage();
      await clickGo(evalJs, sessionId);
      await sleep(400);
      await clickGo(evalJs, sessionId);
      await sleep(7000);
      const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
      const p = path.join(TMP, `shot-format-${path.basename(PAGE, ".html")}.png`);
      fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
      console.log("\nскриншот результата: %s", p);
    }

    // ---------------------------------------------------------- сценарий C
    console.log("\n=== C. Переводчик потерял/сломал маркеры (аварийный путь) ===");
    {
      const { evalJs, sessionId } = await openPage();
      const before = await snapshot(evalJs);

      // [[1]] (картинка) потерян совсем, [[4]] потерял закрывающий маркер
      const fake = [
        "[[2]]Фото: Subaru of America, Inc.[[/2]]",
        "Итоги Subaru Outback Wilderness 2026 года",
        "Комплектация Wilderness — самая прочная версия Outback 2026 года.",
        "Стандартные функции включают электронные амортизаторы и дорожный просвет 9,5 дюймов.",
        "Subaru Outback Wilderness 2026 года оснащен 2,4-литровым двигателем Boxer с турбонаддувом.",
        "По данным [[3]]Subaru of America[[/3]], буксировочная способность составляет [[4]]3500 фунтов, см. [[5]]официальную страницу[[/5]] подробности."
      ].join("\n\n");
      await evalJs(`document.documentElement.setAttribute("data-dzr-fake-translate", ${JSON.stringify(fake)})`);

      await clickGo(evalJs, sessionId);
      await sleep(400);
      await clickGo(evalJs, sessionId);
      await sleep(1500);

      const after = await snapshot(evalJs);
      const dbg = JSON.parse((await evalJs(`document.documentElement.getAttribute("data-dzr-debug-info")`)) || "null");
      console.log("после: теги=%s img=%d figure=%d figcaption=%d strong=%d em=%d links=%j",
        JSON.stringify(after.tags), after.imgs, after.figures, after.figcaption, after.strong, after.em, after.links);
      console.log("текст:\n---\n%s\n---", after.text.slice(0, 400));
      if (dbg) { console.log("токены: %j", dbg.tokens); console.log("html:  %s", String(dbg.html).slice(0, 600)); }

      check("C: потерянная картинка всё равно вставлена", after.imgs === 1, "img=" + after.imgs);
      check("C: <figure> на месте", after.figures === 1);
      check("C: <figcaption> на месте", after.figcaption === 1);
      check("C: целый маркер разметки восстановлен (strong)", after.strong === 1);
      check("C: целый маркер ссылки восстановлен", after.links.includes("https://www.subaru.com/"));
      check("C: текст сломанного маркера не потерян", /3,500 lbs/.test(after.text), after.text.slice(-80));
      check("C: маркеры не попали в текст", !/\[\[|\]\]/.test(after.html), String(after.html).match(/\[\[[^\]]*\]\]/g));
      check("C: структура блоков сохранена", after.tags.length === before.tags.length, JSON.stringify(after.tags));
    }
    } // !IS_NESTED

    // ---------------------------------------------------------- сценарий D
    if (IS_NESTED) {
    console.log("\n=== D. Сложная структура (обёртка, вложенный список, br, img в абзаце, таблица) ===");
    {
      const { evalJs, sessionId } = await openPage();
      const before = await snapshot(evalJs);
      const deep = (e) => e.evalJs(`(() => {
        const b = document.querySelector('.body');
        // спускаемся сквозь div-обёртки: расширение их намеренно «разворачивает»
        let node = b;
        while (node.children.length === 1 && node.children[0].tagName === 'DIV') node = node.children[0];
        return {
          nestedUl: b.querySelectorAll('ul ul').length,
          nestedLi: b.querySelectorAll('ul ul li').length,
          brs: b.querySelectorAll('br').length,
          tables: b.querySelectorAll('table').length,
          cells: b.querySelectorAll('td').length,
          blockquotes: b.querySelectorAll('blockquote').length,
          headings: b.querySelectorAll('h2').length,
          imgs: b.querySelectorAll('img').length,
          topTags: Array.from(node.children).map(e => e.tagName.toLowerCase())
        };
      })()`);
      const d0 = await deep({ evalJs });
      console.log("до:   %j", d0);

      await clickGo(evalJs, sessionId);
      await sleep(400);
      await clickGo(evalJs, sessionId);
      await sleep(7000);

      const after = await snapshot(evalJs);
      const d1 = await deep({ evalJs });
      const dbg = JSON.parse((await evalJs(`document.documentElement.getAttribute("data-dzr-debug-info")`)) || "null");
      console.log("после: %j", d1);
      console.log("текст:\n---\n%s\n---", after.text.slice(0, 700));
      if (dbg) {
        console.log("блоки: %j", dbg.blocks);
        console.log("raw:   %s", String(dbg.raw).slice(0, 700));
        console.log("токены: %j", dbg.tokens);
        console.log("html:  %s", String(dbg.html).slice(0, 900));
      }

      check("D: верхние блоки не изменились", JSON.stringify(d1.topTags) === JSON.stringify(d0.topTags), JSON.stringify(d1.topTags));
      check("D: картинка в абзаце сохранена", after.imgs === d0.imgs || after.imgs === 1, "img=" + after.imgs);
      check("D: <br> сохранён", d1.brs >= d0.brs, "br=" + d1.brs);
      check("D: вложенный список сохранён", d1.nestedUl === d0.nestedUl && d1.nestedLi === d0.nestedLi, JSON.stringify(d1));
      check("D: цитата сохранена", d1.blockquotes === d0.blockquotes);
      check("D: таблица не тронута", d1.tables === d0.tables && d1.cells === d0.cells, JSON.stringify(d1));
      check("D: заголовок сохранён", d1.headings === d0.headings);
      check("D: ссылка в заголовке сохранена", after.links.includes("https://www.subaru.com/wilderness"), JSON.stringify(after.links));
      check("D: жирный сохранён", after.strong >= 1, "strong=" + after.strong);
      check("D: маркеры не попали в текст", !/\[\[|\]\]/.test(after.html), String(after.html).match(/\[\[[^\]]*\]\]/g));
      check("D: текст переведён", /[а-яё]/i.test(after.text));
    }
    } // IS_NESTED

    // ---------------------------------------------------------- сценарий E
    if (IS_LONG) {
    console.log("\n=== E. Длинная статья: отмена и прогресс ===");
    {
      const { evalJs, sessionId } = await openPage();
      const before = await snapshot(evalJs);
      const readBtn = () => evalJs(`(() => {
        const b = document.querySelector('#dzr-bar .dzr-go');
        return { label: b.textContent.trim(), cancel: b.classList.contains('dzr-cancel'), disabled: b.disabled };
      })()`);
      const readStatus = () => evalJs(`document.querySelector('#dzr-bar .dzr-status').textContent`);

      console.log("кнопка до старта: %j", await readBtn());

      // ---- часть 1: отмена ------------------------------------------------
      // Стартуем и сразу отменяем: окно между стартом и отменой маленькое,
      // иначе перевод успевает завершиться и клик запускает новый прогон.
      await clickGo(evalJs, sessionId);   // 1-й клик — подтверждение
      await sleep(300);
      await clickGo(evalJs, sessionId);   // 2-й клик — старт
      await sleep(180);

      const during = await readBtn();
      const stDuring = await readStatus();
      console.log("во время перевода: кнопка=%j статус=%j", during, stDuring);
      check("E: во время работы кнопка стала «Отменить»", during.cancel && /Отмен/i.test(during.label), JSON.stringify(during));
      check("E: кнопка не заблокирована (можно нажать)", during.disabled === false);

      await clickGo(evalJs, sessionId);   // отменяем
      await sleep(1600);
      const stAfter = await readStatus();
      const toastAfter = await evalJs(`(document.getElementById('dzr-toast')||{}).textContent || ''`);
      const btnAfter = await readBtn();
      const after = await snapshot(evalJs);
      console.log("после отмены: статус=%j кнопка=%j", stAfter, btnAfter);
      console.log("              тост=%j", String(toastAfter).slice(0, 120));

      check("E: статус говорит об отмене", /Отмен/i.test(stAfter), stAfter);
      check("E: кнопка вернулась в обычное состояние", !btnAfter.cancel && /Перевести и рерайтить/i.test(btnAfter.label), JSON.stringify(btnAfter));
      check("E: текст статьи НЕ изменён", after.text === before.text, after.text.slice(0, 60));
      check("E: структура не пострадала", JSON.stringify(after.tags) === JSON.stringify(before.tags), JSON.stringify(after.tags));

      // ---- часть 2: прогресс и полный прогон -------------------------------
      // Опрос «раз в 250 мс» за прогоном не поспевал: перевод длинной статьи
      // укладывается в полсекунды, и второй замер приходил уже на «Выделите
      // текст». Проверка «прогресс растёт» краснела от скорости машины, а не от
      // поломки. Поэтому не опрашиваем, а подписываемся на изменения статуса —
      // так собираются все значения, сколько бы их ни успело появиться.
      await evalJs(`(() => {
        const el = document.querySelector('#dzr-bar .dzr-status');
        window.__dzrStatus = [];
        const push = () => {
          const t = el.textContent;
          if (window.__dzrStatus[window.__dzrStatus.length - 1] !== t) window.__dzrStatus.push(t);
        };
        push();
        window.__dzrWatch = new MutationObserver(push);
        window.__dzrWatch.observe(el, { childList: true, characterData: true, subtree: true });
        return true;
      })()`);

      await clickGo(evalJs, sessionId);
      await sleep(300);
      await clickGo(evalJs, sessionId);

      // ждём завершения (перевод длинной статьи идёт небыстро)
      let done = false;
      for (let i = 0; i < 80; i++) {
        await sleep(500);
        const b = await readBtn();
        if (!b.cancel) { done = true; break; }
      }

      const seen = await evalJs(`(window.__dzrWatch.disconnect(), window.__dzrStatus)`);
      const percents = (seen || []).map((s) => parseInt((s.match(/(\d+)%/) || [])[1], 10)).filter((n) => !isNaN(n));
      console.log("история статуса: %j", seen);
      console.log("доли: %j", percents);
      check("E: статус показывает прогресс с долей", (seen || []).some((s) => /\(\d+\/\d+\)/.test(s)), JSON.stringify((seen || []).slice(0, 3)));
      check("E: прогресс растёт", percents.length > 1 && percents[percents.length - 1] > percents[0], JSON.stringify(percents));

      const final = await snapshot(evalJs);
      const finalToast = await evalJs(`(document.getElementById('dzr-toast')||{}).textContent || ''`);
      console.log("полный прогон: завершился=%s теги=%s", done, JSON.stringify(final.tags));
      console.log("               тост=%j", String(finalToast).slice(0, 200));
      check("E: полный прогон завершился", done);
      check("E: после отмены перевод снова работает", /[а-яё]/i.test(final.text), final.text.slice(0, 60));
      check("E: структура сохранена", JSON.stringify(final.tags) === JSON.stringify(before.tags), JSON.stringify(final.tags));
      check("E: в тосте видно статистику перевода", /кэш|через|не переведено|Готово/i.test(String(finalToast)), String(finalToast).slice(0, 120));
    }
    } // IS_LONG

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения в странице:");
      errs.slice(-6).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 300)));
    }

    console.log("\n=== ИТОГ ===");
    const bad = results.filter((r) => !r.ok);
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
    bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
  } finally {
    killChrome(chrome);
    server.close();
  }
}

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

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });
