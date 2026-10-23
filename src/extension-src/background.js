/* Дзен Рерайтер — service worker (MV3).
 * Здесь живут все сетевые запросы: перевод и опциональный AI-рерайт.
 * Контент-скрипт не ходит в сеть сам — так нет проблем с CORS.
 */

// Приписка в конце статьи — стартовое значение, пользователь правит его в настройках.
// Запятые и «ё» расставлены намеренно: это публичный текст под каждой статьёй.
const DEFAULT_SIGNATURE =
  "Ставьте лайк, если понравилось, и пишите в комментариях, о чём хотели бы читать больше.";

const DEFAULTS = {
  sourceLang: "auto",
  targetLang: "ru",
  mode: "translate+rewrite", // translate+rewrite | translate | rewrite
  strength: "medium", // light | medium | strong
  engine: "google", // google | mymemory
  preview: true, // показывать предпросмотр «до → после» перед вставкой
  skipSameLang: true, // не отправлять переводчику фрагменты, уже написанные на целевом языке
  stripLinks: "keep", // ссылки из оригинала: keep — убрать, текст оставить | drop — убрать с текстом | off — не трогать
  signature: false, // дописывать приписку в конце статьи
  signatureText: DEFAULT_SIGNATURE, // что именно дописывать (правится в настройках)
  glossary: "", // термины, которые нельзя переводить: «Оригинал = Замена» построчно
  linkSites: "", // сайты для перелинковки: по строке на сайт (хранится в local)
  linkChannels: "", // каналы Дзена для перелинковки: по строке на канал (хранится в local)
  linkCount: 2, // сколько ссылок ставить в статью
  aiEnabled: false,
  aiBaseUrl: "https://api.openai.com/v1",
  aiModel: "gpt-4o-mini",
  aiKey: "",
  // id стиля из presets.js («Свой промпт» = custom). Нужен только попапу и панели,
  // чтобы показать выбранный пункт списка: воркер работает с готовым aiPrompt.
  aiPreset: "editor",
  // Текст пресета «Редактор Дзена» из presets.js. Дублирование осознанное:
  // presets.js подключается в попап и контент-скрипт, но не в service worker,
  // а при пустых настройках промпт нужен именно здесь. Совпадение сторожит
  // тест (раздел 15 в test-reliability.cjs) — молча разъехаться не даст.
  aiPrompt:
    "Ты — опытный редактор Яндекс Дзена. Перепиши текст своими словами на русском языке: " +
    "сохрани факты, цифры и смысл, измени формулировки и структуру предложений, " +
    "сделай живой, человечный стиль без канцелярита и воды. Сохрани деление на абзацы. " +
    "Верни только готовый текст без комментариев."
};

// ------------------------------------------------------------- хранилища ---
// Настройки лежат в двух местах, и это не случайность:
//   • chrome.storage.sync — мелкие значения, которые приятно синхронизировать
//     между устройствами пользователя;
//   • chrome.storage.local — то, что может быть большим (глоссарий, список
//     сайтов для перелинковки) или секретным (API-ключ).
// Причина: у sync жёсткий лимит QUOTA_BYTES_PER_ITEM = 8192 байта НА КЛЮЧ.
// При превышении set() падает с ошибкой, и длинный глоссарий молча терялся бы
// при сохранении. В local лимит около 5 МБ на всё расширение.

const LOCAL_KEYS = ["glossary", "aiKey", "linkSites", "linkChannels"];

function isLocalKey(key) {
  return LOCAL_KEYS.indexOf(key) !== -1;
}

async function getSettings() {
  const [syncStored, localStored] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get(LOCAL_KEYS)
  ]);
  const out = { ...DEFAULTS, ...syncStored };
  // local перекрывает sync: там актуальные глоссарий и ключ.
  // Пустое значение за значение не считаем — иначе дефолтная пустая строка,
  // которую мы сами же записали при установке, затирала бы глоссарий, ещё
  // лежащий в sync от прошлой версии расширения.
  for (const k of LOCAL_KEYS) {
    const lv = localStored[k];
    if (lv !== undefined && lv !== "") out[k] = lv;
  }
  return out;
}

/**
 * Разовый перенос глоссария и API-ключа из sync в local — они лежали там до
 * того, как мы узнали про лимит 8 КБ. Значения не теряются: если в local уже
 * что-то есть, оно остаётся, а копия из sync просто удаляется.
 *
 * Проверяем при каждом чтении настроек, а не один раз за жизнь воркера: иначе
 * перенос зависел бы от того, успел ли service worker перезапуститься. В норме
 * это одно маленькое чтение двух ключей — sync уже пуст и мы выходим сразу.
 */
async function migrateLegacySettings() {
  try {
    const legacy = await chrome.storage.sync.get(LOCAL_KEYS);
    const present = LOCAL_KEYS.filter((k) => legacy[k] !== undefined && legacy[k] !== "");
    if (!present.length) return;

    const local = await chrome.storage.local.get(LOCAL_KEYS);
    const move = {};
    // Пустое значение в local — это дефолт, а не выбор пользователя: пропускаем
    // его, иначе перенос молча выбросил бы глоссарий из sync (потеря данных).
    for (const k of present) {
      const lv = local[k];
      if (lv === undefined || lv === "") move[k] = legacy[k];
    }
    if (Object.keys(move).length) await chrome.storage.local.set(move);
    await chrome.storage.sync.remove(LOCAL_KEYS);
  } catch (e) {
    /* перенос не критичен: настройки всё равно читаются из обоих хранилищ */
  }
}

/**
 * Сохраняет патч настроек, разложив его по двум хранилищам.
 * Сначала пишем local: если sync упрётся в квоту, глоссарий уже будет сохранён.
 */
async function saveSettings(patch) {
  const src = patch || {};
  const sync = {};
  const local = {};

  for (const k of Object.keys(src)) {
    if (isLocalKey(k)) local[k] = src[k];
    else sync[k] = src[k];
  }

  if (Object.keys(local).length) await chrome.storage.local.set(local);

  if (Object.keys(sync).length) {
    try {
      await chrome.storage.sync.set(sync);
    } catch (e) {
      const m = String((e && e.message) || e);
      if (!/quota/i.test(m)) throw e;
      // Находим виновника, чтобы сказать пользователю, что именно сократить
      let bad = null;
      let worst = 0;
      for (const k of Object.keys(sync)) {
        const size = k.length + JSON.stringify(sync[k]).length;
        if (size > worst) {
          worst = size;
          bad = k;
        }
      }
      const err = new Error(
        "Поле «" +
          (bad || "настройка") +
          "» слишком большое для синхронизации (лимит 8 КБ на поле, сейчас ≈" +
          Math.round(worst / 1024) +
          " КБ). Сократите его — глоссарий и API-ключ уже сохранены, их лимит не касается."
      );
      err.quota = true;
      throw err;
    }
  }

  return { sync: Object.keys(sync), local: Object.keys(local) };
}

/**
 * Первичная заливка значений по умолчанию. Пишем только те ключи, которых
 * реально нет, — чтобы не затирать настройку, сохранённую в момент установки.
 */
async function seedDefaults() {
  const [syncStored, localStored] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get(LOCAL_KEYS)
  ]);

  const syncSeed = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (isLocalKey(k)) continue;
    if (syncStored[k] === undefined) syncSeed[k] = DEFAULTS[k];
  }

  const localSeed = {};
  for (const k of LOCAL_KEYS) {
    // Пустые значения по умолчанию в local не пишем: они ничего не добавляют,
    // зато создают неоднозначность «пусто = дефолт или выбор пользователя»,
    // из-за которой перенос из sync мог выбросить настоящий глоссарий.
    if (localStored[k] === undefined && DEFAULTS[k] !== "") localSeed[k] = DEFAULTS[k];
  }

  if (Object.keys(localSeed).length) await chrome.storage.local.set(localSeed);
  if (Object.keys(syncSeed).length) await chrome.storage.sync.set(syncSeed);

  return { sync: Object.keys(syncSeed), local: Object.keys(localSeed) };
}

// ---------------------------------------------------------------- перевод ---
// Надёжность: таймаут на запрос, повторы с экспоненциальной паузой, кэш
// переводов, параллельные запросы, отмена по требованию и видимый фолбэк
// на второй движок.

const RETRY_TRIES = 4;
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_MAX = 500;
const CONCURRENCY_GOOGLE = 4;
const CONCURRENCY_MYMEMORY = 2;

// активные переводы: requestId -> AbortController (для отмены из контент-скрипта)
const activeRequests = new Map();

/** Режем абзац на куски по границам предложений, чтобы влезть в лимит сервиса. */
function splitChunks(text, limit) {
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+|$)/g) || [text];
  const chunks = [];
  let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > limit && buf) {
      chunks.push(buf);
      buf = "";
    }
    if (s.length > limit) {
      // экстремально длинное «предложение» — режем жёстко
      for (let i = 0; i < s.length; i += limit) chunks.push(s.slice(i, i + limit));
    } else {
      buf += s;
    }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

