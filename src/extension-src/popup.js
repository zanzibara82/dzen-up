/* Дзен Рерайтер — логика попапа: настройки + быстрый рерайт любого текста */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var FIELDS = [
    "targetLang",
    "sourceLang",
    "mode",
    "strength",
    "engine",
    "stripLinks",
    "signatureText",
    "glossary",
    "aiBaseUrl",
    "aiModel",
    "aiKey",
    "aiPrompt",
    "aiPreset",
    "linkSites",
    "linkChannels",
    "linkSynonyms",
    "linkCount"
  ];

  function send(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (res) {
        resolve(res || { ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
      });
    });
  }

  // ---- стили рерайта -------------------------------------------------------
  // Список пресетов живёт в presets.js — он же подключён к панели на странице,
  // чтобы попап и панель не разъезжались в названиях и текстах промптов.
  var PRESETS = (globalThis.DzenPresets && globalThis.DzenPresets.list) || [];
  var DEFAULT_PRESET = (globalThis.DzenPresets && globalThis.DzenPresets.DEFAULT_ID) || "editor";

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return null;
  }

  function showPreset(p) {
    $("aiPresetHint").textContent = (p && p.hint) || "";
  }

  // Последний выбранный настоящий пресет — к нему возвращает кнопка «Вернуть
  // текст пресета». Храним отдельно от селекта: после правки промпта селект
  // переключается на «Свой промпт» и про прежний выбор уже не помнит.
  var lastPresetId = DEFAULT_PRESET;

  /**
   * Ставит пресет в селект. Текст промпта трогает только у настоящих пресетов:
   * у «Своего промпта» текста нет, и затирать им поле нельзя.
   */
  function applyPreset(id) {
    var p = presetById(id) || presetById(DEFAULT_PRESET);
    if (!p) return;
    $("aiPreset").value = p.id;
    showPreset(p);
    if (!p.custom) {
      lastPresetId = p.id;
      $("aiPrompt").value = p.prompt;
    }
  }

  (function fillPresets() {
    var sel = $("aiPreset");
    PRESETS.forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
  })();

  $("aiPreset").addEventListener("change", function () {
    applyPreset($("aiPreset").value);
  });

  // Правка промпта руками — это уже «свой промпт». Без этого выбор пресета
  // затирал бы правку, а селект показывал бы стиль, которого нет.
  $("aiPrompt").addEventListener("input", function () {
    var cur = presetById($("aiPreset").value);
    if (cur && !cur.custom && $("aiPrompt").value !== cur.prompt) {
      $("aiPreset").value = "custom";
      showPreset(presetById("custom"));
    }
  });

  $("aiPromptReset").addEventListener("click", function () {
    applyPreset(lastPresetId);
    $("aiPrompt").focus();
  });

  // ---- вкладки -------------------------------------------------------------
  function activate(tab) {
    $("tab-quick").classList.toggle("active", tab === "quick");
    $("tab-settings").classList.toggle("active", tab === "settings");
    $("panel-quick").hidden = tab !== "quick";
    $("panel-settings").hidden = tab !== "settings";
  }
  $("tab-quick").addEventListener("click", function () {
    activate("quick");
  });
  $("tab-settings").addEventListener("click", function () {
    activate("settings");
  });

  // ---- настройки -----------------------------------------------------------
  var settings = {};

  send({ type: "getSettings" }).then(function (res) {
    if (!res.ok) {
      var st = $("settings-status");
      st.className = "status err";
      st.textContent = "❌ Не удалось прочитать настройки: " + res.error;
      ready();
      return;
    }
    settings = res.settings;
    FIELDS.forEach(function (f) {
      if ($(f) && settings[f] != null) $(f).value = settings[f];
    });
    $("aiEnabled").checked = !!settings.aiEnabled;
    $("ai-fields").hidden = !settings.aiEnabled;
    // поле приписки показываем только когда она включена
    $("signature").checked = !!settings.signature;
    $("signature-fields").hidden = !settings.signature;
    // предпросмотр включён по умолчанию — выключается только явным false
    $("preview").checked = settings.preview !== false;
    // пропуск уже переведённого включён по умолчанию — та же логика
    $("skipSameLang").checked = settings.skipSameLang !== false;

    // Стиль рерайта показываем по факту сохранённого промпта: если он не совпал
    // с текстом пресета, значит его правили руками (или он остался от прошлой
    // версии расширения) — честнее показать «Свой промпт», иначе селект врал бы,
    // что применён стиль, которого в промпте нет.
    var storedPreset = presetById(settings.aiPreset) || presetById(DEFAULT_PRESET);
    var storedPrompt = settings.aiPrompt == null ? "" : String(settings.aiPrompt);
    var edited = storedPrompt !== "" && storedPrompt !== storedPreset.prompt;
    var shownId = edited ? "custom" : storedPreset.id;
    $("aiPreset").value = shownId;
    showPreset(presetById(shownId));
    if (!storedPreset.custom) lastPresetId = storedPreset.id;

    refreshLinkPerm();
    ready();
  });

  // Поля заполняются асинхронно, уже после отрисовки. Признак готовности нужен,
  // чтобы тест (и любой внешний наблюдатель) ждал именно применённых настроек,
  // а не появления кнопки: между этим моментом и ответом хранилища поля пустые.
  function ready() {
    document.documentElement.setAttribute("data-dzr-popup", "ready");
  }

  $("aiEnabled").addEventListener("change", function () {
    $("ai-fields").hidden = !$("aiEnabled").checked;
  });

  $("signature").addEventListener("change", function () {
    $("signature-fields").hidden = !$("signature").checked;
    if ($("signature").checked) $("signatureText").focus();
  });

  $("save").addEventListener("click", async function () {
    var next = {
      aiEnabled: $("aiEnabled").checked,
      preview: $("preview").checked,
      skipSameLang: $("skipSameLang").checked,
      signature: $("signature").checked
    };
    FIELDS.forEach(function (f) {
      if ($(f)) next[f] = $(f).value;
    });
    // Число ссылок храним числом: пустое поле — это «по умолчанию», а не NaN.
    var want = parseInt($("linkCount").value, 10);
    next.linkCount = Math.max(1, Math.min(10, isNaN(want) ? 2 : want));
    $("linkCount").value = next.linkCount;
    var res = await send({ type: "saveSettings", settings: next });
    var st = $("settings-status");
    st.className = "status" + (res.ok ? "" : " err");
    st.textContent = res.ok
      ? "✅ Сохранено. Настройки применились на всех вкладках Дзена."
      : "❌ " + res.error;
    // при ошибке НЕ считаем, что настройки применились: иначе попап начнёт
    // врать про сохранённое значение до следующего открытия
    if (res.ok) settings = Object.assign(settings, next);
    refreshLinkPerm();

    var tabs = await chrome.tabs.query({ url: ["https://dzen.ru/*", "https://zen.yandex.ru/*"] });
    tabs.forEach(function (t) {
      chrome.tabs.sendMessage(t.id, { type: "settingsUpdated" }).catch(function () {});
    });
  });

  // ---- проверка ключей -----------------------------------------------------
  // Проверяем то, что вписано в поля прямо сейчас, а не то, что сохранено:
  // иначе кнопка проверяла бы прошлую версию настроек, и человек чинил бы не то.
  // Запрос уходит в фон — у попапа нет прав на чужие домены.
  async function checkKey(btn, st, overrides) {
    btn.disabled = true;
    st.className = "hint";
    st.textContent = "⏳ Проверяю…";
    try {
      var res = await send({ type: "checkKey", overrides: overrides });
      st.className = "hint" + (res.ok ? "" : " err");
      st.textContent = res.ok ? "✅ " + res.text : "❌ " + res.error;
    } catch (e) {
      st.className = "hint err";
      st.textContent = "❌ " + ((e && e.message) || e);
    } finally {
      btn.disabled = false;
    }
  }

  // Домен AI-сервиса. В манифесте перечислены только openai и openrouter, а
  // адрес API настраивается — значит для своего адреса (z.ai, прокси, локальная
  // модель) право нужно спросить отдельно. Спрашиваем здесь: у кнопки проверки
  // есть настоящее нажатие, без жеста chrome.permissions.request не сработает.
  // Без этого человек видел бы «Failed to fetch» и чинил ключ вместо доступа.
  //
  // http разрешён только для своей машины: локальная модель (Ollama на
  // 127.0.0.1:11434) по https не отвечает вовсе, а просить доступ ко всем
  // http-сайтам ради неё незачем — в необязательных правах лежат ровно
  // localhost и 127.0.0.1.
  function aiOrigin() {
    try {
      var u = new URL(String($("aiBaseUrl").value || "").trim());
      if (u.protocol === "https:") return "https://" + u.host + "/*";
      var local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol === "http:" && local) return "http://" + u.host + "/*";
      return "";
    } catch (e) {
      return "";
    }
  }

  // Адрес на своей машине (Ollama и подобные). Разбор повторяет isLocalAiBase
  // из background.js: позвать чужую функцию попап не может, а спрашивать у фона
  // про каждую мелочь незачем. Такой сервер ключа не требует и отвечает
  // минутами — оба отличия нужны попапу здесь и сейчас.
  function isLocalAi(base) {
    try {
      var h = new URL(String(base || "").trim()).hostname.toLowerCase();
      return (
        h === "localhost" ||
        h === "127.0.0.1" ||
        h === "0.0.0.0" ||
        h === "::1" ||
        h === "[::1]" ||
        /\.local$/.test(h)
      );
    } catch (e) {
      return false;
    }
  }

  $("ai-check").addEventListener("click", async function () {
    var base = String($("aiBaseUrl").value || "").trim();
    var origin = aiOrigin();
    // Про http не на своей машине молчать нельзя: права на такой адрес нет, и
    // человек снова получил бы «запрос не дошёл» без объяснения причины.
    if (!origin && /^http:\/\//i.test(base)) {
      var st0 = $("ai-check-status");
      st0.className = "hint err";
      st0.textContent =
        "⚠️ По http доступ даётся только к localhost и 127.0.0.1 — укажите https или адрес своей машины.";
      return;
    }
    // Для openai и openrouter доступ уже есть — contains это покажет, и
    // лишнего запроса не будет.
    if (origin && !(await chrome.permissions.contains({ origins: [origin] }))) {
      var allowed = await chrome.permissions.request({ origins: [origin] });
      if (!allowed) {
        var st = $("ai-check-status");
        st.className = "hint err";
        st.textContent =
          "⚠️ Нет доступа к " + origin.replace("/*", "") + " — без него ни проверка, ни рерайт не пройдут.";
        return;
      }
    }
    checkKey($("ai-check"), $("ai-check-status"), {
      aiBaseUrl: $("aiBaseUrl").value,
      aiModel: $("aiModel").value,
      aiKey: $("aiKey").value
    });
  });

  // ---- доступ к сайтам перелинковки ----------------------------------------
  // Разбор списка сайтов повторяет parseSiteList в background.js. Дублирование
  // осознанное: chrome.permissions.request требует настоящего жеста пользователя,
  // и надёжнее запросить его прямо из попапа (клик по кнопке), а не гонять через
  // service worker. Правила простые: по строке на сайт, «#» — комментарий.
  // Отличие от фона одно: здесь негодные строки не выбрасываются молча, а
  // называются вслух — поле видит человек, ему и объяснять.
  //
  // Адрес сайта из строки списка. Проверять обязательно: на негодном шаблоне
  // chrome.permissions.contains НЕ отвечает false, а падает — «Invalid value for
  // origin pattern … Invalid port». В поле при этом попадает что угодно: человек
  // копирует туда строку из статьи («Photo: Subaru of America, Inc.»), и тогда
  // отваливается весь обработчик кнопки, а не одна строка. Числовой порт Chrome
  // принимает (проверено: http://localhost:8787/* — годный шаблон), поэтому
  // адрес с портом сохраняем как есть; негоден только порт нечисловой.
  function siteOrigin(line) {
    var s = String(line || "").trim().replace(/\/+$/, "");
    var m = /^(https?):\/\//i.exec(s);
    var scheme = m ? m[1].toLowerCase() : "https";
    var rest = m ? s.slice(m[0].length) : s;
    var host = rest.split("/")[0];
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i.test(host)) {
      return "";
    }
    return scheme + "://" + rest + "/*";
  }

  /** Шаблоны прав и отдельно — строки, которые адресами не оказались. */
  function siteOrigins(raw) {
    var origins = [];
    var bad = [];
    String(raw || "")
      .split(/\r?\n/)
      .forEach(function (line) {
        var s = line.trim();
        if (!s || s.charAt(0) === "#") return;
        var origin = siteOrigin(s);
        if (!origin) bad.push(s);
        else if (origins.indexOf(origin) === -1) origins.push(origin);
      });
    return { origins: origins, bad: bad };
  }

  function skippedNote(bad) {
    if (!bad.length) return "";
    var shown = bad.slice(0, 3).join(", ");
    if (bad.length > 3) shown += " и ещё " + (bad.length - 3);
    return " Не адреса сайтов, пропущены: " + shown + ".";
  }

  // Каналы Дзена живут на одном домене, поэтому в списке нужен один адрес — dzen.ru.
  // Сейчас он объявлен в обязательных правах (manifest.host_permissions) и выдан уже
  // при установке, так что contains() по нему всегда true и кнопка для каналов не нужна.
  // Держим его здесь на случай, если право когда-нибудь переедет в необязательные:
  // тогда каналы подхватят общий запрос доступа сами, без отдельной ветки.
  // Проверяем не «есть ли строки», а «есть ли среди них непустые»: строки с «#»
  // и пробелы каналом не считаются.
  function hasChannels(raw) {
    return String(raw || "")
      .split(/\r?\n/)
      .some(function (l) {
        var s = l.trim();
        return s && s.charAt(0) !== "#";
      });
  }

  function linkOrigins() {
    var picked = siteOrigins($("linkSites").value);
    if (hasChannels($("linkChannels").value)) picked.origins.push("https://dzen.ru/*");
    return picked;
  }

  // Домен из поля «Адрес статьи, откуда взять текст». Это не цель перелинковки,
  // а страница, которую расширение читает по кнопке «Взять текст»; вписывать её
  // в список сайтов нельзя — она стала бы целью ссылок. Право на неё просим
  // здесь же: chrome.permissions.request работает только из попапа по жесту.
  function sourceOrigin() {
    var raw = String(settings.sourceUrl || "").trim();
    if (!raw) return "";
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    try {
      var u = new URL(raw);
      if (u.protocol === "https:") return "https://" + u.host + "/*";
      // http разрешён только своей машине — в необязательных правах его больше негде
      var local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol === "http:" && local) return "http://" + u.host + "/*";
      return "";
    } catch (e) {
      return "";
    }
  }

  /** Всё, на что кнопка доступа обязана спросить разрешение. */
  function accessOrigins() {
    var picked = linkOrigins();
    var src = sourceOrigin();
    if (src && picked.origins.indexOf(src) === -1) picked.origins.push(src);
    return picked;
  }

  function setPermStatus(text, cls) {
    var el = $("link-perm");
    el.textContent = text;
    el.className = "hint" + (cls ? " " + cls : "");
  }

  async function refreshLinkPerm() {
    // Считаем и домен из поля адреса статьи: он тоже читается расширением, и
    // строка доступа обязана говорить правду о нём, а не «ничего не указано».
    var picked = accessOrigins();
    if (!picked.origins.length) {
      setPermStatus(
        picked.bad.length
          ? "⚠️ Ни одного адреса сайта в списке." + skippedNote(picked.bad)
          : "Ни сайты, ни каналы, ни адрес статьи не указаны."
      );
      return;
    }
    var has = await chrome.permissions.contains({ origins: picked.origins });
    setPermStatus(
      (has ? "✅ Доступ есть." : "⚠️ Доступ не выдан — нажмите кнопку.") + skippedNote(picked.bad),
      has && !picked.bad.length ? "" : "err"
    );
  }

  $("link-allow").addEventListener("click", async function () {
    var picked = accessOrigins();
    var note = skippedNote(picked.bad);
    if (!picked.origins.length) {
      setPermStatus("Сначала впишите хотя бы один сайт, канал или адрес статьи." + note, "err");
      return;
    }
    // Список мог поменяться после сохранения — сохраняем текущие поля, чтобы
    // расширение читало ровно те адреса, на которые сейчас спрашиваем доступ.
    await send({
      type: "saveSettings",
      settings: { linkSites: $("linkSites").value, linkChannels: $("linkChannels").value }
    });
    settings.linkSites = $("linkSites").value;
    settings.linkChannels = $("linkChannels").value;

    if (await chrome.permissions.contains({ origins: picked.origins })) {
      setPermStatus("✅ Доступ уже есть." + note, note ? "err" : "");
      return;
    }
    var granted = await chrome.permissions.request({ origins: picked.origins });
    setPermStatus(
      (granted ? "✅ Доступ выдан." : "⚠️ В доступе отказано — перелинковка работать не будет.") + note,
      granted && !note ? "" : "err"
    );
  });

  // ---- переобход каналов ---------------------------------------------------
  // Кнопка нужна не для красоты: карта канала живёт в кэше 12 часов, а человек
  // после публикации новой статьи хочет ссылаться на неё сразу.
  $("channels-refresh").addEventListener("click", async function () {
    var st = $("channels-status");
    var raw = $("linkChannels").value;
    if (!hasChannels(raw)) {
      st.className = "hint err";
      st.textContent = "Сначала впишите хотя бы один канал.";
      return;
    }
    if (!(await chrome.permissions.contains({ origins: ["https://dzen.ru/*"] }))) {
      st.className = "hint err";
      st.textContent = "Нет доступа к dzen.ru — нажмите «Разрешить доступ к сайтам».";
      return;
    }
    st.className = "hint";
    st.textContent = "Обхожу каналы…";
    var res = await send({ type: "refreshChannels", overrides: { linkChannels: raw } });
    if (!res.ok) {
      st.className = "hint err";
      st.textContent = "❌ " + res.error;
      return;
    }
    var list = res.channels || [];
    var total = list.reduce(function (n, c) {
      return n + c.count;
    }, 0);
    st.className = "hint" + (total ? "" : " err");
    st.textContent = total
      ? "✅ Статей в карте: " + total + " (" +
        list.map(function (c) {
          return c.name + " — " + c.count;
        }).join(", ") + ")"
      : "⚠️ Ни одной статьи не нашлось. Проверьте адреса каналов.";
  });

  // ---- выгрузка карты файлом -----------------------------------------------
  // Скачиваем ссылкой с blob:, а не через chrome.downloads: права «downloads»
  // у расширения нет, а просить новое право ради одной кнопки — это баннер
  // «расширение требует новых разрешений» у всех, кто уже поставил.
  function downloadFile(filename, text) {
    var blob = new Blob([text], { type: "application/xml;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Ссылку отпускаем не сразу: отзовём тут же — сорвём само скачивание.
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 10000);
  }

  $("channels-export").addEventListener("click", async function () {
    var st = $("channels-status");
    var raw = $("linkChannels").value;
    if (!hasChannels(raw)) {
      st.className = "hint err";
      st.textContent = "Сначала впишите хотя бы один канал.";
      return;
    }
    st.className = "hint";
    // Карта берётся из кэша, и обход случается только при первом нажатии —
    // но тогда он идёт по страницам ленты и может занять до минуты. Молчаливое
    // «Готовлю карту…» на полторы минуты выглядит как зависание.
    st.textContent = "Готовлю карту… Если канал ещё не обойдён, это займёт до минуты.";
    // Всё, что идёт после ответа фона, — в try: иначе любая ошибка (например,
    // неожиданный ответ) оставит в статусе вечное «Готовлю карту…», и человек
    // будет ждать, не понимая, что уже ничего не происходит.
    try {
      var res = await send({ type: "exportChannelMap", overrides: { linkChannels: raw } });
      if (!res.ok) {
        st.className = "hint err";
        st.textContent = "❌ " + res.error;
        return;
      }
      var files = Array.isArray(res.files) ? res.files : [];
      var total = 0;
      var empty = [];
      files.forEach(function (f) {
        downloadFile(f.filename, f.xml);
        total += f.count;
        if (!f.count) empty.push(f.name);
      });
      st.className = "hint" + (total ? "" : " err");
      st.textContent = total
        ? "✅ Выгружено: " +
          files
            .map(function (f) {
              return f.filename + " — " + f.count;
            })
            .join(", ") +
          (empty.length ? ". Пусто у: " + empty.join(", ") : "")
        : "⚠️ Карта пуста — сначала нажмите «Обновить карты каналов».";
    } catch (e) {
      st.className = "hint err";
      st.textContent = "❌ Не удалось выгрузить карту: " + ((e && e.message) || e);
    }
  });

  // Статус доступа зависит от обоих списков: дописали канал — и права на dzen.ru
  // может уже не хватать. Обновляем подсказку сразу, а не после сохранения.
  ["linkSites", "linkChannels"].forEach(function (id) {
    $(id).addEventListener("input", function () {
      refreshLinkPerm();
    });
  });

  // ---- кэш -----------------------------------------------------------------
  // Кэш один — переводы. Счётчик называет его: иначе непонятно, что обнулилось.
  async function refreshCacheInfo() {
    var st = await chrome.storage.local.get({ dzrCache: {} });
    var n = Object.keys(st.dzrCache || {}).length;
    $("cache-info").textContent = n ? "Сохранено переводов: " + n : "Кэш пуст";
  }

  $("clear-cache").addEventListener("click", async function () {
    await send({ type: "clearCache" });
    await refreshCacheInfo();
    var st = $("settings-status");
    st.className = "status";
    st.textContent = "🧹 Кэш переводов очищен.";
  });

  refreshCacheInfo();

  // ---- быстрый рерайт ------------------------------------------------------
  $("run").addEventListener("click", async function () {
    var text = $("src").value.trim();
    var st = $("quick-status");
    if (!text) {
      st.className = "status err";
      st.textContent = "Вставьте текст в первое поле.";
      return;
    }
    st.className = "status";
    st.textContent = "⏳ Перевожу…";
    $("run").disabled = true;

    try {
      var result = text;
      var mode = settings.mode || "translate+rewrite";
      var stats = null;
      var aiNote = null;

      if (mode !== "rewrite") {
        var tr = await send({ type: "translate", text: text });
        if (!tr.ok) throw new Error(tr.error);
        result = tr.text;
        stats = tr.stats || null;
      }

      if (mode !== "translate") {
        st.textContent = "⏳ Рерайчу…";
        // Свой сервер отвечает минутами, и неподвижное «Рерайчу…» здесь так же
        // неотличимо от зависания, как в панели на странице.
        var localAi = isLocalAi(settings.aiBaseUrl);
        var aiT0 = Date.now();
        var aiTick = setInterval(function () {
          st.textContent =
            "⏳ Рерайчу… " +
            Math.round((Date.now() - aiT0) / 1000) +
            " с" +
            (localAi ? " — своя модель отвечает небыстро, ждём" : "");
        }, 1000);
        try {
          if (settings.aiEnabled && (settings.aiKey || localAi)) {
            var ai = await send({ type: "aiRewrite", text: result });
            if (ai.ok) {
              result = ai.text;
            } else {
              // Причину запоминаем: иначе «✅ Готово» ниже рассказало бы об
              // успехе там, где модель не ответила и текст переписал встроенный
              // рерайтер. Человек правил бы ключ, не зная, что дело в нём.
              aiNote = ai.error;
              result = globalThis.DzenRewriter.rewrite(result, { strength: settings.strength });
            }
          } else {
            result = globalThis.DzenRewriter.rewrite(result, { strength: settings.strength });
          }
        } finally {
          clearInterval(aiTick);
        }
      }

      $("out").value = result;
      var uniq = globalThis.DzenRewriter.uniqueness(text, result);
      var s = globalThis.DzenRewriter.stats(result);
      st.className = "status";
      st.textContent = "✅ Готово: " + s.words + " слов, уникальность ≈ " + uniq + "%";
      if (aiNote) {
        st.textContent += " · ⚠️ AI недоступен (" + aiNote + ") — переписано встроенным рерайтером";
      }
      if (stats) {
        var notes = [];
        if (stats.cached) notes.push(stats.cached + " из кэша");
        if (stats.fellBack) notes.push(stats.fellBack + " через " + stats.fallbackName);
        if (stats.failed) notes.push("⚠️ " + stats.failed + " не переведено");
        if (notes.length) st.textContent += " · " + notes.join(" · ");
      }
      refreshCacheInfo();
    } catch (err) {
      st.className = "status err";
      st.textContent = "❌ " + ((err && err.message) || err);
    } finally {
      $("run").disabled = false;
    }
  });

  $("copy").addEventListener("click", function () {
    var text = $("out").value;
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      var st = $("quick-status");
      st.className = "status";
      st.textContent = "📋 Скопировано в буфер обмена.";
    });
  });
})();
