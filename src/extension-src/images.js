/* Дзен Рерайтер — подбор картинок: разбор выдач, имена и заголовок.
   Модуль без chrome и без DOM-записей: его проверяет юнит-набор, а в браузере
   он подключён и к панели, и к окну подбора, и к попапу. */
var DzenImages = (function () {
  "use strict";
  var MIN_COUNT = 5;
  var MAX_COUNT = 10;
  var DEFAULT_COUNT = 8;
  var MAX_IMAGE_BYTES = 3 * 1024 * 1024;
  var MAX_CANDIDATES = 40;
  var MAX_TITLE = 160;
  // Имена устройств Windows: папку "CON" система создать не даст.
  var WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i;

  function clampCount(value) {
    var text = String(value == null ? "" : value).trim();
    if (!/^\d+$/.test(text)) return DEFAULT_COUNT;
    var n = parseInt(text, 10);
    if (n < MIN_COUNT) return MIN_COUNT;
    if (n > MAX_COUNT) return MAX_COUNT;
    return n;
  }

  // Выдача Bing и Яндекса приходит JSON-ом внутри HTML и в двух формах кавычек:
  // обычной и &quot;. Обратный слэш перед кавычкой — третья форма.
  function decodeEntities(text) {
    return String(text == null ? "" : text)
      .replace(/&(?:quot|#34|#x22);/gi, '"')
      .replace(/&#x2F;/gi, "/")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&(?:amp|#38|#x26);/gi, "&")
      .replace(/\\\//g, "/");
  }

  function pick(html, key) {
    var re = new RegExp(key + '(?:&quot;|"|\\\\")\\s*:\\s*(?:&quot;|"|\\\\")(.*?)(?:&quot;|"|\\\\")', "g");
    var out = [];
    var m;
    while ((m = re.exec(String(html || "")))) out.push(decodeEntities(m[1]));
    return out;
  }

  function parseBing(html) {
    return pick(html, "murl");
  }

  function parseYandex(html) {
    return pick(html, "origUrl");
  }

  function isHttpUrl(url) {
    if (typeof url !== "string" || !url || url.length > 2048) return false;
    try {
      var u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      if (u.username || u.password) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function mergeCandidates(lists, limit) {
    var cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : MAX_CANDIDATES;
    cap = Math.min(cap, MAX_CANDIDATES);
    var rows = (lists || []).map(function (l) { return Array.isArray(l) ? l : []; });
    var seen = {};
    var out = [];
    var deepest = 0;
    rows.forEach(function (l) { if (l.length > deepest) deepest = l.length; });
    for (var i = 0; i < deepest && out.length < cap; i++) {
      for (var j = 0; j < rows.length && out.length < cap; j++) {
        var url = rows[j][i];
        if (!isHttpUrl(url) || seen[url]) continue;
        seen[url] = true;
        out.push(url);
      }
    }
    return out;
  }

  function cleanName(text) {
    return String(text == null ? "" : text)
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[. ]+|[. ]+$/g, "");
  }

  function sanitizeFolderName(title, fallback) {
    var name = cleanName(title);
    if (name.length > 80) name = name.slice(0, 80).replace(/[. ]+$/g, "");
    if (!name) name = cleanName(fallback).slice(0, 80);
    if (!name) name = "novost";
    if (WINDOWS_RESERVED.test(name)) name = "_" + name;
    return name;
  }

  function nextFreeName(base, used) {
    var taken = used instanceof Set ? used : new Set(used || []);
    if (!taken.has(base)) return base;
    for (var i = 2; i < 1000; i++) {
      var candidate = base + " (" + i + ")";
      if (!taken.has(candidate)) return candidate;
    }
    return base + " (" + Date.now() + ")";
  }

  function imageType(bytes) {
    if (!bytes || typeof bytes.length !== "number") return null;
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif";
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
    return null;
  }

  function fileName(index, ext) {
    var n = Math.floor(Number(index));
    if (!isFinite(n) || n < 0) n = 0;
    var tail = String(ext || "").replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
    return (n + 1 < 10 ? "0" + (n + 1) : String(n + 1)) + "." + tail;
  }

  function textOf(el) {
    if (!el) return "";
    if (el.value != null) return String(el.value);
    return String(el.innerText || el.textContent || "");
  }

  function cleanTitle(text) {
    return String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE).trim();
  }

  function titleFromField(doc) {
    if (!doc || typeof doc.querySelector !== "function") return "";
    var selectors = [
      'textarea[placeholder*="Заголовок" i]',
      'input[placeholder*="Заголовок" i]',
      '[contenteditable="true"][data-placeholder*="Заголовок" i]',
      '[contenteditable="true"][aria-label*="Заголовок" i]',
      '.title[contenteditable="true"]',
      'textarea[class*="title" i]',
      'input[class*="title" i]',
      '[data-testid*="title" i] textarea',
      '[data-testid*="title" i] input',
      '[data-testid*="title" i] [contenteditable="true"]',
      '[data-testid*="title" i]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var t = cleanTitle(textOf(doc.querySelector(selectors[i])));
      if (t) return t;
    }
    return "";
  }

  function visible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.getBoundingClientRect === "function") {
      var r = el.getBoundingClientRect();
      if (r && (r.width === 0 || r.height === 0)) return false;
    }
    return true;
  }

  function guessTitle(doc, editor) {
    var t = titleFromField(doc);
    if (t) return t;
    if (doc && typeof doc.querySelectorAll === "function") {
      var h1s = doc.querySelectorAll("h1");
      for (var i = 0; i < h1s.length; i++) {
        if (!visible(h1s[i])) continue;
        t = cleanTitle(textOf(h1s[i]));
        if (t) return t;
      }
    }
    if (editor) {
      var lines = String(textOf(editor)).split(/\r?\n/);
      for (var j = 0; j < lines.length; j++) {
        t = cleanTitle(lines[j]);
        if (t) return t;
      }
    }
    if (doc && typeof doc.title === "string") {
      t = cleanTitle(doc.title.replace(/\s*[—–|-]\s*(?:Яндекс\s+)?Дзен\s*$/i, ""));
      if (t && !/^Дзен$/i.test(t)) return t;
    }
    return "";
  }

  return {
    MIN_COUNT: MIN_COUNT,
    MAX_COUNT: MAX_COUNT,
    DEFAULT_COUNT: DEFAULT_COUNT,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    MAX_CANDIDATES: MAX_CANDIDATES,
    clampCount: clampCount,
    decodeEntities: decodeEntities,
    parseBing: parseBing,
    parseYandex: parseYandex,
    isHttpUrl: isHttpUrl,
    mergeCandidates: mergeCandidates,
    sanitizeFolderName: sanitizeFolderName,
    nextFreeName: nextFreeName,
    imageType: imageType,
    fileName: fileName,
    guessTitle: guessTitle
  };
})();