function abortErr() {
  const e = new Error("Перевод отменён");
  e.name = "AbortError";
  e.cancelled = true;
  return e;
}

function isAbort(e) {
  return !!e && (e.name === "AbortError" || e.cancelled === true);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortErr());
      return;
    }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortErr());
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Пауза перед повтором: 350мс, 700, 1400, 2800 + небольшой разброс. */
function backoffMs(attempt) {
  return Math.min(3000, 350 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
}

/**
 * fetch со своим таймаутом, повторами на 429/5xx/сетевых ошибках и учётом
 * заголовка Retry-After. Отмена пользователем (внешний signal) не повторяется.
 *
 * errorBody: для 4xx приложить к тексту ошибки начало тела ответа. Включается
 * поштучно — там, где сервер объясняет причину словами (у OpenAI-совместимых
 * сервисов тело 4xx говорит, что именно не так с ключом или моделью), а не
 * только кодом. Молча терять это объяснение нельзя: иначе пользователь видит
 * «HTTP 400» без причины.
 *
 * timeoutNote: что добавить к отказу по таймауту. «Таймаут 300 с» — это факт,
 * но не объяснение: у рерайта потолок растёт с объёмом текста, и упереться в
 * него можно именно на длинной статье. Кто ждал, тот знает и размер текста, и
 * что с этим делать; сам fetchJson этого не знает, поэтому пояснение приходит
 * опцией от вызывающего.
 */
async function fetchJson(url, { signal, label, tries = RETRY_TRIES, timeout = REQUEST_TIMEOUT_MS, method, headers, body, errorBody = false, timeoutNote = "" } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt < tries; attempt++) {
    if (signal && signal.aborted) throw abortErr();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), timeout);
    const onOuterAbort = () => ac.abort(abortErr());
    if (signal) {
      if (signal.aborted) onOuterAbort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    };

    try {
      const res = await fetch(url, { signal: ac.signal, method, headers, body });

      if (res.status === 429 || res.status === 408 || res.status >= 500) {
        const ra = parseFloat(res.headers.get("retry-after"));
        // Тело осмысленно и здесь: на превышение лимита AI-сервисы отвечают
        // текстом («rate limit…»), и без него в панели осталось бы сухое
        // «HTTP 429» — человек не понял бы, что дело в лимите, а не в ключе.
        const why = errorBody ? await shortBody(res) : "";
        lastErr = new Error(label + ": HTTP " + res.status + (why ? " — " + why : ""));
        cleanup();
        if (attempt < tries - 1) {
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 8000) : backoffMs(attempt), signal);
        }
        continue;
      }

      if (!res.ok) {
        // 4xx (кроме 408/429) повторять бессмысленно
        const why = errorBody ? await shortBody(res) : "";
        lastErr = new Error(label + ": HTTP " + res.status + (why ? " — " + why : ""));
        cleanup();
        break;
      }

      const data = await res.json();
      cleanup();
      return data;
    } catch (e) {
      cleanup();
      if (signal && signal.aborted) throw abortErr();
      const msg = String((e && e.message) || "");
      if (msg === "timeout") {
        // Повторять таймаут незачем: сервер принял запрос и не успел ответить —
        // во второй раз он будет думать столько же. Повторы нужны для сбоев
        // (429, 5xx, обрыв), а не для медленного ответа, и у рерайта потолок
        // теперь растёт вместе с объёмом текста: три попытки дали бы четверть
        // часа ожидания вместо пяти минут.
        lastErr = new Error(label + ": таймаут " + timeout / 1000 + " с" + (timeoutNote ? " — " + timeoutNote : ""));
        throw lastErr;
      } else if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
        // Сеть не дошла вовсе. Чаще всего это не «сервис упал», а отсутствие
        // доступа к домену: Chrome режет запрос до ответа, и человеку остаётся
        // «Failed to fetch» без подсказки, что дело в домене, а не в ключе.
        // Свой адрес API (не openai/openrouter) правами расширения не покрыт.
        let host = "";
        try { host = new URL(url).host; } catch (err) {}
        lastErr = new Error(
          label + ": запрос не дошёл" + (host ? " — нет доступа к " + host : "") +
            " или сервис недоступен. Проверьте адрес API и доступ расширения к его домену."
        );
      } else {
        lastErr = e;
      }
      if (attempt < tries - 1) await sleep(backoffMs(attempt), signal);
    }
  }

  throw lastErr || new Error(label + ": неизвестная ошибка");
}

/** Начало тела ответа одной строкой — для текста ошибки. */
async function shortBody(res, limit = 300) {
  try {
    const t = await res.text();
    return String(t || "").replace(/\s+/g, " ").trim().slice(0, limit);
  } catch (e) {
    return "";
  }
}

/** Простой пул: не больше `limit` одновременных задач, порядок результата сохраняется. */
async function mapPool(items, limit, worker, signal) {
  const out = new Array(items.length);
  let next = 0;
  let failure = null;

  async function runner() {
    while (!failure) {
      if (signal && signal.aborted) throw abortErr();
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await worker(items[i], i);
      } catch (e) {
        failure = e;
        throw e;
      }
    }
  }

  const n = Math.max(1, Math.min(limit, items.length));
  try {
    await Promise.all(Array.from({ length: n }, runner));
  } catch (e) {
    throw failure || e;
  }
  return out;
}

// ------------------------------------------------------------------ кэш ---
// Один и тот же кусок текста не переводим дважды. Живёт в chrome.storage.local.

let cacheMap = null;
let cacheDirty = false;
let cacheTimer = null;

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + "-" + s.length.toString(36);
}

function cacheKey(text, engine, source, target) {
  return engine + "|" + (source || "auto") + "|" + target + "|" + hashStr(text);
}

async function loadCache() {
  if (cacheMap) return cacheMap;
  try {
    const st = await chrome.storage.local.get({ dzrCache: {} });
    cacheMap = new Map(Object.entries(st.dzrCache || {}));
  } catch (e) {
    cacheMap = new Map();
  }
  return cacheMap;
}

