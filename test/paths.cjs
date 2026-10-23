/**
 * Общие пути для тестов. Всё считается относительно репозитория, а не
 * зашито абсолютными строками: тесты должны запускаться из любого места.
 *
 * Переопределяется переменными окружения:
 *   DZR_EXT     — папка расширения, которую грузим в Chrome (по умолчанию собранная)
 *   DZR_CHROME  — путь к chrome.exe
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

/**
 * Git Bash отдаёт пути в своём виде (/c/Users/...), а Node на Windows их не
 * понимает — для него это путь от корня текущего диска, и папка «не находится».
 * Приводим к C:/Users/... .
 */
function normalize(p) {
  if (!p || process.platform !== "win32") return p;
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  return m ? m[1].toUpperCase() + ":/" + m[2] : p;
}

// Сюда тесты кладут временные копии расширения. Папка внутри проекта, потому
// что Chrome не даёт грузить расширение с путями, которые ему не нравятся,
// а ещё её видно при разборе упавших прогонов.
const SCRATCH = path.join(REPO, ".workbuddy-ai", "tmp");

const MOCK_DIR = path.join(__dirname, "mocks");

// По умолчанию тестируем СОБРАННУЮ папку, а не исходники: так прогон ловит
// и ошибку сборки тоже. Собрать — `npm run ext:build`.
const EXT = process.env.DZR_EXT
  ? path.resolve(normalize(process.env.DZR_EXT))
  : path.join(REPO, "..", "dzen-rewriter");

