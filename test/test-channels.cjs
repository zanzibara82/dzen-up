/**
 * Юнит-тест карты канала Дзена (background.js) без сети и без Chrome.
 *
 * У канала нет sitemap.xml, поэтому карта статей собирается обходом открытой
 * ленты платформы. Здесь проверяем ровно те места, где легко ошибиться молча:
 * разбор адреса канала, выбор статей из выдачи, постраничный обход, кэш и —
 * главное — подбор статьи по ЗАГОЛОВКУ (адрес статьи на Дзене нечитаемый).
 *
 * background.js — не модуль, поэтому грузим его как тело функции с подставным chrome.
 */
const fs = require("fs");
const path = require("path");
const PATHS = require("./paths.cjs");

const SRC = path.join(PATHS.REPO, "src", "extension-src", "background.js");

// ------------------------------------------------------------- подставной chrome
const localStore = {};
let permAllowed = true;
let permOrigins = null;
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
  permissions: {
    contains: async (p) => {
      permOrigins = (p && p.origins) || null;
      return permAllowed;
    },
    request: async () => true
  },
  runtime: {
    // Держим настоящий обработчик сообщений фона: ответ на сообщение — это
    // отдельный контракт, и именно на нём легко разъехаться с попапом.
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
    "\nreturn { DEFAULTS, channelName, channelUrl, parseChannelList, channelPageArticles, " +
    "loadChannel, channelArticles, refreshChannels, pickArticle, findModels, buildLinks, " +
    "escapeXml, xmlComment, channelSitemap, sitemapFileName, exportChannelMaps };"
)(chrome);

const {
  DEFAULTS,
  channelName,
  channelUrl,
  parseChannelList,
  channelPageArticles,
  loadChannel,
  channelArticles,
  refreshChannels,
  pickArticle,
  buildLinks,
  escapeXml,
  xmlComment,
  channelSitemap,
  sitemapFileName,
  exportChannelMaps
} = api;

// ------------------------------------------------------------- подставной fetch
// Ответы keyed by URL. fetchJson просит у ответа status, ok, headers.get, json().
let routes = {};
const fetched = [];

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function installFetch() {
  globalThis.fetch = async (url) => {
    fetched.push(url);
    const r = routes[url];
    if (!r) return jsonRes({}, 404);
    if (r.throw) throw new Error(r.throw);
    if (r.status && r.status !== 200) return jsonRes(r.body || {}, r.status);
    return jsonRes(r.body);
  };
}

// ------------------------------------------------------------- карточки выдачи
/** Карточка статьи, как её отдаёт платформа. publisher — id автора, если нужен. */
function card(url, title, publisher) {
  return {
    type: "card",
    share_link: url,
    link: url + "?feed_exp=ordinary_feed&from=channel&rid=123",
    title,
    publisher_id: publisher
  };
}
/** Подборка — не статья, ссылаться на неё нельзя. */
function suite() {
  return { type: "suites_carousel", title: "Подборки автора", link: "https://dzen.ru/suite/1" };
}

const DZ = "https://dzen.ru/a/";
const EXPORT = "https://dzen.ru/api/v3/launcher/export?channel_name=auto-dom24.ru";
const MORE = "https://dzen.ru/api/v3/launcher/channel-more?channel_name=auto-dom24.ru&next_page_id=abc";

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