function scheduleCacheSave() {
  cacheDirty = true;
  if (cacheTimer) return;
  cacheTimer = setTimeout(async () => {
    cacheTimer = null;
    if (!cacheDirty || !cacheMap) return;
    cacheDirty = false;
    try {
      if (cacheMap.size > CACHE_MAX) {
        const entries = [...cacheMap.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
        for (const [k] of entries.slice(0, entries.length - CACHE_MAX)) cacheMap.delete(k);
      }
      await chrome.storage.local.set({ dzrCache: Object.fromEntries(cacheMap) });
    } catch (e) {
      /* кэш — не критично, молча пропускаем */
    }
  }, 1500);
}

async function clearCache() {
  cacheMap = new Map();
  cacheDirty = false;
  if (cacheTimer) clearTimeout(cacheTimer);
  cacheTimer = null;
  try {
    await chrome.storage.local.remove(["dzrCache"]);
  } catch (e) {}
}

// ------------------------------------------------- определение языка ---
// Нужно, чтобы не гонять переводчик впустую: русский текст при переводе на
// русский всё равно уходит в Google и возвращается почти без изменений, а
// запрос и время тратятся.
//
// Правило одно: отвечаем «уже на целевом языке» только при явной уверенности.
// Пропустить текст, который просили перевести (украинский при цели «русский»),
// гораздо хуже, чем лишний раз сходить в переводчик: во втором случае
// пользователь просто не заметит разницы, в первом — получит непереведённую
// статью и решит, что расширение сломалось.

const SCRIPTS = {
  cyrillic: /[\u0400-\u04FF]/g,
  latin: /[A-Za-z\u00C0-\u024F]/g,
  greek: /[\u0370-\u03FF]/g,
  hebrew: /[\u0590-\u05FF]/g,
  arabic: /[\u0600-\u06FF\u0750-\u077F]/g,
  devanagari: /[\u0900-\u097F]/g,
  thai: /[\u0E00-\u0E7F]/g,
  hangul: /[\uAC00-\uD7AF\u1100-\u11FF]/g,
  kana: /[\u3040-\u30FF]/g,
  han: /[\u4E00-\u9FFF]/g
};

const TARGET_SCRIPT = {
  ru: "cyrillic", uk: "cyrillic", be: "cyrillic", bg: "cyrillic", sr: "cyrillic", mk: "cyrillic", kk: "cyrillic",
  el: "greek",
  he: "hebrew",
  ar: "arabic", fa: "arabic", ur: "arabic",
  hi: "devanagari", mr: "devanagari", ne: "devanagari",
  th: "thai",
  ko: "hangul",
  ja: "kana",
  zh: "han",
  en: "latin", de: "latin", fr: "latin", es: "latin", it: "latin", pt: "latin", nl: "latin",
  pl: "latin", cs: "latin", sk: "latin", sv: "latin", no: "latin", da: "latin", fi: "latin",
  tr: "latin", ro: "latin", hu: "latin", id: "latin", vi: "latin", lt: "latin", lv: "latin", et: "latin"
};

// Кириллицу делят несколько языков, поэтому одной письменности мало — смотрим
// на буквы, которых в русском не бывает. Это буквы украинского, белорусского,
// сербского, македонского и тюркских кириллиц.
const NOT_RUSSIAN = /[іїєґўђћџљњјѕәғқңөұүһ]/i;
// …и наоборот: буквы, которые есть в русском и отсутствуют в болгарском.
// Болгарский иначе не отличить — у него нет ни одной «нерусской» буквы.
const RUSSIAN_ONLY = /[ыэё]/i;

// Латинский алфавит делят десятки языков, поэтому опознаём по служебным словам.
// Списки короткие и состоят из слов, которые в других языках почти не встречаются.
const LATIN_HINTS = {
  en: /\b(the|and|of|to|in|is|are|was|were|that|this|with|for|from|has|have|it|its|as|at|on|by|not|but|which|their|they|be|been|or|an|will|would|can|could)\b/gi,
  de: /\b(der|die|das|und|ist|nicht|mit|den|von|zu|sich|auf|für|als|auch|werden|wird|sind|ein|eine|einer|dass|aber|nach|bei|aus|durch|noch|nur|über)\b/gi,
  fr: /\b(le|la|les|des|une|est|dans|pour|que|qui|avec|sur|pas|plus|par|aux|ce|cette|ses|son|sa|mais|nous|vous|ils|elles|être|avoir)\b/gi,
  es: /\b(el|la|los|las|una|que|en|con|por|para|no|más|como|pero|sus|este|esta|del|al|se|es|son|hay|muy|también)\b/gi,
  it: /\b(il|lo|gli|le|di|che|non|per|con|una|sono|come|anche|più|questo|questa|nel|della|del|dei|si|ma|alla)\b/gi,
  pt: /\b(os|as|que|não|com|para|uma|dos|das|no|na|por|mais|como|mas|seu|sua|este|esta|são|é|foi|ser)\b/gi
};

// Короче этого фрагмент не оцениваем: в «OK» и «Subaru» языка не разглядеть.
const MIN_LETTERS = 30;

function scriptCounts(text) {
  const counts = {};
  let total = 0;
  for (const name of Object.keys(SCRIPTS)) {
    const m = text.match(SCRIPTS[name]);
    const n = m ? m.length : 0;
    counts[name] = n;
    total += n;
  }
  counts.total = total;
  return counts;
}

function hintScore(text, lang) {
  const m = text.match(LATIN_HINTS[lang]);
  return m ? m.length : 0;
}

/**
 * Похоже ли, что фрагмент уже написан на целевом языке?
 * `text` — текст с маркерами [[n]]; букв в маркерах нет, счётчикам они не мешают.
 */
function looksLikeTargetLang(text, targetLang) {
  const lang = String(targetLang || "").toLowerCase().split(/[-_]/)[0];
  const script = TARGET_SCRIPT[lang];
  if (!script) return false; // про этот язык ничего не знаем — не гадаем

  const counts = scriptCounts(text);
  if (counts.total < MIN_LETTERS) return false;
  // основная письменность должна занимать заметную долю: иначе это скорее
  // русский текст с английскими терминами, чем английский
  if (counts[script] / counts.total < 0.6) return false;

  if (script === "latin") {
    const mine = hintScore(text, lang);
    if (mine < 3) return false;
    // если служебных слов другого латинского языка заметно больше — не наше дело
    for (const other of Object.keys(LATIN_HINTS)) {
      if (other !== lang && hintScore(text, other) * 1.5 > mine) return false;
    }
    return true;
  }

  if (script === "cyrillic") {
    if (lang === "ru") return !NOT_RUSSIAN.test(text) && RUSSIAN_ONLY.test(text);
    if (lang === "uk") return /[іїєґ]/.test(text);
    if (lang === "be") return /[ўі]/.test(text);
    if (lang === "sr") return /[ђћџљњј]/.test(text);
    if (lang === "bg") return /ъ/.test(text) && !RUSSIAN_ONLY.test(text);
    return false; // остальные кириллические языки не различаем
  }

  // Иероглифы делят японский и китайский: кана бывает только в японском,
  // поэтому её отсутствие означает китайский.
  if (script === "han") return counts.kana === 0;
  if (script === "kana") return counts.kana > 0;

  // греческий, иврит, арабский, деванагари, тайский, хангыль: письменность
  // однозначно указывает на язык
  return true;
}

// ---------------------------------------------------------- перелинковка ---
// Задача: найти в статье упоминания моделей и превратить их в ссылки на
// материалы сайта, с которым делаем перелинковку.
//
// Текст статьи НЕ переписывается: ссылкой становится слово, которое уже есть
// в тексте. Вставленная сбоку ссылка с придуманным анкором читается как
// реклама, а упоминание в тексте — как нормальная сноска; для Дзена это
// принципиальная разница.
//
// Цель ссылки подбирается по sitemap сайта: ищем статью, в слаге которой есть
// все слова модели («Volvo XC40» → `volvo-udivila-resheniem-po-xc40-...`).
// Если sitemap прочитать не удалось, сайт всё равно используется как цель —
// ссылка ведёт на него самого.

// Марки, по которым узнаём модель в тексте. Список плоский и ручной: угадывать
// «похоже на модель» эвристикой нельзя — в ссылки попадут «Новый», «Читайте»
// и любые другие слова с заглавной буквы.
const CAR_BRANDS = [
  "Abarth", "Acura", "Alfa Romeo", "Alpina", "Aston Martin", "Audi", "Bentley", "BMW",
  "Bugatti", "Buick", "BYD", "Cadillac", "Changan", "Chery", "Chevrolet", "Chrysler",
  "Citroen", "Cupra", "Dacia", "Daewoo", "DAF", "Daihatsu", "Dodge", "Dongfeng",
  "Exeed", "FAW", "Ferrari", "Fiat", "Ford", "Freightliner", "Geely", "Genesis",
  "GMC", "Great Wall", "Haval", "Hino", "Honda", "Hummer", "Hyundai", "Infiniti",
  "International", "Isuzu", "Iveco", "Jaguar", "Jeep", "Jetour", "Kia", "Kenworth",
  "Lada", "Lamborghini", "Lancia", "Land Rover", "Lexus", "Li Auto", "Lifan", "Lincoln",
  "Lotus", "Mack", "MAN", "Maserati", "Maybach", "Mazda", "McLaren", "Mercedes",
  "Mercedes-Benz", "Mercedes-AMG", "Mini", "Mitsubishi", "Moskvich", "Neoplan", "Nio",
  "Nissan", "Omoda", "Opel", "Peugeot", "Peterbilt", "Polestar", "Porsche", "Range Rover",
  "Renault", "Rolls-Royce", "Rover", "Saab", "Scania", "Seat", "Setra", "Skoda", "Smart",
  "SsangYong", "Subaru", "Suzuki", "Tank", "Tesla", "Toyota", "Volkswagen", "Volvo",
  "Voyah", "Western Star", "Xpeng", "Zeekr",
  // Кириллицей пишут реже, но пишут — и тогда ссылка тоже должна находиться
  "Ауди", "БМВ", "Вольво", "ГАЗ", "Джили", "КамАЗ", "Лада", "Москвич", "Ниссан",
  "Рено", "Тойота", "УАЗ", "Хавал", "Хендай", "Хёндэ", "Чери", "Шкода"
];

// Слова, которые не могут быть частью названия модели. Без этого списка
// «Volvo в России» превратилось бы в ссылку с анкором «Volvo в».
const MODEL_STOP = new Set([
  "и", "в", "во", "на", "с", "со", "для", "по", "от", "до", "за", "из", "к", "ко",
  "о", "об", "при", "про", "у", "а", "но", "или", "не", "же", "ли", "бы", "это",
  "этот", "эта", "эти", "тот", "та", "те", "весь", "вся", "все", "свой", "своя",
  "свои", "новый", "новая", "новое", "новые", "старый", "старая", "первый", "второй",
  "третий", "год", "года", "году", "годы", "лет", "версия", "версии", "класс",
  "класса", "модель", "модели", "серия", "серии", "тип", "типа", "ряд", "размер",
  "цена", "цены", "фото", "видео", "обзор", "тест", "плюс", "минус", "топ",
  "the", "of", "and", "with", "for", "new", "vs", "top", "best", "all", "from",
  "into", "plus", "series", "model", "models", "class", "truck", "trucks", "van", "vans"
]);

const BRAND_INDEX = (() => {
  const idx = Object.create(null);
  CAR_BRANDS.forEach((b) => {
    idx[b.toLowerCase()] = b;
  });
  return idx;
})();

/** Слова, из которых может состоять название модели: XC40, Cayenne, T143, CLE. */
function isModelWord(word) {
  const s = String(word || "").replace(/[.\-]+$/, "");
  if (s.length < 2 || s.length > 14) return false;
  if (MODEL_STOP.has(s.toLowerCase())) return false;
  if (/^\d{4}$/.test(s)) return false; // год выпуска — не часть названия
  return /^[A-ZА-ЯЁ]/.test(s) || /\d/.test(s);
}

/** Марка в позиции i — самая длинная из подходящих («Land Rover» бьёт «Land»). */
function matchBrandAt(words, i) {
  for (let len = 3; len >= 1; len--) {
    if (i + len > words.length) continue;
    const parts = [];
    for (let k = 0; k < len; k++) parts.push(words[i + k].toLowerCase().replace(/\.$/, ""));
    const brand = BRAND_INDEX[parts.join(" ")];
    if (brand) return { len, brand };
  }
  return null;
}

/**
 * Названия моделей в тексте: марка плюс до двух слов модели.
 * Возвращает [{anchor, tokens, core}]:
 *   • tokens — все слова для поиска статьи по слагу;
 *   • core — марка плюс первое слово модели: запасной вариант поиска, когда в
 *     слаге модель названа иначе («CLE 646» в тексте, а в адресе — только «cle»).
 */
function findModels(text) {
  const src = String(text || "");
  const re = /[A-Za-z\u00C0-\u024F\u0400-\u04FF0-9][A-Za-z\u00C0-\u024F\u0400-\u04FF0-9.\-]*/g;
  const words = [];
  let m;
  while ((m = re.exec(src)) !== null) words.push(m[0].replace(/[.\-]+$/, "")); // точка от конца предложения — не часть названия

  const out = [];
  const seen = Object.create(null);
  for (let i = 0; i < words.length; i++) {
    const hit = matchBrandAt(words, i);
    if (!hit) continue;
    let j = i + hit.len;
    const tail = [];
    // Следующая марка — уже другое название, а не продолжение этого: без
    // проверки «Volvo Toyota Camry» склеилось бы в одну несуществующую модель.
    while (j < words.length && tail.length < 2 && isModelWord(words[j]) && !matchBrandAt(words, j)) {
      tail.push(words[j]);
      j++;
    }
    const brandWords = words.slice(i, i + hit.len);
    const anchor = brandWords.join(" ") + (tail.length ? " " + tail.join(" ") : "");
    // Разобранные слова дальше не пересканируем: иначе «Land Rover Discovery»
    // дало бы ещё и «Rover Discovery» — вторую, ложную модель, и она съела бы
    // ссылку, которая должна была достаться другой машине.
    i = j - 1;
    const tokens = slugTokens(anchor);
    const key = tokens.join(" ");
    if (!tokens.length || seen[key]) continue;
    seen[key] = true;
    const core = slugTokens(brandWords.join(" "));
    if (tail.length) core.push(slugTokens(tail[0])[0]);
    out.push({ anchor, tokens, core });
  }
  return out;
}

/** Слова строки в виде, в котором они встречаются в слагах URL. */
function slugTokens(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9\u00C0-\u024F\u0400-\u04FF]+/)
    .filter((t) => t.length > 1);
}

