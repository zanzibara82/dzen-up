/**
 * Память-IndexedDB для тестов попапа.
 *
 * Настоящую IndexedDB в тесте подменить нельзя, а рукоять `FileSystemDirectoryHandle`
 * нельзя положить в настоящую: structured clone не переносит методы подставной
 * рукояти, и на выходе получился бы пустой объект. Поэтому набор отдаёт странице
 * эту реализацию — она держит значения по ссылке, как делает сама IndexedDB внутри
 * одного окна, и позволяет тесту заложить рукоять до клика, не трогая наш код.
 *
 * Базы кэшируются по имени: повторный `open` того же имени возвращает ту же базу,
 * как у настоящей IndexedDB. Это нужно, чтобы тест заложил рукоять через `seed`
 * до загрузки попапа, а попап при открытии прочитал её тем же именем. `req.__db`
 * отдаёт базу синхронно — события `onsuccess` приходят позже, как у настоящей БД.
 */
(function (global, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.memoryIdb = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var dbs = {};

  // Запрос заполняет result и зовёт onsuccess своей очередью; транзакция
  // завершается только после последнего запроса, иначе oncomplete застал бы
  // req.result ещё пустым — ровно та гонка, что ломала чтение рукояти.
  function makeStore(data, tx) {
    function request(value) {
      var req = {};
      if (tx) tx.__pending++;
      setTimeout(function () {
        req.result = value;
        if (req.onsuccess) req.onsuccess();
        if (tx) {
          tx.__pending--;
          if (tx.__pending === 0 && tx.oncomplete) tx.oncomplete();
        }
      }, 0);
      return req;
    }
    return {
      get: function (key) { return request(data[key]); },
      put: function (value, key) { data[key] = value; return request(key); },
      delete: function (key) { delete data[key]; return request(undefined); }
    };
  }

  function open(name) {
    var req = {};
    var isNew = !dbs[name];
    var db = dbs[name];
    if (!db) {
      db = dbs[name] = {
        name: name,
        __stores: {},
        close: function () {},
        objectStoreNames: { contains: function (s) { return !!db.__stores[s]; } },
        createObjectStore: function (s) {
          db.__stores[s] = db.__stores[s] || {};
          return makeStore(db.__stores[s]);
        },
        transaction: function () {
          var tx = {
            __pending: 0,
            objectStore: function (s) {
              db.__stores[s] = db.__stores[s] || {};
              return makeStore(db.__stores[s], tx);
            }
          };
          // Запросы ставятся синхронно сразу после transaction(), раньше любого
          // таймера. Если их нет — завершаем сами; если есть — последний запрос
          // сам вызовет oncomplete, когда счётчик дойдёт до нуля.
          setTimeout(function () {
            if (tx.__pending === 0 && tx.oncomplete) tx.oncomplete();
          }, 0);
          return tx;
        }
      };
      Object.defineProperty(db, "__store", {
        get: function () {
          var src = db.__stores.handles || {};
          var snap = {};
          Object.keys(src).forEach(function (k) { snap[k] = src[k]; });
          return snap;
        }
      });
    }
    // Синхронный доступ для посева: тест кладёт рукоять до того, как попап
    // прочитает базу при открытии.
    req.__db = db;
    setTimeout(function () {
      db.version = 1;
      req.result = db;
      if (isNew && req.onupgradeneeded) req.onupgradeneeded();
      if (req.onsuccess) req.onsuccess();
    }, 0);
    return req;
  }

  return {
    open: open,
    // Тест закладывает рукоять до клика — ровно как это делает попап после
    // успешного выбора: та же база, то же хранилище, тот же ключ.
    seed: function (db, handle) {
      db.__stores.handles = db.__stores.handles || {};
      db.__stores.handles["install-dir"] = handle;
    }
  };
});
