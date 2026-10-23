/**
 * Юнит-тест подбора картинок (background.js) без сети и без Chrome.
 *
 * Здесь проверяем ровно те места, где легко ошибиться молча:
 *   • разбор XML-ответа Яндекса — и то, что он НЕ выдумывает картинки там, где
 *     их нет (адрес страницы вместо адреса картинки, мусорный ответ);
 *   • кодировку: ответ приходит base64 с кириллицей внутри;
 *   • форму запроса — метод, заголовок авторизации, горизонтальность, лимит;
 *   • честные сообщения вместо тишины: нет ключа, нет folder ID, пустой запрос;
 *   • контракт сообщения «фон → контент-скрипт» через настоящий обработчик.
 *
 * Форма ответа: в документации показаны только группирующие теги `request` и
 * `response`, а вид тега с адресом картинки не раскрыт. Поэтому разбор написан
 * терпимым — и это отдельно проверяется ниже.
 *
 * background.js — не модуль, поэтому грузим его как тело функции с подставным chrome.
 */
const fs = require("fs");
const path = require("path");
const PATHS = require("./paths.cjs");

const SRC = path.join(PATHS.REPO, "src", "extension-src", "background.js");

// ------------------------------------------------------------- подставной chrome
const localStore = {};
let onMessageListener = null;

function pick(store, keys) {
  const out = {};
  if (keys == null) return { ...store };
  const list = Array.isArray(keys) ? keys : [keys];
  for (const k of list) if (store[k] !== undefined) out[k] = store[k];
  return out;
}

const chrome = {
  storage: {
    sync: { get: async (d) => (d && !Array.isArray(d) ? { ...d } : {}), set: async () => {}, remove: async () => {} },
    local: {
      get: async (keys) => pick(localStore, keys),
      set: async (o) => Object.assign(localStore, o),
      remove: async (k) => {
        delete localStore[k];
      }
    }
  },
  permissions: { contains: async () => true, request: async () => true },
  runtime: {
    onMessage: { addListener(fn) { onMessageListener = fn; } },
    onInstalled: { addListener() {} },
    lastError: null
  },
  contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  tabs: { sendMessage: async () => {}, query: async () => [] }
};

const api = new Function(
  "chrome",
  fs.readFileSync(SRC, "utf8") +
    "\nreturn { DEFAULTS, LOCAL_KEYS, YANDEX_IMAGE_API, IMAGE_COUNT, IMAGE_QUERIES_MAX, IMAGE_ENUMS, " +
    "imageSearchBody, imageSearch, decodeBase64, decodeXmlEntities, xmlAttr, xmlText, " +
    "looksLikeImageUrl, hasImageExt, parseImageXml, headOf, findImages, " +
    "PIXABAY_API, OPENVERSE_API, IMG_SOURCES, IMG_NOTICE, imgSourceInfo, horizontalOnly, " +
    "pixabayLang, pixabayUrl, parsePixabayImages, openverseUrl, parseOpenverseImages, " +
    "IMAGE_CACHE_KEY, IMAGE_CACHE_TTL, IMAGE_CACHE_MAX, imageCacheKey, readImageCache, writeImageCache, " +
    "parseQueries, aiImageQueries, IMAGE_QUERY_PROMPT, checkAiKey, checkImageKey, " +
    "fetchJson, aiRewrite, isLocalAiBase, aiHasAccess, aiTimeoutMs, textWords, aiTimeoutNote, " +
    "AI_TIMEOUT_MS, AI_TIMEOUT_PER_WORD_MS, AI_TIMEOUT_MAX_MS, " +
    "AI_LOCAL_TIMEOUT_MS, AI_LOCAL_TIMEOUT_MAX_MS, " +
    "AI_CHECK_TIMEOUT_MS, AI_CHECK_RETRY_TIMEOUT_MS, AI_LOCAL_CHECK_TIMEOUT_MS };"
)(chrome);

const {
  DEFAULTS,
  LOCAL_KEYS,
  YANDEX_IMAGE_API,
  IMAGE_COUNT,
  IMAGE_QUERIES_MAX,
  IMAGE_ENUMS,
  imageSearchBody,
  decodeBase64,
  decodeXmlEntities,
  xmlText,
  looksLikeImageUrl,
  hasImageExt,
  parseImageXml,
  headOf,
  findImages,
  PIXABAY_API,
  OPENVERSE_API,
  IMG_SOURCES,
  IMG_NOTICE,
  imgSourceInfo,
  horizontalOnly,
  pixabayUrl,
  parsePixabayImages,
  openverseUrl,
  parseOpenverseImages,
  parseQueries,
  checkAiKey,
  checkImageKey,
  fetchJson,
  aiRewrite,
  isLocalAiBase,
  aiHasAccess,
  aiTimeoutMs,
  textWords,
  aiTimeoutNote,
  AI_TIMEOUT_MS,
  AI_TIMEOUT_PER_WORD_MS,
  AI_TIMEOUT_MAX_MS,
  AI_LOCAL_TIMEOUT_MS,
  AI_LOCAL_TIMEOUT_MAX_MS,
  AI_CHECK_TIMEOUT_MS,
  AI_CHECK_RETRY_TIMEOUT_MS,
  AI_LOCAL_CHECK_TIMEOUT_MS,
  IMAGE_CACHE_KEY,
  IMAGE_CACHE_TTL,
  IMAGE_CACHE_MAX,
  imageCacheKey,
  readImageCache,
  writeImageCache
} = api;

/**
 * Кэш ответов поиска живёт между проверками, а часть сценариев требует
 * настоящего запроса. Чистим явно: иначе проверка «запрос ушёл» станет
 * «запрос не понадобился» и набор останется зелёным ни на чём.
 */
function resetImageCache() {
  delete localStore[IMAGE_CACHE_KEY];
}

// Попап — тоже часть контракта: добавили источник в код, забыли в списке —
// и выбрать его нельзя, хотя он есть.
const POPUP_HTML = fs.readFileSync(path.join(PATHS.REPO, "src", "extension-src", "popup.html"), "utf8");

// ------------------------------------------------------------- подставной fetch
let routes = [];
const calls = [];

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

function installFetch() {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    let reply = null;
    for (const r of routes) {
      if (r.match(url, init)) {
        reply = r.reply(url, init);
        break;
      }
    }
    if (reply == null) reply = jsonRes({}, 404);

    // Настоящий fetch уважает signal: по abort он падает, а не дожидается ответа,
    // которого уже никто не ждёт. Заглушка без этого врала бы — таймаут и отмена
    // в тестах не проверялись бы вовсе, а «запрос ушёл» означало бы «ответ пришёл».
    const signal = init && init.signal;
    if (!signal) return reply;
    if (signal.aborted) throw signal.reason || new Error("aborted");
    return Promise.race([
      Promise.resolve(reply),
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true });
      })
    ]);
  };
}

/** Ответ API: XML, завёрнутый в base64 — как отдаёт Яндекс. */
function rawRes(xml) {
  return jsonRes({ rawData: Buffer.from(xml, "utf8").toString("base64") });
}

// ------------------------------------------------------------- фикстуры XML
/**
 * Ответ в том виде, в каком его описывает документация: группирующие теги
 * request/response, внутри — документы. Адрес картинки кладём в <img src>,
 * адрес страницы — в <url>: перепутать их означает вставить битую картинку.
 */
function docXml(opts) {
  const o = opts || {};
  return (
    "<doc>" +
    (o.url ? "<url>" + o.url + "</url>" : "") +
    (o.domain ? "<domain>" + o.domain + "</domain>" : "") +
    (o.title ? "<title>" + o.title + "</title>" : "") +
    (o.img
      ? "<img src=\"" +
        o.img +
        "\"" +
        (o.width ? ' width="' + o.width + '"' : "") +
        (o.height ? ' height="' + o.height + '"' : "") +
        " />"
      : "") +
    "</doc>"
  );
}

function xmlResponse(docs) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<yandexsearch><request><query>тест</query></request>" +
    "<response><results><grouping>" +
    docs.join("") +
    "</grouping></results></response></yandexsearch>"
  );
}

const PHOTO = "https://img.example.com/subaru/outback-wilderness.jpg";
const PAGE = "https://example.com/articles/subaru-outback";