/** Список сайтов из настроек: по строке на сайт, # — комментарий. */
function parseSiteList(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.charAt(0) !== "#")
    .map((line) => (/^https?:\/\//i.test(line) ? line : "https://" + line).replace(/\/+$/, ""))
    // Строка списка становится шаблоном права, а на негодном шаблоне
    // chrome.permissions.contains не отвечает false, а падает — «Invalid value
    // for origin pattern … Invalid port». В поле при этом попадает что угодно:
    // человек копирует туда подпись к фото («Photo: Subaru of America, Inc.»).
    // Поэтому оставляем только похожее на адрес; сказать об остальном вслух
    // обязан тот, кто показывает поле, — попап. Порт числовой Chrome принимает,
    // поэтому адрес с портом (localhost:8787) сохраняем как есть.
    .filter((line) => looksLikeHost(hostOf(line)))
    .filter((line, i, all) => all.indexOf(line) === i);
}

/** Хост, пригодный для шаблона права: имя хоста и, если есть, числовой порт. */
function looksLikeHost(host) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i.test(
    String(host || "")
  );
}

function hostOf(url) {
  const m = /^https?:\/\/([^/]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "";
}

/** Ссылки на вложенные карты в sitemapindex — их тоже надо прочитать. */
function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(String(xml || ""));
}

/** Достаём адреса из sitemap. Регулярка, а не DOMParser: в service worker DOM нет. */
function parseSitemap(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) out.push(m[1].replace(/&amp;/g, "&"));
  return out;
}

const SITEMAP_TTL = 12 * 60 * 60 * 1000; // sitemap большого сайта весит сотни КБ
const SITEMAP_CACHE_KEY = "dzrSitemaps";
const SITEMAP_MAX_URLS = 5000; // больше в статьях не нужно, а кэш растёт
const SITEMAP_MAX_FILES = 6; // вложенные карты читаем не бесконечно

/** Кэш в local под произвольным ключом: карты сайтов и карты каналов. */
async function readLocalCache(key) {
  try {
    const st = await chrome.storage.local.get(key);
    return st[key] || {};
  } catch (e) {
    return {};
  }
}

async function writeLocalCache(key, cache) {
  try {
    await chrome.storage.local.set({ [key]: cache });
  } catch (e) {
    /* кэш — не ценность: не сохранился, прочитаем в следующий раз */
  }
}

/** Адрес карты: если пользователь указал .xml явно — берём его, иначе типовые пути. */
function sitemapCandidates(site) {
  if (/\.xml(\?|$)/i.test(site)) return [site];
  return ["/sitemap.xml", "/wp-sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"].map(
    (p) => site + p
  );
}

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, credentials: "omit", redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.text();
}

/** Читает карту сайта: urlset или sitemapindex с вложенными картами. */
async function loadSitemap(site, signal) {
  const queue = sitemapCandidates(site);
  const urls = [];
  let files = 0;
  const tried = [];
  while (queue.length && files < SITEMAP_MAX_FILES) {
    const url = queue.shift();
    files++;
    tried.push(url);
    let xml;
    try {
      xml = await fetchText(url, signal);
    } catch (e) {
      continue;
    }
    const locs = parseSitemap(xml);
    if (isSitemapIndex(xml)) queue.push.apply(queue, locs.slice(0, SITEMAP_MAX_FILES - files));
    else urls.push.apply(urls, locs);
    if (urls.length >= SITEMAP_MAX_URLS) break;
  }
  return { urls: urls.slice(0, SITEMAP_MAX_URLS), tried };
}

async function sitemapFor(site, signal, refresh) {
  // Ключ кэша — домен плюс путь: у одного домена может быть несколько карт
  // (например, указали /sitemap.xml напрямую, а не корень сайта).
  let path = "";
  try {
    path = new URL(site).pathname.replace(/\/+$/, "");
  } catch (e) {
    path = "";
  }
  const key = hostOf(site) + path;
  const cache = await readLocalCache(SITEMAP_CACHE_KEY);
  const hit = cache[key];
  if (!refresh && hit && Date.now() - hit.at < SITEMAP_TTL) return hit.urls;

  const res = await loadSitemap(site, signal);
  if (res.urls.length) {
    cache[key] = { at: Date.now(), urls: res.urls };
    await writeLocalCache(SITEMAP_CACHE_KEY, cache);
  }
  return res.urls;
}

/**
 * Статья сайта под модель: в слаге должны найтись ВСЕ слова модели, а если
 * такой нет — хотя бы марка с первым словом модели.
 * Из подходящих берём случайную: иначе все ссылки в статье ведут в одно место.
 *
 * Элемент списка — либо строка-адрес (sitemap сайта), либо {url, title}
 * (статья канала Дзена). Во втором случае искать приходится по заголовку:
 * адрес статьи на Дзене — это /a/<случайный id>, в нём модели нет.
 */
function pickArticle(entries, tokens, core, rand) {
  const list = entries || [];
  if (!list.length) return null;
  const r = typeof rand === "function" ? rand() : Math.random();
  const urlOf = (e) => (typeof e === "string" ? e : e.url);
  const hayOf = (e) =>
    typeof e === "string"
      ? e.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "")
      : String(e.title || "") + " " + String(e.url || "").replace(/^https?:\/\/[^/]+/, "");
  const tryFind = (need) => {
    if (!need || !need.length) return null;
    const hits = [];
    for (const e of list) {
      const set = new Set(slugTokens(hayOf(e)));
      if (need.every((t) => set.has(t))) hits.push(urlOf(e));
    }
    if (!hits.length) return null;
    return hits[Math.min(hits.length - 1, Math.floor(r * hits.length))];
  };
  return tryFind(tokens) || tryFind(core);
}

