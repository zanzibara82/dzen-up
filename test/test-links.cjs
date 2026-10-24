/**
 * Юнит-тест перелинковки (background.js) без сети и без Chrome.
 *
 * Проверяем ровно то, что легко сломать незаметно: разбор списка сайтов,
 * поиск моделей в тексте, чтение sitemap (в том числе вложенного) и подбор
 * статьи по слагу. Раскладка ссылок по абзацам живёт в content.js и проверяется
 * отдельно — там нужен настоящий DOM.
 *
 * background.js — не модуль, поэтому грузим его как тело функции с подставным chrome.
 */
const fs = require("fs");
const path = require("path");
const PATHS = require("./paths.cjs");

const SRC = path.join(PATHS.REPO, "src", "extension-src", "background.js");

// ------------------------------------------------------------- подставной chrome
const localStore = {};
let permAllowed = true; // что отвечает chrome.permissions.contains

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
    contains: async () => permAllowed,
    request: async () => true
  },
  runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
  contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  tabs: { sendMessage: async () => {}, query: async () => [] }
};

const SRC_TEXT = fs.readFileSync(SRC, "utf8");

const api = new Function(
  "chrome",
  SRC_TEXT +
    "\nreturn { DEFAULTS, findModels, slugTokens, parseSiteList, parseSitemap, isSitemapIndex, sitemapCandidates, pickArticle, buildLinks, loadSitemap };"
)(chrome);

const {
  DEFAULTS,
  findModels,
  slugTokens,
  parseSiteList,
  parseSitemap,
  isSitemapIndex,
  sitemapCandidates,
  pickArticle,
  buildLinks
} = api;

// ------------------------------------------------------------- подставной fetch
let routes = {}; // url → { ok, status, body } | { throw: "..." }
const fetched = [];

function installFetch() {
  globalThis.fetch = async (url) => {
    fetched.push(url);
    const r = routes[url];
    if (!r) return { ok: false, status: 404, text: async () => "" };
    if (r.throw) throw new Error(r.throw);
    return { ok: r.status === undefined || r.status === 200, status: r.status || 200, text: async () => r.body };
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

function sm(urls) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.map((u) => "<url><loc>" + u + "</loc></url>").join("") +
    "</urlset>"
  );
}
function smIndex(locs) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    locs.map((u) => "<sitemap><loc>" + u + "</loc></sitemap>").join("") +
    "</sitemapindex>"
  );
}