function findChrome() {
  if (process.env.DZR_CHROME && fs.existsSync(process.env.DZR_CHROME)) return process.env.DZR_CHROME;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

/**
 * Профиль Chrome для набора. Имя ПОСТОЯННОЕ, как и у копии расширения: прогон
 * переиспользует ту же папку. Уникальные имена копили по 33 МБ на прогон — за
 * четыре дня набралось 818 профилей и ~26 ГБ в системной temp.
 *
 * Состояние расширения здесь НЕ чистится, и это важно. Раньше мы удаляли
 * `Default/Sync Extension Settings` и `Default/Local Extension Settings`, но файлы
 * в них не отдаются: EPERM и на удаление, и на переименование, и даже на обрезку
 * до нуля — с песочницей и без неё, при обычных правах и без запущенного Chrome
 * (держит что-то внешнее). Попытка ещё и стоила до десяти секунд на набор: 20
 * повторов по 250 мс на два каталога. Поэтому чистку перенесли в
 * `clearStorage` — она идёт через сам chrome.storage.
 */
function testProfile(tag) {
  return path.join(os.tmpdir(), "dzr-test-profile-" + tag);
}

/**
 * Флаги запуска Chrome для тестов — ОБЩИЕ для всех наборов.
 *
 * Два флага важны для диска. Тестовый профиль стартует чистый, и Chrome
 * успевает докачать в него «дополнения» и компоненты: одно из них приносит
 * 1,1 ГБ в Default/Extensions. Обратно эти файлы не отдаются — удаление
 * блокирует ОС (и rm, и PowerShell, и attrib -r), так что убирать гигабайты
 * приходится руками. Легче не пускать: --disable-background-networking
 * запрещает фоновые загрузки, --disable-component-update — обновления
 * компонентов. Профиль перестаёт расти от прогона к прогону.
 *
 * Остальные флаги были выписаны в каждом харнессе заново; одиннадцать наборов
 * уже не совпадали со «списком соседа», поэтому они здесь.
 */
function chromeFlags() {
  return [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-default-browser-check",
    "--no-first-run",
    "--disable-gpu"
  ];
}

/**
 * Убирает настройки расширения, оставшиеся от прошлого прогона.
 *
 * Зачем: профиль переиспользуется, а состояние из него файлами не убрать (см.
 * `testProfile`). Без сброса набор видит прошлый прогон, и проверки «по
 * умолчанию» перестают что-либо проверять. На test-popup это видно прямо:
 * ожидали снятую галочку приписки и текст по умолчанию, а получали включённую
 * галочку и «Свой текст приписки для проверки.» — состояние прошлого прогона.
 * На test-ui из-за того же «до» и «после» переключения стиля совпадали.
 *
 * Почему не изнутри расширения: сначала сброс вставляли в `background.js` копии
 * (приём тот же, что с подменой внешних API), но у наборов service worker не
 * запускается — попап читает `chrome.storage` напрямую, фоновых сообщений нет, —
 * и вставка молча ничего не делала. Поэтому чистим снаружи, через страницу
 * расширения: только у неё есть доступ к `chrome.storage`.
 *
 * Если очистка не прошла — падаем. Иначе набор снова увидит чужое состояние, а
 * прогон покажет зелёный: это ровно тот случай, когда проверка проходит, ничего
 * не проверив.
 */
async function clearStorage(c, extId, extPath) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Перезагружаем расширение — до работы с хранилищем. Chrome НЕ перечитывает
  // файлы программно загруженного расширения: service worker поднимался со
  // скриптом от прошлого прогона, и в нём не было функций, которые на диске уже
  // есть (ловится `typeof` в самом воркере, см. скилл). Пока наборы этого не
  // делали, фон проверялся в старой версии, а правки в background.js проходили
  // мимо браузерных проверок.
  //
  // `chrome.runtime.reload()` тут не годится: программно загруженное расширение
  // он выгружает НАСОВСЕМ — вкладки расширения после него уже не открываются
  // (проверено отдельным экспериментом). Работает выгрузка с последующей
  // загрузкой — то же, что кнопка «Обновить» на странице расширений.
  if (extPath) {
    try {
      await c.send("Extensions.uninstall", { id: extId });
    } catch (e) {
      // Старый Chrome такого метода не знает — тогда останется только очистка.
    }
    await sleep(300);
    const back = await c.send("Extensions.loadUnpacked", { path: extPath });
    if (!back || !back.id) throw new Error("расширение не загрузилось заново после выгрузки");
  }

  const { targetId } = await c.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await c.send("Runtime.enable", {}, sessionId);
    // Страница открывается не мгновенно: пока её нет, chrome.* ещё не определён.
    // Здесь же видно, что расширение вообще поднялось: если оно выгружено, очистка
    // не пройдёт и набор упадёт, а не покажет зелёный на старом коде.
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      const probe = await c.send(
        "Runtime.evaluate",
        { expression: "typeof chrome !== 'undefined' && !!chrome.storage", returnByValue: true },
        sessionId
      );
      ready = !probe.exceptionDetails && probe.result && probe.result.value === true;
      if (!ready) await sleep(100);
    }
    const r = await c.send(
      "Runtime.evaluate",
      {
        expression:
          "(async () => { await chrome.storage.sync.clear(); await chrome.storage.local.clear(); return 'ok'; })()",
        returnByValue: true,
        awaitPromise: true
      },
      sessionId
    );
    if (r.exceptionDetails || !r.result || r.result.value !== "ok") {
      throw new Error("chrome.storage не ответил на очистку: " + JSON.stringify(r.exceptionDetails || r.result).slice(0, 200));
    }
  } finally {
    try { await c.send("Target.closeTarget", { targetId }); } catch (e) {}
  }
}

/**
 * Папка для копии расширения. Имя ПОСТОЯННОЕ: прогон перезаписывает ту же
 * папку. Так копии не копятся (раньше за четыре дня набралось 756 штук и 311 МБ),
 * а подмена файлов в копии снимается перезаписью — она делается после копирования.
 */
function scratchExt(tag) {
  return path.join(SCRATCH, "test-ext-" + tag);
}

module.exports = {
  REPO,
  SCRATCH,
  MOCK_DIR,
  EXT,
  CHROME: findChrome(),
  normalize,
  testProfile,
  chromeFlags,
  clearStorage,
  scratchExt
};