// --------------------------------------------------------- каналы Дзена ---
// У канала на Дзене нет sitemap.xml: запрос к нему отдаёт заглушку антибота
// (страницу «установите приложение»), а не карту. Зато платформа отдаёт ленту
// канала открытым JSON — им и строим «карту канала»: обходим страницы выдачи
// и складываем адреса статей вместе с заголовками.
//
// Заголовок здесь не украшение. Адрес статьи на Дзене — /a/<случайный id>,
// поэтому модель ищется по заголовку; без него ссылка не нашлась бы никогда.
//
// Если обход не удался, канал всё равно остаётся целью ссылки — ведём на сам
// канал. Так же ведёт себя сайт без карты.

const CHANNEL_API = "https://dzen.ru/api/v3/launcher/export";
const CHANNEL_CACHE_KEY = "dzrChannels";
const CHANNEL_TTL = 12 * 60 * 60 * 1000;
const CHANNEL_MAX_PAGES = 6; // страница выдачи — около 20 статей
const CHANNEL_MAX_ARTICLES = 300;

/**
 * Имя канала для API. Принимаем и полный адрес, и короткую запись:
 * «https://dzen.ru/auto-dom24.ru/» → «auto-dom24.ru», «dzen.ru/id/123» → «id/123».
 */
function channelName(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/^(?:www\.)?(?:dzen\.ru|zen\.yandex\.ru)\/?/i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** Адрес канала, на который ведём, если статьи не нашлись. */
function channelUrl(name) {
  return "https://dzen.ru/" + name;
}

/** Список каналов из настроек: по строке на канал, # — комментарий. */
function parseChannelList(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.charAt(0) !== "#")
    .map(channelName)
    .filter(Boolean)
    .filter((name, i, all) => all.indexOf(name) === i);
}

/**
 * Статьи одной страницы выдачи: карточки с адресом и заголовком.
 * owner — publisher_id своего канала, если его удалось узнать с первой страницы.
 */
function channelPageArticles(data, owner) {
  const items = (data && data.items) || [];
  const out = [];
  for (const it of items) {
    // Подборки, видео и реклама — не статьи: ссылаться на них нельзя.
    if (!it || it.type !== "card") continue;
    // Лента канала может подмешать рекомендации других авторов, а ссылаться на
    // чужие статьи нам нечем. Отбрасываем только те карточки, про которые точно
    // знаем, что они чужие: если поля с автором нет, карточку оставляем — иначе
    // смена схемы API обнулила бы всю карту.
    const pub = it.publisher_id != null ? String(it.publisher_id) : "";
    if (owner && pub && pub !== owner) continue;
    const url = it.share_link || String(it.link || "").split("?")[0];
    if (!url) continue;
    out.push({ url, title: String(it.title || "").trim() });
  }
  return out;
}

/** Обходим выдачу канала, пока платформа даёт следующую страницу. */
async function loadChannel(name, signal) {
  const articles = [];
  const seen = new Set();
  let url = CHANNEL_API + "?channel_name=" + encodeURIComponent(name);
  let owner = "";
  let pages = 0;
  while (url && pages < CHANNEL_MAX_PAGES && articles.length < CHANNEL_MAX_ARTICLES) {
    pages++;
    let data;
    try {
      data = await fetchJson(url, { signal, label: "Канал Дзена" });
    } catch (e) {
      break; // первая страница не открылась — обход бессмысленен
    }
    if (!owner && data && data.channel && data.channel.source) {
      owner = String(data.channel.source.publisher_id || "");
    }
    for (const a of channelPageArticles(data, owner)) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      articles.push(a);
    }
    // Ссылку на следующую страницу берём как есть: в ней подписанный _csrf,
    // который сами мы не воспроизведём.
    const next = data && data.more && data.more.link;
    url = typeof next === "string" ? next : "";
  }
  return articles.slice(0, CHANNEL_MAX_ARTICLES);
}

/** Карта канала: из кэша или обходом. refresh — обойти заново. */
async function channelArticles(name, signal, refresh) {
  const cache = await readLocalCache(CHANNEL_CACHE_KEY);
  const hit = cache[name];
  if (!refresh && hit && Date.now() - hit.at < CHANNEL_TTL) return hit.articles;

  const articles = await loadChannel(name, signal);
  // Пустой обход не затирает прежнюю карту: сеть могла просто отвалиться.
  if (articles.length) {
    cache[name] = { at: Date.now(), articles };
    await writeLocalCache(CHANNEL_CACHE_KEY, cache);
  }
  return articles;
}

/**
 * Обход каналов по требованию — кнопка «Обновить карты каналов» в настройках.
 * Возвращает по каналу число найденных статей, чтобы человек видел результат,
 * а не гадал, сработало ли.
 */
async function refreshChannels(settings) {
  const names = parseChannelList(settings.linkChannels);
  const out = [];
  for (const name of names) {
    let articles = [];
    try {
      articles = await channelArticles(name, null, true);
    } catch (e) {
      articles = [];
    }
    out.push({ name, count: articles.length });
  }
  return out;
}

// ------------------------------------------------- карта канала как файл ---
// Обход канала собирает карту внутри расширения. Здесь та же карта отдаётся
// файлом sitemap.xml: её может понадобиться отдать наружу — поисковику,
// в другой инструмент, просто посмотреть списком.
//
// Заголовок статьи кладём XML-комментарием. В схеме sitemap места под него нет,
// но и без заголовка список бесполезен: адрес статьи на Дзене — /a/<случайный
// id>, по нему не понять, о чём материал. Комментарий схеме не мешает —
// читатели sitemap его игнорируют.

/** Экранирование XML. Адреса и заголовки приходят из сети — доверять им нельзя. */
function escapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Текст для XML-комментария. Внутри комментария недопустимы «--» и хвостовое
 * «-»: иначе закрывающая «-->» закрывает комментарий раньше времени и разбор
 * всего файла ломается. Заголовки приходят из сети, поэтому чистим, а не надеемся.
 */
function xmlComment(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/-{2,}/g, "-")
    .replace(/-$/, "- ");
}

