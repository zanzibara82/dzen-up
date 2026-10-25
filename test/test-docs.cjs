/**
 * README против кода: числа и настройки в документации обязаны совпадать
 * с константами и DEFAULTS.
 *
 * Зачем отдельный набор. Дважды находилось враньё одного рода: README описывал
 * «как было бы удобно», а не «как в коде» — кнопку доступа к сайтам приписал
 * каналам, а лимит обхода ленты вообще не называл. Оба раза это нашлось глазами,
 * случайно, спустя дни после правок. Глазами такое искать дорого, а проверка
 * механическая: возьми константу из кода и поищи её значение в тексте.
 *
 * Что этот набор НЕ делает: не сверяет формулировки и не читает смысл. Он ловит
 * ровно один класс ошибок — «в коде 6, в README 8» и «настройка есть, а в таблице
 * её нет». Переписали абзац — набор промолчит; поменяли константу и забыли текст —
 * упадёт.
 *
 * Браузер не нужен: только файлы. Поэтому набор самый быстрый и стоит первым
 * в общем прогоне.
 */
const fs = require("fs");
const path = require("path");
const paths = require("./paths.cjs");

// Папку расширения можно передать аргументом (так делает общий раннер),
// иначе берём собранную по умолчанию. Без этого проверяли бы не ту папку,
// которую только что собрали.
const EXT = process.argv[2] ? paths.normalize(process.argv[2]) : paths.EXT;

let checks = 0;
let fails = 0;
function check(name, ok, detail) {
  checks++;
  if (!ok) fails++;
  const mark = ok ? "PASS" : "FAIL";
  console.log("  " + mark + " " + name + (detail != null ? "  — " + detail : ""));
}

function read(name) {
  return fs.readFileSync(path.join(EXT, name), "utf8");
}

// ------------------------------------------------------------- утилиты разбора ---

/** Значение `const NAME = <выражение>;` — вычисляется как есть, вместе с 12*60*60*1000.
 *  Объявление ищем и как const, и как var: в content.js константы панели объявлены
 *  через var, и требование только const роняло проверку на ровном месте.
 *  Якорь на начало строки — чтобы не прочитать закомментированное объявление:
 *  строка `// const LIMIT = 5;` значением не является. */
function constValue(src, name) {
  const m = new RegExp("^\\s*(?:const|var|let)\\s+" + name + "\\s*=\\s*([^;\\n]+)", "m").exec(src);
  if (!m) throw new Error("не нашёл константу " + name);
  const expr = m[1].split("//")[0].trim();
  // eslint-disable-next-line no-new-func
  return new Function("return (" + expr + ")")();
}

