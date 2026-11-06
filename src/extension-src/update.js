/**
 * Чистые функции автообновления распакованной установки: что скачивать, какие
 * пути вообще допустимы и в каком порядке писать. Здесь нет ни chrome, ни DOM,
 * ни сети: файл грузится классическим скриптом в попап (перед popup.js) и в
 * фоновый воркер, а юнит-набор читает его тем же приёмом, что background.js.
 */
var DzenUpdate = (function () {
  // Имя манифеста и ключ журнала намеренно зафиксированы здесь: их ждут и код
  // записи, и проверки, и «манифест пишется последним» не должен зависеть от
  // того, в каком порядке файл оказался в составе.
  var MANIFEST_NAME = "manifest.json";
  var INTENT_KEY = "dzrUpdateIntent";
  // Папка отката — внутри выбранной: пережить закрытие браузера может только
  // запись на диск, а Chrome лишние файлы в распакованной установке игнорирует.
  var BACKUP_DIR = ".dzr-backup";
  // Рукоять на папку сериализуется только в IndexedDB. Имена зафиксированы:
  // сохранённое одной версией обязано найтись в другой, иначе каждый клик
  // поднимал бы диалог выбора заново.
  var IDB_NAME = "dzr-update";
  var IDB_STORE = "handles";
  var IDB_KEY = "install-dir";

  function isNotFound(e) {
    return !!e && e.name === "NotFoundError";
  }

  /** Каталог и имя, в котором лежит относительный путь. */
  async function parentOf(root, rel, create) {
    var parts = String(rel).split("/");
    var dir = root;
    for (var i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
    }
    return { dir: dir, name: parts[parts.length - 1] };
  }

  /**
   * Байты файла выбранной папки или null, если такого файла там нет.
   *
   * Пустой файл и пропавшая папка — разные беды. Отсутствие файла возвращает
   * null, а сбой при его чтении бросает: по этой грани вызывающий и понимает,
   * что папку перенесли с места или доступ к ней отозвали.
   */
  async function readRel(root, rel) {
    var at = await parentOf(root, rel, false);
    var fh;
    try {
      fh = await at.dir.getFileHandle(at.name, { create: false });
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
    var file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  /** Относительные пути всех файлов папки, обойти рекурсивно. */
  async function listRel(root, prefix) {
    var out = [];
    var it = root.entries();
    for await (const pair of it) {
      var name = pair[0];
      var handle = pair[1];
      var rel = prefix ? prefix + "/" + name : name;
      if (handle && handle.kind === "directory") out = out.concat(await listRel(handle, rel));
      else out.push(rel);
    }
    return out.sort();
  }

  /**
   * Почему выбранная папка — не папка этого расширения, или null, если годится.
   *
   * Порядок проверок — это порядок, в котором человек узнаёт правду: сначала
   * «папки нет», потом «манифест не читается», затем «не та версия манифеста» и
   * только потом «это другое расширение». Ни один файл не будет тронут, пока
   * здесь не пусто.
   */
  async function installDirProblem(root, expectedName) {
    var listing;
    try {
      listing = await listRel(root, "");
    } catch (e) {
      return "папки на месте нет";
    }
    if (listing.indexOf(MANIFEST_NAME) < 0) return "не читается";
    var bytes;
    try {
      bytes = await readRel(root, MANIFEST_NAME);
    } catch (e) {
      return "папки на месте нет";
    }
    if (!bytes || !bytes.length) return "не читается";
    var data = null;
    try {
      data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } catch (e) {
      return "не читается";
    }
    if (!data || typeof data !== "object") return "не читается";
    if (data.manifest_version !== 3) return "не манифест третьей версии";
    if (data.name !== expectedName) return "не то расширение";
    return null;
  }

  /**
   * Принимаем только относительный путь с прямыми слэшами внутри выбранной
   * папки. Обратный слэш, ведущий слэш, буква диска, `..`, `?` и `#` означают,
   * что адрес указывает не на файл пакета, — такой путь не должен дойти до
   * getFileHandle.
   */
  function isSafeRelPath(p) {
    if (typeof p !== "string" || !p) return false;
    if (p.indexOf("\\") >= 0 || p.indexOf("?") >= 0 || p.indexOf("#") >= 0) return false;
    if (p.charAt(0) === "/") return false;
    if (/^[A-Za-z]:/.test(p)) return false;
    var parts = p.split("/");
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === "." || parts[i] === "..") return false;
    }
    return true;
  }

  /** Ссылки `<script src>` и `<link rel="stylesheet" href>` со страницы. */
  function pageAssets(html) {
    var out = [];
    String(html || "").replace(/<script\b[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi, function (m, src) {
      out.push(src);
      return m;
    });
    String(html || "").replace(/<link\b[^>]*>/gi, function (tag) {
      if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) return tag;
      var m = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (m) out.push(m[1]);
      return tag;
    });
    return out;
  }

  /**
   * Состав файлов, которые умеет приносить обновление: из манифеста и со
   * страниц, которые он называет. Второй уровень только у страниц — все
   * страницы уже перечислены в манифесте, а `popup.js` виден лишь из `popup.html`.
   *
   * Возвращается отсортированный набор без дублей: `options_ui.page` и
   * `action.default_popup` — один файл, и просить его дважды незачем.
   */
  function updateFileSet(manifest, htmlTexts) {
    var found = {};
    function add(p) {
      if (isSafeRelPath(p)) found[p] = true;
    }

    var m = manifest || {};
    add(MANIFEST_NAME);
    if (m.background) add(m.background.service_worker);
    var scripts = m.content_scripts || [];
    for (var i = 0; i < scripts.length; i++) {
      var cs = scripts[i] || {};
      (cs.js || []).forEach(add);
      (cs.css || []).forEach(add);
    }
    if (m.action) add(m.action.default_popup);
    if (m.options_ui) add(m.options_ui.page);
    [m.icons, m.action && m.action.default_icon].forEach(function (map) {
      Object.keys(map || {}).forEach(function (size) { add(map[size]); });
    });
    Object.keys(htmlTexts || {}).forEach(function (page) {
      pageAssets(htmlTexts[page]).forEach(add);
    });

    return Object.keys(found).sort();
  }

  function sameBytes(a, b) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /**
   * Что писать и в каком порядке: только изменённые, манифест последним.
   *
   * Манифест — последним осознанно: Chrome читает из него список файлов, и
   * полусостояние «манифест новый, половина файлов старые» расширением не
   * переживается. Пока манифест не тронут, установка остаётся прежней версией.
   */
  function planUpdate(fileSet, localMap, remoteMap) {
    var local = localMap || {};
    var remote = remoteMap || {};
    var out = [];
    (fileSet || []).forEach(function (p) {
      if (p === MANIFEST_NAME) return;
      if (!remote[p]) return;
      if (sameBytes(local[p], remote[p])) return;
      out.push(p);
    });
    if (remote[MANIFEST_NAME] && !sameBytes(local[MANIFEST_NAME], remote[MANIFEST_NAME])) {
      out.push(MANIFEST_NAME);
    }
    return out;
  }

  return {
    MANIFEST_NAME: MANIFEST_NAME,
    INTENT_KEY: INTENT_KEY,
    BACKUP_DIR: BACKUP_DIR,
    IDB_NAME: IDB_NAME,
    IDB_STORE: IDB_STORE,
    IDB_KEY: IDB_KEY,
    isSafeRelPath: isSafeRelPath,
    updateFileSet: updateFileSet,
    planUpdate: planUpdate,
    readRel: readRel,
    listRel: listRel,
    installDirProblem: installDirProblem
  };
})();
