/**
 * Подставная рукоять папки для тестов автообновления.
 *
 * Настоящий `FileSystemDirectoryHandle` в тесте получить нельзя: диалог выбора
 * папки поднимает только живой жест пользователя, а синтетический клик в
 * автоматизации жестом не считается. При этом наш код зовёт лишь горстку методов
 * этого интерфейса, и их собирает здесь обычный объект.
 *
 * Файл подключается с двух сторон: Node берёт его через `require`, страница
 * попапа — текстом, после чего `makeFakeRoot` доступен как глобальная функция.
 */
(function (global, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.makeFakeRoot = api.makeFakeRoot;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var enc = function (s) { return new TextEncoder().encode(s); };
  var dec = function (b) { return new TextDecoder().decode(b); };
  var toBytes = function (data) {
    if (data == null) return new Uint8Array(0);
    if (data instanceof Uint8Array) return data.slice();
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (typeof data === "string") return enc(data);
    if (data.bytes instanceof Uint8Array) return data.bytes.slice();
    return enc(String(data));
  };
  var err = function (name, message) {
    var e = new Error(message || name);
    e.name = name;
    return e;
  };
  var join = function (prefix, name) { return prefix ? prefix + "/" + name : name; };

  function makeFakeRoot(startFiles, opts) {
    opts = opts || {};
    var files = {};
    Object.keys(startFiles || {}).forEach(function (rel) {
      files[rel] = toBytes(startFiles[rel]);
    });
    // Что реально вызывали: по этому журналу проверяется и порядок, и то, что
    // запись шла через getFileHandle, а не «в память».
    var calls = [];
    var writable = {
      write: function (data) {
        if (opts.failOn === "write" && (opts.failRel == null || opts.failRel === this.rel)) {
          return Promise.reject(err(opts.failName || "NotAllowedError", "писать запрещено"));
        }
        this.buf = toBytes(data);
        calls.push("write:" + this.rel);
        return Promise.resolve();
      },
      close: function () {
        if (opts.failOn === "close" && (opts.failRel == null || opts.failRel === this.rel)) {
          return Promise.reject(err("IOError", "запись прервана"));
        }
        files[this.rel] = this.buf || new Uint8Array(0);
        calls.push("close:" + this.rel);
        return Promise.resolve();
      }
    };

    function fileHandle(rel) {
      return {
        kind: "file",
        name: rel.split("/").pop(),
        isFile: true,
        isDirectory: false,
        getFile: function () {
          if (opts.failOn === "read" && (opts.failRel == null || opts.failRel === rel)) {
            throw err("NotFoundError", "папки на месте нет");
          }
          if (!(rel in files)) throw err("NotFoundError", rel);
          var bytes = files[rel];
          calls.push("read:" + rel);
          return Promise.resolve({
            size: bytes.length,
            text: function () { return Promise.resolve(dec(bytes)); },
            arrayBuffer: function () { return Promise.resolve(bytes.slice().buffer); }
          });
        },
        createWritable: function () {
          calls.push("open:" + rel);
          return Promise.resolve(Object.assign({ rel: rel, buf: null }, writable));
        }
      };
    }

    function dirHandle(prefix) {
      return {
        kind: "directory",
        name: prefix.split("/").pop(),
        isFile: false,
        isDirectory: true,
        getDirectoryHandle: function (name, o) {
          var rel = join(prefix, name);
          var has = Object.keys(files).some(function (p) { return p.indexOf(rel + "/") === 0; });
          if (!has && !(o && o.create)) throw err("NotFoundError", rel);
          calls.push("dir:" + rel);
          return Promise.resolve(dirHandle(rel));
        },
        getFileHandle: function (name, o) {
          var rel = join(prefix, name);
          if (!(rel in files) && !(o && o.create)) throw err("NotFoundError", rel);
          calls.push("file:" + rel);
          return Promise.resolve(fileHandle(rel));
        },
        removeEntry: function (name) {
          var rel = join(prefix, name);
          var keys = Object.keys(files).filter(function (p) { return p === rel || p.indexOf(rel + "/") === 0; });
          if (!keys.length) throw err("NotFoundError", rel);
          keys.forEach(function (p) { delete files[p]; });
          calls.push("remove:" + rel);
          return Promise.resolve();
        },
        entries: function () {
          var names = {};
          Object.keys(files).forEach(function (rel) {
            if (prefix && rel.indexOf(prefix + "/") !== 0) return;
            var rest = prefix ? rel.slice(prefix.length + 1) : rel;
            var cut = rest.indexOf("/");
            if (cut < 0) names[rest] = "file";
            else names[rest.slice(0, cut)] = "directory";
          });
          var out = Object.keys(names).sort().map(function (n) {
            var rel = join(prefix, n);
            return [n, names[n] === "file" ? fileHandle(rel) : dirHandle(rel)];
          });
          return {
            next: function () {
              return Promise.resolve(out.length ? { value: out.shift(), done: false } : { done: true });
            },
            [Symbol.asyncIterator]: function () { return this; }
          };
        }
      };
    }

    var root = dirHandle("");
    root.name = opts.name || "dzen-rewriter";
    root.queryPermission = function () {
      calls.push("query");
      return Promise.resolve(opts.permission === undefined ? "granted" : opts.permission);
    };
    root.requestPermission = function (d) {
      calls.push("request:" + ((d && d.mode) || ""));
      var mode = (d && d.mode) || "read";
      if (opts.request === false) return Promise.resolve("denied");
      return Promise.resolve(mode === "readwrite" ? "granted" : "denied");
    };
    // Снимок для проверок: что лежит на «диске» и в каком порядке это делали.
    Object.defineProperty(root, "__files", {
      get: function () {
        var snap = {};
        Object.keys(files).forEach(function (rel) { snap[rel] = files[rel]; });
        return snap;
      }
    });
    root.__calls = calls;
    root.__text = function (rel) {
      return rel in files ? dec(files[rel]) : null;
    };
    return root;
  }

  return { makeFakeRoot: makeFakeRoot };
});
