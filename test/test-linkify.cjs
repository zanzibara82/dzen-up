/**
 * Тест перелинковки в живом редакторе.
 *
 *   node test-linkify.cjs <путь-к-папке-расширения> [страница.html]
 *
 * Проверяем весь путь: кнопка в панели → service worker → sitemap сайта →
 * подбор статьи → расстановка ссылок по абзацам. Юнит-тесты (test-links.cjs)
 * проверяют разбор и подбор отдельно, здесь важно, что получается в статье.
 *
 * Сети не нужно: мок-сервер отдаёт и страницу, и sitemap.xml, а в копию
 * расширения дописывается host_permissions на этот сервер, чтобы
 * chrome.permissions.contains не требовал диалога. Исходники не трогаем.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execSync } = require("child_process");
const PATHS = require("./paths.cjs");

const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-linkify");
const USER_DATA = PATHS.testProfile("linkify");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock-links.html";
const PORT_HTTP = 8797;
const CHROME = PATHS.CHROME;

const SITE = `http://localhost:${PORT_HTTP}`;

// Статьи, которые «есть» на сайте. Слаги нарочно в стиле Вордпресса:
// транслит, слова через дефис.
const ARTICLES = {
  volvo: SITE + "/volvo-xc40-podeshevel-na-fone-skidok/",
  toyota: SITE + "/toyota-camry-novyj-motor-i-salon/",
  scania: SITE + "/scania-t143-posle-kapitalnogo-remonta/",
  kia: SITE + "/kia-sportage-novye-fary/"
};

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Object.values(ARTICLES).map((u) => "<url><loc>" + u + "</loc></url>").join("\n")}
</urlset>`;

// Карта есть, но нужных моделей в ней нет — статьи не подберутся.
const SITEMAP_NO_MATCH = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${SITE}/kak-vybrat-maslo/</loc></url>
<url><loc>${SITE}/remont-dvigatelya-svoimi-rukami/</loc></url>
</urlset>`;

// Лента канала: у Дзена карты статей нет, она собирается обходом открытого API.
// Мок-сервер отдаёт её вместо платформы, чтобы проверка была без сети.
// Чужую карточку (другой publisher_id) добавляем нарочно: она обязана отсеяться.
const CHANNEL_OWN = "111";
const CHANNEL_ALIEN_URL = "https://dzen.ru/a/channelAlien";
const CHANNEL_ARTICLES = {
  volvo: "https://dzen.ru/a/channelVolvo",
  scania: "https://dzen.ru/a/channelScania"
};
const CHANNEL_FEED = {
  channel: { source: { publisher_id: CHANNEL_OWN } },
  items: [
    { type: "card", share_link: CHANNEL_ARTICLES.volvo, title: "Volvo XC40: честный отзыв после 100 000 км", publisher_id: CHANNEL_OWN },
    { type: "suites_carousel", title: "Подборки автора", link: "https://dzen.ru/suite/1" },
    { type: "card", share_link: CHANNEL_ARTICLES.scania, title: "Scania T143 — почему её до сих пор покупают", publisher_id: CHANNEL_OWN },
    { type: "card", share_link: CHANNEL_ALIEN_URL, title: "Чужой текст про Volvo XC40", publisher_id: "999" }
  ],
  more: {}
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
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

function prepareTestExtension() {
  copyDir(SRC_EXT, TEST_EXT);

  const mf = path.join(TEST_EXT, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const origin = `${SITE}/*`;
  m.content_scripts.forEach((cs) => {
    if (!cs.matches.includes(origin)) cs.matches.push(origin);
  });
  // host_permissions вместо запроса разрешения: диалог в тесте не нажать.
  m.host_permissions = (m.host_permissions || []).concat([origin]);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));

  // Адрес ленты канала зашит в код как dzen.ru, в отличие от карты сайта,
  // которую задаёт пользователь в настройках. Чтобы проверять канал без сети,
  // направляем его на мок-сервер — так же, как карта сайта отдаётся им же.
  // Ищем по строке и падаем, если не нашли: молчаливая подмена не должна
  // превратиться в «тест прошёл, а на самом деле ходил в интернет».
  const bg = path.join(TEST_EXT, "background.js");
  const src = fs.readFileSync(bg, "utf8");
  const from = 'const CHANNEL_API = "https://dzen.ru/api/v3/launcher/export";';
  const to = `const CHANNEL_API = ${JSON.stringify(SITE + "/channel-api")};`;
  if (!src.includes(from)) throw new Error("не нашёл в background.js строку с CHANNEL_API — тест устарел");
  fs.writeFileSync(bg, src.replace(from, to));

  return TEST_EXT;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];

    if (url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
      res.end(SITEMAP);
      return;
    }
    if (url === "/empty-sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
      res.end(SITEMAP_NO_MATCH);
      return;
    }
    if (url === "/channel-api") {
      // «broken-channel» — канал, который не отвечает: проверяем откат
      // «ведём на сам канал», а не только удачный обход.
      const name = (new URL(req.url, SITE).searchParams.get("channel_name") || "");
      if (name === "broken-channel") {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(CHANNEL_FEED));
      return;
    }

    const file = path.join(MOCK_DIR, url === "/" ? PAGE : url.replace(/^\//, ""));
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("nope");
        return;
      }
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
      ...PATHS.chromeFlags(),
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

    // ---- попап как зонд настроек (chrome.runtime недоступен из главного мира)
    const probe = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const ps = await c.send("Target.attachToTarget", { targetId: probe.targetId, flatten: true });
    await c.send("Runtime.enable", {}, ps.sessionId);
    const probeEval = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ps.sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };
    // Попап открывается в новом таргете, и сначала в нём живёт пустой документ:
    // помощник, определённый до перехода на popup.html, теряется вместе с ним.
    for (let i = 0; i < 30; i++) {
      if (await probeEval(`!!document.getElementById('save')`)) break;
      await sleep(200);
    }
    await probeEval(
      `window.__send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, ` +
        `(r) => res(r || { ok: false, error: String(((chrome.runtime.lastError || {}).message) || "нет ответа") }))); true`
    );

    const setSettings = async (patch) => {
      const want = Object.keys(patch);
      let ok = false;
      for (let i = 0; i < 8; i++) {
        const res = await probeEval(`__send({ type: 'saveSettings', settings: ${JSON.stringify(patch)} })`);
        const raw = await probeEval(
          `__send({ type: 'getSettings' }).then((r) => JSON.stringify((r || {}).settings || {}))`
        );
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (e) {}
        if (res && res.ok && want.every((k) => parsed[k] === patch[k])) { ok = true; break; }
        await sleep(400);
      }
      if (!ok) throw new Error("не удалось применить настройки: " + JSON.stringify(patch));
    };

    // Страницу открываем заново, а не перезагружаем: content-скрипт узнаёт о
    // новых настройках только через сообщение на вкладку dzen.ru, а мок живёт на
    // localhost. Новая вкладка заодно даёт свежий input-таргет — после
    // location.reload() синтетические клики по CDP доходят через раз.
    let sessionId = null;
    let targetId = null;

    const evalJs = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };

    const openPage = async () => {
      if (targetId) {
        try { await c.send("Target.closeTarget", { targetId }); } catch (e) {}
        await sleep(200);
      }
      const t = await c.send("Target.createTarget", { url: `${SITE}/${PAGE}` });
      targetId = t.targetId;
      const at = await c.send("Target.attachToTarget", { targetId, flatten: true });
      sessionId = at.sessionId;
      await c.send("Runtime.enable", {}, sessionId);
      await c.send("Page.enable", {}, sessionId);
      for (let i = 0; i < 60; i++) {
        if (await evalJs(`!!document.getElementById('dzr-bar') && document.documentElement.getAttribute('data-dzr-settings') === 'ready'`)) return;
        await sleep(200);
      }
      throw new Error("панель не появилась на странице");
    };

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

    const toastText = () => evalJs(`(document.getElementById('dzr-toast') || {}).innerText || ''`);
    const resetToast = () => evalJs(`(() => {
      const t = document.getElementById('dzr-toast');
      if (t) { t.innerHTML = ''; t.classList.remove('dzr-show'); }
      return true;
    })()`);

    /** Снимок статьи: ссылки, их абзацы и текст без разметки. */
    const snapshot = () =>
      evalJs(`(() => {
        const body = document.querySelector('.body');
        const blocks = Array.from(body.children);
        const links = Array.from(body.querySelectorAll('a')).map((a) => ({
          href: a.getAttribute('href'),
          rel: a.getAttribute('rel'),
          text: a.textContent,
          block: blocks.indexOf(a.closest('h1,h2,h3,h4,h5,h6,p,li,blockquote,figure,div')),
          tag: a.closest('h1,h2,h3,h4,h5,h6,p,li,blockquote,figure,div').tagName.toLowerCase()
        }));
        return {
          links,
          html: body.innerHTML,
          text: body.innerText.replace(/\\s+/g, ' ').trim()
        };
      })()`);

    /** Жмёт «Перелинковка» и ждёт уведомления. */
    const runLinkify = async () => {
      await resetToast();
      await clickEl("#dzr-bar .dzr-link-btn");
      for (let i = 0; i < 50; i++) {
        const t = await toastText();
        if (/Перелинковка/.test(t)) return t;
        await sleep(150);
      }
      return await toastText();
    };

    // ==================== 1. ссылки расставляются ====================
    console.log("\n=== 1. статья с моделями и карта сайта ===");
    await setSettings({ preview: false, linkSites: SITE, linkCount: 2 });
    await openPage();
    check("кнопка «Перелинковка» есть в панели", (await evalJs(`!!document.querySelector('#dzr-bar .dzr-link-btn')`)) === true);

    const before = await snapshot();
    check("до нажатия в статье нет ссылок", before.links.length === 0, String(before.links.length));

    let toast = await runLinkify();
    let after = await snapshot();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    console.log(
      "  ссылки: %j",
      after.links.map((l) => l.text + " → " + l.href + " (абзац " + l.block + ")")
    );

    check("ссылок поставлено ровно 2 (значение по умолчанию)", after.links.length === 2, String(after.links.length));
    check("в уведомлении названо число ссылок", /Перелинковка: 2/.test(toast), toast.replace(/\n/g, " | "));
    check(
      "анкоры — упоминания моделей из статьи",
      after.links.every((l) => /^(Volvo XC40|Toyota Camry|Scania T143|Kia Sportage)$/.test(l.text)),
      JSON.stringify(after.links.map((l) => l.text))
    );
    check(
      "ссылка ведёт на статью по модели",
      after.links.some((l) => l.href === ARTICLES.volvo),
      JSON.stringify(after.links.map((l) => l.href))
    );
    check(
      "все адреса взяты из sitemap сайта",
      after.links.every((l) => Object.values(ARTICLES).includes(l.href)),
      JSON.stringify(after.links.map((l) => l.href))
    );
    check(
      "внешние ссылки помечены nofollow",
      after.links.every((l) => l.rel === "nofollow noopener"),
      JSON.stringify(after.links.map((l) => l.rel))
    );
    check(
      "ссылки стоят в абзацах, а не в заголовке",
      after.links.every((l) => l.tag === "p"),
      JSON.stringify(after.links.map((l) => l.tag))
    );
    check(
      "в лид-абзаце ссылки нет",
      after.links.every((l) => l.block !== 1),
      JSON.stringify(after.links.map((l) => l.block))
    );
    check(
      "ссылки не в соседних абзацах",
      after.links.length < 2 || Math.abs(after.links[0].block - after.links[1].block) >= 2,
      JSON.stringify(after.links.map((l) => l.block))
    );
    check("текст статьи не изменился", after.text === before.text, JSON.stringify(after.text.slice(0, 70)));
    check("анкоры не дублируются", new Set(after.links.map((l) => l.text)).size === after.links.length);

    // ---- откат
    await clickEl('#dzr-bar .dzr-icon-btn[title*="Отменить вставку"]');
    await sleep(400);
    const undone = await snapshot();
    check("откат убрал ссылки", undone.links.length === 0, String(undone.links.length));
    check("откат вернул текст статьи", undone.text === before.text, JSON.stringify(undone.text.slice(0, 70)));

    // ==================== 2. сколько просили — столько и поставили ====================
    console.log("\n=== 2. запрошено 4 ссылки, а расставить есть куда только две ===");
    await setSettings({ linkCount: 4 });
    await openPage();
    toast = await runLinkify();
    after = await snapshot();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    console.log("  ссылки: %j", after.links.map((l) => l.text + " (абзац " + l.block + ")"));
    check("поставлено столько, сколько позволяет правило соседства", after.links.length === 2, String(after.links.length));
    check(
      "и в уведомлении — реальное число, а не запрошенное",
      /Перелинковка: 2/.test(toast),
      toast.replace(/\n/g, " | ")
    );

    // ==================== 3. нет моделей — статья не тронута ====================
    console.log("\n=== 3. в тексте нет названий моделей ===");
    await setSettings({ linkCount: 2 });
    await openPage();
    await evalJs(`(() => {
      const ps = document.querySelectorAll('.body p');
      ps[1].textContent = 'Лид: рынок новых машин растёт.';
      ps[2].textContent = 'Продажи выросли на десять процентов за квартал.';
      ps[3].textContent = 'Дилеры ждут поставок и снижают цены.';
      ps[4].textContent = 'Итоги подведём в следующем обзоре.';
      return true;
    })()`);
    const noModelsBefore = await snapshot();
    toast = await runLinkify();
    after = await snapshot();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    check("ссылок не поставили", after.links.length === 0, String(after.links.length));
    check("сказано, что моделей не нашлось", /нет названий моделей/.test(toast), toast.replace(/\n/g, " | "));
    check("статья осталась прежней", after.html === noModelsBefore.html);

    // ==================== 4. карта есть, статьи нет ====================
    console.log("\n=== 4. в карте сайта нет материалов под эти модели ===");
    await setSettings({ linkSites: SITE + "/empty-sitemap.xml" });
    await openPage();
    toast = await runLinkify();
    after = await snapshot();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    check("ссылок не поставили", after.links.length === 0, String(after.links.length));
    check("сказано, что материал не найден", /не нашёл материал/.test(toast), toast.replace(/\n/g, " | "));
    check("в уведомлении перечислены модели", /Volvo XC40/.test(toast), toast.replace(/\n/g, " | "));

    // ==================== 5. нет карты — ведём на сайт ====================
    console.log("\n=== 5. у сайта нет sitemap.xml ===");
    await setSettings({ linkSites: SITE + "/no-map" });
    await openPage();
    toast = await runLinkify();
    after = await snapshot();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    console.log("  ссылки: %j", after.links.map((l) => l.text + " → " + l.href));
    check("ссылки всё равно поставлены", after.links.length === 2, String(after.links.length));
    check(
      "ссылка ведёт на сам сайт",
      after.links.every((l) => l.href === SITE + "/no-map"),
      JSON.stringify(after.links.map((l) => l.href))
    );
    check("об этом сказано в уведомлении", /2 ведут на сам сайт/.test(toast), toast.replace(/\n/g, " | "));

    // ==================== 6. без сайтов в настройках ====================
    console.log("\n=== 6. список сайтов пуст ===");
    await setSettings({ linkSites: "", linkChannels: "" });
    await openPage();
    toast = await runLinkify();
    after = await snapshot();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    check("ссылок не поставили", after.links.length === 0, String(after.links.length));
    check("сказано, что ни сайтов, ни каналов не указано", /ни сайтов, ни каналов/.test(toast), toast.replace(/\n/g, " | "));

    // ==================== 7. ссылки, которые уже были в статье ====================
    // Перелинковка читает статью тем же разбором блоков, что и перевод, но статью
    // не переписывает. Значит, чужие ссылки она трогать не имеет права — иначе
    // настройка «убирать ссылки при переводе» срабатывала бы там, где перевода нет.
    console.log("\n=== 7. в статье уже есть своя ссылка ===");
    await setSettings({ linkSites: SITE, linkCount: 2, stripLinks: "keep" });
    await openPage();
    await evalJs(`(() => {
      const p = document.querySelectorAll('.body p')[1];
      p.innerHTML = 'Лид: рынок новых машин растёт, см. <a href="https://example.com/review">наш обзор</a>.';
      return true;
    })()`);
    const withOwnLink = await snapshot();
    toast = await runLinkify();
    after = await snapshot();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    console.log("  ссылки: %j", after.links.map((l) => l.text + " → " + l.href));
    check(
      "ссылка из статьи осталась",
      after.links.some((l) => l.href === "https://example.com/review"),
      JSON.stringify(after.links.map((l) => l.href))
    );
    check("её текст не изменился", /наш обзор/.test(after.text), after.text.slice(0, 80));
    check("новые ссылки всё равно поставлены", after.links.length >= 2, String(after.links.length));
    check(
      "в чужую ссылку не вложились",
      !/<a[^>]*>[^<]*<a/i.test(after.html),
      String(after.html).match(/<a[^>]*>[^<]*<a/i)
    );
    check("текст статьи не изменился", after.text === withOwnLink.text);

    // ==================== 8. источник — канал Дзена ====================
    // Раньше канал в наборах всегда шёл с пустым списком, то есть браузерная
    // ветка «ссылка на статью канала» не проверялась ни разу — а это ровно тот
    // путь, где ошибка в стыке фона и панели живёт незамеченной. Ленту отдаёт
    // мок-сервер (CHANNEL_FEED), поэтому сеть не нужна.
    console.log("\n=== 8. перелинковка по каналу Дзена ===");
    await setSettings({ linkSites: "", linkChannels: "test-channel", linkCount: 2, stripLinks: "keep" });
    await openPage();
    const channelBefore = await snapshot();
    check("по каналу: до нажатия ссылок нет", channelBefore.links.length === 0, String(channelBefore.links.length));

    toast = await runLinkify();
    after = await snapshot();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    console.log(
      "  ссылки: %j",
      after.links.map((l) => l.text + " → " + l.href + " (абзац " + l.block + ")")
    );

    check("по каналу: ссылки поставлены", after.links.length === 2, String(after.links.length));
    check(
      "по каналу: ссылки ведут на статьи канала",
      after.links.length > 0 && after.links.every((l) => Object.values(CHANNEL_ARTICLES).includes(l.href)),
      JSON.stringify(after.links.map((l) => l.href))
    );
    check(
      "по каналу: анкоры — модели из статьи",
      after.links.every((l) => /^(Volvo XC40|Scania T143)$/.test(l.text)),
      JSON.stringify(after.links.map((l) => l.text))
    );
    check(
      "по каналу: чужая карточка из ленты отсеяна",
      !after.links.some((l) => l.href === CHANNEL_ALIEN_URL),
      JSON.stringify(after.links.map((l) => l.href))
    );
    check(
      "по каналу: ссылки не в первом абзаце",
      after.links.every((l) => l.block > 0),
      JSON.stringify(after.links.map((l) => l.block))
    );
    check(
      "по каналу: текст статьи не изменился",
      after.text === channelBefore.text,
      after.text === channelBefore.text ? "" : "текст поехал"
    );
    check(
      "по каналу: в отчёте нет жалобы на необойдённый канал",
      !/карту собрать не удалось|не удалось обойти/i.test(toast),
      toast.replace(/\n/g, " | ")
    );
    // Главное, ради чего заголовки вообще хранятся: у статьи канала адрес
    // /a/<id> нечитаем, в отчёте должно стоять название. Поле терялось при
    // раскладке ссылок по абзацам, и в уведомлении показывался адрес.
    check(
      "по каналу: в отчёте заголовок статьи, а не адрес",
      /Volvo XC40: честный отзыв/.test(toast) &&
        /Scania T143 — почему её до сих пор покупают/.test(toast),
      toast.replace(/\n/g, " | ")
    );

    // ==================== 8б. канал не обошёлся ====================
    console.log("\n=== 8б. канал не отвечает — ведём на сам канал ===");
    await setSettings({ linkSites: "", linkChannels: "broken-channel", linkCount: 1, stripLinks: "keep" });
    await openPage();
    const brokenBefore = await snapshot();
    toast = await runLinkify();
    after = await snapshot();
    console.log("  уведомление: %j", toast.replace(/\n/g, " | "));
    console.log("  ссылки: %j", after.links.map((l) => l.text + " → " + l.href));
    check(
      "канал не обошёлся: ссылка ведёт на сам канал",
      after.links.some((l) => l.href === "https://dzen.ru/broken-channel"),
      JSON.stringify(after.links.map((l) => l.href))
    );
    check("канал не обошёлся: текст статьи не изменился", after.text === brokenBefore.text);
    check(
      "канал не обошёлся: в отчёте сказано, что карту собрать не удалось",
      /карту собрать не удалось/i.test(toast),
      toast.replace(/\n/g, " | ")
    );
    // Рядом с числом стоит глагол: «1 ведут» читается как ошибка.
    check(
      "канал не обошёлся: глагол согласован с числом",
      /1 ведёт на сам канал/.test(toast) && !/1 ведут/.test(toast),
      toast.replace(/\n/g, " | ")
    );

    const errs = c.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (errs.length) {
      console.log("\nисключения:");
      errs.slice(-6).forEach((e) => console.log("  ", JSON.stringify(e.params).slice(0, 300)));
    }
    check("в странице нет исключений", errs.length === 0, errs.length + " шт.");

    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const p = path.join(TMP, "shot-linkify.png");
    fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот: %s", p);

    console.log("\n=== ИТОГ ===");
    const bad = results.filter((r) => !r.ok);
    console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
    bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
    process.exitCode = bad.length ? 1 : 0;
  } finally {
    try { server.close(); } catch (e) {}
    try { execSync("taskkill /F /T /PID " + chrome.pid, { stdio: "ignore" }); } catch (e) {}
  }
}

main().catch((e) => { console.error("ОШИБКА ТЕСТА:", e.message || e); process.exit(1); });