/** Ключи верхнего уровня в `const DEFAULTS = { ... };`. */
function defaultsKeys(src) {
  const start = src.indexOf("const DEFAULTS = {");
  if (start < 0) throw new Error("не нашёл DEFAULTS");
  const end = src.indexOf("\n};", start);
  if (end < 0) throw new Error("не нашёл конец DEFAULTS");
  const body = src.slice(start, end);
  const keys = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^ {2}([A-Za-z_$][\w$]*):/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** Массив строк из `const NAME = ["a", "b"];`. */
function constArray(src, name) {
  const m = new RegExp("const\\s+" + name + "\\s*=\\s*\\[([^\\]]*)\\]").exec(src);
  if (!m) throw new Error("не нашёл массив " + name);
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Первая колонка markdown-таблицы, которая идёт после заголовка раздела.
 * Ищем от заголовка до строки-разделителя `| --- |`, дальше — до пустой строки:
 * так таблица вырезается целиком, не задевая соседние.
 */
function tableColumn(md, sectionTitle, col) {
  const start = md.indexOf(sectionTitle);
  if (start < 0) return [];
  const head = md.indexOf("| --- |", start);
  if (head < 0) return [];
  const blank = md.indexOf("\n\n", head);
  const block = md.slice(head, blank < 0 ? md.length : blank);
  const out = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((s) => s.trim());
    if (!cells[col] || /^-{2,}/.test(cells[col])) continue;
    out.push(cells[col]);
  }
  return out;
}

const bg = read("background.js");
const content = read("content.js");
const popup = read("popup.js");
const popupHtml = read("popup.html");
const presets = read("presets.js");
const manifest = JSON.parse(read("manifest.json"));
const readme = read("README.md");

/**
 * Тексты, в которых ищем фразы, с схлопнутыми пробелами. И в markdown, и в HTML
 * предложение переносится по строкам, поэтому «120 самых\n свежих» не найдётся
 * поиском по «120 самых свежих». Схлопывание делает проверку устойчивой к
 * переносам: переверстали абзац — тест не покраснел зря.
 */
function norm(s) {
  return String(s).replace(/\s+/g, " ");
}
const docs = {
  "README.md": norm(readme),
  "popup.html": norm(popupHtml)
};
/** Фраза есть в README (переносы строк не мешают). */
const inReadme = (frag) => docs["README.md"].includes(norm(frag));

// README репозитория — отдельный текст: `read()` читает из папки расширения,
// а про тесты и сборку написано в корне. Факт из `test/` нельзя искать в
// пользовательской инструкции, иначе сторож проверяет не то, где правду пишут.
const repoReadme = norm(fs.readFileSync(path.join(paths.REPO, "README.md"), "utf8"));
const inRepo = (frag) => repoReadme.includes(norm(frag));

console.log("\n=== README против кода ===\n");

// ------------------------------------------------- 1. числа обязаны совпадать ---
// Пары «константа → как её значение должно выглядеть в текстах». Значение берём
// из кода, а не пишем числом: иначе тест сам станет вторым источником вранья.
//
// Последний элемент — где фразу искать. Попап здесь не для полноты: подсказку
// «Карта живёт 12 часов» человек читает чаще, чем README, и она разъедется с
// константой ровно так же, если её не сторожить.
const NUMERIC = [
  ["background.js", bg, "RETRY_TRIES", (v) => "до " + v + " раз", "повторы перевода"],
  ["background.js", bg, "REQUEST_TIMEOUT_MS", (v) => v / 1000 + " секундами", "таймаут запроса"],
  ["background.js", bg, "CACHE_MAX", (v) => "до " + v + " записей", "размер кэша переводов"],
  ["background.js", bg, "CONCURRENCY_GOOGLE", (v) => "в " + v + " потока", "потоки Google"],
  ["background.js", bg, "CONCURRENCY_MYMEMORY", (v) => "MyMemory — в " + v, "потоки MyMemory"],
  ["background.js", bg, "MIN_LETTERS", (v) => "~" + v + " букв", "порог определения языка"],
  ["background.js", bg, "SITEMAP_TTL", (v) => v / 3600000 + " часов", "кэш карты сайта"],
  ["background.js", bg, "CHANNEL_TTL", (v) => v / 3600000 + " часов", "кэш карты канала", ["README.md", "popup.html"]],
  ["background.js", bg, "CHANNEL_MAX_PAGES", (v) => "до " + v + " страниц", "лимит обхода ленты"],
  ["background.js", bg, "SITEMAP_MAX_URLS", (v) => "до " + v + " адресов", "лимит адресов карты"],
  ["background.js", bg, "SITEMAP_MAX_TAGS", (v) => "до " + v + " рубрик", "лимит рубрик карты"],
  ["background.js", bg, "SPEC_TOKEN_MIN", (v) => "длиннее " + v + " букв", "порог специфичного слова рубрики"],
  ["content.js", content, "EDITOR_MIN_CHARS", (v) => "от " + v + " символов", "порог «это редактор»"],
  ["content.js", content, "EDGE_ZONE", (v) => "ближе " + v + " px", "зона бокового режима"]
];

for (const [file, src, name, expect, what, where] of NUMERIC) {
  let v;
  try {
    v = constValue(src, name);
  } catch (e) {
    check("число: " + name + " найдена в коде", false, e.message);
    continue;
  }
  const want = norm(expect(v));
  for (const doc of where || ["README.md"]) {
    check(what + ": в " + doc + " есть «" + want + "»", docs[doc].includes(want), name + " = " + v);
  }
}

// Ширина и высота редактора называются вместе: «от 260×100».
try {
  const w = constValue(content, "EDITOR_MIN_W");
  const h = constValue(content, "EDITOR_MIN_H");
  check("порог «это редактор»: в README есть «от " + w + "×" + h + "»", docs["README.md"].includes("от " + w + "×" + h));
} catch (e) {
  check("порог «это редактор»: константы найдены", false, e.message);
}

// Сегменты-рубрики: человек смотрит на адрес своего сайта и должен понять,
// почему тот «/category/…» стал целью ссылки, а «/about/…» — нет. Поэтому
// каждый сегмент из кода обязан быть назван в README — в коде их правят
// молча, и документация отстаёт первой.
try {
  const segments = constArray(bg, "TAG_SEGMENTS");
  const missing = segments.filter((s) => !docs["README.md"].includes("`" + s + "`"));
  check("рубрики: все сегменты названы в README", missing.length === 0, missing.join(", "));
  check("рубрики: список сегментов непустой", segments.length > 0, segments.length + " шт.");
} catch (e) {
  check("рубрики: TAG_SEGMENTS найдена в коде", false, e.message);
}

// Длина слага рубрики — «одно-два слова»: при двух это живая русская фраза, при
// большем числе — уже перечисление. Сторож выбирает фразу по значению константы,
// чтобы правка лимита не осталась без текста для человека.
try {
  const n = constValue(bg, "TAG_MAX_SLUG_PARTS");
  const phrase = n === 2 ? "одно-два слова" : "не больше " + n + " слов";
  check("рубрики: длина слага названа в README («" + phrase + "»)", docs["README.md"].includes(phrase),
    "TAG_MAX_SLUG_PARTS = " + n);
} catch (e) {
  check("рубрики: TAG_MAX_SLUG_PARTS найдена в коде", false, e.message);
}

// Таймаут AI-рерайта: у облака и у своей машины он разный, поэтому берём обе
// константы из кода, а не первое попавшееся `timeout:` в файле. Прежняя версия
// этой проверки читала первую строку `timeout: <число>` — и после того, как
// потолок стал зависеть от адреса, она честно нашла бы чужой таймаут (первое
// `timeout:` в файле относился не к рерайту) и потребовала бы его в README.
try {
  const v = constValue(bg, "AI_TIMEOUT_MS");
  check(
    "таймаут AI-рерайта: в README есть «AI-рерайт — " + v / 1000 + "»",
    v > 0 && inReadme("AI-рерайт — " + v / 1000)
  );
} catch (e) {
  check("таймаут AI-рерайта: константа найдена", false, e.message);
}
// Потолок своей модели в README назван словами — «5 минут», и число это из кода.
// Заодно проверяем сам порядок: у своей машины потолок обязан быть больше, иначе
// длинный ответ локальной модели обрывался бы на середине, как раньше.
try {
  const local = constValue(bg, "AI_LOCAL_TIMEOUT_MS");
  const cloud = constValue(bg, "AI_TIMEOUT_MS");
  check(
    "таймаут своей модели: в README есть «" + local / 60000 + " минут»",
    inReadme(local / 60000 + " минут"),
    "AI_LOCAL_TIMEOUT_MS = " + local
  );
  check(
    "таймаут своей модели выше облачного",
    local > cloud,
    local + " > " + cloud
  );
} catch (e) {
  check("таймаут своей модели: константы найдены", false, e.message);
}

// Потолок рерайта растёт с объёмом текста — это тоже обещание, и числа в нём
// берутся из кода. Проверяем и рост, и оба предела: «5 минут» у облака и
// «10 минут» у своей машины человек видит в README.
try {
  const perWord = constValue(bg, "AI_TIMEOUT_PER_WORD_MS");
  const maxCloud = constValue(bg, "AI_TIMEOUT_MAX_MS");
  const maxLocal = constValue(bg, "AI_LOCAL_TIMEOUT_MAX_MS");
  check(
    "рост потолка назван в README",
    inReadme(perWord + " мс на слово"),
    "AI_TIMEOUT_PER_WORD_MS = " + perWord
  );
  check(
    "предел облака назван в README",
    inReadme("предел — " + maxCloud / 60000 + " минут"),
    "AI_TIMEOUT_MAX_MS = " + maxCloud
  );
  check(
    "предел своей машины назван в README",
    inReadme("до " + maxLocal / 60000 + " минут"),
    "AI_LOCAL_TIMEOUT_MAX_MS = " + maxLocal
  );
  check(
    "предел своей машины выше облачного",
    maxLocal > maxCloud,
    maxLocal + " > " + maxCloud
  );
} catch (e) {
  check("потолки AI-рерайта: константы найдены", false, e.message);
}

// Потолок повтора в проверке ключа. Это обещание появилось вместе с разными
// потолками у двух запросов проверки: первый спрашивает восемь токенов и обязан
// вернуться быстро, второй — двести пятьдесят шесть и адресован модели с
// рассуждением. Человек видит в README «до 90 секунд» — значит, число должно
// приходить из кода, а не жить в тексте само по себе.
try {
  const retry = constValue(bg, "AI_CHECK_RETRY_TIMEOUT_MS");
  const first = constValue(bg, "AI_CHECK_TIMEOUT_MS");
  check(
    "потолок повтора проверки назван в README",
    inReadme("до " + retry / 1000 + " секунд"),
    "AI_CHECK_RETRY_TIMEOUT_MS = " + retry
  );
  check(
    "у повтора проверки потолок больше, чем у первого запроса",
    retry > first,
    retry + " > " + first
  );
} catch (e) {
  check("потолок повтора проверки: константы найдены", false, e.message);
}

// Забор текста по адресу: два числа человек видит в README — сколько ждать загрузку
// чужой страницы и с какого объёма она считается статьёй. Оба обещания берём из
// кода: правка лимита иначе оставила бы в тексте старое число.
try {
  const timeout = constValue(bg, "SOURCE_TIMEOUT_MS");
  const min = constValue(bg, "SOURCE_MIN_CHARS");
  check(
    "забор по адресу: потолок загрузки назван в README",
    inReadme(Math.round(timeout / 1000) + " секунд"),
    "SOURCE_TIMEOUT_MS = " + timeout
  );
  check(
    "забор по адресу: порог «это статья» назван в README",
    inReadme(min + " знаков"),
    "SOURCE_MIN_CHARS = " + min
  );
} catch (e) {
  check("забор по адресу: константы найдены", false, e.message);
}

// Обход ленты: называется не только число страниц, но и вытекающее из него число
// статей (~20 карточек на страницу). Проверяем именно выкладку, чтобы «~120»
// не осталось в текстах, когда лимит страниц поменяют. Попап тоже — там эта
// цифра стоит в подсказке к полю каналов.
try {
  const pages = constValue(bg, "CHANNEL_MAX_PAGES");
  const approx = pages * 20;
  for (const doc of ["README.md", "popup.html"]) {
    check("обход ленты: в " + doc + " есть «" + approx + " самых свежих»", docs[doc].includes(approx + " самых свежих"), pages + " стр. × ~20");
  }
} catch (e) {
  check("обход ленты: выкладка проверена", false, e.message);
}

// Лимит хранилища sync — 8 КБ на ключ. Числа этого в коде нет: это константа
// Chrome, а не наша, поэтому берём её из текста сообщения об ошибке и требуем,
// чтобы та же цифра стояла в README и в подсказке попапа. Три поверхности,
// одна цифра: правишь одну — правь все три.
//
// Якорь — на саму фразу сообщения. Сначала тут стоял поиск «лимит N КБ» по всему
// файлу, и он находил КОММЕНТАРИЙ выше сообщения: подменил цифру в сообщении —
// проверка этого не заметила. Комментарий — не то, что видит пользователь.
{
  const m = /слишком большое для синхронизации\s*\(лимит\s+(\d+)\s*КБ/.exec(bg);
  const kb = m ? m[1] : "";
  check("лимит sync найден в сообщении об ошибке", !!kb, m ? m[0] : "нет");
  if (kb) {
    check("лимит sync: та же цифра в README", inReadme(kb + " КБ"));
    check("лимит sync: та же цифра в подсказке попапа", docs["popup.html"].includes(kb + " КБ"));
  }
}

// Сколько ссылок на статью: дефолт из DEFAULTS, верхняя граница — из клампа в коде.
{
  const def = /linkCount:\s*(\d+)/.exec(bg);
  const max = /Math\.min\((\d+),\s*parseInt\(S\.linkCount/.exec(content);
  const d = def ? Number(def[1]) : NaN;
  const v = max ? Number(max[1]) : NaN;
  check("ссылки на статью: в README есть «от 1 до " + v + "»", v > 0 && inReadme("от 1 до " + v), "кламп в content.js");
  check("ссылки на статью: в README назван дефолт " + d, d > 0 && inReadme("По умолчанию " + d), "DEFAULTS.linkCount");
}

{
  const match = /const MODEL_ALIASES = (\{[\s\S]*?\n\});/.exec(bg);
  const count = match ? Object.keys(new Function("return (" + match[1] + ")")()).length : 0;
  check("словарь моделей: размер назван в README", count > 0 && inReadme(count + " моделей"), "моделей: " + count);
}

// ---------------------------------------- 2. каждая настройка названа в README ---
// Соответствие «ключ настройки → фраза в README». Ключ, которого тут нет,
// считается недокументированным — это и есть сигнал «добавил настройку, забыл
// описать». Новую настройку либо дописывают в README, либо вносят сюда осознанно.
const SETTING_DOC = {
  sourceLang: "Язык оригинала",
  targetLang: "Переводить на",
  mode: "Режим",
  strength: "Глубина рерайта",
  engine: "Движок перевода",
  preview: "Показывать предпросмотр перед вставкой",
  skipSameLang: "Не переводить текст, уже написанный на целевом языке",
  stripLinks: "Ссылки в тексте оригинала",
  signature: "Добавлять приписку в конце статьи",
  signatureText: "Текст приписки правится в поле рядом",
  glossary: "Глоссарий — что не переводить",
  linkSites: "Сайты для перелинковки",
  linkChannels: "Каналы Дзена для перелинковки",
  linkSynonyms: "Синонимы для перелинковки",
  linkCount: "Сколько ссылок на статью",
  sourceUrl: "Адрес статьи, откуда взять текст",
  aiEnabled: "Использовать AI-рерайт (OpenAI-совместимый API)",
  aiBaseUrl: "Base URL",
  aiModel: "модель",
  aiKey: "ключ",
  aiPreset: "Стиль рерайта",
  aiPrompt: "Промпт рерайтера"
};

const keys = defaultsKeys(bg);
check("DEFAULTS разобран", keys.length >= 15, "ключей: " + keys.length);

const undocumented = keys.filter((k) => !SETTING_DOC[k]);
check("у каждой настройки есть строка в README", undocumented.length === 0, undocumented.length ? "не описаны: " + undocumented.join(", ") : keys.length + " настроек");

for (const k of keys) {
  if (!SETTING_DOC[k]) continue;
  check("настройка " + k + " названа в README", inReadme(SETTING_DOC[k]), "«" + SETTING_DOC[k] + "»");
}

// Мусор в обратную сторону: описали настройку, которой в коде нет.
const stale = Object.keys(SETTING_DOC).filter((k) => !keys.includes(k));
check("в таблице нет настроек, которых нет в коде", stale.length === 0, stale.length ? "лишние: " + stale.join(", ") : "нет");

// ------------------------- 2б. названия в таблице = метки в попапе дословно ---
// Таблица настроек — карта экрана настроек: человек ищет в ней ту надпись, которую
// видит в попапе. Назовёшь строку «Предпросмотр перед вставкой», а в попапе
// «Показывать предпросмотр перед вставкой» — и искать придётся на глаз.
// Поэтому сверяем дословно, а не «по смыслу»: переименовали метку в попапе —
// README обязан догнать.
const settingLabels = tableColumn(readme, "## Настройки", 0);
check("таблица настроек разобрана", settingLabels.length >= 15, "строк: " + settingLabels.length);
for (const label of settingLabels) {
  check("строка «" + label + "» дословно есть в попапе", popupHtml.includes(label));
}

// ------------------------------- 2в. таблица стилей = пресеты из presets.js ---
// Тот же класс ошибки: добавили пресет — таблица в README осталась с восемью.
const presetNames = tableColumn(readme, "### Стили рерайта", 0);
const codeNames = [...presets.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
check("таблица стилей разобрана", presetNames.length === codeNames.length, "в README: " + presetNames.length + ", в presets.js: " + codeNames.length);
for (const n of codeNames) check("стиль «" + n + "» описан в README", presetNames.includes(n));
for (const n of presetNames) check("стиль «" + n + "» есть в presets.js", codeNames.includes(n));

// ----------------------------- 2г. кнопка проверки ключа: README и попап ---
// Кнопка — часть того же экрана настроек, и в README она описана. Держим вместе
// три вещи, которые разъезжаются по отдельности: сама надпись, кнопка у поля
// ключа и строка рядом, куда падает ответ.
const CHECK_LABEL = "Проверить ключ";
check("README называет кнопку проверки ключа", inReadme(CHECK_LABEL), "«" + CHECK_LABEL + "»");
const checkButtons = (popupHtml.match(/class="ghost check"/g) || []).length;
check("в попапе кнопка у поля ключа одна", checkButtons === 1, "кнопок: " + checkButtons);
check("надпись кнопки дословно есть в попапе", (popupHtml.match(new RegExp(CHECK_LABEL, "g")) || []).length >= 1);
const checkStatus = (popupHtml.match(/check-status/g) || []).length;
check("под кнопкой есть строка для ответа", checkStatus >= 1, "строк: " + checkStatus);

// README обещает две вещи, которые легко потерять при правке кода. Обещания
// проверяем как обещания: если поведение изменится, README придётся поправить.
check("README: проверка берёт то, что вписано в поля сейчас", inReadme("вписано в поля сейчас"));
check("README: без ключа в сеть никто не идёт", inReadme("в сеть никто не идёт"));
check("README: сказано, что запрос платный и идёт по нажатию", inReadme("только по нажатию") && inReadme("платный"));

// ------------------------------------------- 2д. где брать ключ: адреса ---
// Живой случай: README писал «ключ на pixabay.com», и человек всё равно
// спросил, где именно его взять. Адрес — это и есть инструкция, и он нужен в
// обоих текстах: попап человек читает раньше, чем README.
const KEY_SOURCES = [
  ["platform.openai.com/api-keys", "страница ключей OpenAI"],
  ["openrouter.ai/keys", "страница ключей OpenRouter"]
];
for (const [frag, what] of KEY_SOURCES) {
  check("ключи: в README назван " + what, inReadme(frag), "«" + frag + "»");
  check("ключи: в попапе назван " + what, docs["popup.html"].includes(frag), "«" + frag + "»");
}

// --------------------------------------------- 3. хранилища разложены как в README ---
const localKeys = constArray(bg, "LOCAL_KEYS");
const LOCAL_DOC = { glossary: "Глоссарий", aiKey: "API-ключ", linkSites: "список сайтов", linkChannels: "список каналов", linkSynonyms: "словарь синонимов" };
for (const k of localKeys) {
  const frag = LOCAL_DOC[k];
  check("локальный ключ " + k + " назван в README", !!frag && inReadme(frag), frag ? "«" + frag + "»" : "нет описания в тесте");
}
// Обратная проверка: то, что README кладёт в sync, не должно лежать в LOCAL_KEYS.
const SYNC_DOC = ["sourceLang", "targetLang", "engine", "strength", "preview", "stripLinks", "signature", "linkCount", "sourceUrl"];
const wrongStore = SYNC_DOC.filter((k) => localKeys.includes(k));
check("настройки из sync не попали в local", wrongStore.length === 0, wrongStore.length ? "не там: " + wrongStore.join(", ") : "ок");

// ------------------------------------------------- 4. права: манифест против README ---
const required = manifest.host_permissions || [];
const optional = manifest.optional_host_permissions || [];
check("манифест: dzen.ru — обязательное право", required.includes("https://dzen.ru/*"), required.join(" "));
check("манифест: домены сайтов — необязательное право", optional.includes("https://*/*"), optional.join(" "));

// README обязан объяснять, что доступ к Дзену уже выдан, — иначе снова появится
// «нажмите кнопку» там, где нажимать нечего.
if (required.includes("https://dzen.ru/*")) {
  check("README: сказано, что доступ к dzen.ru выдан при установке", inReadme("уже выдан при установке"));
  check("README: названы обязательные права (host_permissions)", inReadme("host_permissions") || inReadme("обязательных правах"));
}
if (optional.includes("https://*/*")) {
  check("README: кнопка доступа описана для сайтов", inReadme("Разрешить доступ к сайтам"));
}

// Локальная модель (Ollama) отвечает по http, и по https её нет вовсе. Доступ по
// http открыт ТОЛЬКО для своей машины — обещание узкое и обязано быть названным:
// иначе человек с Ollama пойдёт искать причину в ключе.
check(
  "манифест: http открыт только для своей машины",
  optional.includes("http://localhost/*") &&
    optional.includes("http://127.0.0.1/*") &&
    !optional.includes("http://*/*"),
  optional.join(" ")
);
check("README: назван локальный адрес по http", inReadme("127.0.0.1:11434"), "http://127.0.0.1:11434/v1");

// Кнопка не должна приписываться каналам: в абзаце про каналы прямо сказано,
// что она их не касается. Ловим возврат прежней формулировки.
check("README: кнопка доступа не приписана каналам", /каналы не зависят от кнопки/.test(readme));

// Версия обязана совпадать в трёх местах: манифест, бейдж в шапке попапа и
// обещание в README. При подъёме версии человек меняет манифест и забывает
// бейдж — тогда «проверь, что стоит 2.0.0» в README ведёт в тупик.
const ver = manifest.version;
check("попап: бейдж версии совпадает с манифестом", docs["popup.html"].includes("v" + ver), "манифест: " + ver);
check("README: версия в тексте совпадает с манифестом", inReadme(ver), "манифест: " + ver);

// ------------------------------------------------------ 5. состав пакета совпадает ---
const listed = ["manifest.json", "background.js", "content.js", "rewriter.js", "presets.js", "content.css"];
for (const f of listed) {
  const exists = fs.existsSync(path.join(EXT, f));
  check("состав пакета: " + f + " есть в папке и назван в README", exists && inReadme(f));
}

// ------------------------------------ 6. профили тестов не должны обрастать ---
// Chrome в тестовом профиле качает «дополнения»: одно из них приносит 1,1 ГБ в
// Default/Extensions, и профиль раздувается с каждым прогоном. Удалить их потом
// нельзя — ОС отдаёт «Отказано в доступе» и rm, и PowerShell, и уборщику; убирать
// остаётся руками. Поэтому единственная верная защита — не скачивать: на старте
// Chrome обязан получать флаги из одного места (PATHS.chromeFlags), а не свой
// список «как в прошлый раз». Проверка статическая: она смотрит, что каждый
// браузерный харнесс эти флаги передаёт.
const TEST_DIR = path.join(__dirname);
const browserHarnesses = fs
  .readdirSync(TEST_DIR)
  .filter((f) => /^test-.*\.cjs$/.test(f) && f !== path.basename(__filename))
  .filter((f) => {
    const src = fs.readFileSync(path.join(TEST_DIR, f), "utf8");
    // "--user-data-dir=" — верный признак: он есть только там, где реально
    // поднимают Chrome. Проверка по «spawn(CHROME» её бы не поймала: у восьми
    // харнессов аргументы начинаются с переноса строки.
    return src.includes("spawn(") && src.includes("--user-data-dir=");
  });
check("найдены браузерные харнессы", browserHarnesses.length >= 10, browserHarnesses.join(", "));
for (const f of browserHarnesses) {
  const src = fs.readFileSync(path.join(TEST_DIR, f), "utf8");
  check("харнесс " + f + " стартует через PATHS.chromeFlags()", /chromeFlags\s*\(/.test(src));
}
// Сами флаги имеют смысл только если они запрещают фоновые загрузки и обновления
// дополнений; без них helper — пустая обёртка, и профиль снова вырастет до гигабайта.
const pathsSrc = fs.readFileSync(path.join(TEST_DIR, "paths.cjs"), "utf8");
check(
  "флаги запрещают фоновые загрузки и обновления дополнений",
  /--disable-background-networking/.test(pathsSrc) && /--disable-component-update/.test(pathsSrc)
);
check("README репозитория: сказано, как тесты берегут диск", inRepo("chromeFlags"));

console.log("\n=== ИТОГ ===");
console.log("всего проверок: " + checks + ", провалов: " + fails);
process.exit(fails ? 1 : 0);
