/**
 * Тест подбора картинок в живом редакторе.
 *
 *   node test-images-ui.cjs <путь-к-папке-расширения> [страница.html]
 *
 * Проверяем весь путь: кнопка в панели → service worker → Яндекс-поиск →
 * разбор ответа → плитки в окне → вставка картинки в статью, а также обложку
 * и лимит картинок на статью.
 *
 * Сети не нужно: мок-сервер отдаёт и страницу, и картинки, и ответ поиска.
 * Адрес Яндекс-поиска зашит в код константой, поэтому в КОПИИ расширения он
 * подменяется на мок-сервер — и тест падает, если строку не нашёл: молчаливая
 * подмена означала бы «тест прошёл, а он ходил в интернет». Исходники не трогаем.
 *
 * Лимит картинок берём из content.js, а не пишем числом: иначе при смене
 * константы тест проверял бы старое число и молчал.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const PATHS = require("./paths.cjs");

const TMP = PATHS.SCRATCH;
const MOCK_DIR = PATHS.MOCK_DIR;
const TEST_EXT = path.join(TMP, "test-ext-images");
const USER_DATA = PATHS.testProfile("images");

const SRC_EXT = PATHS.normalize(process.argv[2] || PATHS.EXT);
const PAGE = process.argv[3] || "mock-images.html";
const PORT_HTTP = 8794;
const CHROME = PATHS.CHROME;

const SITE = `http://localhost:${PORT_HTTP}`;
const API_URL = SITE + "/yandex-image";
const PIXABAY_URL = SITE + "/pixabay";
const OPENVERSE_URL = SITE + "/openverse";

const TITLE = "Subaru Outback Wilderness: обзор после 20 000 км";

// Лимит картинок на статью — из кода, а не числом в тесте.
const MAX_IMG = (() => {
  const src = fs.readFileSync(path.join(SRC_EXT, "content.js"), "utf8");
  const m = /var IMAGE_MAX_IN_ARTICLE = (\d+);/.exec(src);
  if (!m) throw new Error("не нашёл IMAGE_MAX_IN_ARTICLE в content.js — тест устарел");
  return Number(m[1]);
})();

// Лестница мест — тоже из кода: тест проверяет раскладку, а не свои ожидания.
const IMAGE_SLOTS = (() => {
  const src = fs.readFileSync(path.join(SRC_EXT, "content.js"), "utf8");
  const m = /var IMAGE_SLOTS = \[([^\]]*)\]/.exec(src);
  if (!m) throw new Error("не нашёл IMAGE_SLOTS в content.js — тест устарел");
  return m[1].split(",").map((s) => Number(s.trim()));
})();

// Названия мест для уведомления. Их столько же, сколько мест в лестнице: если
// место добавят, а название забудут, человек увидит «Картинка встала undefined».
const SLOT_NAMES = (() => {
  const src = fs.readFileSync(path.join(SRC_EXT, "content.js"), "utf8");
  const m = /var IMAGE_SLOT_NAMES = \[([\s\S]*?)\]/.exec(src);
  if (!m) throw new Error("не нашёл IMAGE_SLOT_NAMES в content.js — тест устарел");
  return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
})();

// Заглушка картинки. Раньше тут был однопиксельный PNG, но по нему не видно
// ни плитки, ни того, куда картинка встала в статье. SVG с подписью видно и в
// окне, и в тексте, и на скриншоте — при этом это по-прежнему одна картинка,
// которая честно загружается (naturalWidth > 0).
function photoSvg(name) {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180">' +
      '<rect width="240" height="180" fill="#7c3aed"/>' +
      '<rect x="8" y="8" width="224" height="164" fill="none" stroke="#fff" stroke-width="3"/>' +
      '<text x="24" y="104" font-family="sans-serif" font-size="34" fill="#fff">' +
      name +
      "</text></svg>",
    "utf8"
  );
}

// Выдача: две горизонтальные картинки и одна вертикальная. Вертикальная обязана
// отсеяться — проверяем это и на уровне ответа, и по плиткам в окне.
const PHOTOS = {
  wide: { url: SITE + "/photo/wide.jpg", title: "Outback Wilderness спереди", width: 1600, height: 1067 },
  wide2: { url: SITE + "/photo/wide2.jpg", title: "Салон влагостойкий", width: 1280, height: 853 },
  tall: { url: SITE + "/photo/tall.jpg", title: "Вертикальный кадр", width: 900, height: 1600 }
};

// Отдельная выдача для проверки лимита: картинок заведомо больше, чем разрешено
// вставить, — иначе пятый клик просто не по чему было бы делать.
const MANY = Array.from({ length: MAX_IMG + 2 }, (_, i) => ({
  url: SITE + "/photo/m" + (i + 1) + ".jpg",
  title: "Кадр " + (i + 1),
  width: 1600,
  height: 1000
}));

function imageXml(items) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<yandexsearch><response><results><grouping>" +
    items
      .map(
        (it) =>
          "<doc><url>" +
          SITE +
          "/article</url><title>" +
          it.title +
          "</title><img src=\"" +
          it.url +
          "\" width=\"" +
          it.width +
          "\" height=\"" +
          it.height +
          "\" /></doc>"
      )
      .join("") +
    "</grouping></results></response></yandexsearch>"
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("  %s %s%s", ok ? "PASS" : "FAIL", name, detail ? "  — " + detail : "");
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(name, g === w, g === w ? "" : "получено " + g + ", ожидалось " + w);
}

// Режим ответа мок-сервера. Переключаем по ходу теста.
let mode = "ok";
const seen = [];

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
  // Фон ходит за картинками сам, значит ему нужно право на этот домен.
  m.host_permissions = (m.host_permissions || []).concat([origin]);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));

  const bg = path.join(TEST_EXT, "background.js");
  let src = fs.readFileSync(bg, "utf8");
  // Адреса всех трёх источников зашиты в код константами — в копии подменяем их
  // на мок-сервер. Падаем на ненайденной строке: молчаливая подмена означала бы
  // «тест прошёл», а он бы ходил в интернет (или не ходил вовсе).
  const swaps = [
    [
      'const YANDEX_IMAGE_API = "https://searchapi.api.cloud.yandex.net/v2/image/search";',
      `const YANDEX_IMAGE_API = ${JSON.stringify(API_URL)};`
    ],
    ['const PIXABAY_API = "https://pixabay.com/api/";', `const PIXABAY_API = ${JSON.stringify(PIXABAY_URL)};`],
    [
      'const OPENVERSE_API = "https://api.openverse.org/v1/images/";',
      `const OPENVERSE_API = ${JSON.stringify(OPENVERSE_URL)};`
    ]
  ];
  swaps.forEach((s) => {
    if (!src.includes(s[0])) throw new Error("не нашёл в background.js строку " + s[0] + " — тест устарел");
    src = src.replace(s[0], s[1]);
  });
  fs.writeFileSync(bg, src);

  return TEST_EXT;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];

    if (url === "/yandex-image") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (e) {}
        const rec = {
          source: "yandex",
          method: req.method,
          auth: req.headers.authorization,
          orientation: parsed.imageSpec && parsed.imageSpec.orientation,
          format: parsed.imageSpec && parsed.imageSpec.format,
          size: parsed.imageSpec && parsed.imageSpec.size,
          searchType: parsed.query && parsed.query.searchType,
          folderId: parsed.folderId,
          docsOnPage: parsed.docsOnPage,
          queryText: parsed.query && parsed.query.queryText
        };
        seen.push(rec);

        if (mode === "unauthorized") {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
          res.end('{"code":16,"message":"API key not found"}');
          return;
        }
        if (mode === "no-images") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ rawData: Buffer.from("<html>Робот, уйди</html>", "utf8").toString("base64") }));
          return;
        }
        const xml = imageXml(mode === "many" ? MANY : [PHOTOS.wide, PHOTOS.tall, PHOTOS.wide2]);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ rawData: Buffer.from(xml, "utf8").toString("base64") }));
      });
      return;
    }

    // Модель отвечает фразами — по строке на фразу. Нужна, чтобы в окне появился
    // ВТОРОЙ чип: с одним чипом не проверить, что памятка не переживает неудачный
    // поиск, — клик по активному чипу ничего не делает.
    if (url === "/ai/chat/completions") {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "Subaru Outback на бездорожье\nСалон Subaru Outback" } }]
          })
        );
      });
      return;
    }

    // Pixabay: GET, ключ прямо в адресе. Отдаём две горизонтальные и одну
    // вертикальную — вертикаль обязан отсеять наш фильтр, иначе поедет вёрстка.
    if (url === "/pixabay") {
      const q = new URL(req.url, SITE).searchParams;
      seen.push({
        source: "pixabay",
        method: req.method,
        key: q.get("key") || "",
        queryText: q.get("q") || "",
        orientation: q.get("orientation") || "",
        image_type: q.get("image_type") || "",
        per_page: q.get("per_page") || "",
        lang: q.get("lang") || ""
      });
      const hits = [
        { pageURL: SITE + "/photo/wide", tags: "Subaru Outback, внедорожник", largeImageURL: PHOTOS.wide.url,
          imageWidth: PHOTOS.wide.width, imageHeight: PHOTOS.wide.height, user: "Иван Фото" },
        { pageURL: SITE + "/photo/wide2", tags: "Салон, влагостойкая обивка", largeImageURL: PHOTOS.wide2.url,
          imageWidth: PHOTOS.wide2.width, imageHeight: PHOTOS.wide2.height, user: "Мария Снимок" },
        { pageURL: SITE + "/photo/tall", tags: "Вертикальный кадр", largeImageURL: PHOTOS.tall.url,
          imageWidth: PHOTOS.tall.width, imageHeight: PHOTOS.tall.height, user: "Пётр Кадр" }
      ];
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ total: hits.length, totalHits: hits.length, hits: hits }));
      return;
    }

    // Openverse: ключа нет вовсе, только параметры запроса.
    if (url === "/openverse") {
      const q = new URL(req.url, SITE).searchParams;
      seen.push({
        source: "openverse",
        method: req.method,
        key: q.get("key") || "",
        queryText: q.get("q") || "",
        aspect_ratio: q.get("aspect_ratio") || "",
        license_type: q.get("license_type") || "",
        page_size: q.get("page_size") || ""
      });
      // Ошибка нужна для проверки «памятка не переживает неудачный поиск».
      if (mode === "unauthorized") {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end('{"detail":"Invalid token."}');
        return;
      }
      const results = [
        { url: PHOTOS.wide.url, thumbnail: PHOTOS.wide.url, foreign_landing_url: SITE + "/photo/wide",
          creator: "Мария", license: "cc-by", license_version: "4.0", provider: "flickr",
          title: "Subaru на трассе", width: PHOTOS.wide.width, height: PHOTOS.wide.height },
        { url: PHOTOS.wide2.url, thumbnail: PHOTOS.wide2.url, foreign_landing_url: SITE + "/photo/wide2",
          creator: "Пётр", license: "cc0", license_version: "1.0", provider: "wikimedia",
          title: "Салон", width: PHOTOS.wide2.width, height: PHOTOS.wide2.height },
        { url: PHOTOS.tall.url, thumbnail: PHOTOS.tall.url, foreign_landing_url: SITE + "/photo/tall",
          creator: "Вертикальный", license: "by-sa", license_version: "3.0", provider: "flickr",
          title: "Вертикальный кадр", width: PHOTOS.tall.width, height: PHOTOS.tall.height }
      ];
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({ result_count: results.length, page_count: 1, page_size: 12, page: 1, results: results })
      );
      return;
    }

    if (url.startsWith("/photo/")) {
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
      res.end(photoSvg(url.replace("/photo/", "").replace(/\.[a-z]+$/, "")));
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

    // ---- попап как зонд настроек ------------------------------------------
    const probe = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const ps = await c.send("Target.attachToTarget", { targetId: probe.targetId, flatten: true });
    await c.send("Runtime.enable", {}, ps.sessionId);
    const probeEval = async (expression) => {
      const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ps.sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    };
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

    // Ключ и folder ID обязаны лежать в local и читаться обратно как есть —
    // иначе кнопка будет вечно ругаться на пустые настройки.
    await setSettings({ imgKey: "TEST-KEY", imgFolder: "b1g-test-folder" });

    // Кэш ответов поиска живёт сутки — это условие Pixabay. Там, где проверке
    // нужен настоящий запрос к сервису, кэш приходится чистить: иначе набор
    // остаётся зелёным, а в сеть никто не ходил.
    const clearImagesCache = async () => {
      await probeEval(`__send({ type: 'clearCache' })`);
      await sleep(250);
    };
    const cacheKeys = async () =>
      JSON.parse(
        await probeEval(
          `chrome.storage.local.get('dzrImages').then((s) => JSON.stringify(Object.keys(s.dzrImages || {})))`
        )
      );

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

    // index нужен там, где важно, по какой именно плитке кликаем: обложкой
    // становится первая картинка, а не первая в списке нажатий.
    const clickEl = async (selector, index) => {
      const rect = await evalJs(`(() => {
        const list = document.querySelectorAll(${JSON.stringify(selector)});
        const b = list[${index || 0}];
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!rect) throw new Error("нет элемента " + selector + "[" + (index || 0) + "]");
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
    };

    const pressEscape = async () => {
      const p = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...p }, sessionId);
      await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...p }, sessionId);
    };

    const toastText = () => evalJs(`(document.getElementById('dzr-toast') || {}).innerText || ''`);
    const resetToast = () => evalJs(`(() => {
      const t = document.getElementById('dzr-toast');
      if (t) { t.innerHTML = ''; t.classList.remove('dzr-show'); }
      return true;
    })()`);

    const panelOpen = () => evalJs(`!!document.getElementById('dzr-images')`);
    const panelStatus = () => evalJs(`(() => {
      const s = document.querySelector('#dzr-images .dzr-img-status');
      return s ? { text: s.innerText, cls: s.className } : null;
    })()`);
    const tiles = () => evalJs(`(() => {
      const list = Array.from(document.querySelectorAll('#dzr-images .dzr-img-tile img'));
      return list.map((im) => ({
        src: im.getAttribute('src'),
        loaded: im.naturalWidth > 0,
        alt: im.getAttribute('alt')
      }));
    })()`);
    const chips = () => evalJs(`Array.from(document.querySelectorAll('#dzr-images .dzr-img-chip')).map((b) => ({
      text: b.innerText,
      active: b.className.indexOf('is-active') >= 0
    }))`);

    // Подпись окна: «Источник · только горизонтальные · запрос». Источник в ней
    // появляется только после ответа — до запроса мы ещё не знаем, куда пойдём.
    const panelSub = () => evalJs(`(() => {
      const s = document.querySelector('#dzr-images .dzr-pv-sub');
      return s ? s.innerText : null;
    })()`);
    // Памятка про лицензию: у Яндекса её нет, у Pixabay и Openverse — есть.
    const panelNotice = () => evalJs(`(() => {
      const n = document.querySelector('#dzr-images .dzr-img-notice');
      return n ? n.innerText : null;
    })()`);
    // Подписи автора и лицензии под плитками.
    const credits = () => evalJs(`Array.from(document.querySelectorAll('#dzr-images .dzr-img-credit')).map((c) => c.innerText)`);
    const articleImgs = () => evalJs(`Array.from(document.querySelectorAll('.body img')).map((im) => im.getAttribute('src'))`);

    // Первый блок статьи. По нему видно, встала ли картинка обложкой: обложка
    // обязана быть выше подзаголовка, а не рядом с ним.
    const firstBlock = () => evalJs(`(() => {
      const b = document.querySelector('.body');
      const f = b && b.firstElementChild;
      if (!f) return null;
      const im = f.querySelector ? f.querySelector('img') : null;
      return { tag: f.tagName, src: im ? im.getAttribute('src') : null };
    })()`);

    const clickTile = (i) => clickEl("#dzr-images .dzr-img-tile", i);

    // Блоки статьи по порядку: у каждого — адрес картинки, если она в нём есть.
    // По этим номерам и проверяем раскладку: «в середине» и «почти в конце» —
    // это про место в статье, а не про порядок нажатий.
    const blocks = () => evalJs(`(() => {
      const ed = document.querySelector('.body');
      return Array.from(ed.children).map((k) => {
        const im = k.querySelector ? k.querySelector('img') : null;
        return { tag: k.tagName, src: im ? im.getAttribute('src') : null };
      });
    })()`);
    const imgIdx = (list) => list.map((b, i) => (b.src ? i : -1)).filter((i) => i >= 0);
    const imgAt = (list, url) => list.findIndex((b) => b.src === url);
    const hasAdjacent = (idx) => idx.some((v, i) => i > 0 && v - idx[i - 1] < 2);

    // Каретка в середине статьи. Без этого проверка «картинка встала первой»
    // ничего не значит: при пустой каретке редактор и так вставляет в начало,
    // и логика обложки в проверке не участвует.
    const putCaretInParagraph = (n) => evalJs(`(() => {
      const ed = document.querySelector('.body');
      const p = ed && ed.querySelectorAll('p')[${n}];
      if (!p) return false;
      ed.focus();
      const node = p.firstChild || p;
      const r = document.createRange();
      r.setStart(node, node.nodeType === 3 ? Math.min(5, node.textContent.length) : 0);
      r.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    })()`);

    // Геометрия окна: окно мерилось пустым, а потом в него приезжали плитки.
    // Если не переставить окно заново, нижний ряд уезжает за край экрана —
    // и кликнуть по нему нельзя, хотя в разметке он есть.
    const panelBox = () => evalJs(`(() => {
      const p = document.getElementById('dzr-images');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      const tiles = Array.from(p.querySelectorAll('.dzr-img-tile')).map((t) => t.getBoundingClientRect());
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        h: window.innerHeight,
        tiles: tiles.length,
        tilesInside: tiles.every((t) => t.top >= 0 && t.bottom <= window.innerHeight)
      };
    })()`);

    // Ждём именно числа картинок, а не «прошло полсекунды»: вставка асинхронная.
    const waitImgs = async (n) => {
      for (let i = 0; i < 40; i++) {
        if ((await articleImgs()).length === n) return true;
        await sleep(200);
      }
      return false;
    };

    const openImages = async () => {
      await resetToast();
      await clickEl("#dzr-bar .dzr-img-btn");
      for (let i = 0; i < 60; i++) {
        const st = await panelStatus();
        if (st && st.text && st.text.indexOf("Ищу") < 0 && st.text.indexOf("Подбираю") < 0) return;
        await sleep(200);
      }
      throw new Error("окно картинок не дождалось ответа");
    };

    // ---- 1. кнопка и окно --------------------------------------------------
    console.log("\n=== 1. Кнопка и окно ===");
    await openPage();
    check("кнопка «Картинки» есть в панели", (await evalJs(`!!document.querySelector('#dzr-bar .dzr-img-btn')`)) === true);
    check(
      "подпись кнопки — «Картинки»",
      (await evalJs(`document.querySelector('#dzr-bar .dzr-img-btn').innerText`)).indexOf("Картинки") >= 0
    );
    check("окно картинок закрыто до нажатия", (await panelOpen()) === false);

    await openImages();
    check("окно картинок открылось", (await panelOpen()) === true);

    // ---- 2. запрос ушёл правильный ----------------------------------------
    console.log("\n=== 2. Запрос к Яндекс-поиску ===");
    eq("запрос ушёл один раз", seen.length, 1);
    eq("метод POST", seen[0] && seen[0].method, "POST");
    eq("ключ в заголовке Api-Key", seen[0] && seen[0].auth, "Api-Key TEST-KEY");
    eq("folder ID передан", seen[0] && seen[0].folderId, "b1g-test-folder");
    eq("горизонтальные — у поиска", seen[0] && seen[0].orientation, "IMAGE_ORIENTATION_HORIZONTAL");
    eq("сколько картинок просим", seen[0] && seen[0].docsOnPage, "12");
    eq("запрос собран из заголовка статьи", seen[0] && seen[0].queryText, TITLE);

    // ---- 3. плитки в окне --------------------------------------------------
    console.log("\n=== 3. Что показали в окне ===");
    const shown = await tiles();
    eq("в окне две горизонтальные картинки", shown.length, 2);
    eq("первая — горизонтальная", shown[0] && shown[0].src, PHOTOS.wide.url);
    check(
      "вертикальная в окно не попала",
      shown.every((t) => t.src !== PHOTOS.tall.url),
      shown.map((t) => t.src).join(", ")
    );
    check("картинки реально загрузились", shown.every((t) => t.loaded), JSON.stringify(shown.map((t) => t.loaded)));
    eq("подпись картинки — заголовок из выдачи", shown[0] && shown[0].alt, PHOTOS.wide.title);

    const chipList = await chips();
    eq("чип запроса один — заголовок статьи", chipList.length, 1);
    eq("чип подписан заголовком", chipList[0] && chipList[0].text, TITLE);
    check("чип отмечен активным", !!(chipList[0] && chipList[0].active));
    const st = await panelStatus();
    check("в подвале сказано, сколько нашлось", st && st.text.indexOf("Найдено 2") >= 0, st && st.text);

    // ---- 4. вставка в статью ----------------------------------------------
    console.log("\n=== 4. Вставка в статью ===");
    eq("в статье картинок нет", (await articleImgs()).length, 0);
    await clickTile(0);
    for (let i = 0; i < 40; i++) {
      if ((await articleImgs()).length > 0) break;
      await sleep(200);
    }
    const inArticle = await articleImgs();
    eq("картинка появилась в статье", inArticle.length, 1);
    eq("вставили ту, по которой кликнули", inArticle[0], PHOTOS.wide.url);
    const t1 = await toastText();
    check("уведомление не врёт про успех", t1.indexOf("Картинка встала") >= 0, t1);
    check("текст статьи на месте", (await evalJs(`document.querySelector('.body').innerText`)).indexOf("клиренс 241") > 0);

    // ---- 5. окно закрывается ----------------------------------------------
    console.log("\n=== 5. Закрытие окна ===");
    await pressEscape();
    await sleep(200);
    check("Esc закрывает окно", (await panelOpen()) === false);

    // ---- 6. честные ошибки -------------------------------------------------
    console.log("\n=== 6. Честные ошибки ===");
    mode = "unauthorized";
    await clearImagesCache(); // ошибку видно только на живом ответе, а не из кэша
    await openImages();
    const stAuth = await panelStatus();
    check("ошибка показана в окне, а не проглочена", !!(stAuth && stAuth.text.indexOf("Ошибка") >= 0), stAuth && stAuth.text);
    check("причина из ответа видна", !!(stAuth && stAuth.text.indexOf("API key not found") >= 0), stAuth && stAuth.text);
    check("класс ошибки выставлен", !!(stAuth && stAuth.cls.indexOf("is-error") >= 0), stAuth && stAuth.cls);
    eq("плиток при ошибке нет", (await tiles()).length, 0);
    await pressEscape();
    await sleep(150);

    mode = "no-images";
    await clearImagesCache();
    await openImages();
    const stEmpty = await panelStatus();
    check("пустая галерея объяснена", !!(stEmpty && stEmpty.text.indexOf("не нашлось") >= 0), stEmpty && stEmpty.text);
    await pressEscape();
    await sleep(150);

    // ---- 7. форма enum -----------------------------------------------------
    // Живой API короткие значения не принимает (проверено запросом без ключа),
    // поэтому в теле не должно остаться ни одного значения без префикса.
    console.log("\n=== 7. Форма enum в живом запросе ===");
    {
      const r = seen[0];
      const all = [r.searchType, r.orientation, r.format, r.size];
      check("все enum — в полной форме", all.every((v) => /^[A-Z_]+$/.test(v)), all.join(", "));
    }

    // ---- 8. пустые настройки ----------------------------------------------
    console.log("\n=== 8. Без ключа ===");
    mode = "ok";
    await setSettings({ imgKey: "", imgFolder: "" });
    await openImages();
    const stNoKey = await panelStatus();
    check("без ключа сказано, чего не хватает", !!(stNoKey && stNoKey.text.indexOf("ключ Yandex Search API") >= 0), stNoKey && stNoKey.text);
    eq("без ключа в сеть не ходим", seen.filter((r) => r.method).length, seen.length);
    await setSettings({ imgKey: "TEST-KEY", imgFolder: "b1g-test-folder" });

    // ---- 9. окно не мешает другим задачам ---------------------------------
    console.log("\n=== 9. Соседние операции ===");
    mode = "ok";
    await openImages();
    check("окно открыто перед запуском перелинковки", (await panelOpen()) === true);
    await clickEl("#dzr-bar .dzr-link-btn");
    await sleep(500);
    check("запуск другой задачи закрыл окно картинок", (await panelOpen()) === false);

    // ---- 10. источник без ключа: Openverse --------------------------------
    // Проверяем то, чего у Яндекса нет: подпись автора и лицензии под плиткой,
    // памятку про лицензию и название источника в подписи окна. Подпись рисует
    // окно по тому, что вернул фон, — поэтому проверяем и запрос, и разметку.
    console.log("\n=== 10. Openverse: без ключа, с лицензией ===");
    mode = "ok";
    // Включаем AI: он добавляет в окно второй чип с фразой, а без второго чипа не
    // проверить, что памятка не переживает неудачный поиск.
    await setSettings({ imgSource: "openverse", aiEnabled: true, aiBaseUrl: SITE + "/ai", aiKey: "AI-TEST-KEY" });
    await openImages();
    {
      const last = seen[seen.length - 1];
      eq("запрос ушёл в Openverse", last && last.source, "openverse");
      eq("Openverse: просим широкие кадры", last && last.aspect_ratio, "wide");
      check("Openverse: ключа в запросе нет", !(last && last.key), JSON.stringify(last && last.key));
      eq("Openverse: только лицензии, годные для правок", last && last.license_type, "commercial,modification");
      eq("вертикальный кадр отсеян", (await tiles()).length, 2);
      const sub = await panelSub();
      check("источник назван в подписи окна", !!(sub && sub.indexOf("Openverse") >= 0), sub);
      const cr = await credits();
      eq("подпись стоит у каждой плитки", cr.length, 2);
      check("в подписи автор и лицензия", !!(cr[0] && cr[0].indexOf("Мария") >= 0 && cr[0].indexOf("CC-BY") >= 0), cr[0]);
      const nt = await panelNotice();
      check("памятка про лицензию показана", !!(nt && nt.indexOf("лицензи") >= 0), nt);

      // Памятка не должна переживать неудачный поиск: над пустым окном она
      // рассказывает про картинки, которых в окне уже нет. Кликаем по второму
      // чипу (фраза от модели) и роняем поиск — памятка обязана исчезнуть.
      const chipList = await chips();
      check("первый чип — заголовок статьи и он активен", !!(chipList[0] && chipList[0].active), JSON.stringify(chipList[0]));
      check(
        "рядом есть чип с фразой модели, и он не активен",
        !!(chipList[1] && !chipList[1].active && /бездорожь/.test(chipList[1].text)),
        JSON.stringify(chipList[1] && chipList[1].text)
      );
      mode = "unauthorized";
      await clickEl("#dzr-images .dzr-img-chip", 1);
      let failed = false;
      for (let i = 0; i < 40; i++) {
        const s = await panelStatus();
        if (s && s.text.indexOf("Ошибка") >= 0) { failed = true; break; }
        await sleep(200);
      }
      check("поиск по второму чипу упал", failed, (await panelStatus()) && (await panelStatus()).text);
      const ntAfter = await panelNotice();
      check("после неудачного поиска памятка убрана", !ntAfter, JSON.stringify(ntAfter));
      eq("плиток после ошибки нет", (await tiles()).length, 0);
      mode = "ok";
    }
    await pressEscape();
    await sleep(150);
    await setSettings({ aiEnabled: false, aiBaseUrl: "https://api.openai.com/v1", aiKey: "" });

    // ---- 11. контроль: у Яндекса ни подписи, ни памятки --------------------
    // Без этой проверки предыдущая не измеряет ничего: если подпись и памятка
    // рисуются всегда, «подпись есть» пройдёт и там, где её быть не должно.
    console.log("\n=== 11. Контроль: у Яндекса ни подписи, ни памятки ===");
    await setSettings({ imgSource: "yandex" });
    await clearImagesCache(); // эта же пара «Яндекс + заголовок» уже была в кэше
    await openImages();
    {
      const last = seen[seen.length - 1];
      eq("запрос снова в Яндекс", last && last.source, "yandex");
      const sub = await panelSub();
      check("в подписи окна назван Яндекс", !!(sub && sub.indexOf("Яндекс") >= 0), sub);
      eq("подписей под плитками нет", (await credits()).length, 0);
      const nt = await panelNotice();
      check("памятки про лицензию нет", !nt, JSON.stringify(nt));
    }
    await pressEscape();
    await sleep(150);

    // ---- 12. Pixabay: свой ключ -------------------------------------------
    console.log("\n=== 12. Pixabay: ключ в адресе и автор в подписи ===");
    await setSettings({ imgSource: "pixabay", pixabayKey: "PB-TEST-KEY" });
    await openImages();
    {
      const last = seen[seen.length - 1];
      eq("запрос ушёл в Pixabay", last && last.source, "pixabay");
      eq("Pixabay: ключ в адресе", last && last.key, "PB-TEST-KEY");
      eq("Pixabay: горизонтальные — у поиска", last && last.orientation, "horizontal");
      eq("Pixabay: только фотографии", last && last.image_type, "photo");
      eq("Pixabay: для русского запроса просим русскую выдачу", last && last.lang, "ru");
      eq("вертикальный кадр отсеян", (await tiles()).length, 2);
      const cr = await credits();
      check(
        "в подписи автор с Pixabay",
        !!(cr[0] && cr[0].indexOf("Pixabay") >= 0 && cr[0].indexOf("Иван Фото") >= 0),
        cr[0]
      );
      const nt = await panelNotice();
      check("памятка Pixabay — про перезалив", !!(nt && nt.indexOf("Pixabay") >= 0), nt);
    }
    await pressEscape();
    await sleep(150);

    // ---- 13. Pixabay без ключа: объяснение, а не запрос --------------------
    console.log("\n=== 13. Pixabay без ключа ===");
    await setSettings({ pixabayKey: "" });
    {
      const before = seen.length;
      await openImages();
      const st = await panelStatus();
      check("сказано, чего не хватает", !!(st && st.text.indexOf("ключ Pixabay") >= 0), st && st.text);
      eq("в сеть не ходили", seen.length, before);
    }
    await pressEscape();
    await sleep(150);

    // ---- 14. кэш ответов: сутки на фразу -----------------------------------
    // Условие Pixabay: ответы держим в кэше 24 часа. Значит повторный тот же
    // запрос обязан уйти БЕЗ обращения к сети — и видно это по счётчику
    // запросов мок-сервера, а не по словам в окне. Проверка, которая верит
    // надписи «Из кэша», прошла бы и там, где запрос всё равно ушёл.
    console.log("\n=== 14. Кэш ответов поиска картинок ===");
    await setSettings({ imgSource: "pixabay", pixabayKey: "PB-TEST-KEY" });
    await clearImagesCache();
    await openImages();
    {
      eq("первый запрос ушёл в Pixabay", seen[seen.length - 1] && seen[seen.length - 1].source, "pixabay");
      const after = seen.length;
      eq("набор сохранён в кэш", (await cacheKeys()).length, 1);

      await pressEscape();
      await sleep(150);
      await openImages();
      eq("повторный тот же запрос в сеть не пошёл", seen.length, after);
      eq("картинки при этом показаны", (await tiles()).length, 2);
      const st = await panelStatus();
      check("сказано, что ответ из кэша", !!(st && st.text.indexOf("Из кэша") >= 0), st && st.text);

      // Источник входит в ключ кэша: тот же заголовок у другого источника —
      // это другой набор картинок, а не попадание.
      await setSettings({ imgSource: "openverse" });
      await pressEscape();
      await sleep(150);
      const beforeOv = seen.length;
      await openImages();
      eq("другой источник ищется заново", seen.length, beforeOv + 1);
      eq("в кэше теперь два набора", (await cacheKeys()).length, 2);

      // Просроченная запись не подменяет живой поиск. Отматываем `at` на 25
      // часов назад: сутки в тесте не выждать, а граница у нас — 24.
      await setSettings({ imgSource: "pixabay" });
      await probeEval(`chrome.storage.local.get('dzrImages').then((s) => {
        const c = s.dzrImages || {};
        Object.keys(c).forEach((k) => { c[k].at = Date.now() - 25 * 60 * 60 * 1000; });
        return chrome.storage.local.set({ dzrImages: c });
      })`);
      await pressEscape();
      await sleep(150);
      const beforeStale = seen.length;
      await openImages();
      eq("просроченный кэш не подменяет поиск", seen.length, beforeStale + 1);

      // Кнопка «Очистить кэш» в настройках чистит и наборы картинок.
      await clearImagesCache();
      eq("после очистки наборов нет", (await cacheKeys()).length, 0);
      await pressEscape();
      await sleep(150);
      const beforeClear = seen.length;
      await openImages();
      eq("после очистки кэша запрос ушёл снова", seen.length, beforeClear + 1);
    }
    await pressEscape();
    await sleep(150);
    // Дальше — раскладка по статье на Яндекс-выдаче: возвращаем прежний источник,
    // иначе проверки лимита считали бы картинки другого провайдера.
    await setSettings({ imgSource: "yandex", pixabayKey: "" });

    // ---- 15. раскладка по статье и лимит ----------------------------------
    // Статья открывается заново: счёт идёт по документу, и остатки прошлых
    // разделов сбили бы проверку лимита.
    console.log("\n=== 15. Раскладка картинок по статье и лимит (" + MAX_IMG + ") ===");
    mode = "many";
    await clearImagesCache(); // здесь нужна выдача из «many», а не прошлый набор
    await openPage();
    await openImages();
    eq("в выдаче картинок больше лимита", (await tiles()).length, MAX_IMG + 2);

    // Окно должно влезать в экран целиком: кликнуть по уехавшей плитке нельзя,
    // и человек увидит обрезанное окно.
    const box = await panelBox();
    check(
      "окно целиком помещается в экран",
      !!(box && box.top >= 0 && box.bottom <= box.h),
      box && JSON.stringify(box)
    );
    check("все плитки внутри экрана — по любой можно кликнуть", !!(box && box.tilesInside), box && box.tiles + " плиток");

    // Контроль: до вставки первым блоком статьи идёт абзац с лидом, картинок нет.
    // Без этого «картинка встала первой» ничего не доказывала бы.
    const b0 = await blocks();
    eq("до вставки первым блоком был абзац с лидом", b0[0] && b0[0].tag, "P");
    eq("в статье нет наших картинок", imgAt(b0, MANY[0].url), -1);
    eq("подзаголовки на месте до вставки", b0.filter((b) => b.tag === "H2").length, 3);

    // Каретку ставим в середину статьи: место картинки от неё не зависит, и это
    // надо проверить, а не предположить.
    check("каретка поставлена в середину статьи", (await putCaretInParagraph(0)) === true);

    // 1. Первая — в самое начало, обложкой.
    await clickTile(0);
    await waitImgs(1);
    let b = await blocks();
    eq("первая картинка — самый первый блок статьи", imgAt(b, MANY[0].url), 0);
    check("уведомление называет место — обложка", (await toastText()).indexOf("обложкой") >= 0, await toastText());
    eq("текст статьи не пострадал", (await evalJs(`document.querySelector('.body').innerText`)).indexOf("клиренс 241") > 0, true);

    // 2. Вторая — в середину, а не рядом с первой.
    await clickTile(1);
    await waitImgs(2);
    b = await blocks();
    const i2 = imgAt(b, MANY[1].url);
    check(
      "вторая картинка встала в середине статьи",
      i2 >= Math.floor(b.length / 3) && i2 <= Math.ceil((2 * b.length) / 3),
      i2 + " из " + b.length + " блоков"
    );
    check("первая и вторая не рядом", i2 - imgAt(b, MANY[0].url) >= 2, JSON.stringify(imgIdx(b)));
    check("уведомление называет место — середина", (await toastText()).indexOf("в середину") >= 0, await toastText());
    eq("обложка осталась первым блоком", (await firstBlock()).src, MANY[0].url);
    eq("подзаголовок остался в тексте", (await evalJs(`!!document.querySelector('.body h2')`)), true);

    // 3. Третья — почти в конец.
    await clickTile(2);
    await waitImgs(3);
    b = await blocks();
    const i3 = imgAt(b, MANY[2].url);
    eq("в статье три картинки", imgIdx(b).length, 3);
    check("третья картинка встала почти в конец", i3 >= b.length - 2, i3 + " из " + b.length + " блоков");
    check("подряд картинок нет", !hasAdjacent(imgIdx(b)), JSON.stringify(imgIdx(b)) + " из " + b.length + " блоков");
    check("уведомление называет место — почти конец", (await toastText()).indexOf("почти в конец") >= 0, await toastText());

    // 4. Четвёртая — между обложкой и серединой, то есть в свободный промежуток.
    await clickTile(3);
    await waitImgs(MAX_IMG);
    b = await blocks();
    const i4 = imgAt(b, MANY[3].url);
    check(
      "четвёртая встала между обложкой и серединой",
      i4 > imgAt(b, MANY[0].url) && i4 < imgAt(b, MANY[1].url),
      JSON.stringify(imgIdx(b)) + " из " + b.length + " блоков"
    );
    check("подряд картинок по-прежнему нет", !hasAdjacent(imgIdx(b)), JSON.stringify(imgIdx(b)));
    eq("в статье ровно лимит картинок", imgIdx(b).length, MAX_IMG);
    eq("мест в лестнице столько же, сколько разрешено картинок", IMAGE_SLOTS.length, MAX_IMG);
    eq("у каждого места есть название для уведомления", SLOT_NAMES.length, IMAGE_SLOTS.length);
    check("четвёртое место названо вслух", (await toastText()).indexOf("между обложкой и серединой") >= 0, await toastText());
    check(
      "ни одно название места не пустое",
      SLOT_NAMES.every((n) => n.length > 0),
      JSON.stringify(SLOT_NAMES)
    );
    const stCap = await panelStatus();
    check(
      "в подвале счётчик по лимиту",
      !!(stCap && stCap.text.indexOf(MAX_IMG + " из " + MAX_IMG) >= 0),
      stCap && stCap.text
    );

    // Сверх лимита — отказ, и он назван вслух.
    await resetToast();
    await clickTile(MAX_IMG);
    await sleep(700);
    eq("сверх лимита картинка не добавилась", (await articleImgs()).length, MAX_IMG);
    const tCap = await toastText();
    check("отказ назван вслух", tCap.indexOf("больше не добавляю") >= 0, tCap);

    // Контроль: счётчик считает картинки в статье, а не нажатия. Удалили одну —
    // место освободилось, и следующая встала на её место.
    await evalJs(`(() => {
      const im = document.querySelectorAll('.body img')[1];
      if (im && im.parentNode) im.parentNode.removeChild(im);
      return true;
    })()`);
    await waitImgs(MAX_IMG - 1);
    await resetToast();
    await clickTile(MAX_IMG);
    await waitImgs(MAX_IMG);
    eq("после удаления картинки место освободилось", (await articleImgs()).length, MAX_IMG);
    check("вставка снова прошла, а не отказала", (await toastText()).indexOf("Картинка встала") >= 0, await toastText());

    // Контроль: счёт идёт по узлам в документе, а не по числу наших вставок и не
    // по числу разных адресов. Человек может скопировать картинку прямо в
    // редакторе — копия тоже занимает место, и лимит обязан её увидеть.
    // Состояние подобрано так, чтобы две версии счётчика разошлись: узлов —
    // лимит, а разных адресов — на один меньше.
    await evalJs(`(() => {
      const im = document.querySelectorAll('.body img')[1];
      if (im && im.parentNode) im.parentNode.removeChild(im);
      return true;
    })()`);
    await waitImgs(MAX_IMG - 1);
    await evalJs(`(() => {
      const im = document.querySelector('.body img');
      const copy = im.cloneNode(true);
      copy.setAttribute('data-dzr-test-copy', '1');
      im.parentNode.insertBefore(copy, im);
      return true;
    })()`);
    await waitImgs(MAX_IMG);
    const dupes = await articleImgs();
    eq("узлов в статье — лимит", dupes.length, MAX_IMG);
    eq("а разных адресов меньше на копию", new Set(dupes).size, MAX_IMG - 1);
    await resetToast();
    await clickTile(MAX_IMG);
    await sleep(700);
    eq("копия заняла место — сверх лимита не влезло", (await articleImgs()).length, MAX_IMG);
    check("отказ из-за копии назван вслух", (await toastText()).indexOf("больше не добавляю") >= 0, await toastText());

    // Убираем копию и добираем статью до лимита: на снимке она такая, какой её
    // оставил человек, — обложка на месте и в подвале «4 из 4».
    await evalJs(`(() => {
      const im = document.querySelector('.body img[data-dzr-test-copy]');
      if (im && im.parentNode) im.parentNode.removeChild(im);
      return true;
    })()`);
    await waitImgs(MAX_IMG - 1);
    await resetToast();
    await clickTile(MAX_IMG);
    await waitImgs(MAX_IMG);
    eq("статья снова добрана до лимита", (await articleImgs()).length, MAX_IMG);
    eq("обложка осталась на месте", await evalJs(`(document.querySelector('.body').firstElementChild.querySelector('img') || {}).src`), MANY[0].url);

    // Снимок статьи с расставленными картинками — в самом конце раздела: до
    // этого окно нужно открытым для проверок счётчика. По номерам блоков
    // раскладку видно и в выводе, но глазами понятнее, что вышло у человека.
    await pressEscape();
    await sleep(200);
    await evalJs(`(() => {
      const ed = document.querySelector('.body');
      if (ed && ed.scrollIntoView) ed.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    await sleep(300);
    const shot = await c.send("Page.captureScreenshot", { format: "png" }, sessionId);
    const pShot = path.join(PATHS.SCRATCH, "shot-images-layout.png");
    fs.writeFileSync(pShot, Buffer.from(shot.data, "base64"));
    console.log("\nскриншот раскладки: %s", pShot);

    // ------------------------------------------------------------- итог
    const fails = results.filter((r) => !r.ok);
    console.log("\nвсего проверок: %d, провалов: %d", results.length, fails.length);
    if (fails.length) {
      console.log("\nпровалы:");
      fails.forEach((f) => console.log("  · %s%s", f.name, f.detail ? "  — " + f.detail : ""));
    }
    server.close();
    chrome.kill();
    process.exit(fails.length ? 1 : 0);
  } catch (e) {
    console.error("набор упал:", e);
    try { server.close(); } catch (x) {}
    chrome.kill();
    process.exit(1);
  }
}

main();