/** Карта канала в виде sitemap.xml. */
function channelSitemap(articles) {
  const rows = (articles || []).map((a) => {
    const title = xmlComment(a.title);
    // Двойной пробел вылезает, когда заголовок кончался на «-»: xmlComment
    // разводит такой дефис пробелом, а шаблон добавляет ещё один. Схлопываем —
    // xmlComment уже свёл все пробелы к одиночным, так что вреда нет.
    const note = title ? ("<!-- " + title + " -->").replace(/ {2,}/g, " ") : "";
    return (
      "  <url>\n" +
      (note ? "    " + note + "\n" : "") +
      "    <loc>" + escapeXml(a.url) + "</loc>\n" +
      "  </url>"
    );
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    (rows.length ? rows.join("\n") + "\n" : "") +
    "</urlset>\n"
  );
}

/** Имя файла: «auto-dom24.ru» и «id/123» не должны схлопнуться в одно. */
function sitemapFileName(name) {
  const safe = String(name || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return "sitemap-" + (safe || "channel") + ".xml";
}

/**
 * Карты всех указанных каналов — файлами. Берём уже собранную карту, а не
 * обходим заново: обход — это до шести запросов на канал, и ждать его при
 * каждом нажатии «Выгрузить» незачем. Обновить перед выгрузкой — кнопкой
 * «Обновить карты каналов».
 */
async function exportChannelMaps(settings) {
  const names = parseChannelList(settings.linkChannels);
  if (!names.length) throw new Error("Каналы не указаны.");

  // Сегодня dzen.ru лежит в обязательных правах и выдан при установке, поэтому
  // проверка всегда проходит. Оставлена как страховка на случай переезда права
  // в необязательные: тогда выгрузка честно скажет, чего не хватает, вместо
  // непонятной сетевой ошибки.
  const allowed = await chrome.permissions.contains({ origins: ["https://dzen.ru/*"] });
  if (!allowed) {
    const err = new Error("Нет доступа к dzen.ru. Нажмите «Разрешить доступ к сайтам».");
    err.needPermission = true;
    throw err;
  }

  const files = [];
  for (const name of names) {
    let articles = [];
    try {
      articles = await channelArticles(name, null, false);
    } catch (e) {
      articles = [];
    }
    files.push({
      name,
      count: articles.length,
      filename: sitemapFileName(name),
      xml: channelSitemap(articles)
    });
  }
  return { files };
}

/**
 * Готовит список ссылок-кандидатов: анкор (найденный в тексте) → адрес.
 * Возвращает больше, чем нужно поставить, — раскладкой по абзацам занимается
 * контент-скрипт, он видит структуру статьи.
 */
async function buildLinks(text, settings, opts = {}) {
  const sites = parseSiteList(settings.linkSites);
  const channels = parseChannelList(settings.linkChannels);
  const models = findModels(text);
  const stats = {
    models: models.length,
    sites: sites.length,
    channels: channels.length,
    links: 0,
    noSitemap: [],
    noChannel: [],
    siteOnly: 0,
    unmapped: []
  };
  if ((!sites.length && !channels.length) || !models.length) return { links: [], stats };

  // Без разрешения на домен запрос к чужому sitemap не состоится, и человек
  // получил бы невнятное «Failed to fetch» вместо понятного шага.
  const origins = sites.map((s) => s + "/*");
  if (channels.length) origins.push("https://dzen.ru/*");
  if (typeof chrome !== "undefined" && chrome.permissions && chrome.permissions.contains) {
    let allowed = true;
    try {
      allowed = await chrome.permissions.contains({ origins });
    } catch (e) {
      allowed = true; // проверка недоступна — не мешаем работать
    }
    if (!allowed) {
      const err = new Error(
        "Нет доступа к сайтам из списка. Откройте настройки расширения и нажмите «Разрешить доступ к сайтам»."
      );
      err.needPermission = true;
      throw err;
    }
  }

  // Источники ссылок: сайты (по sitemap) и каналы (по обходу выдачи). Ключ —
  // адрес, на который ведём, если статьи не нашлись: сам сайт или сам канал.
  const pools = new Map();
  for (const site of sites) {
    let urls = [];
    try {
      urls = await sitemapFor(site, opts.signal, opts.refresh);
    } catch (e) {
      urls = [];
    }
    if (!urls.length) stats.noSitemap.push(hostOf(site) || site);
    pools.set(site, urls);
  }
  for (const name of channels) {
    let list = [];
    try {
      list = await channelArticles(name, opts.signal, opts.refresh);
    } catch (e) {
      list = [];
    }
    if (!list.length) stats.noChannel.push(name);
    pools.set(channelUrl(name), list);
  }

  const sources = Array.from(pools.keys());
  const links = [];
  models.forEach((model, i) => {
    // Источники перебираем по кругу: первая модель идёт на первый, вторая —
    // на второй. Иначе все ссылки соберутся на первом сайте списка.
    for (let k = 0; k < sources.length; k++) {
      const src = sources[(i + k) % sources.length];
      const entries = pools.get(src) || [];
      const url = entries.length ? pickArticle(entries, model.tokens, model.core, opts.rand) : null;
      if (url) {
        // Заголовок тащим в результат: адрес статьи на Дзене нечитаемый, и в
        // отчёте человеку нужно название, а не /a/<случайный id>.
        const hit = entries.find((e) => (typeof e === "string" ? e : e.url) === url);
        const title = hit && typeof hit === "object" ? hit.title : "";
        links.push({ anchor: model.anchor, url, site: src, kind: "article", title });
        return;
      }
      // Статья не нашлась, но источник указан явно — ведём на него самого.
      if (!entries.length) {
        links.push({ anchor: model.anchor, url: src, site: src, kind: "site" });
        stats.siteOnly++;
        return;
      }
    }
    stats.unmapped.push(model.anchor);
  });

  stats.links = links.length;
  return { links, stats };
}

// --------------------------------------------------------------- движки ---

async function googleTranslate(text, source, target, signal) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=" +
    encodeURIComponent(source || "auto") +
    "&tl=" +
    encodeURIComponent(target) +
    "&q=" +
    encodeURIComponent(text);
  const data = await fetchJson(url, { signal, label: "Google Translate" });
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("Google Translate: неожиданный ответ");
  return data[0].map((part) => (part && part[0]) || "").join("");
}

async function myMemoryTranslate(text, source, target, signal) {
  const pair = (source && source !== "auto" ? source : "en") + "|" + target;
  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) +
    "&langpair=" +
    encodeURIComponent(pair);
  const data = await fetchJson(url, { signal, label: "MyMemory" });
  const out = data && data.responseData && data.responseData.translatedText;
  if (!out) throw new Error("MyMemory: пустой ответ");
  // MyMemory умеет отдавать ошибки прямо в тексте ответа
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID (SOURCE|TARGET|EMAIL)/i.test(out)) {
    throw new Error("MyMemory: " + out.slice(0, 80));
  }
  if (data.responseStatus && Number(data.responseStatus) !== 200) {
    throw new Error("MyMemory: статус " + data.responseStatus);
  }
  return out;
}

function enginePair(engine) {
  const google = { name: "Google", fn: googleTranslate, concurrency: CONCURRENCY_GOOGLE, limit: 1600 };
  const mymemory = { name: "MyMemory", fn: myMemoryTranslate, concurrency: CONCURRENCY_MYMEMORY, limit: 480 };
  return engine === "mymemory" ? { primary: mymemory, fallback: google } : { primary: google, fallback: mymemory };
}

/**
 * Перевод с сохранением структуры абзацев.
 * Возвращает { text, stats }. Отдельный кусок, который не удалось перевести
 * ни одним движком, остаётся как есть — но если не удалось ВСЁ, бросаем ошибку.
 */
async function translateText(text, { sourceLang, targetLang, engine, skipSameLang }, opts = {}) {
  const signal = opts.signal;
  const { primary, fallback } = enginePair(engine);
  const paragraphs = String(text).replace(/\r\n/g, "\n").split(/\n{2,}/);
  const canSkip = skipSameLang !== false;

  // разбиваем на куски, сохраняя структуру «абзац -> куски»
  const jobs = [];
  const shape = paragraphs.map((para) => {
    if (!para.trim()) return [];
    return splitChunks(para, primary.limit).map((chunk) => {
      const job = { chunk, key: cacheKey(chunk, engine, sourceLang, targetLang) };
      // фрагмент уже на целевом языке — переводчик ему не нужен
      if (canSkip && looksLikeTargetLang(chunk, targetLang)) job.same = true;
      jobs.push(job);
      return job;
    });
  });

  const total = jobs.length;
  const stats = {
    total,
    done: 0,
    percent: 0,
    cached: 0,
    skipped: 0,
    fellBack: 0,
    failed: 0,
    engine: primary.name,
    fallbackName: fallback.name
  };

  const report = () => {
    stats.percent = total ? Math.round((stats.done / total) * 100) : 100;
    if (opts.onProgress) opts.onProgress({ ...stats });
  };
  report();

  if (!total) return { text: String(text).trim(), stats };

  const cache = await loadCache();

  await mapPool(
    jobs,
    primary.concurrency,
    async (job) => {
      // Проверяем ДО кэша: если фрагмент уже на целевом языке, кэшировать нечего.
      if (job.same) {
        job.text = job.chunk;
        stats.skipped++;
        stats.done++;
        report();
        return;
      }

      const hit = cache.get(job.key);
      if (hit && typeof hit.t === "string" && hit.t) {
        job.text = hit.t;
        stats.cached++;
        stats.done++;
        report();
        return;
      }

      let out = null;
      try {
        out = await primary.fn(job.chunk, sourceLang, targetLang, signal);
      } catch (e) {
        if (isAbort(e) || (signal && signal.aborted)) throw abortErr();
        try {
          out = await fallback.fn(job.chunk, sourceLang, targetLang, signal);
          stats.fellBack++;
        } catch (e2) {
          if (isAbort(e2) || (signal && signal.aborted)) throw abortErr();
          job.text = job.chunk; // оставляем оригинал: лучше непереведённый кусок, чем потерянный
          job.failed = true;
          stats.failed++;
          stats.done++;
          report();
          return;
        }
      }

      job.text = out;
      cache.set(job.key, { t: out, at: Date.now() });
      scheduleCacheSave();
      stats.done++;
      report();
    },
    signal
  );

  if (stats.failed && stats.failed === total) {
    throw new Error("Сервис перевода недоступен. Проверьте интернет и попробуйте ещё раз.");
  }

  const result = shape.map((para) =>
    para
      .map((j) => j.text)
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );

  return { text: result.join("\n\n").trim(), stats };
}

// ------------------------------------------------------------- AI-рерайт ---

// Потолок ожидания AI-рерайта. Постоянное число здесь плохо с двух сторон:
// короткий режет длинную статью, длинный заставляет ждать впустую на короткой.
// Модель пишет ответ по объёму текста, поэтому потолок растёт вместе с ним и
// упирается в предел — иначе зависший сервис держал бы панель вечно.
// Живая проба (модель с рассуждением, 63 слова): 13 с, то есть ≈200 мс на слово;
// у обычных моделей быстрее, но запас берём по медленной.
const AI_TIMEOUT_MS = 90000; // база: накладные расходы и короткий текст
const AI_TIMEOUT_PER_WORD_MS = 150; // прибавка на каждое слово
const AI_TIMEOUT_MAX_MS = 300000; // предел для облака
// Своя модель (Ollama, LM Studio) считает на своей машине и никого не
// тарифицирует: у неё выше и база, и предел.
const AI_LOCAL_TIMEOUT_MS = 300000;
const AI_LOCAL_TIMEOUT_MAX_MS = 600000;
// Проверка ключа на своей машине может грузить модель в память с диска — на
// слабой машине это дольше тридцати секунд, а «таймаут» здесь читался бы как
// «ключ неверный». Сама просьба короткая, поэтому потолок у неё постоянный.
const AI_LOCAL_CHECK_TIMEOUT_MS = 120000;