// ------------------------------------------------- фикстуры Pixabay и Openverse
// Поля взяты из документации провайдеров: у Pixabay адрес картинки лежит в
// largeImageURL/webformatURL, а адрес страницы — в pageURL; у Openverse адрес
// картинки в url, страницы — в foreign_landing_url. Перепутать их означает
// вставить в статью битую ссылку, поэтому проверяем именно это.
function pixabayHit(o) {
  const x = o || {};
  return {
    id: 195893,
    pageURL: x.page || "https://pixabay.com/photos/subaru-outback-195893/",
    tags: x.tags || "subaru, outback, car",
    previewURL: "https://cdn.pixabay.com/photo/x_150.jpg",
    webformatURL: "https://cdn.pixabay.com/photo/x_640.jpg",
    largeImageURL: x.img || "https://cdn.pixabay.com/photo/x_1280.jpg",
    imageWidth: x.width || 1600,
    imageHeight: x.height || 1067,
    user: x.user || "photographer"
  };
}

function pixabayJson(hits) {
  return { total: hits.length, totalHits: hits.length, hits: hits };
}

function openverseResult(o) {
  const x = o || {};
  return {
    id: "903a50cd-" + (x.n || 1),
    title: x.title || "2008 Subaru Canada Rally Team STI",
    url: x.img || "https://live.staticflickr.com/3110/2615279798_0ec90c5379.jpg",
    thumbnail: "https://api.openverse.org/v1/images/903a50cd/thumb/",
    width: x.width || 1024,
    height: x.height || 768,
    creator: x.creator || "formulaphoto",
    creator_url: "https://www.flickr.com/photos/98419084@N00",
    license: x.license || "by-sa",
    license_version: "2.0",
    foreign_landing_url: x.page || "https://www.flickr.com/photos/98419084@N00/2615279798",
    provider: "flickr"
  };
}

// ------------------------------------------------------------- проверки
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

/** Шлём сообщение в НАСТОЯЩИЙ обработчик фона — контракт, а не догадка о нём. */
function sendMessage(msg) {
  if (!onMessageListener) throw new Error("фон не подписался на сообщения");
  return new Promise((resolve) => {
    const keepOpen = onMessageListener(msg, { id: "test" }, resolve);
    if (keepOpen !== true) throw new Error("фон не оставил канал открытым для ответа");
  });
}