/**
 * Шлём сообщение в НАСТОЯЩИЙ обработчик фона и ждём ответ — как это делает Chrome.
 * Раньше проверок на это не было, и в ответ уехало `{ files: { files: [...] } }`:
 * функция возвращала объект, а обработчик складывал его в переменную `files`.
 */
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

  // ---- 1. адрес канала ----------------------------------------------------
  eq("адрес: полный URL", channelName("https://dzen.ru/auto-dom24.ru"), "auto-dom24.ru");
  eq("адрес: хвостовой слэш убран", channelName("https://dzen.ru/auto-dom24.ru/"), "auto-dom24.ru");
  eq("адрес: без схемы", channelName("dzen.ru/auto-dom24.ru"), "auto-dom24.ru");
  eq("адрес: только имя", channelName("auto-dom24.ru"), "auto-dom24.ru");
  eq("адрес: канал по id", channelName("https://dzen.ru/id/6a80211e5150b44d74a55d27"), "id/6a80211e5150b44d74a55d27");
  eq("адрес: параметры отброшены", channelName("https://dzen.ru/auto-dom24.ru?from=feed"), "auto-dom24.ru");
  eq("адрес: пустая строка", channelName("   "), "");
  eq("адрес: null не роняет", channelName(null), "");
  eq("адрес ссылки на канал", channelUrl("auto-dom24.ru"), "https://dzen.ru/auto-dom24.ru");

  // ---- 2. список каналов --------------------------------------------------
  eq(
    "список: комментарии и пустые строки игнорируются",
    parseChannelList("# мои каналы\n\nhttps://dzen.ru/auto-dom24.ru\n   \n#второй\nhttps://dzen.ru/id/123"),
    ["auto-dom24.ru", "id/123"]
  );
  eq("список: дубликаты схлопываются", parseChannelList("auto-dom24.ru\nhttps://dzen.ru/auto-dom24.ru"), [
    "auto-dom24.ru"
  ]);
  eq("список: пустое значение — пустой список", parseChannelList(""), []);
  eq("список: null не роняет", parseChannelList(null), []);

  // ---- 3. выбор статей из выдачи -----------------------------------------
  const page = {
    items: [
      card(DZ + "aaa", "Грузовик Renault Trucks T High на маршруте"),
      suite(),
      { type: "channel_long_video_floor", title: "Видео" },
      card(DZ + "bbb", "Volvo XC40 подешевел"),
      { type: "card", title: "Без адреса" }
    ]
  };
  eq(
    "выдача: берём только карточки статей с адресом",
    channelPageArticles(page).map((a) => a.url),
    [DZ + "aaa", DZ + "bbb"]
  );
  eq("выдача: заголовок сохраняется", channelPageArticles(page)[1].title, "Volvo XC40 подешевел");
  eq("выдача: пустой ответ — пустой список", channelPageArticles(null), []);
  eq(
    "выдача: адрес без share_link берётся из link без параметров",
    channelPageArticles({ items: [{ type: "card", link: DZ + "ccc?rid=9", title: "T" }] })[0].url,
    DZ + "ccc"
  );

  // ---- 3б. чужие статьи из рекомендаций -----------------------------------
  // Лента канала может подмешать материалы других авторов — ссылаться на них
  // нам нечем. Отбрасываем только достоверно чужие: без автора карточку оставляем,
  // иначе смена схемы API обнулила бы карту.
  const mixedPage = {
    items: [
      { type: "card", share_link: DZ + "own", title: "Своя", publisher_id: "111" },
      { type: "card", share_link: DZ + "alien", title: "Чужая", publisher_id: "222" },
      { type: "card", share_link: DZ + "nopub", title: "Без автора" }
    ]
  };
  eq(
    "выдача: чужая карточка отброшена, своя и без автора остались",
    channelPageArticles(mixedPage, "111").map((a) => a.url),
    [DZ + "own", DZ + "nopub"]
  );
  eq(
    "выдача: без своего publisher_id фильтр не включается",
    channelPageArticles(mixedPage, "").length,
    3
  );
  eq(
    "выдача: без аргумента автора фильтр не включается",
    channelPageArticles(mixedPage).length,
    3
  );

  // ---- 4. постраничный обход ---------------------------------------------
  routes = {
    [EXPORT]: { body: { items: [card(DZ + "aaa", "Первая статья")], more: { link: MORE } } },
    [MORE]: { body: { items: [card(DZ + "bbb", "Вторая статья")], more: {} } }
  };
  fetched.length = 0;
  const walked = await loadChannel("auto-dom24.ru");
  eq("обход: собрал статьи со всех страниц", walked.map((a) => a.url), [DZ + "aaa", DZ + "bbb"]);
  eq("обход: сходил ровно на две страницы", fetched.length, 2);

  // Дубликаты между страницами не задваивают карту.
  routes = {
    [EXPORT]: { body: { items: [card(DZ + "aaa", "Первая"), card(DZ + "aaa", "Первая снова")], more: { link: MORE } } },
    [MORE]: { body: { items: [card(DZ + "aaa", "Первая")], more: {} } }
  };
  eq("обход: повтор адреса не задваивает статью", (await loadChannel("auto-dom24.ru")).length, 1);

  // Первая страница не открылась — обход прекращается, а не падает.
  routes = { [EXPORT]: { status: 500 } };
  eq("обход: недоступная выдача не роняет обход", await loadChannel("auto-dom24.ru"), []);

  // Платформа не дала ссылку на следующую страницу — останавливаемся.
  routes = { [EXPORT]: { body: { items: [card(DZ + "aaa", "Одна")] } } };
  eq("обход: без ссылки на следующую страницу — одна страница", (await loadChannel("auto-dom24.ru")).length, 1);

  // Свой publisher_id узнаём с первой страницы и фильтруем по нему дальше.
  routes = {
    [EXPORT]: {
      body: {
        channel: { source: { publisher_id: "111" } },
        items: [card(DZ + "aaa", "Своя", "111"), card(DZ + "alien", "Чужая", "222")],
        more: { link: MORE }
      }
    },
    [MORE]: { body: { items: [card(DZ + "bbb", "Тоже чужая", "333")], more: {} } }
  };
  eq(
    "обход: чужой автор отсеян на обеих страницах",
    (await loadChannel("auto-dom24.ru")).map((a) => a.url),
    [DZ + "aaa"]
  );

  // ---- 5. кэш карты -------------------------------------------------------
  for (const k of Object.keys(localStore)) delete localStore[k];
  routes = {
    [EXPORT]: { body: { items: [card(DZ + "aaa", "Из сети")], more: {} } }
  };
  fetched.length = 0;
  const first = await channelArticles("auto-dom24.ru");
  eq("кэш: первый обход берёт статьи из сети", first.length, 1);
  eq("кэш: в сеть сходили один раз", fetched.length, 1);
  routes = {};
  const second = await channelArticles("auto-dom24.ru");
  eq("кэш: повторный вызов берёт из кэша", second.length, 1);
  eq("кэш: в сеть больше не ходили", fetched.length, 1);

  // refresh=true обязан обойти заново, даже если кэш свежий.
  routes = { [EXPORT]: { body: { items: [card(DZ + "aaa", "Из сети"), card(DZ + "bbb", "Новая")], more: {} } } };
  const forced = await channelArticles("auto-dom24.ru", null, true);
  eq("кэш: refresh обходит заново", forced.length, 2);

  // Неудачный обход не затирает прежнюю карту.
  routes = { [EXPORT]: { status: 500 } };
  const broken = await channelArticles("auto-dom24.ru", null, true);
  eq("кэш: неудачный обход вернул пусто", broken.length, 0);
  routes = {};
  const kept = await channelArticles("auto-dom24.ru");
  eq("кэш: прежняя карта уцелела", kept.length, 2);

  // ---- 6. подбор статьи по заголовку --------------------------------------
  // Адрес статьи на Дзене — /a/<случайный id>: по нему модель не найти,
  // искать приходится по заголовку. Это и есть причина хранить заголовки.
  const pool = [
    { url: DZ + "zzz111", title: "Грузовик Renault Trucks T High — надёжный партнёр" },
    { url: DZ + "zzz222", title: "Volvo XC40 подешевел на фоне скидок" }
  ];
  const model = { anchor: "Renault Trucks", tokens: ["renault", "trucks"], core: ["renault"] };
  eq("подбор: статья найдена по заголовку", pickArticle(pool, model.tokens, model.core, () => 0), DZ + "zzz111");
  eq(
    "подбор: чужой модели нет — null",
    pickArticle(pool, ["scania"], ["scania"], () => 0),
    null
  );
  // Строки (sitemap сайта) ищутся по адресу, как и раньше.
  eq(
    "подбор: строки ищутся по слагу адреса",
    pickArticle(["https://site.ru/volvo-xc40-obzor/"], ["volvo", "xc40"], ["volvo"], () => 0),
    "https://site.ru/volvo-xc40-obzor/"
  );

  // ---- 7. сборка ссылок с каналом ----------------------------------------
  for (const k of Object.keys(localStore)) delete localStore[k];
  routes = {
    [EXPORT]: {
      body: {
        items: [
          card(DZ + "aaa", "Renault Trucks T High на маршруте"),
          card(DZ + "bbb", "Volvo XC40 подешевел на фоне скидок")
        ],
        more: {}
      }
    }
  };
  const text = "Новый Renault Trucks T High и обновлённый Volvo XC40.";
  permAllowed = true;
  permOrigins = null;
  const res = await buildLinks(text, { ...DEFAULTS, linkSites: "", linkChannels: "https://dzen.ru/auto-dom24.ru" }, { rand: () => 0 });
  eq("сборка: без сайтов, но с каналом ссылки ставятся", res.links.length, 2);
  eq("сборка: первая ссылка ведёт на статью канала", res.links[0].url, DZ + "aaa");
  eq("сборка: вид ссылки — статья", res.links[0].kind, "article");
  // Анкор — живое упоминание из текста, а не выдуманная подпись. Слова модели
  // берёт findModels, и «Trucks» для него стоп-слово, поэтому анкор — «Renault».
  check(
    "сборка: анкоры — живые упоминания из текста",
    res.links.every((l) => text.indexOf(l.anchor) !== -1),
    JSON.stringify(res.links.map((l) => l.anchor))
  );
  eq("сборка: вторая ссылка — под вторую модель", res.links[1].anchor, "Volvo XC40");
  eq("сборка: вторая ссылка ведёт на свою статью", res.links[1].url, DZ + "bbb");
  // Заголовок тащим в результат: в отчёте по адресу /a/<id> ничего не понять.
  eq("сборка: заголовок статьи доехал до отчёта", res.links[0].title, "Renault Trucks T High на маршруте");

  // ---- 7б. сайт и канал вместе -------------------------------------------
  // Источники чередуются, и модель ищется по своему признаку: на сайте — по
  // слагу адреса, в канале — по заголовку. Заголовок есть только у канала.
  for (const k of Object.keys(localStore)) delete localStore[k];
  routes = {
    "https://site.ru/sitemap.xml": {
      body:
        '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        "<url><loc>https://site.ru/volvo-xc40-obzor/</loc></url></urlset>"
    },
    [EXPORT]: { body: { items: [card(DZ + "aaa", "Renault Trucks T High на маршруте")], more: {} } }
  };
  const mixed = await buildLinks(text, { ...DEFAULTS, linkSites: "https://site.ru", linkChannels: "auto-dom24.ru" }, { rand: () => 0 });
  eq("смешанный: обе ссылки поставлены", mixed.links.length, 2);
  eq("смешанный: сайт и канал посчитаны", [mixed.stats.sites, mixed.stats.channels], [1, 1]);
  eq("смешанный: модель канала нашлась по заголовку", mixed.links[0].url, DZ + "aaa");
  eq("смешанный: модель сайта нашлась по слагу", mixed.links[1].url, "https://site.ru/volvo-xc40-obzor/");
  eq("смешанный: у ссылки на сайт заголовка нет", mixed.links[1].title, "");
  eq("сборка: в отчёте видно число каналов", res.stats.channels, 1);
  check(
    "сборка: у ссылки указан источник-канал",
    res.links[0].site === "https://dzen.ru/auto-dom24.ru",
    String(res.links[0].site)
  );
  check(
    "сборка: доступ спрашивают и к dzen.ru",
    Array.isArray(permOrigins) && permOrigins.indexOf("https://dzen.ru/*") !== -1,
    JSON.stringify(permOrigins)
  );

  // Обход не удался — канал всё равно цель: ведём на сам канал, как и с сайтом без карты.
  for (const k of Object.keys(localStore)) delete localStore[k];
  routes = { [EXPORT]: { status: 500 } };
  const fallback = await buildLinks(text, { ...DEFAULTS, linkSites: "", linkChannels: "auto-dom24.ru" }, { rand: () => 0 });
  eq("сборка: без карты ссылка ведёт на сам канал", fallback.links[0].url, "https://dzen.ru/auto-dom24.ru");
  eq("сборка: вид ссылки — канал", fallback.links[0].kind, "site");
  eq("сборка: в отчёте названы необойдённые каналы", fallback.stats.noChannel, ["auto-dom24.ru"]);

  // Ничего не указано — работаем как раньше, без единого запроса.
  for (const k of Object.keys(localStore)) delete localStore[k];
  routes = {};
  fetched.length = 0;
  const empty = await buildLinks(text, { ...DEFAULTS, linkSites: "", linkChannels: "" }, {});
  eq("сборка: без сайтов и каналов ссылок нет", empty.links.length, 0);
  eq("сборка: без сайтов и каналов в сеть не ходим", fetched.length, 0);

  // Моделей в тексте нет — канал даже не обходим.
  routes = { [EXPORT]: { body: { items: [card(DZ + "aaa", "Renault Trucks")], more: {} } } };
  fetched.length = 0;
  const noModels = await buildLinks("Просто текст без марок.", { ...DEFAULTS, linkSites: "", linkChannels: "auto-dom24.ru" }, {});
  eq("сборка: без моделей ссылок нет", noModels.links.length, 0);
  eq("сборка: без моделей канал не обходим", fetched.length, 0);

  // ---- 8. переобход по кнопке --------------------------------------------
  for (const k of Object.keys(localStore)) delete localStore[k];
  routes = {
    [EXPORT]: { body: { items: [card(DZ + "aaa", "A"), card(DZ + "bbb", "B")], more: {} } }
  };
  const refreshed = await refreshChannels({ linkChannels: "auto-dom24.ru\nhttps://dzen.ru/id/999" });
  eq("переобход: отчёт по каждому каналу", refreshed, [
    { name: "auto-dom24.ru", count: 2 },
    { name: "id/999", count: 0 }
  ]);

  // ---- 9. экранирование XML ----------------------------------------------
  // Заголовки и адреса приходят из сети. Один неэкранированный «&» или «<»
  // делает файл неразбираемым — и молча: внешний инструмент просто скажет
  // «некорректный sitemap».
  eq("XML: амперсанд", escapeXml("a & b"), "a &amp; b");
  eq("XML: угловые скобки", escapeXml("<loc>"), "&lt;loc&gt;");
  eq("XML: двойные кавычки", escapeXml('он сказал "да"'), "он сказал &quot;да&quot;");
  eq("XML: апостроф", escapeXml("it's"), "it&apos;s");
  eq("XML: амперсанд не экранируется дважды", escapeXml("a&amp;b"), "a&amp;amp;b");
  eq("XML: null не роняет", escapeXml(null), "");

  // Внутри комментария «--» и хвостовое «-» закрывают его раньше времени.
  eq("комментарий: двойной дефис схлопнут", xmlComment("a--b"), "a-b");
  eq("комментарий: длинная черта схлопнута", xmlComment("a----b"), "a-b");
  eq("комментарий: хвостовой дефис разведён", xmlComment("a-"), "a- ");
  eq("комментарий: перевод строки схлопнут", xmlComment("a\n   b"), "a b");
  eq("комментарий: пустой заголовок", xmlComment("   "), "");

  // ---- 10. выгрузка карты файлом -----------------------------------------
  // Карта канала живёт внутри расширения; файл нужен, когда её отдают наружу.
  // Проверяем форму sitemap.xml и то, что «грязный» заголовок его не ломает.
  for (const k of Object.keys(localStore)) delete localStore[k];
  const messy = DZ + "ddd?a=1&b=2";
  routes = {
    [EXPORT]: {
      body: {
        items: [
          card(DZ + "aaa", "Грузовик Renault Trucks T High"),
          card(messy, 'Volvo "XC40" & Co <тест>'),
          card(DZ + "ccc", "Заголовок с -- двойным дефисом -")
        ],
        more: {}
      }
    }
  };
  const dump = await exportChannelMaps({ linkChannels: "auto-dom24.ru" });
  eq("выгрузка: файл на каждый канал", dump.files.length, 1);
  eq("выгрузка: имя файла по каналу", dump.files[0].filename, "sitemap-auto-dom24.ru.xml");
  eq("выгрузка: число статей в отчёте", dump.files[0].count, 3);
  const xml = dump.files[0].xml;
  check(
    "выгрузка: это urlset по схеме sitemap",
    /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(xml),
    xml.slice(0, 72)
  );
  check("выгрузка: адрес статьи внутри loc", xml.indexOf("<loc>" + DZ + "aaa</loc>") !== -1);
  eq("выгрузка: записей ровно по числу статей", (xml.match(/<url>/g) || []).length, 3);
  check(
    "выгрузка: амперсанд в адресе экранирован",
    xml.indexOf("<loc>" + DZ + "ddd?a=1&amp;b=2</loc>") !== -1
  );
  check(
    "выгрузка: заголовок сохранён комментарием",
    xml.indexOf("<!-- Грузовик Renault Trucks T High -->") !== -1
  );
  // Внутри комментария экранировать НЕЛЬЗЯ: «&amp;» читался бы как текст «&amp;».
  // Комментарий — это сырые символы, недопустим там только «--».
  check(
    "выгрузка: в комментарии заголовок не экранируется",
    xml.indexOf('<!-- Volvo "XC40" & Co <тест> -->') !== -1
  );
  check(
    "выгрузка: грязный заголовок не рвёт комментарий",
    xml.indexOf("<!-- Заголовок с - двойным дефисом - -->") !== -1
  );
  // Общая страховка на весь файл: какой бы заголовок ни пришёл, ни один
  // комментарий не должен содержать «--» или кончаться на «-».
  const comments = xml.match(/<!--[\s\S]*?-->/g) || [];
  check(
    "выгрузка: ни один комментарий не сломан",
    comments.length === 3 &&
      comments.every((c) => {
        const body = c.slice(4, -3);
        return body.indexOf("--") === -1 && !/-$/.test(body);
      }),
    JSON.stringify(comments)
  );
  check(
    "выгрузка: комментарии не попали внутрь loc",
    /<loc>[^<]*<!--/.test(xml) === false
  );

  // Пустой канал: файл всё равно валиден, просто без записей.
  for (const k of Object.keys(localStore)) delete localStore[k];
  routes = { [EXPORT]: { body: { items: [], more: {} } } };
  const blank = await exportChannelMaps({ linkChannels: "id/999" });
  eq("выгрузка: пустой канал даёт пустой файл", blank.files[0].count, 0);
  check(
    "выгрузка: пустой urlset без записей",
    blank.files[0].xml.indexOf("<url>") === -1 &&
      blank.files[0].xml.indexOf("</urlset>") !== -1
  );
  eq("выгрузка: имя файла для канала по id", blank.files[0].filename, "sitemap-id-999.xml");

  // Несколько каналов — по файлу на каждый.
  for (const k of Object.keys(localStore)) delete localStore[k];
  routes = {
    [EXPORT]: { body: { items: [card(DZ + "aaa", "A")], more: {} } },
    ["https://dzen.ru/api/v3/launcher/export?channel_name=id%2F999"]: {
      body: { items: [card(DZ + "bbb", "B"), card(DZ + "ccc", "C")], more: {} }
    }
  };
  const two = await exportChannelMaps({ linkChannels: "auto-dom24.ru\nhttps://dzen.ru/id/999" });
  eq("выгрузка: два канала — два файла", two.files.map((f) => f.filename), [
    "sitemap-auto-dom24.ru.xml",
    "sitemap-id-999.xml"
  ]);
  eq("выгрузка: счёт по каждому каналу", two.files.map((f) => f.count), [1, 2]);
  check(
    "выгрузка: во втором файле статьи второго канала",
    two.files[1].xml.indexOf(DZ + "bbb") !== -1 && two.files[1].xml.indexOf(DZ + "aaa") === -1
  );

  // Выгрузка не ходит в сеть заново: карта уже собрана предыдущими вызовами.
  fetched.length = 0;
  const again = await exportChannelMaps({ linkChannels: "auto-dom24.ru" });
  eq("выгрузка: берёт готовую карту из кэша", fetched.length, 0);
  eq("выгрузка: карта из кэша не пустая", again.files[0].count, 1);

  // Без каналов — ошибка, а не пустой файл «на всякий случай».
  let noChannels = null;
  try {
    await exportChannelMaps({ linkChannels: "# только комментарий" });
  } catch (e) {
    noChannels = e;
  }
  check(
    "выгрузка: без каналов понятная ошибка",
    !!(noChannels && /не указаны/i.test(noChannels.message)),
    noChannels && noChannels.message
  );

  eq("имя файла: точка в имени канала остаётся", sitemapFileName("auto-dom24.ru"), "sitemap-auto-dom24.ru.xml");
  eq("имя файла: слэш заменён", sitemapFileName("id/6a80211e"), "sitemap-id-6a80211e.xml");
  eq("имя файла: пустое имя не роняет", sitemapFileName(""), "sitemap-channel.xml");

  // ---- 11. доступ --------------------------------------------------------
  permAllowed = false;
  for (const k of Object.keys(localStore)) delete localStore[k];
  let denied = null;
  try {
    await buildLinks(text, { ...DEFAULTS, linkSites: "", linkChannels: "auto-dom24.ru" }, {});
  } catch (e) {
    denied = e;
  }
  check("доступ: без разрешения поднимаем понятную ошибку", !!(denied && denied.needPermission), denied && denied.message);

  // Выгрузка спрашивает тот же доступ и падает так же понятно.
  let exportDenied = null;
  try {
    await exportChannelMaps({ linkChannels: "auto-dom24.ru" });
  } catch (e) {
    exportDenied = e;
  }
  check(
    "доступ: выгрузка без разрешения падает понятно",
    !!(exportDenied && exportDenied.needPermission),
    exportDenied && exportDenied.message
  );
  permAllowed = true;

  // ---- 12. контракт ответа на сообщение ----------------------------------
  // Здесь и пряталась ошибка, которую не увидели ни юнит-тест функции, ни тест
  // попапа: `exportChannelMaps` возвращает `{ files }`, а обработчик складывал
  // это в переменную `files` — и в попап уезжало `{ files: { files: [...] } }`.
  // Попап падал на `files.forEach is not a function`, статус замирал на
  // «Готовлю карту…», файл не скачивался. Функцию тестировали в отрыве от
  // обёртки, а попап — на подменённом ответе. Проверяем стык.
  for (const k of Object.keys(localStore)) delete localStore[k];
  routes = { [EXPORT]: { body: { items: [card(DZ + "aaa", "Renault Trucks T High")], more: {} } } };
  const reply = await sendMessage({
    type: "exportChannelMap",
    overrides: { linkChannels: "auto-dom24.ru" }
  });
  check("сообщение: ответ ok", reply.ok === true, JSON.stringify(reply).slice(0, 120));
  check(
    "сообщение: files — массив, а не вложенный объект",
    Array.isArray(reply.files),
    JSON.stringify(reply.files && Object.keys(reply.files))
  );
  eq("сообщение: в массиве один файл", Array.isArray(reply.files) ? reply.files.length : -1, 1);
  check(
    "сообщение: у файла есть имя, xml и число статей",
    !!(
      reply.files &&
      reply.files[0] &&
      reply.files[0].filename === "sitemap-auto-dom24.ru.xml" &&
      /^<\?xml/.test(reply.files[0].xml) &&
      reply.files[0].count === 1
    ),
    JSON.stringify(reply.files && reply.files[0] && { f: reply.files[0].filename, c: reply.files[0].count })
  );

  // Переобход отдаёт `channels` — попап читает именно это поле.
  routes = { [EXPORT]: { body: { items: [card(DZ + "aaa", "A")], more: {} } } };
  const reply2 = await sendMessage({
    type: "refreshChannels",
    overrides: { linkChannels: "auto-dom24.ru" }
  });
  check(
    "сообщение: переобход отдаёт channels массивом",
    reply2.ok === true && Array.isArray(reply2.channels) && reply2.channels[0].count === 1,
    JSON.stringify(reply2).slice(0, 140)
  );

  // Ошибка тоже должна приходить разбираемой, а не «ok: true» с пустотой.
  const reply3 = await sendMessage({
    type: "exportChannelMap",
    overrides: { linkChannels: "# только комментарий" }
  });
  check(
    "сообщение: ошибка приходит как ok:false с текстом",
    reply3.ok === false && /не указаны/i.test(String(reply3.error)),
    JSON.stringify(reply3).slice(0, 140)
  );

  console.log("\n=== ИТОГ ===");
  const bad = results.filter((r) => !r.ok);
  console.log("всего проверок: %d, провалов: %d", results.length, bad.length);
  bad.forEach((b) => console.log("  FAIL: %s (%s)", b.name, b.detail));
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => {
  console.error("ОШИБКА ТЕСТА:", e && e.stack ? e.stack : e);
  process.exit(1);
});