/**
 * Сколько ждём ответ модели на этот текст. Пять минут для облака — предел
 * осознанный: длиннее человек уже не ждёт, а отказ виден в панели, и текст
 * можно переписать встроенным рерайтером. Пять минут безопасны и для
 * сервис-воркера: с Chrome 110 он завершается, если одно событие обрабатывается
 * дольше пяти минут, но запрос идёт внутри ответа на сообщение из
 * контент-скрипта, а обмен сообщениями держит воркер живым и отменяет таймер.
 */
function aiTimeoutMs(text, local) {
  const words = textWords(text);
  const base = local ? AI_LOCAL_TIMEOUT_MS : AI_TIMEOUT_MS;
  const max = local ? AI_LOCAL_TIMEOUT_MAX_MS : AI_TIMEOUT_MAX_MS;
  return Math.min(max, base + words * AI_TIMEOUT_PER_WORD_MS);
}

/** Сколько слов в тексте. Считает и потолок, и объяснение к его отказу. */
function textWords(text) {
  return String(text || "").split(/\s+/).filter(Boolean).length;
}

/**
 * Пояснение к отказу по таймауту. Живёт отдельно от запроса, потому что это
 * единственная часть отказа, которую видно только после долгого ожидания:
 * собрать её внутри `aiRewrite` значило бы не иметь возможности проверить её
 * иначе как пятиминутным ожиданием.
 *
 * Про ключ сказано прямо: «таймаут» после пяти минут ожидания человек читает
 * как «ключ не тот», и это самое дорогое ложное прочтение — он идёт править
 * рабочие настройки вместо того, чтобы взять модель побыстрее.
 */
function aiTimeoutNote(text) {
  return (
    "модель не успела ответить на " +
    textWords(text) +
    " слов — дело в длине текста и скорости модели, а не в ключе. " +
    "Поможет модель побыстрее или разбиение статьи"
  );
}

/**
 * Адрес на своей машине. У такого сервиса три отличия, и все три нам важны:
 * ключа он не спрашивает (Ollama принимает запрос без `Authorization`),
 * отвечает медленнее облака и доступен расширению только по http.
 */
function isLocalAiBase(base) {
  let host = "";
  try {
    host = new URL(String(base || "")).hostname.toLowerCase();
  } catch (e) {
    return false; // негодный адрес — не наша забота, отказ будет по существу
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" || // в браузере hostname приходит в скобках
    /\.local$/.test(host)
  );
}

/** Есть чем ходить в AI: ключ или свой адрес — второму ключ не нужен вовсе. */
function aiHasAccess(settings) {
  return !!settings.aiKey || isLocalAiBase(settings.aiBaseUrl || DEFAULTS.aiBaseUrl);
}

/**
 * Заголовки запроса к AI. Пустой ключ — это не «нет ключа», а мусорный
 * заголовок `Authorization: Bearer `, который чужой сервер вправе отвергнуть.
 * Своя модель ключа не ждёт, поэтому без ключа заголовка просто нет.
 */
function aiHeaders(settings) {
  const headers = { "Content-Type": "application/json" };
  if (settings.aiKey) headers.Authorization = "Bearer " + settings.aiKey;
  return headers;
}

async function aiRewrite(text, settings, opts = {}) {
  const base = (settings.aiBaseUrl || DEFAULTS.aiBaseUrl).replace(/\/+$/, "");
  const local = isLocalAiBase(base);
  const data = await fetchJson(base + "/chat/completions", {
    signal: opts.signal,
    label: "AI",
    tries: local ? 1 : 3,
    timeout: aiTimeoutMs(text, local),
    // Таймаут рерайта — единственный отказ, который человек видит после долгого
    // ожидания, и «таймаут 300 с» само по себе читается как поломка ключа.
    // На деле это чаще всего длина текста: потолок растёт с объёмом, но предел
    // у него есть. Говорим это прямо, вместе с тем, что делать.
    timeoutNote: aiTimeoutNote(text),
    method: "POST",
    headers: aiHeaders(settings),
    body: JSON.stringify({
      model: settings.aiModel || DEFAULTS.aiModel,
      temperature: 0.75,
      messages: [
        { role: "system", content: settings.aiPrompt || DEFAULTS.aiPrompt },
        { role: "user", content: text }
      ]
    })
  });
  const out = aiContent(data);
  // «Пустой ответ» без тела — тупик: непонятно, адрес не тот, модель не та или
  // сервис отказал. Тело ответа отвечает на это одним взглядом. Отдельно
  // называем модель с рассуждением: у неё текст уезжает в `reasoning`, а
  // `content` приходит пустым — человеку это не увидеть, а причина именно там.
  if (!out) {
    const choice = aiChoice(data);
    const why =
      choice && choice.finish_reason === "length"
        ? " Похоже, это модель с рассуждением: весь лимит ответа ушёл на размышление (finish_reason: length), а текста в content не осталось."
        : "";
    throw new Error("AI ответил, но текста в ответе нет." + why + " Начало ответа: " + headOf(JSON.stringify(data)));
  }
  return out.trim();
}

/** Начало ответа для текста ошибки: без него форма ответа не видна. */
function headOf(xml) {
  return String(xml || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

// ------------------------------------------------------- проверка ключей ---

// Сколько просим у модели на проверке. Восемь токенов — это «ответь одним
// словом», больше незачем: проверка должна стоить копейки. Но у моделей с
// рассуждением (deepseek, o-серия, glm с thinking) ответ приходит в поле
// `reasoning`, и восьми токенов хватает ровно на то, чтобы `content` остался
// пустым. Тогда проверка спрашивает второй раз с запасом — и уже по этому
// ответу решает, рабочий ли ключ.
const AI_CHECK_MAX_TOKENS = 8;
const AI_CHECK_RETRY_MAX_TOKENS = 256;
// Потолки проверки. Первый запрос — восемь токенов, он обязан вернуться быстро,
// и 30 с здесь уже запас. Второй в тридцать два раза больше и адресован ровно
// той модели, ради которой он и делается, — модели с рассуждением, а она
// медленная. Один потолок на оба запроса означал бы, что времени не хватает
// именно тогда, когда ответ нужнее всего, и человек читал бы «таймаут» вместо
// вердикта. Своя машина держит свой потолок на оба: там медленное — загрузка
// модели с диска, а не ответ.
const AI_CHECK_TIMEOUT_MS = 30000;
const AI_CHECK_RETRY_TIMEOUT_MS = 90000;

/** Первый вариант ответа модели: у chat-совместимых сервисов он один. */
function aiChoice(data) {
  return (data && data.choices && data.choices[0]) || null;
}

/**
 * Текст ответа модели. Пусто бывает у моделей с рассуждением: они пишут в
 * `reasoning`, а `content` оставляют пустым. Пустая строка и «поля нет» —
 * разные вещи, поэтому возвращаем именно строку либо пустоту.
 */
function aiContent(data) {
  const msg = aiChoice(data) && aiChoice(data).message;
  return (msg && typeof msg.content === "string" && msg.content.trim()) || "";
}

/**
 * Сервис ответил по-настоящему (структура ответа чат-модели на месте), даже
 * если текста в нём нет. Этого достаточно, чтобы не отправлять человека чинить
 * адрес API: `{"code":500,"msg":"404 NOT_FOUND"}` такого ответа не даёт.
 */
function aiAnswered(data) {
  const msg = aiChoice(data) && aiChoice(data).message;
  return !!(msg && typeof msg.content === "string");
}

// Кнопка «Проверить» в настройках. Смысл простой: о нерабочем ключе человек
// должен узнавать в настройках, а не на середине статьи после десяти минут
// перевода. Поэтому проверка делает один настоящий запрос и говорит, что
// ответил сервис.
//
// Проверяем ровно тот путь, которым пользуется расширение: тот же адрес, тот
// же заголовок, та же модель. Тогда «ключ рабочий» означает не «сервис жив»,
// а «вот этим ключом рерайт пройдёт». Побочная польза: неверное название
// модели тоже всплывает здесь.
//
// Ключи берём из полей попапа (msg.overrides), а не из хранилища: проверять
// надо то, что человек только что вписал, — иначе кнопка проверяла бы прошлую
// версию настроек. Запросы платные, поэтому
// проверка идёт только по нажатию и без повторов.

async function checkAiKey(settings) {
  const base = (settings.aiBaseUrl || DEFAULTS.aiBaseUrl).replace(/\/+$/, "");
  const local = isLocalAiBase(base);
  // Своя модель ключа не спрашивает, и требовать его здесь значило бы не пустить
  // человека к работающему рерайту из-за пустого поля. README обещал это с самого
  // начала — но обещал зря, пока проверка и рерайт требовали ключ.
  if (!settings.aiKey && !local) throw new Error("Не указан API-ключ — впишите его в поле выше");

  const model = settings.aiModel || DEFAULTS.aiModel;
  // Просьба короткая и с потолком на ответ: проверяем ключ и название модели,
  // а не платим за абзац текста. Провайдер, который не принимает max_tokens,
  // скажет об этом в ответе — и это тоже честный ответ.
  const ask = (maxTokens, timeout) =>
    fetchJson(base + "/chat/completions", {
      label: "Проверка ключа",
      tries: 1,
      timeout,
      method: "POST",
      headers: aiHeaders(settings),
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: "Ответь одним словом: ok" }]
      }),
      errorBody: true
    });

  let data = await ask(AI_CHECK_MAX_TOKENS, local ? AI_LOCAL_CHECK_TIMEOUT_MS : AI_CHECK_TIMEOUT_MS);
  let answer = aiContent(data);
  // Пустой ответ при целом ответе модели — это, как правило, модель с
  // рассуждением: восемь токенов ушли в поле `reasoning`, а `content` остался
  // пустым (`finish_reason: "length"`). Ругаться на адрес API в этом случае
  // нельзя — ключ и название модели рабочие, а виноват наш собственный лимит.
  // Поэтому спрашиваем второй раз с запасом: обычно этого хватает, чтобы
  // увидеть настоящий ответ. Повтор идёт только по этой причине и только один.
  if (!answer && aiAnswered(data)) {
    data = await ask(
      AI_CHECK_RETRY_MAX_TOKENS,
      local ? AI_LOCAL_CHECK_TIMEOUT_MS : AI_CHECK_RETRY_TIMEOUT_MS
    );
    answer = aiContent(data);
  }

  if (!answer) {
    // Ответ модели в теле есть, текста в нём нет даже с запасом: модель только
    // рассуждает. Это не «неверный адрес», но и не «ключ рабочий» — рерайт
    // таким ответом не получится, и человек должен знать, почему.
    if (aiAnswered(data)) {
      return (
        "Сервис ответил, модель «" +
        (data.model || model) +
        "» существует, но текста в ответе нет даже с запасом лимита — похоже, это модель " +
        "с рассуждением, и весь ответ уходит в размышление. Проверьте её на настоящем тексте."
      );
    }
    // Код 200 — это ещё не ответ модели. Неверный адрес умеет отвечать «200» с
    // телом-ошибкой: у z.ai путь без /paas/v4 отдаёт {"code":500,"msg":"404
    // NOT_FOUND"} и при этом 200. Пока проверка смотрела только на код, она
    // говорила «ключ рабочий» ровно в том случае, ради которого и существует —
    // когда рерайт не пойдёт. Поэтому проверяем, что в теле есть ответ модели.
    throw new Error(
      "Сервис ответил, но ответа модели в теле нет — проверьте адрес API (нужен адрес, к которому " +
        "дописывается /chat/completions). Начало ответа: " +
        headOf(JSON.stringify(data))
    );
  }
  const answered = data.model || model;
  return local
    ? "Модель «" + answered + "» ответила. Ключ не нужен — это свой сервер."
    : "Ключ рабочий. Модель «" + answered + "» ответила.";
}