// ------------------------------------------------------------- сценарии
async function main() {
  installFetch();

  // ---- 1. разбор ответа ---------------------------------------------------
  console.log("\n=== 1. Разбор XML-ответа ===");
  {
    const imgs = parseImageXml(xmlResponse([docXml({ url: PAGE, title: "Subaru Outback", img: PHOTO, width: 1600, height: 1067 })]));
    eq("картинка найдена", imgs.length, 1);
    eq("адрес картинки, а не страницы", imgs[0] && imgs[0].url, PHOTO);
    eq("заголовок прочитан", imgs[0] && imgs[0].title, "Subaru Outback");
    eq("размеры прочитаны", [imgs[0].width, imgs[0].height], [1600, 1067]);
  }

  // КОНТРОЛЬ: адрес страницы — не картинка. Если бы разбор брал <url>,
  // здесь была бы одна «картинка», и в статью уехал бы битый <img>.
  {
    const imgs = parseImageXml(xmlResponse([docXml({ url: PAGE, title: "Только страница" })]));
    eq("контроль: адрес страницы картинкой не считается", imgs.length, 0);
  }

  // КОНТРОЛЬ: мусор не превращается в картинки.
  {
    eq("контроль: мусорный ответ", parseImageXml("<html><body>Доступ запрещён</body></html>").length, 0);
    eq("контроль: пустая строка", parseImageXml("").length, 0);
    eq("контроль: null не роняет", parseImageXml(null).length, 0);
  }

  // Вертикальную отсеиваем сами, если размеры в ответе есть.
  {
    const imgs = parseImageXml(
      xmlResponse([
        docXml({ img: "https://img.example.com/h1.jpg", width: 1600, height: 900 }),
        docXml({ img: "https://img.example.com/v1.jpg", width: 900, height: 1600 }),
        docXml({ img: "https://img.example.com/sq1.jpg", width: 800, height: 800 })
      ])
    );
    eq("вертикальные и квадратные отсеяны", imgs.map((i) => i.url), ["https://img.example.com/h1.jpg"]);
  }

  // Нет размеров — ничего не выбрасываем: горизонтальность уже попросили у поиска.
  {
    const imgs = parseImageXml(
      xmlResponse([docXml({ img: "https://img.example.com/a.jpg" }), docXml({ img: "https://img.example.com/b.jpg" })])
    );
    eq("без размеров оставляем всех", imgs.length, 2);
  }

  // Дубликаты не задваиваются.
  {
    const imgs = parseImageXml(xmlResponse([docXml({ img: PHOTO }), docXml({ img: PHOTO })]));
    eq("дубликаты схлопнуты", imgs.length, 1);
  }

  // Адрес текстом внутри <image> — вторая правдоподобная форма.
  {
    const imgs = parseImageXml("<response><grouping><doc><title>Т</title><image>https://img.example.com/x.png</image></doc></grouping></response>");
    eq("адрес внутри <image> прочитан", imgs[0] && imgs[0].url, "https://img.example.com/x.png");
  }

  // Если <doc> нет вовсе — разбираем ответ целиком, а не отдаём пустоту.
  {
    const imgs = parseImageXml("<response><img src=\"https://img.example.com/loose.jpeg\" /></response>");
    eq("ответ без <doc> всё равно разобран", imgs.length, 1);
  }

  // ---- 2. сущности и кодировка --------------------------------------------
  console.log("\n=== 2. Сущности и кодировка ===");
  eq("&amp; развёрнут", decodeXmlEntities("a&amp;b"), "a&b");
  eq("&amp;lt; не превращается в <", decodeXmlEntities("&amp;lt;"), "&lt;");
  eq("числовая сущность", decodeXmlEntities("&#1055;"), "П");
  eq("CDATA развёрнут", xmlText("<![CDATA[Заголовок]]>"), "Заголовок");
  eq("теги вырезаны из текста", xmlText("<b>Жирный</b> заголовок"), "Жирный заголовок");

  {
    // КОНТРОЛЬ против наивного atob: кириллица должна выжить.
    const xml = xmlResponse([docXml({ title: "Обзор Subaru Outback — тест-драйв", img: PHOTO })]);
    const back = decodeBase64(Buffer.from(xml, "utf8").toString("base64"));
    check("base64 → кириллица не испорчена", back.indexOf("Обзор Subaru Outback — тест-драйв") > 0);
    eq("base64: пустая строка", decodeBase64(""), "");
  }
  {
    const imgs = parseImageXml(
      xmlResponse([docXml({ title: "<![CDATA[Обзор: «Outback» & тест]]>", img: "https://img.example.com/a.jpg?a=1&amp;b=2" })])
    );
    eq("сущности в адресе картинки развёрнуты", imgs[0].url, "https://img.example.com/a.jpg?a=1&b=2");
    eq("сущности в заголовке развёрнуты", imgs[0].title, "Обзор: «Outback» & тест");
  }

  eq("адрес страницы картинкой не считается", looksLikeImageUrl("не url"), false);
  eq("http-адрес картинкой считается", looksLikeImageUrl("http://a.ru/b.jpg"), true);
  eq("расширение картинки узнаётся", hasImageExt("http://a.ru/b.JPG?v=2"), true);
  eq("адрес без расширения — не картинка", hasImageExt("http://a.ru/page"), false);

  // ---- 3. форма запроса ---------------------------------------------------
  console.log("\n=== 3. Форма запроса к Яндекс-поиску ===");
  {
    const body = JSON.parse(imageSearchBody("Subaru Outback", { imgFolder: "b1g2folder" }));
    eq("тип поиска", body.query.searchType, "SEARCH_TYPE_RU");
    eq("текст запроса", body.query.queryText, "Subaru Outback");
    eq("фильтр по содержимому", body.query.familyMode, "FAMILY_MODE_STRICT");
    eq("автоправка опечаток выключена", body.query.fixTypoMode, "FIX_TYPO_MODE_OFF");
    eq("горизонтальные — просим у поиска", body.imageSpec.orientation, "IMAGE_ORIENTATION_HORIZONTAL");
    eq("размер — большой", body.imageSpec.size, "IMAGE_SIZE_LARGE");
    eq("формат — jpeg", body.imageSpec.format, "IMAGE_FORMAT_JPEG");
    eq("сколько картинок", body.docsOnPage, String(IMAGE_COUNT));
    eq("folder ID передан", body.folderId, "b1g2folder");
    check("адреса страницы в запросе нет (site не задан)", body.site === undefined);
    // Живой API короткие значения не принимает (проверено запросом без ключа),
    // поэтому в теле не должно остаться ни одного значения без префикса.
    const enums = [
      body.query.searchType,
      body.query.familyMode,
      body.query.fixTypoMode,
      body.imageSpec.format,
      body.imageSpec.size,
      body.imageSpec.orientation
    ];
    check(
      "все enum — в полной форме",
      enums.every((v) => /^[A-Z_]+$/.test(v)),
      enums.join(", ")
    );
  }
  {
    const long = "я".repeat(900);
    const body = JSON.parse(imageSearchBody(long, { imgFolder: "f" }));
    eq("длинный запрос обрезан по лимиту поля", body.query.queryText.length, 400);
  }

  // ---- 4. живой вызов: заголовок авторизации и запасной enum ---------------
  console.log("\n=== 4. Запрос целиком (подставная сеть) ===");
  {
    calls.length = 0;
    routes = [
      { match: (u) => u === YANDEX_IMAGE_API, reply: () => rawRes(xmlResponse([docXml({ url: PAGE, title: "Т", img: PHOTO, width: 1200, height: 800 })])) }
    ];
    const out = await findImages("Subaru Outback", { imgKey: "SECRET", imgFolder: "f1" });
    eq("одна картинка в ответе", out.images.length, 1);
    eq("запрос ушёл один раз", calls.length, 1);
    eq("метод POST", calls[0].init.method, "POST");
    eq("ключ в заголовке Api-Key", calls[0].init.headers.Authorization, "Api-Key SECRET");
    eq("тип содержимого", calls[0].init.headers["Content-Type"], "application/json");
  }

  // 400 не должен приводить к повтору: запрос платный, а форма enum проверена
  // живым API — второй попытки не бывает.
  {
    calls.length = 0;
    routes = [{ match: (u) => u === YANDEX_IMAGE_API, reply: () => jsonRes('{"code":3,"message":"invalid"}', 400) }];
    let err = null;
    try {
      await findImages("Subaru", { imgKey: "K", imgFolder: "f" });
    } catch (e) {
      err = e;
    }
    check("400 не повторяется вторым запросом", calls.length === 1, "запросов: " + calls.length);
    check("400 показан пользователю", !!err && err.message.indexOf("HTTP 400") > 0, err && err.message);
  }

  // 401 по другой причине не должен маскироваться повтором.
  {
    calls.length = 0;
    routes = [{ match: (u) => u === YANDEX_IMAGE_API, reply: () => jsonRes('{"code":16,"message":"API key not found"}', 401) }];
    let err = null;
    try {
      await findImages("Subaru", { imgKey: "bad", imgFolder: "f" });
    } catch (e) {
      err = e;
    }
    check("401 не повторяется вторым запросом", calls.length === 1, "запросов: " + calls.length);
    check("причина из тела ответа видна пользователю", !!err && err.message.indexOf("API key not found") > 0, err && err.message);
  }

  // ---- 5. честные ошибки --------------------------------------------------
  console.log("\n=== 5. Честные ошибки вместо тишины ===");
  {
    calls.length = 0;
    routes = [];
    const errs = [];
    for (const [name, settings, query] of [
      ["нет ключа", { imgKey: "", imgFolder: "f" }, "x"],
      ["нет folder ID", { imgKey: "k", imgFolder: "" }, "x"],
      ["пустой запрос", { imgKey: "k", imgFolder: "f" }, "   "]
    ]) {
      try {
        await findImages(query, settings);
        errs.push(null);
      } catch (e) {
        errs.push(e.message);
      }
      check("ошибка: " + name, !!errs[errs.length - 1], errs[errs.length - 1] || "исключения не было");
    }
    check("без настроек в сеть не ходим", calls.length === 0, "запросов: " + calls.length);
  }

  // Ответ есть, а картинок в нём нет — показываем начало ответа, а не пустоту.
  {
    routes = [{ match: (u) => u === YANDEX_IMAGE_API, reply: () => rawRes("<html><body>Робот, уйди</body></html>") }];
    let msg = "";
    try {
      await findImages("Subaru", { imgKey: "k", imgFolder: "f" });
    } catch (e) {
      msg = e.message;
    }
    check("пустая галерея объяснена", msg.indexOf("не нашлось") > 0, msg);
    check("в объяснении видно начало ответа", msg.indexOf("Робот, уйди") > 0);
    eq("headOf схлопывает переводы строк", headOf("<a>\n\n  <b>"), "<a> <b>");
  }

  // ---- 6. фразы для поиска ------------------------------------------------
  console.log("\n=== 6. Поисковые фразы из смысла статьи ===");
  eq(
    "нумерация и маркеры срезаны",
    parseQueries("1. Subaru Outback тест\n2) Обзор кроссовера\n- Дорожный просвет"),
    ["Subaru Outback тест", "Обзор кроссовера", "Дорожный просвет"]
  );
  eq("кавычки срезаны", parseQueries('«Обзор Outback»'), ["Обзор Outback"]);
  eq("больше трёх фраз не берём", parseQueries("ааа\nббб\nввв\nггг\nддд").length, IMAGE_QUERIES_MAX);
  eq("короткие обрывки отброшены", parseQueries("\n\nab\nобзор\n"), ["обзор"]);
  eq("фраза в один знак отброшена", parseQueries("я"), []);
  eq("пустой ответ модели", parseQueries(""), []);

  // ---- 7. контракт сообщения ---------------------------------------------
  console.log("\n=== 7. Контракт «фон → контент-скрипт» ===");
  {
    routes = [{ match: (u) => u === YANDEX_IMAGE_API, reply: () => rawRes(xmlResponse([docXml({ img: PHOTO, width: 1200, height: 800 })])) }];
    const res = await sendMessage({ type: "findImages", query: "Subaru", overrides: { imgKey: "k", imgFolder: "f" } });
    eq("ответ ok", res.ok, true);
    check("картинки — массив", Array.isArray(res.images), typeof res.images);
    eq("запрос возвращён вместе с картинками", res.query, "Subaru");
  }
  {
    const res = await sendMessage({ type: "findImages", query: "Subaru", overrides: { imgKey: "", imgFolder: "" } });
    eq("ошибка тоже приходит ответом, а не молчанием", res.ok, false);
    check("текст ошибки непустой", !!(res.error && res.error.length), res.error);
  }
  {
    // Без AI фразы не выдумываются — панель останется с заголовком статьи.
    const res = await sendMessage({ type: "imageQueries", text: "текст", overrides: { aiEnabled: false, aiKey: "" } });
    eq("без AI список фраз пуст", res.ok, true);
    eq("без AI фраз нет", res.queries, []);
  }

  // ---- 8. настройки в правильном хранилище -------------------------------
  console.log("\n=== 8. Где лежат настройки ===");
  check("imgKey объявлен в DEFAULTS", Object.prototype.hasOwnProperty.call(DEFAULTS, "imgKey"));
  check("imgFolder объявлен в DEFAULTS", Object.prototype.hasOwnProperty.call(DEFAULTS, "imgFolder"));
  check("imgKey — в local (ключ секретный)", LOCAL_KEYS.indexOf("imgKey") !== -1, LOCAL_KEYS.join(", "));
  check("imgFolder — в local (без ключа бесполезен)", LOCAL_KEYS.indexOf("imgFolder") !== -1);
  check("дефолтный ключ пуст", DEFAULTS.imgKey === "" && DEFAULTS.imgFolder === "");

  // ---- 9. проверка ключей кнопкой ----------------------------------------
  // Кнопка «Проверить» в настройках обязана говорить правду: рабочий ключ —
  // рабочий, чужой — с причиной из ответа. И без ключа она не должна ходить
  // в сеть: оба запроса платные.
  console.log("\n=== 9. Проверка ключей из настроек ===");
  {
    calls.length = 0;
    routes = [];
    const cases = [
      ["нет ключа AI", checkAiKey, { aiKey: "", aiBaseUrl: "https://api.example.com/v1", aiModel: "m" }, "API-ключ"],
      ["нет ключа Яндекса", checkImageKey, { imgKey: "", imgFolder: "f" }, "Yandex Search API"],
      ["нет folder ID", checkImageKey, { imgKey: "k", imgFolder: "" }, "folder ID"]
    ];
    for (const [name, fn, settings, frag] of cases) {
      let msg = null;
      try {
        await fn(settings);
      } catch (e) {
        msg = e.message;
      }
      check("проверка: ошибка «" + name + "»", !!msg && msg.indexOf(frag) >= 0, msg || "исключения не было");
    }
    check("проверка без настроек в сеть не ходит", calls.length === 0, "запросов: " + calls.length);
  }

  // Рабочий ключ Яндекса: один запрос, одна картинка — этого хватает, чтобы
  // отличить рабочий ключ от чужого. Двенадцать картинок проверке не нужны.
  {
    calls.length = 0;
    routes = [
      {
        match: (u) => u === YANDEX_IMAGE_API,
        reply: () => rawRes(xmlResponse([docXml({ url: PAGE, title: "Т", img: PHOTO, width: 1600, height: 1067 })]))
      }
    ];
    const text = await checkImageKey({ imgKey: "SECRET", imgFolder: "f1" });
    eq("проверка ключа Яндекса: один запрос", calls.length, 1);
    eq("проверка просит одну картинку, а не двенадцать", JSON.parse(calls[0].init.body).docsOnPage, "1");
    check("сказано, что ключ рабочий", text.indexOf("рабочий") >= 0, text);
    check("названо, сколько картинок в ответе", /картинок в ответе — 1/.test(text), text);
  }

  // Чужой ключ Яндекса: причина из тела ответа и без повторов.
  {
    calls.length = 0;
    routes = [{ match: (u) => u === YANDEX_IMAGE_API, reply: () => jsonRes('{"code":16,"message":"API key not found"}', 401) }];
    let msg = "";
    try {
      await checkImageKey({ imgKey: "bad", imgFolder: "f" });
    } catch (e) {
      msg = e.message;
    }
    check("проверка ключа Яндекса: причина видна", msg.indexOf("API key not found") > 0, msg);
    eq("проверка ключа Яндекса: без повторов", calls.length, 1);
  }

  // Ключ AI проверяем тем же путём, что и рерайт: адрес, заголовок, модель.
  // Иначе «ключ рабочий» означало бы «сервис жив», а не «рерайт пройдёт».
  {
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("/chat/completions") > 0,
        reply: () => jsonRes({ model: "deepseek-v4.1-flash", choices: [{ message: { content: "ok" } }] })
      }
    ];
    const text = await checkAiKey({ aiKey: "SK", aiBaseUrl: "https://api.b.ai/v1/", aiModel: "deepseek-v4.1-flash" });
    eq("проверка ключа AI: один запрос", calls.length, 1);
    eq("адрес собран без двойного слэша", calls[0].url, "https://api.b.ai/v1/chat/completions");
    eq("ключ в заголовке Bearer", calls[0].init.headers.Authorization, "Bearer SK");
    eq("метод POST", calls[0].init.method, "POST");
    const body = JSON.parse(calls[0].init.body);
    eq("модель взята из настроек", body.model, "deepseek-v4.1-flash");
    check("на ответ выставлен потолок", body.max_tokens > 0 && body.max_tokens <= 32, String(body.max_tokens));
    check("названа ответившая модель", text.indexOf("deepseek-v4.1-flash") >= 0, text);
  }

  // Чужой ключ AI: причина из тела, а не «что-то пошло не так».
  {
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("/chat/completions") > 0,
        reply: () => jsonRes('{"error":{"message":"Incorrect API key provided"}}', 401)
      }
    ];
    let msg = "";
    try {
      await checkAiKey({ aiKey: "bad", aiBaseUrl: "https://api.b.ai/v1", aiModel: "m" });
    } catch (e) {
      msg = e.message;
    }
    check("проверка ключа AI: причина видна", msg.indexOf("Incorrect API key") > 0, msg);
    eq("проверка ключа AI: без повторов", calls.length, 1);
  }

  // Неверное название модели — самая частая причина «ключ вроде рабочий, а
  // рерайт не идёт». Проверка обязана показать и это.
  {
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("/chat/completions") > 0,
        reply: () => jsonRes('{"error":{"message":"model `gpt-9` does not exist"}}', 404)
      }
    ];
    let msg = "";
    try {
      await checkAiKey({ aiKey: "SK", aiBaseUrl: "https://api.b.ai/v1", aiModel: "gpt-9" });
    } catch (e) {
      msg = e.message;
    }
    check("неверная модель названа в ответе проверки", msg.indexOf("does not exist") > 0, msg);
  }

  // ---- 9б. Проверка не имеет права врать ----------------------------------
  // Код 200 — это ещё не ответ модели. Неверный адрес умеет отвечать «200» с
  // телом-ошибкой: у z.ai путь без /paas/v4 отдаёт {"code":500,"msg":"404
  // NOT_FOUND"} и при этом 200. Пока проверка смотрела только на код, она
  // говорила «ключ рабочий» ровно тогда, когда рерайт не пойдёт.
  console.log("\n=== 9б. Ответ 200 без ответа модели ===");
  {
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("/chat/completions") > 0,
        reply: () => jsonRes({ code: 500, msg: "404 NOT_FOUND", success: false })
      }
    ];
    let msg = "";
    try {
      await checkAiKey({ aiKey: "SK", aiBaseUrl: "https://api.z.ai/api", aiModel: "glm-5.3" });
    } catch (e) {
      msg = e.message;
    }
    check("200 без ответа модели — не «ключ рабочий»", msg.length > 0, msg || "проверка промолчала");
    check("причина видна из тела ответа", msg.indexOf("404 NOT_FOUND") > 0, msg);
    check("человеку подсказан адрес API", msg.indexOf("адрес API") > 0, msg);
    check("ответа модели нет — в сеть сходили один раз", calls.length === 1, "запросов: " + calls.length);
  }

  // Тот же ответ, но уже в рерайте: «пустой ответ» без тела — тупик.
  {
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("/chat/completions") > 0,
        reply: () => jsonRes({ code: 500, msg: "404 NOT_FOUND", success: false })
      }
    ];
    let msg = "";
    try {
      await aiRewrite("Текст статьи.", { aiKey: "SK", aiBaseUrl: "https://api.z.ai/api", aiModel: "glm-5.3" });
    } catch (e) {
      msg = e.message;
    }
    check("пустой ответ рерайта объяснён телом ответа", msg.indexOf("404 NOT_FOUND") > 0, msg);
  }

  // Обрыв сети. «Failed to fetch» — это всё, что видит человек, вписавший свой
  // адрес API: ни источника, ни домена, ни подсказки, что дело в доступе.
  {
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("api.example.com") > 0,
        reply: () => {
          throw new TypeError("Failed to fetch");
        }
      }
    ];
    let msg = "";
    try {
      await fetchJson("https://api.example.com/v1/models", { label: "AI", tries: 1 });
    } catch (e) {
      msg = e.message;
    }
    check("обрыв сети не остаётся английским «Failed to fetch»", msg.indexOf("Failed to fetch") < 0, msg);
    check("в отказе назван домен", msg.indexOf("api.example.com") > 0, msg);
    check("в отказе назван источник", msg.indexOf("AI:") === 0, msg);
    check("человеку сказано про доступ к домену", msg.indexOf("доступ") > 0, msg);
  }

  // ---- 9в. Модель с рассуждением: пустой content — не «неверный адрес» ----
  // Живой случай: `deepseek-v4.1-flash` на проверке отвечает
  // {"choices":[{"message":{"content":"","reasoning":"We need answer one word: ok."},
  // "finish_reason":"length"}]} — то есть сервис ответил по-настоящему, а текст
  // ушёл в поле reasoning: восемь токенов проверки кончились на размышлении.
  // Прежняя проверка видела пустой content и отправляла человека чинить адрес
  // API, хотя адрес, ключ и модель рабочие.
  console.log("\n=== 9в. Модель с рассуждением: пустой ответ при целом ответе ===");
  {
    const reasoningOnly = () =>
      jsonRes({
        model: "deepseek-v4.1-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "", reasoning: "We need answer one word: ok." },
            finish_reason: "length"
          }
        ]
      });

    // а) и со второго раза текста нет — говорим правду про рассуждение, но НЕ
    // про адрес: ключ и модель рабочие.
    calls.length = 0;
    routes = [{ match: (u) => u.indexOf("/chat/completions") > 0, reply: reasoningOnly }];
    let msg = "";
    let text = "";
    try {
      text = await checkAiKey({ aiKey: "SK", aiBaseUrl: "https://api.polza.ai/api/v1", aiModel: "deepseek-v4.1-flash" });
    } catch (e) {
      msg = e.message;
    }
    check("пустой content не выдаётся за неверный адрес", msg.indexOf("адрес API") < 0, msg || text);
    check("модель названа рабочей, но текста нет", /рассуждением/.test(text), text || msg);
    check("названо имя модели", text.indexOf("deepseek-v4.1-flash") > 0, text);
    check("повтор с запасом лимита сделан", calls.length === 2, "запросов: " + calls.length);
    const first = JSON.parse(calls[0].init.body);
    const second = JSON.parse(calls[1].init.body);
    check("первый запрос короткий", first.max_tokens === 8, String(first.max_tokens));
    check("повтор с запасом на рассуждение", second.max_tokens > first.max_tokens, String(second.max_tokens));

    // Потолок повтора не может быть меньше потолка первого запроса. Повтор в
    // тридцать два раза больше и делается ровно ради медленной модели, поэтому
    // общий потолок на оба запроса отнимал бы время там, где оно нужнее всего,
    // и человек читал бы «таймаут» вместо вердикта о ключе.
    check(
      "у повтора потолок больше, чем у первого запроса",
      AI_CHECK_RETRY_TIMEOUT_MS > AI_CHECK_TIMEOUT_MS,
      AI_CHECK_RETRY_TIMEOUT_MS / 1000 + " с против " + AI_CHECK_TIMEOUT_MS / 1000 + " с"
    );
    check(
      "потолок своей модели покрывает оба запроса",
      AI_LOCAL_CHECK_TIMEOUT_MS >= AI_CHECK_RETRY_TIMEOUT_MS,
      AI_LOCAL_CHECK_TIMEOUT_MS / 1000 + " с"
    );

    // б) со второго раза текст есть — проверка честно говорит «ключ рабочий».
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("/chat/completions") > 0,
        reply: (u, init) =>
          JSON.parse(init.body).max_tokens > 8
            ? jsonRes({ model: "deepseek-v4.1-flash", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })
            : reasoningOnly()
      }
    ];
    const ok = await checkAiKey({ aiKey: "SK", aiBaseUrl: "https://api.polza.ai/api/v1", aiModel: "deepseek-v4.1-flash" });
    check("со второго раза ответ есть — «ключ рабочий»", /Ключ рабочий/.test(ok), ok);
    eq("запросов ровно два", calls.length, 2);

    // в) рерайт той же моделью: причина пустого ответа названа, а не «пустой ответ».
    calls.length = 0;
    routes = [{ match: (u) => u.indexOf("/chat/completions") > 0, reply: reasoningOnly }];
    msg = "";
    try {
      await aiRewrite("Текст статьи.", { aiKey: "SK", aiBaseUrl: "https://api.polza.ai/api/v1", aiModel: "deepseek-v4.1-flash" });
    } catch (e) {
      msg = e.message;
    }
    check("рерайт объясняет пустой ответ рассуждением", /рассуждением/.test(msg), msg);
    check("и называет finish_reason", /finish_reason: length/.test(msg), msg);
  }

  // ---- 9г. Своя модель: без ключа и с длинным ожиданием --------------------
  // Локальная модель (Ollama и подобные) — не экзотика, а самый дешёвый способ
  // включить рерайт. У неё три отличия, и все три ломали работу: ключа у неё нет
  // (расширение отказывало в рерайте), отвечает она минутами (потолок 90 с её
  // обрывал), а повторять её бессмысленно — она не «сбойнула», она считает.
  // README обещал «ключ оставьте пустым» с самого начала, но обещал зря.
  console.log("\n=== 9г. Своя модель: ключ не нужен, ждать дольше ===");
  {
    const local = "http://127.0.0.1:11434/v1";
    for (const [base, want, what] of [
      [local, true, "127.0.0.1 с портом"],
      ["http://localhost:11434/v1", true, "localhost"],
      ["http://0.0.0.0:11434/v1", true, "0.0.0.0"],
      ["http://[::1]:11434/v1", true, "адрес IPv6"],
      ["http://mac.local:11434/v1", true, "имя .local"],
      ["https://api.openai.com/v1", false, "чужой сервис"],
      ["https://api.z.ai/api/paas/v4", false, "чужой сервис по https"],
      ["http://192.168.1.5:11434/v1", false, "другая машина в сети (права не даются)"],
      ["", false, "пустой адрес"],
      ["не адрес", false, "мусор в поле"]
    ]) {
      eq("своя машина? " + what, isLocalAiBase(base), want);
    }
    check(
      "потолок своей модели выше облачного",
      AI_LOCAL_TIMEOUT_MS > AI_TIMEOUT_MS,
      AI_LOCAL_TIMEOUT_MS / 1000 + " с против " + AI_TIMEOUT_MS / 1000 + " с"
    );

    // Потолок растёт вместе с текстом: фиксированные 90 с верны только для
    // короткой заметки. На статье в 2000 слов модель честно считает дольше —
    // и обрыв по потолку выглядел бы как «сервис не ответил», хотя он отвечал.
    const words = (n) => new Array(n).fill("слово").join(" ");
    eq("пустой текст — базовый потолок облака", aiTimeoutMs("", false), AI_TIMEOUT_MS);
    eq("пустой текст — базовый потолок своей модели", aiTimeoutMs("", true), AI_LOCAL_TIMEOUT_MS);
    eq(
      "прибавка идёт по словам",
      aiTimeoutMs(words(100), false),
      AI_TIMEOUT_MS + 100 * AI_TIMEOUT_PER_WORD_MS
    );
    check(
      "длинный текст получает больше времени",
      aiTimeoutMs(words(1000), false) > aiTimeoutMs(words(200), false),
      aiTimeoutMs(words(200), false) / 1000 + " с → " + aiTimeoutMs(words(1000), false) / 1000 + " с"
    );
    eq("у облака есть предел — 5 минут", aiTimeoutMs(words(5000), false), AI_TIMEOUT_MAX_MS);
    eq("у своей модели предел — 10 минут", aiTimeoutMs(words(5000), true), AI_LOCAL_TIMEOUT_MAX_MS);
    check(
      "предел своей модели выше облачного при том же тексте",
      aiTimeoutMs(words(5000), true) > aiTimeoutMs(words(5000), false),
      aiTimeoutMs(words(5000), true) / 1000 + " с против " + aiTimeoutMs(words(5000), false) / 1000 + " с"
    );

    // Рерайт без ключа на своей машине: раньше здесь был отказ «не указан
    // ключ», и человек с Ollama не мог включить рерайт вовсе.
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("/chat/completions") > 0,
        reply: () => jsonRes({ model: "qwen2.5:7b", choices: [{ message: { content: "Готовый текст." } }] })
      }
    ];
    const out = await aiRewrite("Текст статьи.", { aiKey: "", aiBaseUrl: local, aiModel: "qwen2.5:7b" });
    eq("рерайт своей модели прошёл без ключа", out, "Готовый текст.");
    eq("запрос ушёл на путь OpenAI-совместимого API", calls[0].url, "http://127.0.0.1:11434/v1/chat/completions");
    check(
      "пустой ключ не превратился в заголовок «Bearer »",
      calls[0].init.headers.Authorization === undefined,
      String(calls[0].init.headers.Authorization)
    );
    eq("свой сервер не заставляют ждать модель дважды", calls.length, 1);

    // Своя модель молчит или падает — второй попытки нет: она считает, а не
    // сбоит, и три повтора дали бы четверть часа ожидания вместо минуты.
    calls.length = 0;
    routes = [{ match: (u) => u.indexOf("/chat/completions") > 0, reply: () => jsonRes({}, 500) }];
    try {
      await aiRewrite("Текст.", { aiKey: "", aiBaseUrl: local, aiModel: "qwen2.5:7b" });
    } catch (e) {
      /* отказ и есть предмет проверки */
    }
    eq("своя модель: попытка одна", calls.length, 1);

    // Чужой сервис по-прежнему повторяем: там сбой — это сбой.
    calls.length = 0;
    routes = [{ match: (u) => u.indexOf("/chat/completions") > 0, reply: () => jsonRes({}, 500) }];
    try {
      await aiRewrite("Текст.", { aiKey: "SK", aiBaseUrl: "https://api.b.ai/v1", aiModel: "m" });
    } catch (e) {
      /* отказ и есть предмет проверки */
    }
    eq("чужой сервис: повторы остались", calls.length, 3);

    // Проверка ключа у своей модели: ключа нет, но проверить надо — иначе
    // человек не узнает ни что адрес верный, ни что модель называется так.
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("/chat/completions") > 0,
        reply: () => jsonRes({ model: "qwen2.5:7b", choices: [{ message: { content: "ok" } }] })
      }
    ];
    const text = await checkAiKey({ aiKey: "", aiBaseUrl: local, aiModel: "qwen2.5:7b" });
    check("проверка своей модели прошла без ключа", text.indexOf("qwen2.5:7b") > 0, text);
    check("и сказала, что ключ тут не нужен", /ключ не нужен/i.test(text), text);
    check(
      "проверка своей модели не шлёт пустой ключ",
      calls[0].init.headers.Authorization === undefined,
      String(calls[0].init.headers.Authorization)
    );

    // А у чужого сервиса ключ по-прежнему обязателен: без него проверка
    // отправила бы запрос впустую и сказала бы «ключ рабочий» про пустоту.
    let msg = "";
    try {
      await checkAiKey({ aiKey: "", aiBaseUrl: "https://api.b.ai/v1", aiModel: "m" });
    } catch (e) {
      msg = e.message;
    }
    check("чужой сервис без ключа: отказ до запроса", /ключ/i.test(msg), msg || "проверка промолчала");

    // Доступ к AI: ключ или свой адрес. Без этого «включён AI, ключа нет» на
    // своей машине читалось бы как «AI выключен» — и фразы для картинок, и
    // рерайт молча уходили бы во встроенный рерайтер.
    check("AI доступен по ключу", aiHasAccess({ aiKey: "SK", aiBaseUrl: "https://api.b.ai/v1" }));
    check("AI доступен без ключа на своей машине", aiHasAccess({ aiKey: "", aiBaseUrl: local }));
    check(
      "без ключа и без своего адреса AI недоступен",
      !aiHasAccess({ aiKey: "", aiBaseUrl: "https://api.b.ai/v1" })
    );

    // Таймаут назван в отказе и не повторяется. Проверяем на коротком потолке:
    // ждать 5 минут ради проверки сообщения — это пять минут прогона ни за что.
    // Попыток просим три нарочно: сервис, не ответивший за пять минут, не
    // ответит быстрее во второй раз, а три повтора дали бы четверть часа.
    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("slow.example.com") > 0,
        // Отвечает позже потолка — как настоящий сервис, который «думает».
        reply: () => new Promise((r) => setTimeout(() => r(jsonRes({})), 5000))
      }
    ];
    msg = "";
    try {
      await fetchJson("https://slow.example.com/v1/chat/completions", { label: "AI", tries: 3, timeout: 150 });
    } catch (e) {
      msg = e.message;
    }
    check("таймаут назван в отказе, а не потерян", /таймаут/.test(msg), msg || "отказа не было");
    eq("таймаут не повторяют", calls.length, 1);

    // Пояснение к таймауту. «Таймаут 300 с» — факт, но не объяснение, и после
    // пяти минут ожидания его читают как «ключ не тот». Проверяем на коротком
    // потолке: пояснение едет опцией, поэтому его видно и без пятиминутного
    // ожидания — а собрать его внутри рерайта значило бы не проверить никак.
    eq("слова считаются", textWords("одно два три"), 3);
    eq("пустой текст — ноль слов", textWords(""), 0);
    eq("пробелы — не слова", textWords("   \n  "), 0);

    const note = aiTimeoutNote("одно два три");
    check("пояснение называет объём текста", /3 слов/.test(note), note);
    check("и снимает прочтение «сломался ключ»", /не в ключе/.test(note), note);
    check("и говорит, что делать", /побыстрее|разбиение/.test(note), note);

    calls.length = 0;
    routes = [
      {
        match: (u) => u.indexOf("slow.example.com") > 0,
        reply: () => new Promise((r) => setTimeout(() => r(jsonRes({})), 5000))
      }
    ];
    msg = "";
    try {
      await fetchJson("https://slow.example.com/v1/chat/completions", {
        label: "AI",
        tries: 1,
        timeout: 150,
        timeoutNote: note
      });
    } catch (e) {
      msg = e.message;
    }
    check("пояснение доехало до отказа", msg.indexOf(note) > 0, msg);
    check("и не съело сам таймаут", /таймаут/.test(msg), msg);
  }

  // ---- 10. второй источник: Pixabay и Openverse ---------------------------
  console.log("\n=== 10. Второй источник картинок ===");
  {
    check("у каждого источника есть название для панели", Object.keys(IMG_SOURCES).every((id) => !!IMG_SOURCES[id].label), JSON.stringify(Object.keys(IMG_SOURCES)));
    check(
      "у каждого источника есть строка про лицензию (пусть и пустая)",
      Object.keys(IMG_SOURCES).every((id) => Object.prototype.hasOwnProperty.call(IMG_NOTICE, id)),
      Object.keys(IMG_NOTICE).join(", ")
    );
    eq("источники перечислены в коде", Object.keys(IMG_SOURCES).join(","), "yandex,pixabay,openverse");
    check(
      "ключ нужен Яндексу и Pixabay, а folder ID — только Яндексу",
      IMG_SOURCES.yandex.needsKey && IMG_SOURCES.yandex.needsFolder &&
        IMG_SOURCES.pixabay.needsKey && !IMG_SOURCES.pixabay.needsFolder &&
        !IMG_SOURCES.openverse.needsKey && !IMG_SOURCES.openverse.needsFolder
    );

    // Список источников в попапе — часть контракта: добавили источник в код и
    // забыли в списке, значит выбрать его нельзя, хотя он есть. Смотрим только
    // свой список: в попапе есть и другие <select>, и все их значения сюда не
    // относятся (проверка ловила их и падала на первом же чужом <option>).
    const imgSourceBlock = (POPUP_HTML.match(/<select id="imgSource">([\s\S]*?)<\/select>/) || [])[1] || "";
    const popupSources = (imgSourceBlock.match(/<option value="([a-z]+)">/g) || []).map((s) => s.replace(/.*"([a-z]+)".*/, "$1"));
    eq("в попапе перечислены те же источники", popupSources.join(","), Object.keys(IMG_SOURCES).join(","));

    // Мусор в настройке не должен уводить поиск в никуда: незнакомое значение
    // считаем Яндексом — так же, как вёл себя код до появления выбора.
    eq("незнакомый источник — Яндекс", imgSourceInfo({ imgSource: "что-то" }).id, "yandex");
    eq("пустой источник — Яндекс", imgSourceInfo({}).id, "yandex");
    eq("известный источник узнаётся", imgSourceInfo({ imgSource: "openverse" }).id, "openverse");
  }

  // Форма запросов. У Pixabay и Openverse это GET с параметрами, поэтому ключ
  // виден в адресе — проверяем адрес, а не «где-то там есть ключ».
  {
    const pb = new URL(pixabayUrl("Subaru Outback", { pixabayKey: "KEY" }, IMAGE_COUNT));
    eq("Pixabay: адрес", pb.origin + pb.pathname, PIXABAY_API);
    eq("Pixabay: ключ в адресе", pb.searchParams.get("key"), "KEY");
    eq("Pixabay: горизонтальные просим у поиска", pb.searchParams.get("orientation"), "horizontal");
    eq("Pixabay: только фотографии", pb.searchParams.get("image_type"), "photo");
    eq("Pixabay: безопасный поиск включён", pb.searchParams.get("safesearch"), "true");
    eq("Pixabay: сколько картинок", pb.searchParams.get("per_page"), String(IMAGE_COUNT));
    eq("Pixabay: латинский запрос — язык не навязываем", pb.searchParams.get("lang"), null);
    eq("Pixabay: русский запрос ищем по-русски", new URL(pixabayUrl("Субару Аутбек", { pixabayKey: "K" }, 5)).searchParams.get("lang"), "ru");
    eq("Pixabay: длинный запрос обрезан по лимиту поля", new URL(pixabayUrl("я".repeat(300), { pixabayKey: "K" }, 12)).searchParams.get("q").length, 100);

    const ov = new URL(openverseUrl("Subaru Outback", IMAGE_COUNT));
    eq("Openverse: адрес", ov.origin + ov.pathname, OPENVERSE_API);
    eq("Openverse: горизонтальные просим у поиска", ov.searchParams.get("aspect_ratio"), "wide");
    eq("Openverse: сколько картинок", ov.searchParams.get("page_size"), String(IMAGE_COUNT));
    eq("Openverse: только лицензии, годные для статьи", ov.searchParams.get("license_type"), "commercial,modification");
    eq("Openverse: без взрослого содержимого", ov.searchParams.get("mature"), "false");
    check("Openverse: ключа в адресе нет", ov.searchParams.get("key") === null, ov.search);
  }

  // Разбор ответов. Вертикальный кадр у каждого провайдера свой — и он должен
  // отсеяться. Адреса у фикстур разные намеренно: с одинаковыми вторая картинка
  // отсеялась бы как дубль, и проверка прошла бы, ничего не проверив.
  {
    const imgs = parsePixabayImages(
      pixabayJson([
        pixabayHit({}),
        pixabayHit({ img: "https://cdn.pixabay.com/photo/vert_1280.jpg", width: 800, height: 1400 })
      ])
    );
    eq("Pixabay: вертикальная отсеяна", imgs.length, 1);
    eq("Pixabay: берём крупную версию, а не превью", imgs[0].url, "https://cdn.pixabay.com/photo/x_1280.jpg");
    eq("Pixabay: теги стали заголовком", imgs[0].title, "subaru, outback, car");
    eq("Pixabay: размеры сохранены", [imgs[0].width, imgs[0].height], [1600, 1067]);
    eq("Pixabay: подписан источник и автор", imgs[0].credit, "Pixabay · photographer");
    eq("Pixabay: ссылка на страницу автора", imgs[0].creditUrl, "https://pixabay.com/photos/subaru-outback-195893/");
    eq("контроль: пустой ответ Pixabay", parsePixabayImages({}).length, 0);
    eq("контроль: null не роняет разбор Pixabay", parsePixabayImages(null).length, 0);
    eq("контроль: хит без адреса пропущен", parsePixabayImages(pixabayJson([{ tags: "x" }])).length, 0);

    const ovImgs = parseOpenverseImages({
      result_count: 2,
      results: [openverseResult({}), openverseResult({ n: 2, img: "https://live.staticflickr.com/1/tall.jpg", width: 600, height: 900 })]
    });
    eq("Openverse: вертикальная отсеяна", ovImgs.length, 1);
    eq("Openverse: адрес картинки, а не превью", ovImgs[0].url, "https://live.staticflickr.com/3110/2615279798_0ec90c5379.jpg");
    eq("Openverse: заголовок сохранён", ovImgs[0].title, "2008 Subaru Canada Rally Team STI");
    eq("Openverse: автор, лицензия и провайдер подписаны", ovImgs[0].credit, "formulaphoto · BY-SA 2.0 · flickr");
    eq("Openverse: ссылка на страницу картинки", ovImgs[0].creditUrl, "https://www.flickr.com/photos/98419084@N00/2615279798");
    eq("контроль: пустой ответ Openverse", parseOpenverseImages({}).length, 0);
    eq("контроль: null не роняет разбор Openverse", parseOpenverseImages(null).length, 0);
  }

  // Живой вызов: куда именно ушёл запрос и что вернулось панели.
  {
    calls.length = 0;
    routes = [{ match: (u) => u.indexOf(PIXABAY_API) === 0, reply: () => jsonRes(pixabayJson([pixabayHit({})])) }];
    const out = await findImages("Subaru Outback", { imgSource: "pixabay", pixabayKey: "K" });
    eq("Pixabay: картинка нашлась", out.images.length, 1);
    eq("Pixabay: источник назван в ответе", out.source, "Pixabay");
    eq("Pixabay: запрос ушёл один раз", calls.length, 1);
    check("Pixabay: в Яндекс при этом не ходили", calls.every((c) => c.url.indexOf(YANDEX_IMAGE_API) !== 0));
    check("Pixabay: ключ в адресе, а не в заголовке", !calls[0].init.headers, JSON.stringify(calls[0].init.headers));
    check("Pixabay: памятка про источник приложена", /источник/i.test(out.notice), out.notice);

    calls.length = 0;
    routes = [{ match: (u) => u.indexOf(OPENVERSE_API) === 0, reply: () => jsonRes({ results: [openverseResult({})] }) }];
    const ovOut = await findImages("Subaru", { imgSource: "openverse" });
    eq("Openverse: картинка нашлась без ключа", ovOut.images.length, 1);
    eq("Openverse: источник назван в ответе", ovOut.source, "Openverse");
    eq("Openverse: запрос ушёл один раз", calls.length, 1);
    check("Openverse: подпись лицензии приложена", /лиценз/i.test(ovOut.notice), ovOut.notice);

    // Контроль: без выбора источника поведение прежнее — Яндекс.
    calls.length = 0;
    resetImageCache(); // ту же пару «Яндекс + Subaru» уже искали выше — нужен живой запрос
    routes = [{ match: (u) => u === YANDEX_IMAGE_API, reply: () => rawRes(xmlResponse([docXml({ img: PHOTO, width: 1200, height: 800 })])) }];
    const yOut = await findImages("Subaru", { imgKey: "k", imgFolder: "f" });
    eq("без настройки источника работаем с Яндексом", yOut.source, "Яндекс");
    eq("без настройки источника в Яндекс и ушли", calls[0].url, YANDEX_IMAGE_API);
    eq("у Яндекса памятки про лицензию нет", yOut.notice, "");
  }

  // Честные ошибки: чего не хватает и что ответил поиск.
  {
    calls.length = 0;
    routes = [];
    let msg = "";
    try {
      await findImages("Subaru", { imgSource: "pixabay", pixabayKey: "" });
    } catch (e) {
      msg = e.message;
    }
    check("Pixabay без ключа: сказано, чего не хватает", msg.indexOf("Pixabay") >= 0, msg || "исключения не было");
    eq("Pixabay без ключа: в сеть не ходим", calls.length, 0);

    routes = [{ match: (u) => u.indexOf(PIXABAY_API) === 0, reply: () => jsonRes(pixabayJson([])) }];
    resetImageCache();
    msg = "";
    try {
      await findImages("Subaru", { imgSource: "pixabay", pixabayKey: "K" });
    } catch (e) {
      msg = e.message;
    }
    check("Pixabay: пустая выдача объяснена, а не проглочена", msg.indexOf("Pixabay") === 0 && msg.indexOf("не нашлось") > 0, msg);

    routes = [{ match: (u) => u.indexOf(OPENVERSE_API) === 0, reply: () => jsonRes("<html>Робот, уйди</html>") }];
    resetImageCache();
    msg = "";
    try {
      await findImages("Subaru", { imgSource: "openverse" });
    } catch (e) {
      msg = e.message;
    }
    check("Openverse: мусорный ответ объяснён", msg.indexOf("Openverse") === 0 && msg.indexOf("не нашлось") > 0, msg);
  }

  // Проверка ключа кнопкой — по выбранному источнику. У Яндекса запрос платный,
  // у остальных бесплатный, и текст это говорит.
  {
    calls.length = 0;
    routes = [{ match: (u) => u.indexOf(PIXABAY_API) === 0, reply: () => jsonRes(pixabayJson([pixabayHit({})])) }];
    const text = await checkImageKey({ imgSource: "pixabay", pixabayKey: "K" });
    eq("проверка ключа Pixabay: один запрос", calls.length, 1);
    check("проверка Pixabay: сказано, что запрос бесплатный", /бесплатн/i.test(text), text);

    calls.length = 0;
    routes = [{ match: (u) => u.indexOf(OPENVERSE_API) === 0, reply: () => jsonRes({ results: [openverseResult({})] }) }];
    const ovText = await checkImageKey({ imgSource: "openverse" });
    eq("проверка Openverse: один запрос", calls.length, 1);
    check("проверка Openverse: сказано, что ключ не нужен", /не нужен/i.test(ovText), ovText);

    calls.length = 0;
    routes = [];
    let msg = "";
    try {
      await checkImageKey({ imgSource: "pixabay", pixabayKey: "" });
    } catch (e) {
      msg = e.message;
    }
    check("проверка Pixabay без ключа: объяснение, а не запрос", !!msg && calls.length === 0, msg || "исключения не было");
  }

  // Источник и памятка должны доехать до панели вместе с картинками: панель не
  // угадывает, откуда они, — иначе в подписи окна стоял бы «Яндекс» для Pixabay.
  {
    resetImageCache();
    routes = [{ match: (u) => u.indexOf(OPENVERSE_API) === 0, reply: () => jsonRes({ results: [openverseResult({})] }) }];
    const res = await sendMessage({ type: "findImages", query: "Subaru", overrides: { imgSource: "openverse" } });
    eq("источник едет вместе с картинками", res.source, "Openverse");
    check("памятка едет вместе с картинками", !!res.notice, res.notice);
  }

  // ---- 11. где лежат новые настройки -------------------------------------
  console.log("\n=== 11. Настройки источников в хранилищах ===");
  check("imgSource объявлен в DEFAULTS", Object.prototype.hasOwnProperty.call(DEFAULTS, "imgSource"));
  check("pixabayKey объявлен в DEFAULTS", Object.prototype.hasOwnProperty.call(DEFAULTS, "pixabayKey"));
  eq("по умолчанию источник — Яндекс", DEFAULTS.imgSource, "yandex");
  eq("дефолтный ключ Pixabay пуст", DEFAULTS.pixabayKey, "");
  check("выбор источника — в sync (это не секрет)", LOCAL_KEYS.indexOf("imgSource") === -1, LOCAL_KEYS.join(", "));
  check("ключ Pixabay — в local (ключ секретный)", LOCAL_KEYS.indexOf("pixabayKey") !== -1, LOCAL_KEYS.join(", "));

  // ---- 12. кэш ответов поиска --------------------------------------------
  // Условие Pixabay: ответы держим в кэше 24 часа. Здесь проверяем сам кэш —
  // ключ, срок, вытеснение и терпимость к сломанному хранилищу. А то, что при
  // попадании в кэш запрос действительно НЕ уходит в сеть, ловит браузерный
  // набор: тут подставной fetch, и настоящей сети нет ни в одном случае.
  console.log("\n=== 12. Кэш ответов поиска картинок ===");
  {
    resetImageCache();
    const images = [{ url: PHOTO, title: "Т", width: 1200, height: 800, credit: "", creditUrl: "" }];
    const pbKey = imageCacheKey("pixabay", "Subaru", IMAGE_COUNT);

    check(
      "источник входит в ключ",
      imageCacheKey("pixabay", "Subaru", 12) !== imageCacheKey("yandex", "Subaru", 12),
      imageCacheKey("pixabay", "Subaru", 12)
    );
    check("регистр и пробелы в фразе не важны", imageCacheKey("pixabay", "  Subaru  ", 12) === imageCacheKey("pixabay", "subaru", 12));
    check("число картинок входит в ключ", imageCacheKey("pixabay", "Subaru", 12) !== imageCacheKey("pixabay", "Subaru", 3));
    check("кэш — не настройка (в LOCAL_KEYS его нет)", LOCAL_KEYS.indexOf(IMAGE_CACHE_KEY) === -1, IMAGE_CACHE_KEY);

    eq("пустой кэш ничего не отдаёт", await readImageCache(pbKey), null);

    await writeImageCache(pbKey, images);
    const back = await readImageCache(pbKey);
    eq("свежая запись читается", back && back.length, 1);
    eq("картинка вернулась та же", back && back[0].url, PHOTO);
    eq("другой источник в кэш не попал", await readImageCache(imageCacheKey("yandex", "Subaru", 12)), null);

    // Просрочка. Ровно на границе суток проверять нельзя: между записью и
    // чтением проходит время, и проверка стала бы плавающей — минута в запасе.
    localStore[IMAGE_CACHE_KEY][pbKey].at = Date.now() - IMAGE_CACHE_TTL - 60000;
    eq("просроченная запись не отдаётся", await readImageCache(pbKey), null);
    localStore[IMAGE_CACHE_KEY][pbKey].at = Date.now() - IMAGE_CACHE_TTL + 60000;
    check("запись младше суток ещё живая", !!(await readImageCache(pbKey)));

    // Пустой набор в кэш не кладём: «не нашлось» — это про сегодняшнюю выдачу.
    resetImageCache();
    await writeImageCache(pbKey, []);
    eq("пустой набор не считается попаданием", await readImageCache(pbKey), null);

    // Вытеснение: кэш не имеет права расти бесконечно.
    resetImageCache();
    for (let i = 0; i < IMAGE_CACHE_MAX + 5; i++) {
      await writeImageCache(imageCacheKey("pixabay", "фраза " + i, IMAGE_COUNT), images);
      await new Promise((r) => setTimeout(r, 2)); // чтобы `at` у записей различались
    }
    const keys = Object.keys(localStore[IMAGE_CACHE_KEY]);
    eq("кэш не растёт бесконечно", keys.length, IMAGE_CACHE_MAX);
    check(
      "вытесняются самые старые",
      keys.indexOf(imageCacheKey("pixabay", "фраза 0", IMAGE_COUNT)) === -1 &&
        keys.indexOf(imageCacheKey("pixabay", "фраза " + (IMAGE_CACHE_MAX + 4), IMAGE_COUNT)) !== -1,
      "записей: " + keys.length
    );

    // Сломанное хранилище не должно ронять поиск: кэш — не ценность.
    const goodGet = chrome.storage.local.get;
    chrome.storage.local.get = async () => {
      throw new Error("хранилище недоступно");
    };
    let broken = null;
    try {
      broken = await readImageCache(pbKey);
    } catch (e) {
      broken = "упало: " + e.message;
    }
    chrome.storage.local.get = goodGet;
    eq("сломанное хранилище не роняет поиск", broken, null);
  }

  // ---- 13. причина отказа: тело ответа, а не только код -------------------
  // Проверено живьём в браузере: на неверный ключ Pixabay отвечает 400 и текстом
  // «[ERROR 400] Invalid or missing API key (https://pixabay.com/api/docs/)»,
  // а на превышение лимита — «API rate limit exceeded». Тело в фикстурах —
  // настоящие ответы сервисов. Без чтения тела в панели оставалось бы «HTTP 400»,
  // и чужой ключ выглядел бы как поломка расширения.
  console.log("\n=== 13. Причина отказа берётся из ответа сервиса ===");
  {
    const pbBadKey = "[ERROR 400] Invalid or missing API key (https://pixabay.com/api/docs/).";

    resetImageCache();
    routes = [{ match: (u) => u.indexOf(PIXABAY_API) === 0, reply: () => jsonRes(pbBadKey, 400) }];
    let msg = "";
    try {
      await findImages("Subaru", { imgSource: "pixabay", pixabayKey: "чужой" });
    } catch (e) {
      msg = e.message;
    }
    check("Pixabay: причина из тела видна", msg.indexOf("Invalid or missing API key") > 0, msg);
    check("Pixabay: код ответа тоже назван", msg.indexOf("400") > 0, msg);

    resetImageCache();
    routes = [{ match: (u) => u.indexOf(OPENVERSE_API) === 0, reply: () => jsonRes({ detail: "Invalid token." }, 401) }];
    msg = "";
    try {
      await findImages("Subaru", { imgSource: "openverse" });
    } catch (e) {
      msg = e.message;
    }
    check("Openverse: причина из тела видна", msg.indexOf("Invalid token") > 0, msg);

    // Лимит — не «просто ошибка»: причина говорит про лимит, а не про ключ.
    // 429 повторяется (tries: 2), поэтому проверка занимает паузу между попытками.
    resetImageCache();
    routes = [{ match: (u) => u.indexOf(PIXABAY_API) === 0, reply: () => jsonRes("API rate limit exceeded", 429) }];
    msg = "";
    try {
      await findImages("Subaru", { imgSource: "pixabay", pixabayKey: "K" });
    } catch (e) {
      msg = e.message;
    }
    check("превышение лимита названо лимитом, а не кодом", msg.indexOf("API rate limit exceeded") > 0, msg);

    // Кнопка «Проверить ключ» говорит то же самое — иначе непонятно, что чинить.
    routes = [{ match: (u) => u.indexOf(PIXABAY_API) === 0, reply: () => jsonRes(pbBadKey, 400) }];
    msg = "";
    try {
      await checkImageKey({ imgSource: "pixabay", pixabayKey: "чужой" });
    } catch (e) {
      msg = e.message;
    }
    check("проверка ключа Pixabay: причина видна", msg.indexOf("Invalid or missing API key") > 0, msg);

    routes = [{ match: (u) => u.indexOf(OPENVERSE_API) === 0, reply: () => jsonRes({ detail: "Invalid token." }, 401) }];
    msg = "";
    try {
      await checkImageKey({ imgSource: "openverse" });
    } catch (e) {
      msg = e.message;
    }
    check("проверка Openverse: причина видна", msg.indexOf("Invalid token") > 0, msg);
  }

  // ------------------------------------------------------------- итог
  const fails = results.filter((r) => !r.ok);
  console.log("\nвсего проверок: %d, провалов: %d", results.length, fails.length);
  if (fails.length) {
    console.log("\nпровалы:");
    fails.forEach((f) => console.log("  · %s%s", f.name, f.detail ? "  — " + f.detail : ""));
  }
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error("набор упал:", e);
  process.exit(1);
});