// ------------------------------------------------------------- сценарии
async function main() {
  installFetch();

  // ---- 1. список сайтов ---------------------------------------------------
  eq("список: строка без схемы получает https", parseSiteList("auto-dom24.ru"), ["https://auto-dom24.ru"]);
  eq("список: хвостовой слэш убирается", parseSiteList("https://auto-dom24.ru/"), ["https://auto-dom24.ru"]);
  eq(
    "список: комментарии и пустые строки игнорируются",
    parseSiteList("# мои сайты\n\nauto-dom24.ru\n   \n#второй\nhttps://example.com"),
    ["https://auto-dom24.ru", "https://example.com"]
  );
  eq("список: дубликаты схлопываются", parseSiteList("a.ru\nhttps://a.ru\nA.ru"), [
    "https://a.ru",
    "https://A.ru"
  ]);
  eq("список: пустое значение — пустой список", parseSiteList(""), []);
  eq("список: null не роняет", parseSiteList(null), []);

  // Строка списка становится шаблоном права, а на негодном шаблоне
  // chrome.permissions.contains не отвечает false, а падает — «Invalid value for
  // origin pattern … Invalid port». Поэтому неадреса отсеиваются здесь, а не
  // ловятся исключением при запросе доступа: в поле попадает что угодно.
  eq("список: неадрес отсеян", parseSiteList("Photo: Subaru of America, Inc.\nauto-dom24.ru"), [
    "https://auto-dom24.ru"
  ]);
  eq("список: адрес с числовым портом сохраняется", parseSiteList("localhost:8787\nexample.com"), [
    "https://localhost:8787",
    "https://example.com"
  ]);
  eq("список: нечисловой порт отсеян (шаблон права на нём падает)",
    parseSiteList("example.com:порт\nexample.com"), ["https://example.com"]);
  eq("список: путь в адресе сохраняется", parseSiteList("auto-dom24.ru/blog"), [
    "https://auto-dom24.ru/blog"
  ]);

  // ---- 2. поиск моделей ---------------------------------------------------
  eq(
    "модели: марка + модель",
    findModels("Обзор Volvo XC40 на дороге").map((m) => m.anchor),
    ["Volvo XC40"]
  );
  eq(
    "модели: точка из конца предложения не попадает в анкор",
    findModels("Мы купили Volkswagen.").map((m) => m.anchor),
    ["Volkswagen"]
  );
  eq(
    "модели: служебное слово не приклеивается к анкору",
    findModels("Volvo в России дорожает").map((m) => m.anchor),
    ["Volvo"]
  );
  eq(
    "модели: длинная марка выигрывает у короткой",
    findModels("Land Rover Discovery поехал").map((m) => m.anchor),
    ["Land Rover Discovery"]
  );
  eq("модели: неизвестная марка не считается", findModels("Zzzz Qwerty поехал"), []);
  eq(
    "модели: часть марки не становится второй моделью",
    findModels("Range Rover Sport поехал").map((m) => m.anchor),
    ["Range Rover Sport"]
  );
  eq(
    "модели: две марки подряд — две модели, а не одна склейка",
    findModels("Volvo Toyota Camry").map((m) => m.anchor),
    ["Volvo", "Toyota Camry"]
  );
  eq("модели: год не часть названия", findModels("Toyota 2024 года").map((m) => m.anchor), ["Toyota"]);
  eq("модели: кириллица тоже ловится", findModels("Обзор Лада Веста").map((m) => m.anchor), ["Лада Веста"]);
  eq(
    "модели: повтор не дублируется",
    findModels("Volvo XC40 и снова Volvo XC40").map((m) => m.anchor),
    ["Volvo XC40"]
  );
  eq("модели: пустой текст — пусто", findModels(""), []);

  // tokens/core — на них опирается подбор статьи
  const v = findModels("Mercedes-AMG CLE 646")[0];
  eq("модели: tokens по всем словам", v.tokens, ["mercedes", "amg", "cle", "646"]);
  eq("модели: core — марка плюс первое слово модели", v.core, ["mercedes", "amg", "cle"]);

  const aliases = [
    ["тест-драйв Кайенна", "Кайенна", ["cayenne"]],
    ["расход Гранты", "Гранты", ["granta"]],
    ["обзор Соляриса", "Соляриса", ["solaris"]],
    ["покупка Октавии", "Октавии", ["octavia"]],
    ["цены на Поло", "Поло", ["polo"]],
    ["Тойоты Камри", "Тойоты Камри", ["toyota", "camry"]],
    ["Порше Кайенна", "Порше Кайенна", ["porsche", "cayenne"]],
    ["обзор Хёндэ Солярис", "Хёндэ Солярис", ["hyundai", "solaris"]],
    ["новая Лада веста", "Лада веста", ["lada", "vesta"]],
    ["Toyota RAV4", "Toyota RAV4", ["toyota", "rav4"]],
    ["Toyota RAV 4", "Toyota RAV 4", ["toyota", "rav4"]],
    ["Toyota rav-4", "Toyota rav-4", ["toyota", "rav4"]],
    ["RAV 4", "RAV 4", ["rav4"]],
    ["Land Cruiser", "Land Cruiser", ["land", "cruiser"]],
    ["Toyota\tLand  Cruiser", "Toyota\tLand  Cruiser", ["toyota", "land", "cruiser"]]
  ];
  for (const [text, anchor, tokens] of aliases) {
    eq("синонимы: " + text, findModels(text), [{ anchor, tokens, core: tokens }]);
  }
  eq("синонимы: варианты одной модели не дублируются",
    findModels("Кайенн и Cayenne, затем Кайенна").map((m) => m.anchor), ["Кайенн"]);
  eq("синонимы: часть слова не совпадает", findModels("Грантовый конкурс и полотно"), []);
  eq("синонимы: граница предложения не склеивается",
    findModels("Toyota. Camry подорожала").map((m) => m.anchor), ["Toyota", "Camry"]);
  eq("синонимы: пользователь переопределяет встроенный вариант",
    findModels("Кайенна", "polo = Кайенна"), [{ anchor: "Кайенна", tokens: ["polo"], core: ["polo"] }]);
  eq("синонимы: пользователь добавляет фразу",
    findModels("Обзор народного седана", "polo = народного седана"),
    [{ anchor: "народного седана", tokens: ["polo"], core: ["polo"] }]);
  eq("синонимы: канон из нескольких слов",
    findModels("Наш Крузак", "Land Cruiser = Крузак"),
    [{ anchor: "Крузак", tokens: ["land", "cruiser"], core: ["land", "cruiser"] }]);
  eq("синонимы: комментарии, пустые и некорректные строки не добавляют терминов",
    findModels("Жук и Слон", "# beetle = Жук\n\n = Слон\nСлон =\nbeetle = Жук = Слон"), []);
  eq("синонимы: переопределение не меняет встроенный словарь",
    findModels("Кайенна")[0]?.tokens, ["cayenne"]);
  eq("синонимы: добавление варианта марки не отбрасывает модель",
    findModels("Toyota Hilux", "Toyota = Тойотка").map((m) => m.anchor), ["Toyota Hilux"]);
  eq("синонимы: вариант марки также захватывает модель",
    findModels("Тойотка Hilux", "Toyota = Тойотка")[0]?.tokens, ["toyota", "hilux"]);
  eq("синонимы: короткая часть названия не теряется",
    findModels("C-HR", "Toyota C-HR = C-HR")[0]?.tokens, ["toyota", "c", "hr"]);
  eq("синонимы: укороченный вариант не появляется сам",
    findModels("HR", "Toyota C-HR = C-HR"), []);
  eq("синонимы: союз внутри пользовательской фразы сохраняется",
    findModels("народный и автомобиль", "polo = народный и автомобиль")[0]?.anchor, "народный и автомобиль");
  eq("синонимы: топливо не становится маркой", findModels("расход газа"), []);
  eq("синонимы: обычное написание X-Trail распознаётся",
    findModels("X-Trail")[0]?.tokens, ["x", "trail"]);
  eq("синонимы: переопределение канона действует на его варианты",
    findModels("Кайенна", "polo = cayenne")[0]?.tokens, ["polo"]);
  eq("синонимы: последнее правило выигрывает",
    findModels("Кайенна", "polo = Кайенна\ngranta = Кайенна")[0]?.tokens, ["granta"]);
  eq("синонимы: канон из знаков препинания не удаляет модель",
    findModels("Поло", "??? = polo")[0]?.tokens, ["polo"]);
  eq("синонимы: альтернативное написание остаётся для выбора места ссылки",
    findModels("Toyota Camry подорожала. Тойота Камри стала удобнее.")[0]?.alternatives, ["Тойота Камри"]);
  eq("синонимы: повторное переопределение канона действует на все варианты",
    findModels("Кайенна", "polo = cayenne\ngranta = cayenne")[0]?.tokens, ["granta"]);
  eq("синонимы: пользовательские варианты следуют повторному переопределению",
    findModels("Каен", "cayenne = Каен\npolo = cayenne\ngranta = cayenne")[0]?.tokens, ["granta"]);
  eq("синонимы: собственный канон можно переопределить повторно",
    findModels("Родстер", "roadster = Родстер\npolo = roadster\ngranta = roadster")[0]?.tokens, ["granta"]);
  eq("синонимы: правило на себя восстанавливает исходный канон",
    findModels("Кайенна", "polo = cayenne\ncayenne = cayenne")[0]?.tokens, ["cayenne"]);
  eq("синонимы: встречные правила не зацикливаются",
    findModels("Кайенна", "polo = cayenne\ncayenne = polo")[0]?.tokens, ["cayenne"]);

  // ---- 3. sitemap ---------------------------------------------------------
  eq(
    "sitemap: loc вытаскиваются",
    parseSitemap(sm(["https://a.ru/x", "https://a.ru/y"])),
    ["https://a.ru/x", "https://a.ru/y"]
  );
  eq("sitemap: &amp; разворачивается", parseSitemap(sm(["https://a.ru/?a=1&amp;b=2"])), [
    "https://a.ru/?a=1&b=2"
  ]);
  check("sitemap: index опознаётся", isSitemapIndex(smIndex(["https://a.ru/s.xml"])) === true);
  check("sitemap: urlset не считается index", isSitemapIndex(sm(["https://a.ru/x"])) === false);
  eq(
    "sitemap: адреса карт по умолчанию",
    sitemapCandidates("https://a.ru"),
    [
      "https://a.ru/sitemap.xml",
      "https://a.ru/wp-sitemap.xml",
      "https://a.ru/sitemap_index.xml",
      "https://a.ru/sitemap-index.xml"
    ]
  );
  eq("sitemap: явный .xml берётся как есть", sitemapCandidates("https://a.ru/my.xml"), [
    "https://a.ru/my.xml"
  ]);

  // ---- 4. подбор статьи ---------------------------------------------------
  const urls = [
    "https://a.ru/volvo-udivila-resheniem-po-xc40-novyj-krossover/",
    "https://a.ru/toyota-camry-obzor/",
    "https://a.ru/kia-sportage-i-ceny/"
  ];
  eq(
    "подбор: все слова модели найдены в слаге",
    pickArticle(urls, ["volvo", "xc40"], ["volvo"], () => 0),
    urls[0]
  );
  eq("подбор: нет совпадений — null", pickArticle(urls, ["bmw", "x5"], ["bmw"], () => 0), null);
  eq(
    "подбор: ни полное, ни запасное совпадение не нашлось — null",
    pickArticle(urls, ["mercedes", "cle", "646"], ["mercedes", "cle"], () => 0),
    null
  );
  eq(
    "подбор: core находит статью, когда лишнего слова модели в слаге нет",
    pickArticle(
      ["https://a.ru/kia-sportage-i-ceny/"],
      ["kia", "sportage", "2025"],
      ["kia", "sportage"],
      () => 0
    ),
    "https://a.ru/kia-sportage-i-ceny/"
  );
  eq("подбор: пустой список — null", pickArticle([], ["volvo"], ["volvo"]), null);
  eq(
    "подбор: односимвольный запрос не находит ничего",
    pickArticle(urls, ["a"], ["a"], () => 0.99),
    null
  );
  // два подходящих адреса — rand решает, какой взять
  const two = ["https://a.ru/toyota-camry-1/", "https://a.ru/toyota-camry-2/"];
  check("подбор: rand=0 берёт первый", pickArticle(two, ["toyota", "camry"], [], () => 0) === two[0]);
  check("подбор: rand≈1 берёт последний", pickArticle(two, ["toyota", "camry"], [], () => 0.99) === two[1]);

  eq("слова слага: знаки препинания не мешают", slugTokens("Volvo XC40!"), ["volvo", "xc40"]);
  eq("слова слага: однобуквенные выбрасываются", slugTokens("a b c"), []);
  for (const spelling of ["RAV4", "RAV 4", "rav-4"]) {
    eq("нормализация: " + spelling, slugTokens(spelling), ["rav4"]);
  }
  eq("нормализация: год не приклеивается к модели", slugTokens("Camry 2024"), ["camry", "2024"]);
  eq("подбор: кириллический вариант в слаге",
    pickArticle(["https://a.ru/test-kajenna/", "https://a.ru/обзор-кайенна/"], ["cayenne"], [], () => 0),
    "https://a.ru/обзор-кайенна/");
  eq("подбор: закодированный кириллический слаг",
    pickArticle(["https://a.ru/" + encodeURIComponent("обзор-кайенна")], ["cayenne"], [], () => 0),
    "https://a.ru/" + encodeURIComponent("обзор-кайенна"));
  eq("подбор: заголовок канала использует тот же словарь",
    pickArticle([{ url: "https://dzen.ru/a/123", title: "Цена Порше Кайенна" }], ["porsche", "cayenne"], [], () => 0),
    "https://dzen.ru/a/123");
  eq("подбор: пользовательские варианты действуют и на цель",
    pickArticle(["https://a.ru/test-народного-седана/"], ["polo"], [], () => 0, "polo = народного седана"),
    "https://a.ru/test-народного-седана/");
  eq("подбор: полное совпадение приоритетнее ядра",
    pickArticle(["https://a.ru/kia-sportage/", "https://a.ru/kia-sportage-hybrid/"],
      ["kia", "sportage", "hybrid"], ["kia", "sportage"], () => 0), "https://a.ru/kia-sportage-hybrid/");

  for (const [text, url, synonyms] of [
    ["Kia Rio 3", "https://a.ru/kia-rio-3-obzor/", ""],
    ["Hyundai Santa Fe", "https://a.ru/hyundai-santa-fe-2-obzor/", ""],
    ["Мазда3", "https://a.ru/mazda-3-obzor/", ""],
    ["Кайенна", "https://a.ru/cayenne-obzor/", "polo = cayenne\ngranta = cayenne"],
    ["Икстрейл", "https://a.ru/nissan-x-trail-obzor/", ""],
    ["Кайенна", "https://a.ru/porsche-cayenne/", "polo = cayenne"],
    ["C-HR", "https://a.ru/toyota-c-hr-obzor/", "Toyota C-HR = C-HR"],
    ["народный и автомобиль", "https://a.ru/народный-и-автомобиль/", "polo = народный и автомобиль"]
  ]) {
    const model = findModels(text, synonyms)[0];
    eq("подбор: согласованная нормализация «" + text + "»",
      model ? pickArticle([url], model.tokens, model.core, () => 0, synonyms) : null, url);
  }

  let titleReads = 0;
  const indexedEntry = { url: "https://dzen.ru/a/indexed", get title() { titleReads++; return "Kia Sportage"; } };
  eq("подбор: запасной поиск использует ту же статью",
    pickArticle([indexedEntry], ["kia", "sportage", "hybrid"], ["kia", "sportage"], () => 0), indexedEntry.url);
  eq("подбор: заголовок разбирается один раз, даже при поиске по ядру", titleReads, 1);
  titleReads = 0;
  const articleCache = new Map();
  pickArticle([indexedEntry], ["volvo"], [], () => 0, "", articleCache);
  pickArticle([indexedEntry], ["kia", "sportage"], [], () => 0, "", articleCache);
  eq("подбор: карта разбирается один раз для нескольких моделей", titleReads, 1);

  // ---- 5. buildLinks: полный проход ---------------------------------------
  permAllowed = true;
  routes = {
    "https://a.ru/sitemap.xml": {
      body: smIndex(["https://a.ru/sm-posts.xml", "https://a.ru/sm-trucks.xml"])
    },
    "https://a.ru/sm-posts.xml": {
      body: sm([
        "https://a.ru/volvo-udivila-resheniem-po-xc40-novyj-krossover/",
        "https://a.ru/kia-sportage-i-ceny/"
      ])
    },
    "https://a.ru/sm-trucks.xml": { body: sm(["https://a.ru/scania-t143-vosstanovlenie/"]) },
    "https://b.ru/sitemap.xml": { body: sm(["https://b.ru/toyota-camry-obzor/"]) }
  };

  let res = await buildLinks(
    "Volvo XC40 подешевел. Toyota Camry обновилась. Scania T143 снова в строю.",
    { linkSites: "a.ru\nb.ru" },
    { refresh: true, rand: () => 0 }
  );
  eq(
    "сборка: три ссылки на три модели",
    res.links.map((l) => l.anchor),
    ["Volvo XC40", "Toyota Camry", "Scania T143"]
  );
  eq("сборка: адрес подобран по модели", res.links[0].url, "https://a.ru/volvo-udivila-resheniem-po-xc40-novyj-krossover/");
  eq("сборка: вложенная карта тоже прочитана", res.links[2].url, "https://a.ru/scania-t143-vosstanovlenie/");
  check("сборка: ссылки вида article", res.links.every((l) => l.kind === "article"));
  eq("сборка: статистика моделей и сайтов", [res.stats.models, res.stats.sites, res.stats.links], [3, 2, 3]);
  eq("сборка: без промахов", res.stats.unmapped, []);
  eq("сборка: карты нашлись у обоих сайтов", res.stats.noSitemap, []);

  // сайты перебираются по кругу — иначе все ссылки уедут на первый сайт
  res = await buildLinks("Volvo XC40 и Toyota Camry", { linkSites: "a.ru\nb.ru" }, { refresh: true, rand: () => 0 });
  eq(
    "сборка: сайты чередуются",
    res.links.map((l) => l.site),
    ["https://a.ru", "https://b.ru"]
  );
  eq("сборка: вторая модель ушла на второй сайт", res.links[1].url, "https://b.ru/toyota-camry-obzor/");

  // ---- 6. buildLinks: нет карты — ведём на сайт ---------------------------
  routes = {};
  res = await buildLinks("Volvo XC40 поехал", { linkSites: "c.ru" }, { refresh: true, rand: () => 0 });
  eq("сборка: без карты ссылка ведёт на сам сайт", res.links.map((l) => l.url), ["https://c.ru"]);
  eq("сборка: тип ссылки — site", res.links[0].kind, "site");
  eq("сборка: сайт без карты отмечен", res.stats.noSitemap, ["c.ru"]);
  eq("сборка: siteOnly посчитан", res.stats.siteOnly, 1);

  // ---- 7. buildLinks: модель есть, статьи нет, карта есть -----------------
  routes = { "https://a.ru/sitemap.xml": { body: sm(["https://a.ru/kia-sportage-i-ceny/"]) } };
  res = await buildLinks("Volvo XC40 поехал", { linkSites: "a.ru" }, { refresh: true, rand: () => 0 });
  eq("сборка: статьи нет — ссылок нет", res.links, []);
  eq("сборка: ненайденная модель названа", res.stats.unmapped, ["Volvo XC40"]);
  eq("сборка: карта была, значит siteOnly не растёт", res.stats.siteOnly, 0);

  // ---- 8. buildLinks: нет моделей / нет сайтов ----------------------------
  res = await buildLinks("Просто текст без машин", { linkSites: "a.ru" }, { refresh: true });
  eq("сборка: без моделей ссылок нет", res.links, []);
  eq("сборка: без моделей статистика честная", res.stats.models, 0);
  res = await buildLinks("Volvo XC40", { linkSites: "" }, { refresh: true });
  eq("сборка: без сайтов ссылок нет", res.links, []);
  eq("сборка: без сайтов статистика честная", res.stats.sites, 0);

  // ---- 9. buildLinks: нет разрешения на домены ---------------------------
  permAllowed = false;
  let threw = null;
  try {
    await buildLinks("Volvo XC40", { linkSites: "a.ru" }, { refresh: true });
  } catch (e) {
    threw = e;
  }
  check("сборка: без разрешения бросает ошибку", !!threw);
  check("сборка: ошибка помечена needPermission", !!(threw && threw.needPermission));
  check(
    "сборка: в ошибке сказано, что делать",
    !!(threw && /Разрешить доступ/.test(threw.message)),
    threw && threw.message
  );
  permAllowed = true;

  // ---- 10. кэш карт -------------------------------------------------------
  // Прошлый проход прогрел кэш для a.ru (там осталась только статья про Kia).
  // Повторный проход с refresh=false обязан обойтись без сети.
  fetched.length = 0;
  res = await buildLinks("Kia Sportage подешевел", { linkSites: "a.ru" }, { refresh: false, rand: () => 0 });
  eq("кэш: повторный проход не ходит в сеть", fetched.length, 0);
  eq(
    "кэш: но ссылка из кэша всё равно нашлась",
    res.links.map((l) => l.url),
    ["https://a.ru/kia-sportage-i-ceny/"]
  );

  // ---- 11. значения по умолчанию ------------------------------------------
  // Пользователь просил ровно две ссылки на статью и пустой список сайтов:
  // если кто-то поменяет дефолт, это должно упасть здесь, а не всплыть у него.
  eq("дефолт: ссылок на статью — 2", DEFAULTS.linkCount, 2);
  eq("дефолт: сайтов для перелинковки нет", DEFAULTS.linkSites, "");

  routes = { "https://a.ru/sitemap.xml": { body: sm(["https://a.ru/polo-obzor/", "https://a.ru/porsche-cayenne-test/"]) } };
  res = await buildLinks("тест-драйв Кайенна", { linkSites: "a.ru" }, { refresh: true, rand: () => 0 });
  eq("сборка: модель без марки ведёт на статью", res.links.map((l) => [l.anchor, l.url]),
    [["Кайенна", "https://a.ru/porsche-cayenne-test/"]]);
  res = await buildLinks("тест-драйв Кайенна", { linkSites: "a.ru", linkSynonyms: "polo = Кайенна" }, { rand: () => 0 });
  eq("сборка: пользовательское правило передаётся из настроек", res.links.map((l) => l.url), ["https://a.ru/polo-obzor/"]);

  // ---- итог ---------------------------------------------------------------
  const failed = results.filter((r) => !r.ok).length;
  console.log("");
  console.log("всего проверок: " + results.length + ", провалов: " + failed);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error("Харнесс упал:", (e && e.stack) || e);
  process.exitCode = 1;
});
