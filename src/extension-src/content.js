/* Дзен Рерайтер — контент-скрипт для dzen.ru / zen.yandex.ru
 * Рисует плавающую панель с иконкой внизу окна редактора,
 * забирает выделенный текст, переводит + рерайтит и вставляет обратно.
 */
(function () {
  "use strict";

  if (window.__dzrLoaded) return;
  window.__dzrLoaded = true;

  var S = {
    targetLang: "ru",
    mode: "translate+rewrite",
    strength: "medium",
    aiEnabled: false,
    aiPreset: "editor",
    sourceLang: "auto",
    preview: true,
    skipSameLang: true,
    // что делать со ссылками, приехавшими вместе с текстом оригинала:
    // keep | drop | off (см. раздел «ссылки в оригинале»)
    stripLinks: "keep",
    // приписка в конце статьи: свой текст под каждой статьёй
    signature: false,
    signatureText: "",
    linkCount: 2,
    glossary: ""
  };

  var busy = false;
  var lastOriginal = "";
  var bar, statusEl, goBtn, undoBtn, langSel, modeSel, presetSel, linkBtn;

  // подпись кнопки по умолчанию и подтверждение обработки всей статьи
  var goLabel = "";
  var confirmedAll = false;
  var confirmTimer = null;
  // снимок редактора до вставки — для надёжного отката
  var undoSnapshot = null;
  // идентификатор текущего перевода: по нему его можно отменить
  var currentRunId = null;
  // Ответ пришёл от адреса на своей машине (Ollama и подобные). Фон говорит об
  // этом отдельным сообщением до запроса: локальная модель считает минутами, и
  // панель обязана сказать, что ждать долго, — иначе это выглядит как зависание.
  var aiLocal = false;

  // панель закрыта пользователем — наблюдатель за DOM не должен её возвращать
  var closed = false;
  // Панель свёрнута в пузырёк. На страницах без редактора (лента Дзена, чтение
  // статьи) она сворачивается сама, чтобы не мешать; когда редактор появился —
  // разворачивается. Свёрнутую вручную не разворачиваем: это выбор пользователя.
  var collapsed = false;
  var collapsedByUser = false;
  var collapseBtn = null;
  var editorWatch = null;
  // Что считаем «редактором статьи», а не строкой поиска и не полем комментария
  var EDITOR_MIN_W = 260;
  var EDITOR_MIN_H = 100;
  var EDITOR_MIN_CHARS = 400;
  // текущее положение панели (числа, а не строки со «px»)
  var barLeft = null;
  var barTop = null;
  var barSide = "none";
  // зона у края экрана, в которой панель встаёт вертикально
  var EDGE_ZONE = 90;
  var EDGE_GAP = 12;

  // Клик по панели забирает фокус у редактора Дзена, и он сбрасывает DOM-выделение.
  // Поэтому запоминаем выделение заранее (selectionchange/mouseup) и работаем с ним.
  var savedRange = null;
  var savedText = "";
  var savedBlocks = [];
  var savedEditor = null;

  // ------------------------------------------------------------ утилиты ---

  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (chrome.runtime.lastError) {
            // Фоновый скрипт браузер усыпляет, а долгий запрос к своей модели
            // может пережить его выгрузку. Английское «message port closed»
            // человеку ничего не объясняет и уводит искать причину в ключе.
            var m = String(chrome.runtime.lastError.message || "");
            if (/message port closed|receiving end does not exist/i.test(m)) {
              m = "фоновый скрипт расширения был выгружен браузером — запустите ещё раз";
            }
            resolve({ ok: false, error: m });
            return;
          }
          resolve(res || { ok: false, error: "Пустой ответ фонового скрипта" });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function isAlive(range) {
    try {
      var n = range.startContainer;
      if (!n) return false;
      var host = n.nodeType === 1 ? n : n.parentElement;
      return !!(host && host.isConnected !== false);
    } catch (e) {
      return false;
    }
  }

  /** Текст диапазона. Некоторые редакторы отдают пустой Selection.toString(). */
  function rangeToText(range) {
    if (!range) return "";
    try {
      var t = range.toString();
      if (t && t.trim()) return t;
    } catch (e) {}
    try {
      var box = document.createElement("div");
      box.appendChild(range.cloneContents());
      return box.innerText || box.textContent || "";
    } catch (e) {}
    return "";
  }

  function countWords(t) {
    return (t || "").trim().split(/\s+/).filter(Boolean).length;
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  // -------------------------------------------- структура текста (блоки) ---
  // Range.toString() склеивает абзацы в одну строку, поэтому выделение читаем
  // по блокам (абзац / заголовок / пункт списка / фигура) и запоминаем их теги,
  // чтобы потом восстановить разметку в редакторе.
  //
  // Картинки и инлайн-разметку (жирный, курсив, ссылки) переводчик съедает,
  // если отдать их как текст. Поэтому каждый блок разбирается на сегменты:
  //   • обычный текст          → уходит в перевод как есть;
  //   • инлайн-элемент         → [[n]]текст[[/n]] (маркеры переживают перевод);
  //   • картинка/фигура и т.п. → [[n]] (сам узел запоминаем и вставляем обратно).
  // После перевода маркеры разбираются обратно. Если переводчик маркер потерял
  // или размножил — подставляем исходный текст/узел, чтобы ничего не пропало.

  var BLOCKISH = /^(P|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|FIGURE|TABLE|DIV|SECTION|ARTICLE|HR|DL|DD|DT|TD|TH)$/;
  var WRAP_TAGS = /^(A|B|STRONG|I|EM|U|S|STRIKE|DEL|INS|CODE|SUP|SUB|MARK|SMALL|SPAN|FONT|ABBR|Q|CITE|TIME|KBD|SAMP|VAR|FIGCAPTION|BDI|BDO)$/;
  var VOID_TAGS = /^(IMG|PICTURE|VIDEO|AUDIO|IFRAME|TABLE|PRE|HR|BR|SVG|CANVAS|EMBED|OBJECT|SOURCE|TRACK|INPUT|BUTTON|SELECT|TEXTAREA|FIGURE|UL|OL|DL|BLOCKQUOTE)$/;
  // эти блоки не переводим — переносим целиком
  var VOID_BLOCK_TAGS = /^(TABLE|PRE|IFRAME|VIDEO|AUDIO|SVG|CANVAS|OBJECT|EMBED)$/;

  function newTable() {
    return { seq: 0, map: {} };
  }

  // ------------------------------------------------------------ глоссарий ---
  // Слова, которые переводчик калечит: бренды, модели, термины. Мы вынимаем их
  // из текста в отдельные маркеры ещё до перевода и возвращаем на место после —
  // ровно в том виде, который задал пользователь. Маркеры уже проверены на
  // выживание в Google Translate (см. ниже), так что это тот же механизм,
  // которым мы спасаем картинки и жирный шрифт.

  var glossaryCache = { raw: null, terms: null };

  function parseGlossary(raw) {
    var s = String(raw || "");
    if (glossaryCache.raw === s) return glossaryCache.terms;
    var terms = [];
    s.split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (!t || t.charAt(0) === "#") return; // # — комментарий
      var eq = t.indexOf("=");
      var from = (eq >= 0 ? t.slice(0, eq) : t).trim();
      var to = eq >= 0 ? t.slice(eq + 1).trim() : "";
      if (!from) return;
      terms.push({ from: from, to: to || from, lower: from.toLowerCase() });
    });
    // длинные первыми: «Subaru Outback» должен выиграть у «Subaru»
    terms.sort(function (a, b) {
      return b.from.length - a.from.length;
    });
    glossaryCache = { raw: s, terms: terms };
    return terms;
  }

  function isWordChar(ch) {
    return !!ch && /[0-9A-Za-zА-Яа-яЁё_]/.test(ch);
  }

  /** Термин не должен находиться внутри другого слова: «Box» не ловим в «Boxer». */
  function onWordBoundary(text, at, len) {
    var before = at > 0 ? text.charAt(at - 1) : "";
    var after = text.charAt(at + len);
    return !isWordChar(before) && !isWordChar(after);
  }

  /**
   * Режем текст на куски, отделяя термины глоссария.
   * Возвращает [{s}] и [{term}] или null, если терминов в тексте нет.
   */
  function splitTerms(text) {
    var terms = parseGlossary(S.glossary);
    if (!terms.length || !text) return null;
    var lower = text.toLowerCase();
    var out = [];
    var pos = 0;
    while (pos < text.length) {
      var best = null;
      var bestAt = -1;
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i];
        var at = lower.indexOf(t.lower, pos);
        if (at < 0 || !onWordBoundary(text, at, t.from.length)) continue;
        if (bestAt < 0 || at < bestAt || (at === bestAt && t.from.length > best.from.length)) {
          best = t;
          bestAt = at;
        }
      }
      if (!best) break;
      if (bestAt > pos) out.push({ s: text.slice(pos, bestAt) });
      out.push({ term: best });
      pos = bestAt + best.from.length;
    }
    if (!out.length) return null;
    if (pos < text.length) out.push({ s: text.slice(pos) });
    return out;
  }

  /** Термин с сохранением обёрток: жирный, курсив, ссылка вокруг него. */
  function termHtml(t) {
    var txt = t.text || "";
    return t.chain && t.chain.length ? wrapChainHtml(t.chain, txt) : escapeHtml(txt);
  }

  /** Убирает служебные атрибуты редактора (ProseMirror метит узлы data-pm-*). */
  function cleanAttrs(node) {
    if (!node.attributes) return node;
    for (var i = node.attributes.length - 1; i >= 0; i--) {
      var name = node.attributes[i].name;
      if (/^data-pm/i.test(name) || /^on/i.test(name) || name === "contenteditable") {
        node.removeAttribute(name);
      }
    }
    return node;
  }

  function cleanClone(el) {
    var c = el.cloneNode(true);
    var kids = c.querySelectorAll ? c.querySelectorAll("*") : [];
    var all = [c].concat(Array.prototype.slice.call(kids));
    all.forEach(cleanAttrs);
    return c;
  }

  /** Копия без детей — для обёрток, внутрь которых мы вкладываем узел сами. */
  function shallowClone(el) {
    return cleanAttrs(el.cloneNode(false));
  }

  /**
   * Цепочка инлайн-обёрток от узла вверх до блока, снаружи внутрь.
   * Одна и та же и для текста (обёртки возвращаются через маркеры), и для
   * вставных узлов вроде картинки (см. buildVoidClone).
   */
  function wrapChainTo(node, block) {
    var chain = [];
    var p = node.parentElement;
    while (p && p !== block && p !== document.body) {
      if (WRAP_TAGS.test(p.tagName) && !isOurNode(p)) chain.unshift(p);
      p = p.parentElement;
    }
    return chain;
  }

  function intersects(el, range) {
    try {
      return range.intersectsNode(el);
    } catch (e) {
      return false;
    }
  }

  /** Контейнер, внутрь которого надо спуститься (список, обёртка с абзацами). */
  function isContainer(el) {
    var tag = el.tagName;
    if (/^(UL|OL|DL)$/.test(tag)) return true;
    if (!/^(DIV|SECTION|ARTICLE|MAIN|ASIDE|HEADER|FOOTER)$/.test(tag)) return false;
    // если в обёртке есть собственный текст — это не обёртка, а сам блок
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 3 && c.nodeValue && c.nodeValue.trim()) return false;
    }
    for (var j = 0; j < el.children.length; j++) {
      if (BLOCKISH.test(el.children[j].tagName)) return true;
    }
    return false;
  }

  /** Блоки = «строчки» статьи: абзацы, заголовки, пункты списка, фигуры. */
  function topBlocks(range, root) {
    var out = [];
    (function walk(container) {
      var kids = container.children || [];
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (isOurNode(el) || !intersects(el, range)) continue;
        if (isContainer(el)) {
          walk(el);
          continue;
        }
        out.push(el);
      }
    })(root);
    return out;
  }

  // ------------------------------------------- ссылки в оригинале (чистка) ---
  // Копируя статью с чужого сайта, вместе с текстом притаскивают и ссылки:
  // на источник, на соседние материалы, на «читайте также». В своей статье на
  // Дзене они лишние, поэтому при переводе мы их убираем.
  //
  // По умолчанию текст ссылки остаётся: он часть предложения, и выкинуть его —
  // значит поломать фразу («подробности в <a>официальном пресс-релизе</a>»).
  // Кому нужно обратное — строка «Читайте также: …» целиком — выбирает режим
  // «вместе с текстом».
  //
  // Чистим на входе, а не после перевода. Так ссылки не попадают ни в маркеры,
  // ни в переводчик, и вернуться в статью им уже нечем: маркер, который переводчик
  // потеряет, мы восстанавливаем из таблицы, а тут восстанавливать нечего.

  /** Режим чистки ссылок. Незнакомое значение читаем как «keep» — безопаснее. */
  function linkStripMode() {
    var m = S.stripLinks;
    if (m === "off" || m === false) return "off";
    return m === "drop" ? "drop" : "keep";
  }

  /** Ближайший <a> внутри блока. Сам блок и выше не смотрим — там уже чужая зона. */
  function anchorInside(node, block) {
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== block && el !== document.body) {
      if (el.tagName === "A") return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Считаем ссылку один раз: внутри неё может быть и текст, и картинка, и
   * <strong> — все они придут сюда со своим <a>. Идентичность узла и есть ключ,
   * поэтому в списке храним сами элементы, а не числа.
   */
  function countAnchors(table, anchors) {
    if (!anchors || !anchors.length) return;
    if (!table.anchors) table.anchors = [];
    for (var i = 0; i < anchors.length; i++) {
      if (table.anchors.indexOf(anchors[i]) < 0) table.anchors.push(anchors[i]);
    }
  }

  /**
   * Чистит ссылки в уже снятом клоне узла — таблицы, преформата, фигуры. Такие
   * блоки переносятся целиком, минуя разбор по сегментам, поэтому ссылки внутри
   * них надо убирать отдельно. Возвращает список вычищенных <a> (для счётчика).
   *
   * Картинку внутри ссылки не выбрасываем даже в режиме «вместе с текстом»:
   * потерять иллюстрацию из-за того, что её обернули в <a>, — слишком дорогая
   * цена за уборку ссылок.
   */
  function stripAnchorsInClone(clone, mode) {
    var found = [];
    if (mode === "off" || !clone.querySelectorAll) return found;
    var list = Array.prototype.slice.call(clone.querySelectorAll("a"));
    list.forEach(function (a) {
      found.push(a);
      if (mode === "drop" && !a.querySelector("img,picture,video")) {
        if (a.parentNode) a.parentNode.removeChild(a);
        return;
      }
      // разворачиваем ссылку: её содержимое встаёт на место самой ссылки
      while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a);
      a.parentNode.removeChild(a);
    });
    return found;
  }

  /**
   * Клон вставного узла вместе с его инлайн-обёртками.
   *
   * Раньше обёртки терялись: ссылка вокруг картинки не возвращалась в статью
   * никогда, потому что узел запоминался один, а <a> над ним просто исчезал.
   * Пока чистка ссылок не появилась, это было незаметно, но с ней режим «не
   * трогать ссылки» начинал врать. Теперь обёртки проходят тот же путь, что и
   * текст, и снимаются по выбранному режиму, а не случайно.
   */
  function buildVoidClone(node, block, mode) {
    var out = cleanClone(node);
    var chain = wrapChainTo(node, block);
    for (var i = chain.length - 1; i >= 0; i--) {
      if (mode !== "off" && chain[i].tagName === "A") continue; // ссылку не восстанавливаем
      var c = shallowClone(chain[i]);
      c.appendChild(out);
      out = c;
    }
    return out;
  }

  /**
   * Разбираем блок на сегменты: {k:"t"|"i"|"v"}.
   * Инлайн-сегмент несёт номер маркера и цепочку обёрток (strong → em → …),
   * void-сегмент — номер маркера, за которым записан сам узел.
   *
   * Чистка ссылок включается опцией, а не настройкой напрямую, и это важно:
   * через тот же разбор ходит перелинковка, и она статью не переписывает.
   * Снимай мы ссылки по настройке всегда — перелинковка молча разворачивала бы
   * все ссылки, которые в статье уже были.
   */
  function tokenizeBlock(el, table, blockIdx, opts) {
    var strip = opts && opts.stripLinks ? linkStripMode() : "off";
    // таблицу и преформат переводить нельзя — тащим как есть
    if (VOID_BLOCK_TAGS.test(el.tagName)) {
      var n0 = ++table.seq;
      var whole = cleanClone(el);
      countAnchors(table, stripAnchorsInClone(whole, strip));
      table.map[n0] = { kind: "void", node: whole, blockIdx: blockIdx };
      return [{ k: "v", n: n0 }];
    }

    var parts = [];

    function chainOf(node) {
      return wrapChainTo(node, el);
    }

    function walk(node) {
      if (node.nodeType === 3) {
        var s = node.nodeValue;
        if (!s) return;
        // Ссылку определяем раньше всех остальных решений: и «оставить текст»,
        // и «убрать вместе с текстом» — это про одно и то же <a>, и посчитать
        // его надо в обоих случаях.
        var link = strip === "off" ? null : anchorInside(node, el);
        if (link) {
          countAnchors(table, [link]);
          if (strip === "drop") return; // текст ссылки не нужен ни переводчику, ни статье
        }
        if (!s.trim()) {
          parts.push({ k: "t", s: s });
          return;
        }
        var chain = chainOf(node);
        // keep: разворачиваем ссылку, но прочие обёртки сохраняем — жирный
        // внутри ссылки должен остаться жирным.
        if (link) {
          chain = chain.filter(function (c) {
            return c.tagName !== "A";
          });
        }

        // Термины глоссария вынимаем в отдельные маркеры до перевода.
        // Ветка включается только когда термины реально нашлись — иначе
        // разбор текста идёт ровно как раньше.
        var pieces = splitTerms(s);
        if (pieces) {
          pieces.forEach(function (pc) {
            if (pc.term) {
              var nt = ++table.seq;
              table.map[nt] = {
                kind: "term",
                text: pc.term.to, // что подставить в результат
                chain: chain.map(cleanClone),
                chainSrc: chain, // исходные узлы — по ним склеиваем соседей
                blockIdx: blockIdx
              };
              // в part.plain — то, что реально написано в статье: по нему
              // считается «выделено N слов» и снимается снимок для отката
              parts.push({ k: "v", n: nt, plain: pc.term.from });
            } else if (!pc.s.trim()) {
              parts.push({ k: "t", s: pc.s });
            } else if (chain.length) {
              var ni = ++table.seq;
              table.map[ni] = { kind: "inline", chain: chain.map(cleanClone), chainSrc: chain, text: pc.s, blockIdx: blockIdx };
              parts.push({ k: "i", n: ni, s: pc.s });
            } else {
              parts.push({ k: "t", s: pc.s });
            }
          });
          return;
        }

        if (!chain.length) {
          parts.push({ k: "t", s: s });
          return;
        }
        var n = ++table.seq;
        table.map[n] = { kind: "inline", chain: chain.map(cleanClone), chainSrc: chain, text: s, blockIdx: blockIdx };
        parts.push({ k: "i", n: n, s: s });
        return;
      }
      if (node.nodeType !== 1 || isOurNode(node)) return;
      var tag = node.tagName;
      // Картинка внутри ссылки: саму ссылку снимаем, но узел переносим как есть —
      // и в режиме «вместе с текстом» тоже (см. stripAnchorsInClone).
      var linkEl = strip === "off" ? null : anchorInside(node, el);
      if (linkEl) countAnchors(table, [linkEl]);
      if (VOID_TAGS.test(tag)) {
        var nv = ++table.seq;
        var voidClone = buildVoidClone(node, el, strip);
        countAnchors(table, stripAnchorsInClone(voidClone, strip));
        table.map[nv] = { kind: "void", node: voidClone, blockIdx: blockIdx };
        parts.push({ k: "v", n: nv });
        return;
      }
      Array.prototype.forEach.call(node.childNodes, walk);
    }

    Array.prototype.forEach.call(el.childNodes, walk);
    return parts;
  }

  function partsToRaw(parts) {
    return parts
      .map(function (p) {
        if (p.k === "t") return p.s;
        if (p.k === "i") return "[[" + p.n + "]]" + p.s + "[[/" + p.n + "]]";
        // Термин глоссария — без пробелов: иначе он оторвётся от знаков
        // препинания («Subaru's» → «Subaru 's»). Картинку наоборот окружаем
        // пробелами, чтобы маркер не прилип к соседнему слову.
        return p.plain != null ? "[[" + p.n + "]]" : " [[" + p.n + "]] ";
      })
      .join("");
  }

  function partsToPlain(parts) {
    return parts
      .map(function (p) {
        if (p.k !== "v") return p.s;
        return p.plain != null ? p.plain : " ";
      })
      .join("");
  }

  /**
   * Читаем выделение как список блоков. table — общая таблица маркеров,
   * чтобы номера не пересекались между блоками.
   * opts.stripLinks — снимать ли ссылки (только путь перевода, см. tokenizeBlock).
   */
  function readBlocks(range, root, table, opts) {
    if (!range || !root) return [];
    var blocks = [];
    topBlocks(range, root).forEach(function (el, idx) {
      var parts = tokenizeBlock(el, table, idx, opts);
      var text = partsToPlain(parts).replace(/\s+/g, " ").trim();
      var hasVoid = parts.some(function (p) {
        return p.k === "v";
      });
      if (!text && !hasVoid) return; // пустой абзац пропускаем, а блок с картинкой — нет
      blocks.push({
        el: el,
        tag: String(el.tagName).toLowerCase(),
        text: text,
        raw: partsToRaw(parts).replace(/\s+/g, " ").trim(),
        parts: parts,
        keep: VOID_BLOCK_TAGS.test(el.tagName),
        _i: idx
      });
    });

    // после отбрасывания пустых блоков перенумеруем ссылки в таблице маркеров
    var remap = {};
    blocks.forEach(function (b, i) {
      remap[b._i] = i;
    });
    Object.keys(table.map).forEach(function (k) {
      var t = table.map[k];
      if (remap[t.blockIdx] != null) t.blockIdx = remap[t.blockIdx];
    });

    return blocks;
  }

  function blocksToText(blocks, field) {
    return blocks
      .map(function (b) {
        return b[field || "text"];
      })
      .join("\n\n");
  }

  /**
   * Куда именно попадёт вставка.
   *  - mode "contents": выделение внутри одного блока (например, абзаца или
   *    пункта списка) — заменяем только его содержимое, тег блока сохраняется;
   *  - mode "blocks": выделение покрывает блоки целиком — вставляем их заново,
   *    а если родитель уже список, обёртку <ul> не добавляем.
   */
  function blockContext(range, blocks) {
    if (!range || !blocks.length) return { mode: "blocks", parent: null };
    if (blocks.length === 1) {
      var el = blocks[0].el;
      var sc = range.startContainer;
      var ec = range.endContainer;
      var inStart = el === sc || el.contains(sc);
      var inEnd = el === ec || el.contains(ec);
      if (inStart && inEnd) return { mode: "contents", parent: el };
    }
    return { mode: "blocks", parent: (blocks[0].el && blocks[0].el.parentElement) || null };
  }

  /** Разбираем ответ переводчика обратно на блоки (фон сохраняет \n\n). */
  function splitResult(result, count) {
    var parts = String(result)
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map(function (s) {
        return s.replace(/\s+/g, " ").trim();
      })
      .filter(Boolean);
    return parts.length === count ? parts : null;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Значение для атрибута. От escapeHtml отличается кавычкой: без неё адрес
   * картинки, пришедший из поиска, закрыл бы атрибут и добавил свои.
   */
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  // ------------------------------------------ разбор маркеров обратно ---
  // [[n]]…[[/n]] — инлайн-обёртка, [[n]] — вставной узел (картинка и пр.).

  var MARKER_RE = /\[\[(\d+)\]\]([\s\S]*?)\[\[\/\1\]\]|\[\[(\d+)\]\]/g;

  function resetRefs(table) {
    Object.keys(table.map).forEach(function (k) {
      table.map[k].refs = 0;
      table.map[k].rendered = false;
      table.map[k].hasText = false;
    });
  }

  function parseMarkers(s, table) {
    var out = [];
    var last = 0;
    var m;
    MARKER_RE.lastIndex = 0;
    while ((m = MARKER_RE.exec(s)) !== null) {
      if (m.index > last) out.push({ k: "t", s: s.slice(last, m.index) });
      if (m[1] !== undefined) {
        var n = parseInt(m[1], 10);
        var t = table.map[n];
        if (t && t.kind === "inline") {
          t.refs++;
          if (String(m[2]).trim()) t.hasText = true;
          out.push({ k: "i", n: n, s: m[2] });
        } else {
          out.push({ k: "t", s: m[2] });
        }
      } else {
        var nv = parseInt(m[3], 10);
        var tv = table.map[nv];
        if (tv && (tv.kind === "void" || tv.kind === "term")) {
          tv.refs++;
          out.push({ k: "v", n: nv });
        } else if (tv && tv.kind === "inline") {
          // закрывающий маркер потерялся — оставляем хотя бы текст
          out.push({ k: "t", s: tv.text });
        }
      }
      last = MARKER_RE.lastIndex;
    }
    if (last < s.length) out.push({ k: "t", s: s.slice(last) });
    return out;
  }

  /**
   * Маркер считается рабочим, только если встретился ровно один раз
   * И не потерял свой текст.
   *
   * Второе условие неочевидно, но обязательно: Google Translate иногда
   * отклеивает маркеры от содержимого — "[[1]]markers[[/1]]" превращается
   * в "маркерами [[1]][[/1]]". Счётчик ссылок при этом цел, а форматирование
   * потеряно. Поэтому пустой маркер там, где текст был, тоже считаем сломанным.
   */
  function markBroken(table) {
    Object.keys(table.map).forEach(function (k) {
      var t = table.map[k];
      t.broken = t.refs !== 1;
      if (!t.broken && t.kind === "inline" && String(t.text || "").trim() && !t.hasText) {
        t.broken = true;
      }
    });
  }

  /**
   * Оборачиваем готовую разметку в цепочку обёрток, снаружи внутрь.
   * Отдельно от wrapChainHtml, потому что содержимое тут уже HTML: экранировать
   * его нельзя, иначе склейка соседей (см. joinSegItems) съест теги.
   */
  function wrapChainRaw(chain, innerHtml) {
    var out = innerHtml;
    for (var i = chain.length - 1; i >= 0; i--) {
      var c = chain[i].cloneNode(true);
      c.innerHTML = out;
      out = c.outerHTML;
    }
    return out;
  }

  function wrapChainHtml(chain, innerText) {
    return wrapChainRaw(chain, escapeHtml(innerText));
  }

  /**
   * Рендерим сегменты в «детали»: готовый HTML, текст и цепочка обёрток
   * с указанием исходного узла статьи. Исходный узел нужен, чтобы склеить
   * соседей (см. joinSegItems): «Photo: » и «press service» выросли из одного
   * <figcaption>, значит подпись должна остаться одной, а не размножиться.
   */
  function renderSegItems(segs, table) {
    return segs.map(function (s) {
      if (s.k === "t") return { html: escapeHtml(s.s), text: s.s, src: [] };
      var t = table.map[s.n];
      if (!t) return { html: s.k === "i" ? escapeHtml(s.s) : "", text: s.s || "", src: [] };
      if (s.k === "i") {
        t.rendered = true;
        // разметку потеряли — но текст сохраняем
        if (t.broken) return { html: escapeHtml(s.s), text: s.s, src: [] };
        return { html: wrapChainHtml(t.chain, s.s), text: s.s, src: t.chainSrc || [] };
      }
      if (t.rendered) return { html: "", text: "", src: [] }; // переводчик размножил маркер
      t.rendered = true;
      return { html: t.kind === "term" ? termHtml(t) : t.node.outerHTML, text: "", src: [] };
    });
  }

  /** Общая часть двух цепочек — по исходным узлам, а не по их копиям. */
  function sharedChain(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return a.slice(0, n);
  }

  /**
   * Склеиваем соседние сегменты, выросшие из общего предка.
   *
   * Раньше каждый текстовый узел нёс собственную копию обёртки, и подпись
   * «Photo: <a>press service</a>» возвращалась двумя <figcaption> — картинка
   * получала две подписи вместо одной. Теперь общая часть цепочки рисуется
   * один раз, а остаток остаётся за своим сегментом.
   *
   * Пробелы внутри обёртки склейку не разрывают: в разметке сайтов подпись
   * часто записана с переносом строки, и на этом она снова распалась бы.
   */
  function joinSegItems(items) {
    var out = "";
    var i = 0;
    while (i < items.length) {
      var chain = items[i].src || [];
      if (!chain.length) {
        out += items[i].html;
        i++;
        continue;
      }
      var j = i + 1;
      while (j < items.length) {
        var next = items[j].src || [];
        if (!next.length) {
          // Пробел обёртки не имеет: он может быть и внутри <figcaption> (тогда
          // его надо втянуть), и между двумя соседними обёртками (тогда он
          // остаётся снаружи). Поэтому смотрим вперёд и приклеиваем пробел
          // только если за ним идёт сегмент с общим предком.
          if (!(items[j].text && !items[j].text.trim())) break;
          var after = j;
          while (
            after < items.length &&
            !(items[after].src || []).length &&
            items[after].text &&
            !items[after].text.trim()
          ) {
            after++;
          }
          var beyond = (items[after] && items[after].src) || [];
          if (!beyond.length || !sharedChain(chain, beyond).length) break;
          j = after;
          continue;
        }
        var common = sharedChain(chain, next);
        if (!common.length) break;
        chain = common;
        j++;
      }
      if (j - i === 1) {
        out += items[i].html;
        i++;
        continue;
      }
      var inner = "";
      for (var k = i; k < j; k++) {
        var rest = (items[k].src || []).slice(chain.length);
        inner += wrapChainRaw(rest.map(cleanClone), escapeHtml(items[k].text));
      }
      out += wrapChainRaw(chain.map(cleanClone), inner);
      i = j;
    }
    return out;
  }

  /**
   * Собираем блок: рендерим доехавшие сегменты и возвращаем на место то,
   * что переводчик потерял совсем. Место ищем по ближайшему следующему
   * маркеру, который уцелел, — так картинка не улетает в конец абзаца.
   */
  function renderBlock(segs, block, table) {
    var items = renderSegItems(segs, table);

    var order = ((block && block.parts) || [])
      .filter(function (p) {
        return p.k !== "t";
      })
      .map(function (p) {
        return p.n;
      });

    var pre = {};
    var tail = [];
    order.forEach(function (n, pos) {
      var t = table.map[n];
      if (!t || t.rendered) return;
      t.rendered = true;
      var html =
        t.kind === "void" ? t.node.outerHTML : t.kind === "term" ? termHtml(t) : escapeHtml(t.text);

      var at = -1;
      for (var j = pos + 1; j < order.length && at < 0; j++) {
        for (var k = 0; k < segs.length; k++) {
          if (segs[k].k !== "t" && segs[k].n === order[j]) {
            at = k;
            break;
          }
        }
      }
      if (at >= 0) (pre[at] = pre[at] || []).push(html);
      else tail.push(html);
    });

    var laid = items.map(function (it, i) {
      if (!pre[i]) return it;
      // узел, вернувшийся на своё место, пришёл не из текста: свою обёртку он
      // несёт сам, и склейку с соседями рвёт — иначе уедет внутрь чужой обёртки
      return { html: pre[i].join("") + it.html, text: "", src: [] };
    });

    return joinSegItems(laid) + tail.join("");
  }

  function stripMarkers(segs, table) {
    return segs
      .map(function (s) {
        if (s.k !== "v") return s.s;
        // у термина глоссария есть текст — он должен попасть и в plain-версию
        var t = table && table.map[s.n];
        return t && t.kind === "term" ? t.text : "";
      })
      .join("");
  }

  /**
   * Собираем HTML с исходной разметкой: заголовки, абзацы, списки, картинки.
   * linkify — необязательный шаг «вставить ссылки в этот блок»: он получает
   * индекс блока и его разметку, а возвращает изменённую. Так перелинковка идёт
   * ровно тем же путём, что и перевод, и раскладка видит структуру статьи.
   */
  function blocksToHtml(segsList, blocks, ctx, table, linkify) {
    if (ctx && ctx.mode === "contents") {
      var only = renderBlock(segsList[0] || [], blocks[0], table);
      return linkify ? linkify(0, only) : only;
    }

    var parentTag = ctx && ctx.parent ? String(ctx.parent.tagName || "") : "";
    var insideList = /^(UL|OL)$/.test(parentTag);

    var html = "";
    var listOpen = false;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var inner = renderBlock(segsList[i] || [], b, table);
      if (linkify) inner = linkify(i, inner);

      if (b.keep) {
        if (listOpen) {
          html += "</ul>";
          listOpen = false;
        }
        html += inner;
        continue;
      }
      if (b.tag === "li") {
        if (!insideList && !listOpen) {
          html += "<ul>";
          listOpen = true;
        }
        html += "<li>" + inner + "</li>";
        continue;
      }
      if (listOpen) {
        html += "</ul>";
        listOpen = false;
      }
      if (/^h[1-6]$/.test(b.tag)) html += "<" + b.tag + ">" + inner + "</" + b.tag + ">";
      else if (b.tag === "blockquote") html += "<blockquote><p>" + inner + "</p></blockquote>";
      else if (b.tag === "figure") html += "<figure>" + inner + "</figure>";
      else html += "<p>" + inner + "</p>";
    }
    if (listOpen) html += "</ul>";
    return html;
  }

  /**
   * Готовим пару {plain, html} для вставки в редактор.
   * linkify — необязательный шаг раскладки ссылок; пробрасывается в blocksToHtml,
   * где у него есть доступ к структуре статьи (индекс и тег каждого блока).
   */
  function buildPayload(result, blocks, ctx, table, linkify) {
    var parts = blocks.length ? splitResult(result, blocks.length) : null;
    var segsList = null;

    if (parts) {
      resetRefs(table);
      segsList = parts.map(function (p) {
        return parseMarkers(p, table);
      });
      markBroken(table);
    }

    if (ctx && ctx.mode === "contents") {
      var segs;
      if (segsList) {
        segs = segsList[0];
      } else {
        resetRefs(table);
        segs = parseMarkers(String(result).replace(/\s+/g, " ").trim(), table);
        markBroken(table);
      }
      var only = renderBlock(segs, blocks[0], table);
      return {
        plain: stripMarkers(segs, table).trim(),
        html: linkify ? linkify(0, only) : only
      };
    }

    if (segsList) {
      var plain = segsList
        .map(function (s) {
          return stripMarkers(s, table).replace(/\s+/g, " ").trim();
        })
        .filter(Boolean)
        .join("\n\n");
      return { plain: plain, html: blocksToHtml(segsList, blocks, ctx, table, linkify) };
    }

    // переводчик сломал структуру блоков — вставляем как сплошной текст,
    // но маркеры всё равно вычищаем
    resetRefs(table);
    var flat = stripMarkers(parseMarkers(String(result), table), table);
    return { plain: flat, html: plainToHtml(flat) };
  }

  function plainToHtml(text) {
    return String(text)
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map(function (p) {
        return "<p>" + escapeHtml(p.replace(/\s+/g, " ").trim()) + "</p>";
      })
      .join("");
  }

  /** Выделение не должно попадать на нашу же панель. */
  function isOurNode(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body) {
      if (el.id === "dzr-bar" || el.id === "dzr-toast") return true;
      el = el.parentElement;
    }
    return false;
  }

  function liveSelectionRange() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    if (!r || r.collapsed) return null;
    if (isOurNode(r.commonAncestorContainer)) return null;
    return r;
  }

  /** Запомнить текущее выделение. Возвращает true, если что-то запомнили. */
  function captureSelection() {
    var r = liveSelectionRange();
    if (!r) return false;
    var root = editableRoot(r.commonAncestorContainer) || editableRoot(r.startContainer) || document.body;
    var blocks = readBlocks(r, root, newTable());
    var text = blocks.length ? blocksToText(blocks) : rangeToText(r);
    if (!text || !text.trim()) return false;
    savedRange = r.cloneRange();
    savedBlocks = blocks;
    savedText = text;
    savedEditor = root === document.body ? null : root;
    return true;
  }

  function clearSaved() {
    savedRange = null;
    savedText = "";
    savedBlocks = [];
    savedEditor = null;
  }

  function hasSaved() {
    return !!(savedRange && savedText.trim() && isAlive(savedRange));
  }

  function applyRange(range) {
    try {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return !sel.isCollapsed;
    } catch (e) {
      return false;
    }
  }

  function describeEditor(editor) {
    var sel = window.getSelection();
    var cls = editor && editor.className ? "." + String(editor.className).trim().split(/\s+/)[0] : "";
    var len = editor ? String(editor.innerText || editor.value || "").length : 0;
    return (
      "редактор: <" +
      (editor ? editor.tagName.toLowerCase() : "не найден") +
      cls +
      "> · символов: " +
      len +
      " · выделений в документе: " +
      (sel ? sel.rangeCount : "нет")
    );
  }

  /**
   * Есть ли на странице настоящее поле для статьи.
   *
   * Одного `[contenteditable]` мало: на Дзене он есть и у поля комментария,
   * и у строки поиска. Поэтому требуем либо заметный размер, либо уже
   * набранный объём текста. Ошибиться в сторону «редактора нет» не страшно:
   * панель просто останется пузырьком, который разворачивается кликом.
   */
  function hasWorkableEditor() {
    var els = document.querySelectorAll('[contenteditable="true"], textarea');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (isOurNode(el)) continue;
      if (String(el.innerText || el.value || "").length >= EDITOR_MIN_CHARS) return true;
      var r = el.getBoundingClientRect();
      if (r.width >= EDITOR_MIN_W && r.height >= EDITOR_MIN_H) return true;
    }
    return false;
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") return /^(text|search|url)$/i.test(el.type || "text");
    return el.isContentEditable === true;
  }

  function editableRoot(node) {
    var el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body) {
      if (isEditable(el)) {
        if (el.isContentEditable) {
          // поднимаемся до корня редактируемой области
          var root = el;
          while (
            root.parentElement &&
            root.parentElement.isContentEditable &&
            root.parentElement !== document.body
          ) {
            root = root.parentElement;
          }
          return root;
        }
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function findEditor() {
    // 1) редактор, в котором находится выделение (живое или запомненное)
    var r = liveSelectionRange() || (hasSaved() ? savedRange : null);
    if (r) {
      var fromRange = editableRoot(r.commonAncestorContainer) || editableRoot(r.startContainer);
      if (fromRange) return fromRange;
    }

    // 2) поле, в котором стоит курсор
    var active = document.activeElement;
    if (isEditable(active)) return editableRoot(active);

    // 3) редактор, который использовали в прошлый раз
    if (savedEditor && document.contains(savedEditor)) return savedEditor;

    // 4) эвристика: самый крупный редактируемый блок на странице
    var candidates = Array.prototype.slice.call(
      document.querySelectorAll('[contenteditable="true"], [contenteditable=""], textarea')
    );
    candidates = candidates.filter(function (el) {
      if (isOurNode(el)) return false;
      var rect = el.getBoundingClientRect();
      return rect.width > 220 && rect.height > 60;
    });
    candidates.sort(function (a, b) {
      return (b.innerText || b.value || "").length - (a.innerText || a.value || "").length;
    });
    return candidates[0] || null;
  }

  function getSelectedText(editor) {
    if (!editor) return "";
    if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
      var s = editor.selectionStart,
        e = editor.selectionEnd;
      if (s != null && e != null && e > s) return editor.value.slice(s, e);
      return "";
    }
    // живое выделение
    var r = liveSelectionRange();
    if (r) {
      var live = rangeToText(r);
      if (live.trim()) return live;
    }
    // выделение, снятое до клика по панели
    if (hasSaved()) return savedText;
    return "";
  }

  function makeSelectAllRange(editor) {
    var range = document.createRange();
    range.selectNodeContents(editor);
    return range;
  }

  // ------------------------------------------------------------- вставка ---

  function setNativeValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Заменяем выделение. payload = { plain, html }.
   * Редакторы (ProseMirror в Дзене) синхронизируют своё внутреннее выделение
   * асинхронно, поэтому после установки диапазона делаем паузу — иначе вставка
   * уезжает в конец документа, а не в заменяемый фрагмент.
   */
  async function replaceSelection(editor, payload, range, wholeEditor) {
    try {
      editor.focus();
    } catch (e) {}

    if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
      var start = editor.selectionStart || 0;
      var end = editor.selectionEnd != null ? editor.selectionEnd : editor.value.length;
      if (wholeEditor || end <= start) {
        start = 0;
        end = editor.value.length;
      }
      var next = editor.value.slice(0, start) + payload.plain + editor.value.slice(end);
      setNativeValue(editor, next);
      editor.setSelectionRange(start, start + payload.plain.length);
      return true;
    }

    var before = editor.innerHTML;

    // Вернуть выделение в редактор. Живое выделение легко теряется: редакторы
    // сбрасывают его на focusout, а ProseMirror синхронизирует своё внутреннее
    // выделение асинхронно. Поэтому выделяем заново перед каждой попыткой, а не
    // один раз в начале — иначе вставка «промахивается» мимо фрагмента.
    function reselect() {
      var target = range && isAlive(range) ? range : wholeEditor ? makeSelectAllRange(editor) : null;
      if (!target) return false;
      applyRange(target);
      return true;
    }

    // 1) paste с text/html — редактор сам построит заголовки, абзацы и списки
    //    и корректно обновит своё внутреннее состояние (так работают
    //    ProseMirror / Draft.js / редактор Дзена)
    function tryPaste() {
      try {
        var dt = new DataTransfer();
        dt.setData("text/plain", payload.plain);
        dt.setData("text/html", payload.html);
        var pasteEvt = new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        });
        // редактор вызвал preventDefault → он обработал вставку сам
        return editor.dispatchEvent(pasteEvt) === false;
      } catch (e) {
        return false; // ClipboardEvent недоступен — идём дальше
      }
    }

    // 2) Прямая замена узлов — даёт ровно ту разметку, которую мы собрали
    //    (execCommand insertHTML умеет «заворачивать» блоки в текущий тег)
    function tryFragment() {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return false;
      var live = sel.getRangeAt(0);
      // выделение могло остаться в нашей панели или вообще вне редактора
      if (isOurNode(live.startContainer)) return false;
      if (!editor.contains(live.commonAncestorContainer)) return false;
      var frag;
      try {
        frag = live.createContextualFragment(payload.html);
      } catch (e) {
        return false;
      }
      if (!frag || !frag.childNodes.length) return false;
      try {
        var lastNode = frag.lastChild;
        live.deleteContents();
        live.insertNode(frag);
        if (lastNode) {
          var after = document.createRange();
          after.setStartAfter(lastNode);
          after.collapse(true);
          sel.removeAllRanges();
          sel.addRange(after);
        }
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
        return true;
      } catch (e) {
        return false; // структура не собралась — падаем в текст
      }
    }

    // 3) Запасной путь: текст по абзацам
    function tryText() {
      var paragraphs = payload.plain.split(/\n{2,}/);
      var okAny = false;
      for (var i = 0; i < paragraphs.length; i++) {
        if (i > 0) document.execCommand("insertParagraph");
        okAny = document.execCommand("insertText", false, paragraphs[i]) || okAny;
      }
      return okAny;
    }

    // Две попытки: если с первого раза не вышло, редактор мог «перехватить»
    // фокус или сбросить выделение — повторяем, заново выделив фрагмент.
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        editor.focus();
      } catch (e) {}
      reselect();
      await sleep(attempt === 0 ? 80 : 40);
      reselect(); // редактор синхронизирует своё выделение асинхронно
      await sleep(20);

      if (tryPaste()) return true;
      if (tryFragment()) return true;
      // вставка могла пройти «мимо» Selection (например, редактор слушает
      // beforeinput) — тогда судим по факту: содержимое изменилось?
      if (editor.innerHTML !== before) return true;
    }

    // последний шанс — обычный текст; успехом считаем только реальное изменение
    try {
      editor.focus();
    } catch (e) {}
    reselect();
    tryText();
    return editor.innerHTML !== before;
  }

  // ---------------------------------------------------------------- UI ---

  function icon(name) {
    var paths = {
      wand:
        '<path d="M15 4V2m0 20v-2M9.5 8.5 3 15l6 6 6.5-6.5M13 7l4 4M19.5 4.5 21 3m-1.5 7.5L21 12M4 9h2M2 4h2"/>',
      undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
      close: '<path d="M18 6 6 18M6 6l12 12"/>',
      grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
      spin: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
      chevron: '<path d="M6 15l6-6 6 6"/>',
      link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>'
    };
    return (
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      paths[name] +
      "</svg>"
    );
  }

  // ------------------------------------------ уведомление и копирование ---
  // Уведомление — единственное место, где после вставки видно статистику.
  // Клик по нему копирует результат: выделять статью заново ради этого неудобно,
  // а текст часто нужен ещё где-то (в другом окне, в переписке, в черновике).

  var toastEl = null;

  /**
   * Копируем сразу два представления — HTML и обычный текст. Тогда вставка в
   * редактор сохранит абзацы и разметку, а в блокнот попадёт чистый текст.
   * Если браузер не даёт ClipboardItem, откатываемся на writeText, затем на
   * execCommand: на части страниц Clipboard API закрыт.
   */
  function copyToClipboard(copy) {
    var text = copy.text || "";
    var html = copy.html || "";

    function plain() {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        return Promise.reject(new Error("нет доступа к буферу обмена"));
      }
      return navigator.clipboard.writeText(text).then(function () {
        return "текстом";
      });
    }

    function legacy() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok
        ? Promise.resolve("текстом")
        : Promise.reject(new Error("браузер запретил копирование"));
    }

    if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard && navigator.clipboard.write) {
      try {
        var item = new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" })
        });
        return navigator.clipboard.write([item]).then(
          function () {
            return "с форматированием";
          },
          function () {
            return plain().catch(legacy);
          }
        );
      } catch (e) {
        /* конструктор не принял данные — идём обычным путём */
      }
    }
    return plain().catch(legacy);
  }

  function setToastHint(el, text, kind) {
    var hint = el.querySelector(".dzr-toast-hint");
    if (!hint) return;
    hint.textContent = text;
    hint.className = "dzr-toast-hint" + (kind ? " dzr-toast-hint-" + kind : "");
  }

  function hideToastAfter(el, ms) {
    clearTimeout(el.__t);
    el.__t = setTimeout(function () {
      el.classList.remove("dzr-show");
    }, ms);
  }

  function onToastClick() {
    var el = toastEl;
    if (!el || !el.__copy) return;
    copyToClipboard(el.__copy).then(
      function (how) {
        setToastHint(el, "📋 Скопировано " + how, "ok");
        hideToastAfter(el, 2600);
      },
      function (err) {
        setToastHint(el, "⚠️ Не удалось скопировать: " + ((err && err.message) || err), "err");
        hideToastAfter(el, 4200);
      }
    );
  }

  function ensureToast() {
    var el = toastEl && toastEl.isConnected ? toastEl : document.getElementById("dzr-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "dzr-toast";
      document.body.appendChild(el);
    }
    if (!el.__wired) {
      el.__wired = true;
      el.addEventListener("click", onToastClick);
      // уведомление — не кнопка, но кликабельно: с клавиатуры тоже должно работать
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          onToastClick();
        }
      });
    }
    toastEl = el;
    return el;
  }

  /**
   * Показать уведомление.
   *   isError — true (красная рамка), "warn" (жёлтая) или ничего.
   *   copy    — { text, html }: делает уведомление кликабельным, клик копирует.
   */
  function toast(message, isError, copy) {
    var el = ensureToast();
    el.innerHTML = message;
    el.style.borderColor =
      isError === true
        ? "rgba(248,113,113,.5)"
        : isError === "warn"
        ? "rgba(251,191,36,.45)"
        : "rgba(255,255,255,.12)";

    el.__copy = copy && (copy.text || copy.html) ? copy : null;
    el.classList.toggle("dzr-copyable", !!el.__copy);
    if (el.__copy) {
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.title = "Клик — скопировать результат в буфер обмена";
      var hint = document.createElement("span");
      hint.className = "dzr-toast-hint";
      hint.textContent = "Клик — скопировать результат";
      el.appendChild(hint);
    } else {
      el.removeAttribute("role");
      el.removeAttribute("tabindex");
      el.removeAttribute("title");
    }

    el.classList.add("dzr-show");
    // у кликабельного уведомления времени больше: его надо успеть заметить и прочитать
    hideToastAfter(el, el.__copy ? 9000 : 5200);
  }

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "dzr-status" + (kind ? " dzr-" + kind : "");
  }

  // ------------------------------------------------ свёртывание в пузырёк ---
  // Панель занимает место внизу экрана. Там, где редактора нет (лента, чтение
  // статьи), она мешает — сворачиваем её в круглый пузырёк.

  function setCollapsed(on) {
    if (!bar) return;
    if (on && busy) return; // во время работы нужны и статус, и «Отменить»
    collapsed = !!on;
    bar.classList.toggle("dzr-collapsed", collapsed);
    if (collapseBtn) {
      collapseBtn.innerHTML = collapsed ? icon("wand") : icon("chevron");
      collapseBtn.title = collapsed
        ? "Развернуть панель"
        : "Свернуть в пузырёк, чтобы не мешала";
      collapseBtn.setAttribute("aria-label", collapseBtn.title);
      collapseBtn.setAttribute("data-collapsed", collapsed ? "true" : "false");
    }
    // пока свёрнуты — следим, не появился ли редактор (Дзен — SPA)
    if (collapsed && !collapsedByUser) startEditorWatch();
    else stopEditorWatch();
    // в пузырьке держим его у края, чтобы не висел посреди текста
    if (barLeft != null) placeAt(barLeft, barTop, barSide);
  }

  function isCollapsed() {
    return collapsed;
  }

  function startEditorWatch() {
    if (editorWatch) return;
    editorWatch = setInterval(function () {
      if (!collapsed || collapsedByUser || closed) return;
      // карточка предпросмотра привязана к панели — не дёргаем её под руками
      if (isPreviewOpen()) return;
      if (hasWorkableEditor()) setCollapsed(false);
    }, 1500);
  }

  function stopEditorWatch() {
    if (editorWatch) {
      clearInterval(editorWatch);
      editorWatch = null;
    }
  }

  /**
   * Развернуть или свернуть — с учётом того, кто это решил.
   * Клик пользователя запоминаем: авто-правило больше не должно спорить с ним.
   */
  function toggleCollapsed(byUser) {
    if (byUser) collapsedByUser = true;
    setCollapsed(!collapsed);
  }

  // ----------------------------------------------------- предпросмотр ---
  // Перевод не должен затирать статью молча: сначала показываем, как текст
  // встанет, и ждём решения. «Отмена» не трогает статью вообще.

  var previewEl = null;
  var previewApply = null;
  var previewKeys = null;

  function isPreviewOpen() {
    return !!previewEl;
  }

  function closePreview() {
    if (previewKeys) {
      document.removeEventListener("keydown", previewKeys, true);
      previewKeys = null;
    }
    if (previewEl && previewEl.parentNode) previewEl.parentNode.removeChild(previewEl);
    previewEl = null;
    previewApply = null;
  }

  /** Ставим карточку над панелью, не давая ей уехать за пределы экрана. */
  function positionNearBar(el) {
    if (!el) return;
    var W = window.innerWidth;
    var H = window.innerHeight;
    var w = el.offsetWidth || 540;
    var h = el.offsetHeight || 380;
    var r = bar ? bar.getBoundingClientRect() : null;
    var left = r ? r.left : (W - w) / 2;
    var top = r ? r.top - h - 12 : (H - h) / 2;
    // не влезло сверху — ставим под панелью
    if (top < 12 && r) top = r.bottom + 12;
    left = Math.max(12, Math.min(left, W - w - 12));
    top = Math.max(12, Math.min(top, H - h - 12));
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
    el.style.visibility = "visible";
  }

  function positionPreview() {
    positionNearBar(previewEl);
  }

  /**
   * payload = { plain, html }, meta — строка со статистикой.
   * onApply вызывается только кнопкой «Применить»; Esc и «Отмена» — onCancel.
   */
  function showPreview(payload, meta, onApply, onCancel) {
    closePreview();

    previewEl = document.createElement("div");
    previewEl.id = "dzr-preview";
    previewEl.setAttribute("role", "dialog");
    previewEl.setAttribute("aria-label", "Предпросмотр перевода");
    previewEl.style.visibility = "hidden";

    var head = document.createElement("div");
    head.className = "dzr-pv-head";
    head.innerHTML =
      "<b>Предпросмотр</b>" +
      '<span class="dzr-pv-sub">так текст встанет в статью' +
      (meta ? " · " + escapeHtml(meta) : "") +
      "</span>";

    var body = document.createElement("div");
    body.className = "dzr-pv-body";
    body.innerHTML = payload.html || "<p>" + escapeHtml(payload.plain) + "</p>";

    var foot = document.createElement("div");
    foot.className = "dzr-pv-foot";

    var applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "dzr-pv-apply";
    applyBtn.textContent = "Применить";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "dzr-pv-cancel";
    cancelBtn.textContent = "Отмена";

    var hint = document.createElement("span");
    hint.className = "dzr-pv-hint";
    hint.textContent = "Ctrl+Enter — применить · Esc — отмена";

    foot.appendChild(applyBtn);
    foot.appendChild(cancelBtn);
    foot.appendChild(hint);

    previewEl.appendChild(head);
    previewEl.appendChild(body);
    previewEl.appendChild(foot);
    document.body.appendChild(previewEl);

    positionPreview();

    function doApply(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      var fn = previewApply;
      closePreview();
      if (fn) fn();
    }

    function doCancel(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      closePreview();
      if (onCancel) onCancel();
    }

    applyBtn.addEventListener("click", doApply);
    cancelBtn.addEventListener("click", doCancel);
    // клики по самой карточке не должны доходить до редактора статьи
    previewEl.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
    previewEl.addEventListener("click", function (e) {
      e.stopPropagation();
    });

    previewApply = onApply;

    previewKeys = function (e) {
      if (e.key === "Escape") doCancel(e);
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doApply(e);
    };
    document.addEventListener("keydown", previewKeys, true);
  }

  /** Пункты селекта с двумя подписями: полной и короткой (для вертикальной панели). */
  function fillSelect(sel, items) {
    items.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      opt.setAttribute("data-full", o[1]);
      opt.setAttribute("data-short", o[2] || o[1]);
      sel.appendChild(opt);
    });
  }

  /**
   * Стиль рерайта нужен только там, где текст проходит через AI. В режиме
   * «только перевод» он ни на что не влияет, поэтому прячем — панель и без
   * него широкая.
   */
  function syncPresetVisibility() {
    if (presetSel && modeSel) presetSel.hidden = modeSel.value === "translate";
  }

  /**
   * Название целевого языка в предложном падеже — для сообщений вида
   * «3 фрагм. уже на русском». Держим отдельно от селекта: там подпись с флагом
   * и в другой форме («На русский»), из неё фразу не собрать.
   */
  var LANG_IN = {
    ru: "русском",
    en: "английском",
    de: "немецком",
    es: "испанском",
    tr: "турецком",
    uk: "украинском",
    "zh-cn": "китайском"
  };

  function langIn() {
    return LANG_IN[String(S.targetLang).toLowerCase()] || String(S.targetLang);
  }

  /** Вертикальная раскладка панели (когда её притащили к боковому краю). */
  function setVertical(on) {
    if (!bar) return;
    bar.classList.toggle("dzr-vertical", !!on);
    [langSel, modeSel, presetSel].forEach(function (sel) {
      if (!sel) return;
      Array.prototype.forEach.call(sel.options, function (o) {
        var t = o.getAttribute(on ? "data-short" : "data-full");
        if (t) o.textContent = t;
      });
    });
  }

  function isVertical() {
    return !!(bar && bar.classList.contains("dzr-vertical"));
  }

  /**
   * Поставить панель в точку (left, top).
   * side — к какому краю экрана её прижали: "left" | "right" | "none".
   * Сторону определяем по позиции КУРСОРА, а не по габаритам панели: панель
   * широкая (600+ px), и её центр далеко от края даже когда она прижата к нему.
   * Иначе раскладка переключалась бы туда-сюда при перетаскивании.
   */
  function placeAt(left, top, side) {
    if (!bar) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    barSide = side || "none";
    setVertical(barSide === "left" || barSide === "right");

    // после смены раскладки размеры другие — считаем заново
    var rect = bar.getBoundingClientRect();
    var w = rect.width;
    var h = rect.height;

    if (barSide === "left") left = EDGE_GAP;
    else if (barSide === "right") left = vw - w - EDGE_GAP;

    barLeft = Math.max(EDGE_GAP, Math.min(left, Math.max(EDGE_GAP, vw - w - EDGE_GAP)));
    barTop = Math.max(EDGE_GAP, Math.min(top, Math.max(EDGE_GAP, vh - h - EDGE_GAP)));

    bar.style.transform = "none";
    bar.style.left = barLeft + "px";
    bar.style.top = barTop + "px";
    bar.style.bottom = "auto";
  }

  function sideForPointer(clientX) {
    if (clientX <= EDGE_ZONE) return "left";
    if (clientX >= window.innerWidth - EDGE_ZONE) return "right";
    return "none";
  }

  function buildBar() {
    if (document.getElementById("dzr-bar")) return;

    bar = document.createElement("div");
    bar.id = "dzr-bar";

    var grip = document.createElement("div");
    grip.className = "dzr-grip";
    grip.innerHTML = icon("grip");
    grip.title = "Перетащить панель";

    var controls = document.createElement("div");
    controls.className = "dzr-controls";

    langSel = document.createElement("select");
    langSel.className = "dzr-select";
    langSel.title = "Язык, на который переводим";
    fillSelect(langSel, [
      ["ru", "🇷🇺 На русский", "RU"],
      ["en", "🇬🇧 English", "EN"],
      ["de", "🇩🇪 Deutsch", "DE"],
      ["es", "🇪🇸 Español", "ES"],
      ["tr", "🇹🇷 Türkçe", "TR"],
      ["uk", "🇺🇦 Українська", "UK"],
      ["zh-CN", "🇨🇳 中文", "中文"]
    ]);

    modeSel = document.createElement("select");
    modeSel.className = "dzr-select";
    modeSel.title = "Что делать с текстом";
    fillSelect(modeSel, [
      ["translate+rewrite", "Перевод + рерайт", "П+Р"],
      ["translate", "Только перевод", "Перевод"],
      ["rewrite", "Только рерайт", "Рерайт"]
    ]);

    presetSel = document.createElement("select");
    presetSel.className = "dzr-select";
    presetSel.title = "Стиль AI-рерайта";
    fillSelect(
      presetSel,
      ((globalThis.DzenPresets && globalThis.DzenPresets.list) || []).map(function (p) {
        return [p.id, p.name, p.short || p.name];
      })
    );

    goBtn = document.createElement("button");
    goBtn.className = "dzr-go";
    goBtn.title = "Перевести и отрерайтить выделенный текст (Ctrl+Shift+Y)";
    goLabel = icon("wand") + "<span>Перевести и рерайтить</span>";
    goBtn.innerHTML = goLabel;

    undoBtn = document.createElement("button");
    undoBtn.className = "dzr-icon-btn";
    undoBtn.title = "Отменить вставку и скопировать оригинал";
    undoBtn.innerHTML = icon("undo");
    undoBtn.hidden = true;

    // Перелинковка: отдельная кнопка, потому что это другая задача — не переписать
    // статью, а расставить в ней ссылки на материалы своих сайтов.
    linkBtn = document.createElement("button");
    linkBtn.className = "dzr-link-btn";
    linkBtn.title = "Перелинковка: превратить упоминания моделей в ссылки на свои статьи";
    linkBtn.innerHTML = icon("link") + "<span>Перелинковка</span>";

    collapseBtn = document.createElement("button");
    collapseBtn.className = "dzr-icon-btn dzr-toggle";
    collapseBtn.title = "Свернуть в пузырёк, чтобы не мешала";
    collapseBtn.innerHTML = icon("chevron");

    var closeBtn = document.createElement("button");
    closeBtn.className = "dzr-icon-btn";
    closeBtn.title = "Скрыть панель до перезагрузки страницы";
    closeBtn.innerHTML = icon("close");

    statusEl = document.createElement("div");
    statusEl.className = "dzr-status";
    statusEl.textContent = "Выделите текст";

    controls.appendChild(langSel);
    controls.appendChild(modeSel);
    controls.appendChild(presetSel);
    bar.appendChild(grip);
    bar.appendChild(controls);
    bar.appendChild(goBtn);
    bar.appendChild(linkBtn);
    bar.appendChild(statusEl);
    bar.appendChild(undoBtn);
    bar.appendChild(collapseBtn);
    bar.appendChild(closeBtn);
    document.body.appendChild(bar);

    langSel.value = S.targetLang;
    modeSel.value = S.mode;
    presetSel.value = S.aiPreset;
    syncPresetVisibility();

    goBtn.addEventListener("click", function (e) {
      e.preventDefault();
      // во время работы кнопка превращается в «Отменить»
      if (busy) cancelRun();
      else run();
    });
    linkBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (busy) cancelRun();
      else runLinkify();
    });
    langSel.addEventListener("change", function () {
      S.targetLang = langSel.value;
      send({ type: "saveSettings", settings: { targetLang: S.targetLang } });
    });
    modeSel.addEventListener("change", function () {
      S.mode = modeSel.value;
      send({ type: "saveSettings", settings: { mode: S.mode } });
      syncPresetVisibility();
    });
    presetSel.addEventListener("change", function () {
      S.aiPreset = presetSel.value;
      var patch = { aiPreset: S.aiPreset };
      // Промпт сохраняем вместе со стилем: service worker читает настройки на
      // каждый запрос и о смене стиля иначе не узнает. Для «своего промпта»
      // текст не трогаем — там как раз пользовательский.
      var p = globalThis.DzenPresets && globalThis.DzenPresets.byId(S.aiPreset);
      if (p && !p.custom) patch.aiPrompt = p.prompt;
      send({ type: "saveSettings", settings: patch });
    });
    undoBtn.addEventListener("click", function () {
      undoLast();
    });
    collapseBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleCollapsed(true);
    });
    closeBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      closed = true;
      stopEditorWatch();
      closePreview(); // карточка без панели бессмысленна
      bar.remove();
    });

    // Главное: панель не должна забирать фокус у редактора.
    // Иначе Дзен сбрасывает выделение и мы теряем выделенный фрагмент.
    bar.addEventListener("mousedown", function (e) {
      if (e.target && e.target.closest && e.target.closest("select")) return; // селекту нужен фокус
      captureSelection();
      e.preventDefault();
    });

    makeDraggable(bar, grip);
    restorePosition();
    watchSelection();
  }

  function makeDraggable(el, handle) {
    var sx = 0,
      sy = 0,
      dragging = false;

    handle.addEventListener("mousedown", function (e) {
      dragging = true;
      // переходим от CSS-центрирования к абсолютным координатам
      var rect = el.getBoundingClientRect();
      el.style.transform = "none";
      el.style.bottom = "auto";
      barLeft = rect.left;
      barTop = rect.top;
      el.style.left = barLeft + "px";
      el.style.top = barTop + "px";
      sx = e.clientX;
      sy = e.clientY;
      el.classList.add("dzr-dragging");
      e.preventDefault();
    });

    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx;
      var dy = e.clientY - sy;
      sx = e.clientX;
      sy = e.clientY;
      placeAt(
        (barLeft == null ? 0 : barLeft) + dx,
        (barTop == null ? 0 : barTop) + dy,
        sideForPointer(e.clientX)
      );
    });

    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("dzr-dragging");
      if (barLeft != null) placeAt(barLeft, barTop, barSide);
      savePosition();
    });
  }

  function savePosition() {
    try {
      chrome.storage.local.set({
        barPos: { left: barLeft, top: barTop, side: barSide }
      });
    } catch (e) {}
  }

  function restorePosition() {
    try {
      chrome.storage.local.get({ barPos: null }, function (data) {
        if (!bar || !data || !data.barPos) return;
        var pos = data.barPos;
        if (typeof pos.left !== "number" || typeof pos.top !== "number") return;
        placeAt(pos.left, pos.top, pos.side || "none");
      });
    } catch (e) {}
  }

  function watchSelection() {
    document.addEventListener("selectionchange", function () {
      if (busy) return;
      if (captureSelection()) {
        setStatus("Выделено: " + countWords(savedText) + " сл.", "ok");
      } else if (hasSaved()) {
        // выделение уже снято (например, кликом по панели), но мы его помним
        setStatus("Выделено: " + countWords(savedText) + " сл. ✓", "ok");
      } else {
        setStatus("Выделите текст");
      }
    });
    // фиксируем выделение до того, как клик по панели его сбросит
    document.addEventListener(
      "mouseup",
      function () {
        if (!busy) captureSelection();
      },
      true
    );
  }

  // ------------------------------------------------------------ процесс ---

  /** Снять «режим подтверждения» и вернуть кнопке обычную подпись. */
  function resetConfirm() {
    clearTimeout(confirmTimer);
    confirmTimer = null;
    confirmedAll = false;
    if (goBtn) {
      goBtn.classList.remove("dzr-confirm");
      if (!busy) goBtn.innerHTML = goLabel;
    }
  }

  /** Прервать текущий перевод: текст в редакторе при этом не трогается. */
  function cancelRun() {
    if (!busy || !currentRunId) return;
    var id = currentRunId;
    currentRunId = null;
    send({ type: "cancelTranslate", requestId: id });
    setStatus("Отменяю…", "warn");
    if (goBtn) {
      goBtn.disabled = true;
      goBtn.innerHTML = '<span class="dzr-spin" style="line-height:0">' + icon("spin") + "</span><span>Отмена…</span>";
    }
  }

  /** Надёжный откат: сначала штатный Ctrl+Z редактора, иначе снимок DOM. */
  function undoLast() {
    var snap = undoSnapshot;

    if (!snap || !snap.editor || !document.contains(snap.editor)) {
      try {
        document.execCommand("undo");
      } catch (e) {}
      if (lastOriginal) {
        navigator.clipboard.writeText(lastOriginal).catch(function () {});
        toast("↩️ Отменено. Оригинал скопирован в буфер обмена.");
      }
      return;
    }

    var ed = snap.editor;
    try {
      ed.focus();
    } catch (e) {}

    // textarea: просто возвращаем прежнее значение
    if (snap.value != null) {
      setNativeValue(ed, snap.value);
      undoSnapshot = null;
      undoBtn.hidden = true;
      if (lastOriginal) navigator.clipboard.writeText(lastOriginal).catch(function () {});
      toast("↩️ Вставка отменена. Оригинал скопирован в буфер обмена.");
      return;
    }

    // Перелинковка: возвращаем снимок напрямую. Нативная отмена здесь не
    // работает — вставка идёт синтетической вставкой/заменой узлов и в
    // историю набора не попадает, а по тексту «до» и «после» не различить:
    // текст статьи перелинковка не меняет.
    if (snap.restore && snap.html != null) {
      try {
        ed.innerHTML = snap.html;
        ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo" }));
      } catch (e) {}
      undoSnapshot = null;
      undoBtn.hidden = true;
      toast("↩️ Ссылки убраны — статья вернулась к исходному виду.");
      return;
    }

    try {
      document.execCommand("undo");
    } catch (e) {}

    setTimeout(function () {
      // сравниваем «сплющенный» текст: innerText содержит переводы строк,
      // а probe их не содержит — иначе indexOf никогда не совпадёт
      var now = String(ed.innerText || "").replace(/\s+/g, " ");
      var probeIn = (snap.plain || "").replace(/\s+/g, " ").trim().slice(0, 40);
      var probeOr = (snap.orig || "").replace(/\s+/g, " ").trim().slice(0, 40);
      var insertedStill = !!probeIn && now.indexOf(probeIn) !== -1;
      var originalBack = !!probeOr && now.indexOf(probeOr) !== -1;
      var restored = false;

      // штатный откат не сработал (текст на месте, оригинала нет) — возвращаем снимок
      if (insertedStill && !originalBack && snap.html != null) {
        try {
          ed.innerHTML = snap.html;
          ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo" }));
          restored = true;
        } catch (e) {}
      }

      undoSnapshot = null;
      undoBtn.hidden = true;
      if (document.documentElement.hasAttribute("data-dzr-debug")) {
        document.documentElement.setAttribute(
          "data-dzr-undo",
          JSON.stringify({ insertedStill: insertedStill, originalBack: originalBack, restored: restored })
        );
      }
      if (lastOriginal) navigator.clipboard.writeText(lastOriginal).catch(function () {});
      toast(
        "↩️ Вставка отменена" +
          (restored ? " (восстановил из снимка)" : "") +
          ".<br>Оригинал скопирован в буфер обмена."
      );
    }, 150);
  }

  /**
   * Вставка и всё, что после неё: снимок для отката, статистика, уведомления.
   * Вынесено отдельно, потому что вызывается двумя путями — сразу или после
   * подтверждения в предпросмотре.
   */
  async function insertAndReport(job) {
    // busy здесь НЕ проверяем: при вызове из run() он уже выставлен в true,
    // и проверка молча съедала бы вставку. Повторный вход не страшен —
    // вызывающий либо уже под защитой busy (run), либо кнопка в карточке
    // исчезает вместе с карточкой до повторного клика (предпросмотр).
    busy = true;
    try {
      var editor = job.editor;
      var isField = editor.tagName === "TEXTAREA" || editor.tagName === "INPUT";

      // снимок берём ровно перед вставкой: до этого момента статья не тронута
      undoSnapshot = isField
        ? { editor: editor, value: editor.value, plain: job.payload.plain, orig: job.plain }
        : {
            editor: editor,
            html: editor.innerHTML,
            plain: job.payload.plain,
            orig: job.plain,
            // Перелинковка не меняет текст — только добавляет ссылки. Значит,
            // отличить «вставлено» от «оригинала» по тексту нельзя, и откат
            // обязан идти напрямую по снимку (см. undoLast).
            restore: !!job.linkStats
          };

      setStatus("Вставляю…");
      var inserted = await replaceSelection(editor, job.payload, job.range, job.usedSelectAll);
      if (!inserted) throw new Error("Не удалось вставить текст в редактор");

      // Перелинковка отчитывается иначе: статистика перевода тут ни при чём —
      // она считалась бы по исходному тексту, а не по переводу.
      if (job.linkStats) {
        reportLinkResult(job);
        return;
      }

      var uniq = globalThis.DzenRewriter.uniqueness(job.plain, job.result);
      var st = globalThis.DzenRewriter.stats(job.result);
      var secs = ((Date.now() - job.started) / 1000).toFixed(1);

      // что происходило с переводом — показываем, а не прячем
      var notes = [];
      var ts = job.translateStats;
      if (ts) {
        if (ts.cached) notes.push(ts.cached + " из кэша");
        if (ts.skipped) notes.push(ts.skipped + " фрагм. уже на " + langIn() + " — не отправлял");
        if (ts.fellBack) notes.push(ts.fellBack + " через " + ts.fallbackName);
        if (ts.failed) notes.push("⚠️ " + ts.failed + " не переведено");
      }
      // Снятые ссылки — тоже часть отчёта: пользователь должен видеть, что из
      // оригинала что-то выкинули, а не гадать, куда делась ссылка на источник.
      if (job.strippedLinks) notes.push("🔗 " + job.strippedLinks + " ссыл. убрано из оригинала");

      clearSaved();
      setStatus("Готово за " + secs + " с", "ok");
      undoBtn.hidden = false;

      // Раньше предупреждение о фолбэке показывалось ОТДЕЛЬНЫМ уведомлением сразу
      // после успешного — то есть затирало его, и статистика пропадала. Теперь это
      // одно уведомление: сначала результат, ниже — оговорки.
      var warn = null;
      if (ts && ts.fellBack) {
        warn =
          "⚠️ " +
          ts.engine +
          " не отвечал — " +
          ts.fellBack +
          " фрагм. переведены через " +
          ts.fallbackName +
          ". Качество может отличаться.";
      } else if (ts && ts.failed) {
        warn =
          "⚠️ " +
          ts.failed +
          " фрагм. не удалось перевести — они оставлены на языке оригинала. " +
          "Нажмите кнопку ещё раз: удачные куски возьмутся из кэша.";
      }
      // Отказ AI важнее оговорок переводчика: текст в статье переписан не
      // моделью, а встроенным рерайтером, и человек обязан это знать.
      if (job.aiNote) {
        warn =
          "⚠️ AI недоступен (" +
          job.aiNote +
          ") — текст переписан встроенным рерайтером.";
      }

      toast(
        "✅ <b>Готово!</b>" +
          (job.usedSelectAll ? "<br>Обработан весь текст редактора." : "") +
          "<br>" +
          st.words +
          " слов · " +
          st.chars +
          " символов · уникальность ≈ " +
          uniq +
          "%" +
          (notes.length ? '<br><span class="dzr-dim">' + notes.join(" · ") + "</span>" : "") +
          (warn ? '<br><span class="dzr-warn">' + warn + "</span>" : "") +
          '<br><span class="dzr-dim">Ctrl+Z или ↩️ — отменить вставку</span>',
        warn ? "warn" : false,
        { text: job.payload.plain, html: job.payload.html }
      );
    } catch (err) {
      setStatus("Ошибка", "error");
      toast("❌ " + escapeHtml(String((err && err.message) || err)), true);
    } finally {
      busy = false;
      goBtn.disabled = false;
      goBtn.classList.remove("dzr-cancel");
      goBtn.innerHTML = goLabel;
    }
  }

  // ---------------------------------------------------------- перелинковка ---
  // Ссылку получает слово, которое уже есть в тексте: анкор — живое упоминание
  // модели, а не приставленная сбоку конструкция «Читайте также». Поэтому статья
  // не переписывается, а только обогащается ссылками, и текст остаётся прежним.

  /** Внешние ссылки помечаем nofollow: на Дзене это норма для ссылок на свои сайты. */
  function relForUrl(url) {
    return /^https?:\/\/([^/]*\.)?dzen\.ru(\/|$)/i.test(url) || /^https?:\/\/zen\.yandex\.ru(\/|$)/i.test(url)
      ? ""
      : ' rel="nofollow noopener"';
  }

  /**
   * Оборачивает первое вхождение анкора в ссылку. Идём по HTML как по частям
   * «тег / текст» и трогаем только текст: иначе ссылка разрезала бы разметку
   * пополам, а внутрь уже существующей ссылки попадать нельзя вовсе.
   * null — анкор не найден или разорван тегами (тогда ссылку не ставим).
   */
  function wrapAnchorInHtml(html, anchor, url, rel) {
    var parts = String(html).match(/<[^>]*>|[^<]+/g);
    if (!parts) return null;
    var low = String(anchor).toLowerCase();
    var inLink = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].charAt(0) === "<") {
        if (/^<a[\s>]/i.test(parts[i])) inLink++;
        else if (/^<\/a[\s>]/i.test(parts[i])) inLink = Math.max(0, inLink - 1);
        continue;
      }
      if (inLink) continue;
      var at = parts[i].toLowerCase().indexOf(low);
      while (at >= 0 && !onWordBoundary(parts[i], at, anchor.length)) {
        at = parts[i].toLowerCase().indexOf(low, at + 1);
      }
      if (at < 0) continue;
      parts[i] =
        parts[i].slice(0, at) +
        '<a href="' +
        escapeHtml(url) +
        '"' +
        (rel || "") +
        ">" +
        escapeHtml(parts[i].slice(at, at + anchor.length)) +
        "</a>" +
        parts[i].slice(at + anchor.length);
      return parts.join("");
    }
    return null;
  }

  /**
   * Раскладка ссылок по статье. Правила намеренно жёсткие: ссылка в первом
   * абзаце читается как реклама, две подряд — как спам, повтор анкора — как
   * накрутка. Поэтому: не первый абзац, не соседние абзацы, не заголовки и не
   * подписи к картинкам, один анкор — один раз.
   */
  function makeLinkPlanner(blocks, links, count) {
    var placed = [];
    var used = {};
    var lastAt = -2;
    var queue = (links || []).slice();

    // «Первый абзац» — это первый абзац, а не блок с индексом 0: статью почти
    // всегда открывает заголовок, и по индексу лид сдвигался бы на строку вниз,
    // получая ровно ту ссылку, от которой мы уходим.
    var lead = -1;
    for (var n = 0; n < blocks.length; n++) {
      var tg = String((blocks[n] && blocks[n].tag) || "").toLowerCase();
      if (!/^h[1-6]$/.test(tg) && tg !== "figcaption") {
        lead = n;
        break;
      }
    }

    return {
      placed: placed,
      /** Вызывается для каждого блока при сборке HTML: inner — его разметка. */
      apply: function (i, inner) {
        if (placed.length >= count) return inner;
        if (i === lead && blocks.length > 1) return inner; // лид не трогаем
        if (i - lastAt < 2) return inner; // и не ставим в соседние абзацы
        var tag = String((blocks[i] && blocks[i].tag) || "").toLowerCase();
        if (/^h[1-6]$/.test(tag) || tag === "figcaption") return inner;
        for (var k = 0; k < queue.length; k++) {
          var link = queue[k];
          var key = String(link.anchor).toLowerCase();
          if (used[key]) continue;
          var html = wrapAnchorInHtml(inner, link.anchor, link.url, relForUrl(link.url));
          if (html == null) continue;
          used[key] = true;
          queue.splice(k, 1);
          lastAt = i;
          placed.push({
            block: i,
            anchor: link.anchor,
            url: link.url,
            kind: link.kind,
            // Заголовок нужен отчёту: у статьи канала адрес /a/<id> нечитаем.
            // Без него в уведомлении показывался адрес, хотя заголовок уже был
            // найден при подборе — терялся ровно здесь.
            title: link.title
          });
          return html;
        }
        return inner;
      }
    };
  }

  /** Заголовок статьи канала для отчёта — с обрезкой по длине. */
  function shortTitle(title) {
    var s = String(title || "").replace(/\s+/g, " ").trim();
    return s.length > 60 ? s.slice(0, 60).replace(/\s+\S*$/, "") + "…" : s;
  }

  /**
   * «1 ведёт», «2 ведут»: в отчёте рядом с числом стоит глагол, и «1 ведут»
   * читается как ошибка. Считаем по-русски: 11–14 — исключение.
   */
  function leadsWord(n) {
    var last = n % 10;
    var lastTwo = n % 100;
    return last === 1 && lastTwo !== 11 ? "ведёт" : "ведут";
  }

  /** Короткая подпись адреса для уведомления: домен и хвост слага. */
  function hostLabel(url) {
    var m = /^https?:\/\/([^/]+)(\/[^?#]*)?/i.exec(String(url));
    if (!m) return String(url);
    var host = m[1].replace(/^www\./, "");
    var path = (m[2] || "").replace(/\/+$/, "");
    if (!path) return host;
    var parts = path.split("/").filter(Boolean);
    var last = parts[parts.length - 1] || "";
    if (last.length > 30) last = last.slice(0, 30) + "…";
    return host + "/" + last;
  }

  function noLinksMessage(stats) {
    var s = stats || {};
    if (!s.sites && !s.channels) {
      return (
        "⚠️ Перелинковка: ни сайтов, ни каналов не указано.<br>" +
        '<span class="dzr-dim">Откройте настройки расширения и впишите сайты или каналы Дзена — по строке на адрес.</span>'
      );
    }
    if (!s.models) {
      return (
        "⚠️ Перелинковка: в тексте нет названий моделей, которые я знаю.<br>" +
        '<span class="dzr-dim">Ссылкой становится «марка + модель»: Volvo XC40, Toyota Camry, Scania T143.</span>'
      );
    }
    var parts = [];
    if (s.unmapped && s.unmapped.length) parts.push("не нашёл материал для: " + s.unmapped.join(", "));
    if (s.noSitemap && s.noSitemap.length) parts.push("без карты сайта: " + s.noSitemap.join(", "));
    if (s.noChannel && s.noChannel.length) parts.push("канал не удалось обойти: " + s.noChannel.join(", "));
    return (
      "⚠️ Перелинковка: ссылок не поставил.<br>" +
      '<span class="dzr-dim">' + escapeHtml(parts.join(" · ") || "подходящих статей не нашлось") + "</span>"
    );
  }

  /** Отчёт после вставки ссылок — вместо статистики перевода, она тут ни при чём. */
  function reportLinkResult(job) {
    var ls = job.linkStats || {};
    var placed = ls.placed || [];
    var s = ls.stats || {};
    var secs = ((Date.now() - job.started) / 1000).toFixed(1);

    var rows = placed.map(function (p) {
      // У статьи канала адрес нечитаемый (/a/<id>) — показываем заголовок.
      // Длинный заголовок режем: строка отчёта не должна занимать весь экран.
      var label = p.title ? shortTitle(p.title) : hostLabel(p.url);
      return escapeHtml(p.anchor) + " → " + escapeHtml(label);
    });
    var notes = [];
    if (s.unmapped && s.unmapped.length) notes.push("не нашёл материал: " + s.unmapped.join(", "));
    // Считаем по расставленным, а не по кандидатам: в статье человек видит
    // ровно эти ссылки, и «4 ведут на сам сайт» при двух ссылках читалось бы
    // как ошибка.
    var siteOnly = placed.filter(function (p) {
      return p.kind === "site";
    });
    if (siteOnly.length) {
      // Канал — не сайт: «нет sitemap.xml» для него неверно, карты у канала нет
      // в принципе, её собирают обходом ленты.
      var toChannel = siteOnly.filter(function (p) {
        return /^https?:\/\/dzen\.ru\//i.test(p.url);
      }).length;
      var toSite = siteOnly.length - toChannel;
      var where = [];
      if (toSite) where.push(toSite + " " + leadsWord(toSite) + " на сам сайт — нет sitemap.xml");
      if (toChannel) {
        where.push(toChannel + " " + leadsWord(toChannel) + " на сам канал — карту собрать не удалось");
      }
      notes.push(where.join(" · "));
    }

    clearSaved();
    setStatus("Готово: " + placed.length + " ссыл.", "ok");
    undoBtn.hidden = false;
    toast(
      "🔗 <b>Перелинковка: " + placed.length + "</b>" +
        (job.usedSelectAll ? "<br>Ссылки расставлены по всей статье." : "") +
        '<br><span class="dzr-dim">' +
        rows.join("<br>") +
        "</span>" +
        (notes.length ? '<br><span class="dzr-warn">' + escapeHtml(notes.join(" · ")) + "</span>" : "") +
        '<br><span class="dzr-dim">' +
        secs +
        " с · Ctrl+Z или ↩️ — отменить вставку</span>",
      false,
      { text: job.payload.plain, html: job.payload.html }
    );
  }

  /**
   * Перелинковка: берём статью (или выделение), просим у воркера ссылки под
   * найденные модели и расставляем их по абзацам. Текст при этом не меняется —
   * если ссылок не нашлось, статью вообще не трогаем.
   */
  async function runLinkify() {
    if (busy) return;
    if (isPreviewOpen()) closePreview();

    var editor = findEditor();
    if (!editor) {
      toast("❌ Не нашёл поле редактора на странице. Кликните в текст статьи и попробуйте снова.", true);
      return;
    }
    if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
      toast("⚠️ Перелинковка работает в редакторе статьи, а не в поле ввода.", true);
      return;
    }

    var range = hasSaved() ? savedRange.cloneRange() : null;
    if (!range) {
      var live = liveSelectionRange();
      if (live) range = live.cloneRange();
    }
    var usedSelectAll = !range;
    if (usedSelectAll) range = makeSelectAllRange(editor);

    var table = newTable();
    var root = editableRoot(range.commonAncestorContainer) || editableRoot(range.startContainer) || editor;
    var blocks = readBlocks(range, root, table);
    var plain = blocks.length ? blocksToText(blocks) : rangeToText(range);
    var source = blocks.length ? blocksToText(blocks, "raw") : plain;

    if (!plain.trim()) {
      toast("❌ Не удалось прочитать текст из редактора.", true);
      return;
    }

    busy = true;
    linkBtn.disabled = true;
    var started = Date.now();
    try {
      setStatus("Подбираю ссылки…");
      var res = await send({ type: "linkify", text: plain });
      if (!res.ok) throw new Error(res.error);

      var links = res.links || [];
      var stats = res.stats || {};
      var want = Math.max(1, Math.min(10, parseInt(S.linkCount, 10) || 2));
      var planner = makeLinkPlanner(blocks, links, want);
      var ctx = blockContext(range, blocks);
      var payload = buildPayload(source, blocks, ctx, table, planner.apply);

      if (!planner.placed.length) {
        // Ссылок нет — статью не перевставляем: незачем трогать текст без причины
        setStatus("Ссылок не нашлось", "warn");
        toast(noLinksMessage(stats), "warn");
        return;
      }

      await insertAndReport({
        payload: payload,
        editor: editor,
        range: range,
        usedSelectAll: usedSelectAll,
        plain: plain,
        result: source,
        started: started,
        linkStats: { placed: planner.placed, stats: stats }
      });
    } catch (err) {
      setStatus("Ошибка", "error");
      toast("❌ " + escapeHtml(String((err && err.message) || err)), true);
    } finally {
      busy = false;
      linkBtn.disabled = false;
    }
  }

  async function run() {
    if (busy) return;
    // новый запуск отменяет неразобранный предпросмотр: пользователь явно
    // попросил пересчитать, а не применить старое
    if (isPreviewOpen()) closePreview();

    var editor = findEditor();
    if (!editor) {
      toast("❌ Не нашёл поле редактора на странице. Кликните в текст статьи и попробуйте снова.", true);
      return;
    }

    var isField = editor.tagName === "TEXTAREA" || editor.tagName === "INPUT";

    // 1) Выделение, запомненное до клика по панели — основной источник.
    var range = hasSaved() ? savedRange.cloneRange() : null;
    // 2) Если запомненного нет — берём живое выделение.
    if (!range) {
      var live = liveSelectionRange();
      if (live) range = live.cloneRange();
    }
    // 3) Ничего не выделено — по инструкции берём весь текст редактора,
    //    но сначала спрашиваем подтверждение: это перезапишет всю статью.
    var usedSelectAll = !range;
    if (usedSelectAll && !isField) range = makeSelectAllRange(editor);

    if (usedSelectAll && !isField && !confirmedAll) {
      var charsAll = String(editor.innerText || "").length;
      if (charsAll > 200) {
        confirmedAll = true;
        goBtn.classList.add("dzr-confirm");
        goBtn.innerHTML = icon("wand") + "<span>Обработать всю статью?</span>";
        setStatus("Вся статья: " + charsAll + " симв.", "warn");
        toast(
          "⚠️ Ничего не выделено.<br>Нажмите кнопку ещё раз, чтобы обработать <b>всю статью</b> (" +
            charsAll +
            " симв.)."
        );
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(resetConfirm, 8000);
        return;
      }
    }
    resetConfirm();

    var table = newTable();
    var blocks = [];
    var plain = "";
    var source = "";

    if (isField) {
      if (usedSelectAll) {
        plain = editor.value || "";
      } else {
        var s0 = editor.selectionStart || 0;
        var e0 = editor.selectionEnd != null ? editor.selectionEnd : 0;
        plain = e0 > s0 ? editor.value.slice(s0, e0) : "";
        if (!plain.trim()) {
          plain = editor.value || "";
          usedSelectAll = true;
        }
      }
      source = plain;
    } else {
      var root = editableRoot(range.commonAncestorContainer) || editableRoot(range.startContainer) || editor;
      // Ссылки снимаем только здесь — на пути перевода. Перелинковка читает те же
      // блоки без этой опции и статью не трогает.
      blocks = readBlocks(range, root, table, { stripLinks: true });
      plain = blocks.length ? blocksToText(blocks) : rangeToText(range);
      source = blocks.length ? blocksToText(blocks, "raw") : plain;
    }

    // Ссылки, снятые с текста ещё до перевода. Считаем их здесь, пока таблица
    // маркеров под рукой: к моменту вставки от неё уже ничего не остаётся.
    var strippedLinks = (table.anchors || []).length;

    if (!plain.trim()) {
      toast(
        "❌ Не удалось прочитать текст из редактора.<br><span class=\"dzr-dim\">" +
          describeEditor(editor) +
          "</span>",
        true
      );
      return;
    }
    if (plain.length > 40000) {
      toast("⚠️ Слишком много текста (" + plain.length + " симв.). Обработайте статью частями.", true);
      return;
    }

    busy = true;
    lastOriginal = plain;
    currentRunId = "r" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    aiLocal = false; // признак прошлого запуска не должен пережить новый
    // пока идёт работа, кнопка работает как «Отменить»
    goBtn.disabled = false;
    goBtn.classList.add("dzr-cancel");
    goBtn.innerHTML = icon("close") + "<span>Отменить</span>";
    var started = Date.now();
    var translateStats = null;
    // Причина отказа AI, если он был. Отдельным уведомлением её показывать
    // нельзя: сразу за ним приходит «Готово», и toast() затирает первое — то
    // есть человек видел успех ровно там, где модель не работала вовсе.
    var aiNote = null;

    try {
      var result = source;

      if (S.mode !== "rewrite") {
        // отладочный канал: data-dzr-fake-translate="..." подставляет «перевод»
        // из атрибута — удобно проверять разбор маркеров без сети
        var fake = document.documentElement.getAttribute("data-dzr-fake-translate");
        if (fake != null) {
          // "@echo" — вернуть исходный текст как есть. Так проверяем, что разбор
          // маркеров и глоссарий ничего не теряют и не добавляют: результат
          // обязан совпасть со статьёй (кроме подстановок глоссария).
          result = fake === "@echo" ? source : fake;
        } else {
          setStatus("Перевожу… 0%");
          var tr = await send({
            type: "translate",
            text: source,
            requestId: currentRunId,
            overrides: { targetLang: S.targetLang, sourceLang: S.sourceLang }
          });
          if (!tr.ok) {
            if (tr.cancelled) {
              var ce = new Error("Отменено");
              ce.cancelled = true;
              throw ce;
            }
            throw new Error(tr.error);
          }
          result = tr.text;
          translateStats = tr.stats || null;
        }
      }

      if (S.mode !== "translate" && document.documentElement.getAttribute("data-dzr-fake-translate") == null) {
        setStatus("Рерайчу…");
        if (S.aiEnabled) {
          // Секунды в статусе — не украшение. Своя модель отвечает минуту и
          // больше, и неподвижное «Рерайчу…» в это время неотличимо от
          // зависания: человек жмёт кнопку второй раз и запускает второй
          // запрос. Заодно говорим словами, что долгое ожидание — это норма.
          var aiStart = Date.now();
          var aiTick = setInterval(function () {
            setStatus(
              "Рерайчу… " +
                Math.round((Date.now() - aiStart) / 1000) +
                " с" +
                (aiLocal ? " — своя модель отвечает небыстро, ждём" : "")
            );
          }, 1000);
          var ai;
          try {
            ai = await send({ type: "aiRewrite", text: result, requestId: currentRunId });
          } finally {
            clearInterval(aiTick);
          }
          if (ai.ok) {
            result = ai.text;
          } else if (ai.cancelled) {
            var ce2 = new Error("Отменено");
            ce2.cancelled = true;
            throw ce2;
          } else {
            aiNote = ai.error;
            result = globalThis.DzenRewriter.rewrite(result, { strength: S.strength });
          }
        } else {
          result = globalThis.DzenRewriter.rewrite(result, { strength: S.strength });
        }
      }

      // разбираем ответ обратно по блокам: заголовки, абзацы, списки,
      // картинки и инлайн-разметку возвращаем на место
      var ctx = blockContext(range, blocks);
      var payload = buildPayload(result, blocks, ctx, table);

      // Приписка в конце статьи — наш собственный текст, а не перевод, поэтому
      // дописываем его после сборки: переводчик его не видит и не портит.
      var sig = signatureFor(blocks, editor, plain);
      if (sig) {
        payload.html +=
          ctx.mode === "contents" ? "<br><br>" + escapeHtml(sig) : "<p>" + escapeHtml(sig) + "</p>";
        payload.plain += (payload.plain ? "\n\n" : "") + sig;
      }

      if (document.documentElement.hasAttribute("data-dzr-debug")) {
        document.documentElement.setAttribute(
          "data-dzr-debug-info",
          JSON.stringify({
            mode: ctx.mode,
            parent: ctx.parent ? ctx.parent.tagName : null,
            blocks: blocks.map(function (b) {
              return b.tag;
            }),
            parts: blocks.length ? (splitResult(result, blocks.length) ? blocks.length : 0) : 0,
            raw: source.slice(0, 800),
            stripped: strippedLinks,
            signature: !!sig,
            tokens: Object.keys(table.map).map(function (k) {
              var t = table.map[k];
              return k + ":" + t.kind + (t.broken ? "!BROKEN" : "") + "x" + t.refs;
            }),
            html: payload.html,
            source: plain.slice(0, 300)
          })
        );
      }

      var job = {
        payload: payload,
        editor: editor,
        range: range,
        usedSelectAll: usedSelectAll,
        plain: plain,
        result: result,
        translateStats: translateStats,
        strippedLinks: strippedLinks,
        aiNote: aiNote,
        started: started
      };

      // Предпросмотр: статью не трогаем, пока пользователь не нажмёт «Применить»
      if (S.preview) {
        var st0 = globalThis.DzenRewriter.stats(result);
        // Отказ AI виден и здесь: в предпросмотре нет итогового уведомления,
        // и без пометки человек решил бы, что текст переписала модель.
        setStatus(
          aiNote ? "Предпросмотр: AI недоступен — переписано встроенным рерайтером" : "Предпросмотр: проверьте результат",
          "warn"
        );
        showPreview(
          payload,
          st0.words + " слов · " + st0.chars + " симв." + (aiNote ? " · ⚠️ AI недоступен: " + aiNote : ""),
          function () {
            insertAndReport(job);
          },
          function () {
            setStatus("Отменено — текст не изменён", "warn");
            toast("⏹ Предпросмотр закрыт. Текст статьи не изменён.");
          }
        );
        return;
      }

      await insertAndReport(job);
    } catch (err) {
      if (err && err.cancelled) {
        setStatus("Отменено", "warn");
        toast("⏹ Перевод отменён. Текст статьи не изменён.");
      } else {
        setStatus("Ошибка", "error");
        toast("❌ " + ((err && err.message) || err), true);
      }
    } finally {
      busy = false;
      currentRunId = null;
      goBtn.disabled = false;
      goBtn.classList.remove("dzr-cancel");
      goBtn.innerHTML = goLabel;
    }
  }

  // ------------------------------------------------ приписка в конце статьи ---
  // Под каждой статьёй — свой текст: «ставьте лайк, пишите, о чём рассказать дальше».
  // Это не перевод, а наша собственная строка, поэтому в переводчик она не уходит:
  // дописываем её уже после сборки ответа. Отдай мы её переводчику — на другом языке
  // она вернулась бы пересказанной чужой формулировкой, а должна звучать ровно так,
  // как её написал пользователь.

  /**
   * Последний ли это блок статьи. Приписка нужна в конце статьи, а не в конце
   * выделенного куска: если работают с фрагментом, ставить её посреди текста нельзя.
   * Пустые соседи хвостом не считаются — ProseMirror держит пустой абзац в конце.
   */
  function isArticleTail(block, editor) {
    if (!block || !block.el || !editor) return false;
    var node = block.el;
    while (node && node !== editor) {
      var sib = node.nextElementSibling;
      while (sib) {
        if (String(sib.textContent || "").trim() || sib.querySelector("img,picture,video,table,figure")) {
          return false;
        }
        sib = sib.nextElementSibling;
      }
      node = node.parentElement;
    }
    return node === editor;
  }

  /** Текст приписки для этой обработки. Пустая строка — приписки не будет. */
  function signatureFor(blocks, editor, plain) {
    if (!S.signature) return "";
    var sig = String(S.signatureText || "").trim();
    if (!sig || !blocks.length) return "";
    // Кнопку жмут повторно после правок — второй такой же приписки быть не должно.
    if (plain.indexOf(sig) !== -1) return "";
    return isArticleTail(blocks[blocks.length - 1], editor) ? sig : "";
  }

  // ----------------------------------------------------------- запуск ---

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === "run") run();
    if (msg.type === "progress" && msg.stage === "translate") {
      var p = msg.percent != null ? msg.percent : 0;
      var tail = msg.total ? " (" + msg.done + "/" + msg.total + ")" : "";
      setStatus("Перевожу… " + p + "%" + tail);
    }
    if (msg.type === "progress" && msg.stage === "ai") {
      aiLocal = !!msg.local;
    }
    if (msg.type === "settingsUpdated") loadSettings();
  });

  function loadSettings() {
    send({ type: "getSettings" }).then(function (res) {
      if (res && res.ok) {
        S = Object.assign(S, res.settings);
        if (langSel) langSel.value = S.targetLang;
        if (modeSel) modeSel.value = S.mode;
        if (presetSel) presetSel.value = S.aiPreset;
        syncPresetVisibility();
        // Признак «настройки прочитаны и применены». До этого момента панель
        // живёт на значениях по умолчанию из S, и клик по кнопке отработает по
        // ним, а не по сохранённым настройкам. Тесты ждут этот атрибут, чтобы
        // не зависеть от того, успел ли ответ прийти; в работе он безвреден.
        document.documentElement.setAttribute("data-dzr-settings", "ready");
      }
    });
  }

  function boot() {
    if (window.top !== window.self && !document.querySelector('[contenteditable="true"], textarea')) return;
    buildBar();
    loadSettings();
    // Состояние свёрнутости НЕ переносим между страницами: на странице с
    // редактором панель обязана быть развёрнута. Решаем по факту — есть ли
    // здесь что редактировать. Разметка в SPA появляется позже, поэтому
    // свёрнутый пузырёк продолжает следить за появлением редактора.
    setCollapsed(!hasWorkableEditor());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // редактор Дзена — SPA: следим, чтобы панель не потерялась при перерисовке.
  // Но если пользователь закрыл её крестиком — не возвращаем.
  var mo = new MutationObserver(function () {
    if (closed) return;
    if (!document.getElementById("dzr-bar") && document.body) {
      buildBar();
      loadSettings();
      // панель пересоздана — возвращаем прежнее состояние свёрнутости
      setCollapsed(collapsedByUser ? collapsed : !hasWorkableEditor());
      return;
    }
    // Дзен — SPA: редактор мог появиться при перерисовке. Разворачиваемся сразу,
    // не дожидаясь опроса по таймеру.
    if (collapsed && !collapsedByUser && !isPreviewOpen() && hasWorkableEditor()) setCollapsed(false);
  });
  if (document.body) mo.observe(document.body, { childList: true, subtree: false });

  // при изменении размеров окна держим панель в пределах экрана
  window.addEventListener("resize", function () {
    if (barLeft != null) placeAt(barLeft, barTop, barSide);
    if (isPreviewOpen()) positionPreview();
  });
})();
