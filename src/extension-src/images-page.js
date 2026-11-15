/* Дзен Рерайтер — окно подбора изображений для новости.
   Окно живёт на происхождении расширения: только здесь есть рукоять папки
   установки и можно попросить доступ к сайтам с картинками. Панель на странице
   Дзена этого не может и лишь присылает сюда заголовок. */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var WIDE_ORIGINS = ["https://*/*"];
  var SEARCH_TIMEOUT_MS = 15000;
  var SEARCH_MAX_BYTES = 2 * 1024 * 1024;
  var IMAGE_TIMEOUT_MS = 12000;
  var WORKERS = 4;

  var root = null;
  var running = false;
  var abort = null;
  var written = 0;
  var wantCount = DzenImages.DEFAULT_COUNT;
  var folderName = "";
  var canWrite = false;
  var canNet = false;
  var autoStarted = false;

  function setStatus(text, kind) {
    var el = $("status");
    el.className = "status" + (kind ? " " + kind : "");
    el.textContent = text;
  }

  function setBusy(on) {
    running = on;
    $("start").hidden = on;
    $("stop").hidden = !on;
    $("title").disabled = on;
  }

  // Маркер состояния для браузерного набора: ready — можно подбирать,
  // blocked — ждём прав или папки, running — идёт подбор, done — закончили.
  function mark(state) {
    document.documentElement.setAttribute("data-dzr-images", state);
  }

  function readTitle() {
    var t = $("title").value;
    return String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function queryTitle() {
    try {
      return String(new URLSearchParams(location.search).get("title") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
    } catch (e) {
      return "";
    }
  }

  function loadCount() {
    chrome.storage.sync.get({ imageCount: DzenImages.DEFAULT_COUNT }, function (res) {
      wantCount = DzenImages.clampCount(res && res.imageCount);
      $("count").textContent = "Сколько фото: " + wantCount + " (меняется в настройках)";
    });
  }

  function updateReady() {
    $("choose-dir").hidden = !!root;
    $("allow-write").hidden = !root || canWrite;
    $("allow-net").hidden = canNet;
    var ready = !!root && canWrite && canNet;
    if (!running) mark(ready ? "ready" : "blocked");
    return ready;
  }

  function queryWrite() {
    if (!root) return Promise.resolve(false);
    return root.queryPermission({ mode: "readwrite" }).then(function (state) {
      canWrite = state === "granted";
      return canWrite;
    }).catch(function () {
      canWrite = false;
      return false;
    });
  }

  function netGranted() {
    return new Promise(function (resolve) {
      chrome.permissions.contains({ origins: WIDE_ORIGINS }, function (yes) {
        canNet = !!yes && !chrome.runtime.lastError;
        resolve(canNet);
      });
    });
  }

  // Таймаут поверх внешнего сигнала отмены: отмена пользователя и таймаут
  // приходят по одному и тому же пути, и различать их не нужно.
  function withTimeout(signal, ms) {
    var ctl = new AbortController();
    var timer = setTimeout(function () {
      ctl.abort();
    }, ms);
    var onAbort = function () {
      ctl.abort();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: ctl.signal,
      done: function () {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    };
  }

  async function readCapped(res, cap) {
    var len = res.headers.get("content-length");
    if (len && Number(len) > cap) throw new Error("тяжелее потолка");
    if (!res.body || typeof res.body.getReader !== "function") {
      var buf = await res.arrayBuffer();
      if (buf.byteLength > cap) throw new Error("тяжелее потолка");
      return new Uint8Array(buf);
    }
    var reader = res.body.getReader();
    var chunks = [];
    var total = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      total += step.value.length;
      if (total > cap) {
        try { await reader.cancel(); } catch (e) {}
        throw new Error("тяжелее потолка");
      }
      chunks.push(step.value);
    }
    var out = new Uint8Array(total);
    var at = 0;
    chunks.forEach(function (c) {
      out.set(c, at);
      at += c.length;
    });
    return out;
  }

  async function fetchCapped(url, cap, ms, signal) {
    var t = withTimeout(signal, ms);
    try {
      var res = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: t.signal
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await readCapped(res, cap);
    } finally {
      t.done();
    }
  }

  async function searchOne(url, parse, signal) {
    try {
      var bytes = await fetchCapped(url, SEARCH_MAX_BYTES, SEARCH_TIMEOUT_MS, signal);
      return parse(new TextDecoder("utf-8").decode(bytes));
    } catch (e) {
      if (signal && signal.aborted) throw e;
      return [];
    }
  }

  function searchBoth(title, signal) {
    var q = encodeURIComponent(title);
    var bing = "https://www.bing.com/images/async?q=" + q + "&first=0&count=35&mmasync=1";
    var yandex = "https://yandex.ru/images/search?text=" + q;
    return Promise.all([
      searchOne(bing, DzenImages.parseBing, signal),
      searchOne(yandex, DzenImages.parseYandex, signal)
    ]).then(function (lists) {
      return DzenImages.mergeCandidates(lists, DzenImages.MAX_CANDIDATES);
    });
  }

  function digestHex(bytes) {
    return crypto.subtle.digest("SHA-256", bytes).then(function (hash) {
      return Array.prototype.map.call(new Uint8Array(hash), function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
    });
  }

  async function downloadOne(url, signal) {
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    // Право выдано только на https: http-картинка не скачается, и тратить на неё
    // запрос, который упрётся в отказ, незачем.
    if (u.protocol !== "https:") return null;
    var bytes;
    try {
      bytes = await fetchCapped(url, DzenImages.MAX_IMAGE_BYTES, IMAGE_TIMEOUT_MS, signal);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      return null;
    }
    var ext = DzenImages.imageType(bytes);
    if (!ext) return null;
    var hash;
    try {
      hash = await digestHex(bytes);
    } catch (e) {
      return null;
    }
    return { bytes: bytes, ext: ext, hash: hash };
  }

  async function downloadPool(candidates, want, signal, onOne) {
    var queue = candidates.slice();
    var results = [];
    var seen = {};
    var stopped = false;

    async function worker() {
      while (!stopped && results.length < want && queue.length) {
        var url = queue.shift();
        var got;
        try {
          got = await downloadOne(url, signal);
        } catch (e) {
          if (signal && signal.aborted) throw e;
          continue;
        }
        if (!got || seen[got.hash]) continue;
        if (results.length >= want) break;
        seen[got.hash] = true;
        results.push(got);
        onOne(results.length);
        if (results.length >= want) stopped = true;
      }
    }

    var workers = [];
    for (var i = 0; i < WORKERS && i < candidates.length; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  async function start() {
    if (running) return;
    var title = readTitle();
    if (!title) {
      setStatus("Впишите заголовок новости — по нему ищутся картинки.");
      $("title").focus();
      return;
    }
    if (!root) {
      updateReady();
      setStatus("Выберите папку установки расширения.", "err");
      return;
    }
    if (!canWrite) {
      updateReady();
      setStatus("Браузер не дал право записи в папку — нажмите «Разрешить запись».", "err");
      return;
    }
    if (!canNet) {
      updateReady();
      setStatus("Нет доступа к сайтам с картинками — нажмите «Разрешить доступ к сайтам с картинками».", "err");
      return;
    }

    written = 0;
    folderName = "";
    abort = new AbortController();
    var signal = abort.signal;
    setBusy(true);
    mark("running");
    setStatus("Ищу картинки…");
    try {
      var candidates = await searchBoth(title, signal);
      if (!candidates.length) {
        setStatus("Не удалось получить ссылки на картинки. Проверьте заголовок и повторите.", "err");
        return;
      }
      setStatus("Скачиваю фото (0 из " + wantCount + ")…");
      var found = await downloadPool(candidates, wantCount, signal, function (n) {
        setStatus("Скачиваю фото (" + n + " из " + wantCount + ")…");
      });
      if (!found.length) {
        setStatus("Найденные картинки не скачались: не картинки или тяжелее 3 МБ.", "err");
        return;
      }
      var news = await root.getDirectoryHandle("news", { create: true });
      var used = new Set();
      try {
        for await (var entry of news.entries()) used.add(entry[0]);
      } catch (e) {}
      folderName = DzenImages.nextFreeName(DzenImages.sanitizeFolderName(title, "novost"), used);
      for (var i = 0; i < found.length; i++) {
        var rel = "news/" + folderName + "/" + DzenImages.fileName(i, found[i].ext);
        await DzenUpdate.writeRel(root, rel, found[i].bytes);
        written++;
      }
      setStatus("Записано " + written + " из " + wantCount + ": news/" + folderName + "/",
        found.length < wantCount ? "warn" : "ok");
    } catch (e) {
      if (signal.aborted) {
        setStatus("Остановлено. Записано " + written +
          (folderName ? " в news/" + folderName + "/" : "."));
      } else {
        setStatus("Ошибка подбора: " + ((e && e.message) || String(e)) +
          (folderName ? " (папка news/" + folderName + "/, записано " + written + ")" : ""), "err");
      }
    } finally {
      abort = null;
      setBusy(false);
      $("start").textContent = "Подобрать заново";
      mark("done");
    }
  }

  $("start").addEventListener("click", start);

  $("stop").addEventListener("click", function () {
    if (!abort) return;
    abort.abort();
    setStatus("Останавливаю…");
  });

  $("title").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    start();
  });

  $("settings").addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  });

  $("choose-dir").addEventListener("click", async function () {
    if (typeof window.showDirectoryPicker !== "function") {
      setStatus("Этот браузер не умеет выбирать папку. Нужен Chrome или Яндекс Браузер.", "err");
      return;
    }
    var picked;
    try {
      // Диалог поднимается до первого ожидания: запрос жеста иначе отклонится.
      picked = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (e) {
      if (e && e.name === "AbortError") {
        setStatus("Выбор папки отменён.");
        return;
      }
      setStatus("Не удалось открыть папку: " + ((e && e.message) || e), "err");
      return;
    }
    var problem = await DzenUpdate.installDirProblem(picked, chrome.runtime.getManifest().name);
    if (problem) {
      setStatus("Это " + problem + ". Выберите папку установки расширения «Дзен Рерайтер».", "err");
      return;
    }
    root = picked;
    try {
      await DzenUpdate.saveDirHandle(root);
    } catch (e) {}
    await queryWrite();
    updateReady();
    setStatus(canWrite ? "Папка выбрана. Можно подбирать." : "Папка выбрана, но запись запрещена. Нажмите «Разрешить запись».", canWrite ? "" : "err");
  });

  $("allow-write").addEventListener("click", async function () {
    if (!root) return;
    var state;
    try {
      state = await root.requestPermission({ mode: "readwrite" });
    } catch (e) {
      state = "denied";
    }
    canWrite = state === "granted";
    updateReady();
    setStatus(canWrite ? "Запись разрешена. Можно подбирать." : "Браузер не дал право записи — подобрать не получится.", canWrite ? "" : "err");
  });

  $("allow-net").addEventListener("click", function () {
    chrome.permissions.request({ origins: WIDE_ORIGINS }, function (yes) {
      canNet = !!yes && !chrome.runtime.lastError;
      updateReady();
      setStatus(canNet ? "Доступ к сайтам получен. Можно подбирать." : "Без доступа к сайтам картинки не скачать.", canNet ? "" : "err");
    });
  });

  loadCount();
  var initial = queryTitle();
  if (initial) $("title").value = initial;
  DzenUpdate.loadDirHandle()
    .then(function (handle) {
      root = handle || null;
    })
    .catch(function () {
      root = null;
    })
    .then(queryWrite)
    .then(netGranted)
    .then(function () {
      var ready = updateReady();
      if (ready && initial && !autoStarted) {
        autoStarted = true;
        start();
      }
    });
})();