// ------------------------------------------------------------ сообщения ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "getSettings") {
        await migrateLegacySettings();
        sendResponse({ ok: true, settings: await getSettings() });
        return;
      }

      if (msg.type === "saveSettings") {
        const saved = await saveSettings(msg.settings || {});
        sendResponse({ ok: true, saved: saved });
        return;
      }

      if (msg.type === "clearCache") {
        await clearCache();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "cancelTranslate") {
        const ac = activeRequests.get(msg.requestId);
        if (ac) ac.abort(abortErr());
        sendResponse({ ok: true, cancelled: !!ac });
        return;
      }

      if (msg.type === "translate") {
        const id = msg.requestId || "r" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        const settings = { ...(await getSettings()), ...(msg.overrides || {}) };
        const ac = new AbortController();
        activeRequests.set(id, ac);

        // прогресс не чаще 8 раз в секунду, чтобы не заваливать контент-скрипт
        let lastSent = 0;
        const onProgress = (p) => {
          const now = Date.now();
          if (now - lastSent < 120 && p.percent < 100) return;
          lastSent = now;
          if (sender.tab && sender.tab.id != null) {
            chrome.tabs
              .sendMessage(sender.tab.id, { type: "progress", stage: "translate", ...p })
              .catch(() => {});
          }
        };

        try {
          const res = await translateText(msg.text, settings, { signal: ac.signal, onProgress });
          sendResponse({ ok: true, text: res.text, stats: res.stats, requestId: id });
        } finally {
          activeRequests.delete(id);
        }
        return;
      }

      if (msg.type === "aiRewrite") {
        const settings = { ...(await getSettings()), ...(msg.overrides || {}) };
        // Ключ обязателен только для чужого сервиса: свой принимает запрос без него.
        if (!aiHasAccess(settings)) throw new Error("Не указан API-ключ в настройках расширения");
        const id = msg.requestId || "a" + Date.now();
        const ac = new AbortController();
        activeRequests.set(id, ac);
        // Панель должна знать, что ждать долго, — иначе неподвижное «Рерайчу…»
        // неотличимо от зависания. О самом адресе знает только фон.
        if (sender.tab && sender.tab.id != null) {
          chrome.tabs
            .sendMessage(sender.tab.id, {
              type: "progress",
              stage: "ai",
              local: isLocalAiBase(settings.aiBaseUrl || DEFAULTS.aiBaseUrl)
            })
            .catch(() => {});
        }
        try {
          sendResponse({ ok: true, text: await aiRewrite(msg.text, settings, { signal: ac.signal }) });
        } finally {
          activeRequests.delete(id);
        }
        return;
      }

      if (msg.type === "linkify") {
        const settings = { ...(await getSettings()), ...(msg.overrides || {}) };
        const res = await buildLinks(msg.text, settings, { refresh: !!msg.refresh });
        sendResponse({ ok: true, links: res.links, stats: res.stats });
        return;
      }

      // Переобход каналов по кнопке в настройках. Отдельным сообщением, а не
      // через linkify: человек хочет увидеть, что карта собралась, до того как
      // жать перелинковку.
      if (msg.type === "refreshChannels") {
        const settings = { ...(await getSettings()), ...(msg.overrides || {}) };
        const channels = await refreshChannels(settings);
        sendResponse({ ok: true, channels });
        return;
      }

      // Выгрузка собранной карты каналов файлом sitemap.xml.
      if (msg.type === "exportChannelMap") {
        const settings = { ...(await getSettings()), ...(msg.overrides || {}) };
        // Осторожно с именем: exportChannelMaps возвращает { files }, и если
        // назвать этой переменной files, в ответ уедет { files: { files: [...] } }.
        const out = await exportChannelMaps(settings);
        sendResponse({ ok: true, files: out.files });
        return;
      }

      // Разрешение на чтение sitemap запрашивает попап — прямо из обработчика
      // клика по кнопке. Здесь такого пути нет намеренно: chrome.permissions.request
      // требует настоящего жеста пользователя, и надёжнее не гонять его через
      // service worker, а держать один путь вместо двух.

      if (msg.type === "checkKey") {
        const settings = { ...(await getSettings()), ...(msg.overrides || {}) };
        sendResponse({ ok: true, text: await checkAiKey(settings) });
        return;
      }

      sendResponse({ ok: false, error: "Неизвестный тип сообщения: " + msg.type });
    } catch (err) {
      if (isAbort(err)) {
        sendResponse({ ok: false, cancelled: true, error: "Перевод отменён" });
        return;
      }
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  })();
  return true; // асинхронный ответ
});

// --------------------------------------------------- меню и горячие клавиши ---

chrome.runtime.onInstalled.addListener(async (details) => {
  await migrateLegacySettings();
  // Заливаем значения по умолчанию только при чистой установке. При обновлении
  // или перезагрузке расширения настройки уже есть, а запись по умолчанию
  // успевала затереть только что сохранённое значение (гонка с попапом).
  if (details && details.reason === "install") await seedDefaults();
  // Подбор картинок убран в 2.0.0: вычищаем его настройки и кэш, чтобы ключи
  // не оставались в хранилище мёртвым грузом.
  try {
    await chrome.storage.sync.remove(["imgSource"]);
    await chrome.storage.local.remove(["imgKey", "imgFolder", "pixabayKey", "dzrImages"]);
  } catch (e) {}
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "dzr-run",
      title: "Перевести и отрерайтить выделенное",
      contexts: ["selection", "editable"],
      documentUrlPatterns: ["https://dzen.ru/*", "https://zen.yandex.ru/*"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "dzr-run" && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "run" }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "translate-rewrite") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: "run" }).catch(() => {});
});
