/* ============================================================
   Pinyin — app de estudio de chino mandarín
   Sin dependencias ni compilación: se sirve tal cual.
   ============================================================ */
(function () {
"use strict";

/* ───────────────────────── utilidades ───────────────────────── */

var $  = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

function el(tag, cls, txt) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

function shuffle(a) {
  a = a.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function toast(msg) {
  var t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.hidden = true; }, 2200);
}

var DAY = 86400000;
function today() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

/* Quita las marcas de tono: 'xièxie' -> 'xiexie'. La diéresis se conserva
   como 'v' porque lü y lu son sílabas distintas. */
function stripTones(s) {
  var out = "";
  var norm = s.normalize("NFD");
  for (var i = 0; i < norm.length; i++) {
    var c = norm[i];
    if (c >= "̀" && c <= "ͯ") {
      if (c === "̈" && out.slice(-1) === "u") out = out.slice(0, -1) + "v";
      continue;
    }
    out += c;
  }
  return out.toLowerCase().replace(/ü/g, "v");
}

var TONE_OF = {};
(function () {
  var marks = { "a": "āáǎà", "e": "ēéěè", "i": "īíǐì",
                "o": "ōóǒò", "u": "ūúǔù", "ü": "ǖǘǚǜ" };
  for (var k in marks)
    for (var i = 0; i < 4; i++) TONE_OF[marks[k][i]] = i + 1;
})();

function toneOf(syl) {
  for (var i = 0; i < syl.length; i++)
    if (TONE_OF[syl[i]]) return TONE_OF[syl[i]];
  return 5;
}

/* ───────────────────────── almacenamiento ───────────────────────── */

var Store = {
  KEY_PROG: "pinyin.progress.v2",
  KEY_SET:  "pinyin.settings.v2",

  progress: {},
  settings: {
    rate: 0.85, voice: "", autoplay: true,
    colors: true, hsk: true, sandhi: true,
    newPerSession: 10, maxPerSession: 30
  },

  load: function () {
    try {
      var p = localStorage.getItem(this.KEY_PROG);
      if (p) this.progress = JSON.parse(p);
    } catch (e) { this.progress = {}; }
    try {
      var s = localStorage.getItem(this.KEY_SET);
      if (s) {
        var parsed = JSON.parse(s);
        for (var k in parsed) if (k in this.settings) this.settings[k] = parsed[k];
      }
    } catch (e) {}
  },

  saveProgress: function () {
    try { localStorage.setItem(this.KEY_PROG, JSON.stringify(this.progress)); }
    catch (e) { toast("No se pudo guardar el progreso"); }
  },

  saveSettings: function () {
    try { localStorage.setItem(this.KEY_SET, JSON.stringify(this.settings)); } catch (e) {}
  },

  card: function (id) {
    var p = this.progress[id];
    if (!p) {
      p = { reps: 0, ok: 0, ease: 2.5, interval: 0, due: 0, lapses: 0 };
      this.progress[id] = p;
    }
    return p;
  },

  /* Importa de una vez el historial del backup anterior.
     La última sesión de ese backup fue hace meses, así que un SRS honesto
     marcaría las ~400 tarjetas como vencidas el mismo día. Eso no se estudia,
     se abandona. Se reparte la mochila en dos semanas, poniendo delante lo
     más flojo y lo más antiguo. */
  seedFromBackup: function (cards) {
    if (Object.keys(this.progress).length) return false;

    var seeded = cards.filter(function (c) {
      return c.stats && c.stats.studyCount > 0;
    }).map(function (c) {
      var reps = c.stats.studyCount;
      var ok = c.stats.correctCount || 0;
      var acc = reps ? ok / reps : 0;
      // más repasos y más acierto => intervalo más largo
      var base = reps >= 15 ? 21 : reps >= 10 ? 14 : reps >= 7 ? 10
               : reps >= 4 ? 6  : reps >= 2 ? 3  : 1;
      var interval = Math.max(1, Math.round(base * (acc >= 0.9 ? 1 : acc >= 0.7 ? 0.6 : 0.3)));
      return {
        id: c.id, reps: reps, ok: ok, acc: acc, interval: interval,
        last: c.stats.lastStudiedAt || 0,
        priority: acc * 1000 + interval      // primero lo flojo y lo frágil
      };
    });

    seeded.sort(function (a, b) { return a.priority - b.priority; });

    var PER_DAY = 35, SPREAD = 14;
    seeded.forEach(function (s, i) {
      var day = Math.min(SPREAD - 1, Math.floor(i / PER_DAY));
      Store.progress[s.id] = {
        reps: s.reps, ok: s.ok,
        ease: s.acc >= 0.9 ? 2.6 : s.acc >= 0.7 ? 2.3 : 1.9,
        interval: s.interval,
        due: today() + day * DAY,
        lapses: 0,
        imported: true
      };
    });

    cards.forEach(function (c) { Store.card(c.id); });
    this.saveProgress();
    return true;
  },

  reset: function () {
    this.progress = {};
    try { localStorage.removeItem(this.KEY_PROG); } catch (e) {}
  }
};

/* ───────────────────────── repaso espaciado ───────────────────────── */
/* SM-2 recortado a dos botones. Con tres o cuatro grados el usuario duda
   más de lo que gana en precisión, y aquí lo que importa es no frenar. */

var SRS = {
  grade: function (id, correct) {
    var p = Store.progress[id] || Store.card(id);
    p.reps++;
    if (correct) {
      p.ok++;
      p.interval = p.interval === 0 ? 1
                 : p.interval === 1 ? 3
                 : Math.round(p.interval * p.ease);
      p.ease = Math.min(2.8, p.ease + 0.06);
    } else {
      p.lapses++;
      p.interval = 0;                      // vuelve al montón de hoy
      p.ease = Math.max(1.4, p.ease - 0.22);
    }
    p.due = today() + Math.max(0, p.interval) * DAY;
    p.last = Date.now();
    Store.saveProgress();
    return p;
  },

  isDue: function (id) {
    var p = Store.progress[id];
    if (!p || !p.reps) return false;
    return (p.due || 0) <= today();
  },

  isNew: function (id) {
    var p = Store.progress[id];
    return !p || !p.reps;
  },

  accuracy: function (id) {
    var p = Store.progress[id];
    if (!p || !p.reps) return null;
    return p.ok / p.reps;
  }
};

/* ───────────────────────── datos ───────────────────────── */

var Data = {
  raw: null, cards: [], byId: {}, decks: [], grammar: [], complements: [],

  load: function () {
    return fetch("data/vocabulario.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) {
        Data.raw = d;
        Data.cards = d.cards || [];
        Data.decks = d.decks || [];
        Data.grammar = d.grammar || [];
        Data.complements = d.complements || [];
        Data.cards.forEach(function (c) { Data.byId[c.id] = c; });
        var imported = Store.seedFromBackup(Data.cards);
        Data.cards.forEach(function (c) { Store.card(c.id); });
        Store.saveProgress();
        if (imported) Data.justImported = true;
        return d;
      });
  },

  deckCards: function (deck) {
    return (deck.cards || []).map(function (id) { return Data.byId[id]; })
                             .filter(Boolean);
  },

  deckStats: function (deck) {
    var cards = this.deckCards(deck);
    var due = 0, fresh = 0, sum = 0, n = 0;
    cards.forEach(function (c) {
      if (SRS.isNew(c.id)) fresh++;
      else if (SRS.isDue(c.id)) due++;
      var a = SRS.accuracy(c.id);
      if (a !== null) { sum += a; n++; }
    });
    return {
      total: cards.length, due: due, fresh: fresh,
      accuracy: n ? sum / n : null,
      studied: cards.length - fresh
    };
  },

  allDue: function () {
    return Data.cards.filter(function (c) { return SRS.isDue(c.id); });
  },

  /* ¿Hay vocabulario nuevo en la PC?

     La app funciona offline gracias a la caché del service worker, pero esa
     caché no se entera sola de que regeneraste el dataset. Se compara la fecha
     de generación contra el servidor y se avisa. Si no hay red (estás fuera de
     casa), no pasa nada: se sigue con lo que hay. */
  checkForUpdates: function (manual) {
    var actual = (Data.raw || {}).generated;
    return fetch("data/vocabulario.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("sin respuesta");
        return r.json();
      })
      .then(function (fresh) {
        if (fresh.generated && fresh.generated !== actual) {
          UI.showUpdateBanner(fresh);
          return true;
        }
        if (manual) toast("Ya tienes la última versión");
        return false;
      })
      .catch(function () {
        if (manual) toast("No se pudo conectar con la PC");
        return false;
      });
  }
};

/* ───────────────────────── audio ───────────────────────── */

var Speech = {
  voices: [], voice: null, ready: false,

  init: function () {
    if (!("speechSynthesis" in window)) return;
    var pick = function () {
      Speech.voices = speechSynthesis.getVoices().filter(function (v) {
        return /^zh/i.test(v.lang);
      });
      Speech.ready = true;
      Speech.select(Store.settings.voice);
      UI.fillVoices();
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
  },

  select: function (name) {
    if (!this.voices.length) { this.voice = null; return; }
    var found = null;
    if (name) {
      found = this.voices.filter(function (v) { return v.name === name; })[0];
    }
    if (!found) {
      // se prefiere mandarín continental sobre cantonés o taiwanés
      found = this.voices.filter(function (v) { return /zh[-_]CN|zh[-_]Hans/i.test(v.lang); })[0]
           || this.voices[0];
    }
    this.voice = found;
  },

  speak: function (text) {
    if (!("speechSynthesis" in window) || !text) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = (this.voice && this.voice.lang) || "zh-CN";
      if (this.voice) u.voice = this.voice;
      u.rate = Store.settings.rate;
      speechSynthesis.speak(u);
    } catch (e) {}
  },

  available: function () { return this.voices.length > 0; }
};

/* ───────────────────────── render de pinyin ───────────────────────── */

function renderPinyin(card, opts) {
  opts = opts || {};
  var wrap = el("span", "py");
  (card.tokens || []).forEach(function (tok, i) {
    if (tok.t === "p") { wrap.appendChild(document.createTextNode(tok.hanzi)); return; }
    if (i > 0) wrap.appendChild(document.createTextNode(" "));
    tok.syl.forEach(function (s) {
      wrap.appendChild(el("span", "t" + s[1], s[0]));
    });
  });
  if (!wrap.textContent) wrap.textContent = card.pinyin || "";
  return wrap;
}

function plainPinyin(card) { return card.pinyin || ""; }

/* Ilustración de la tarjeta: imagen generada si existe, si no el emoji.
   `size` es 'big' para la tarjeta de estudio y 'small' para la lista. */
function renderIllustration(card, size) {
  if (card.image) {
    var img = el("img", "card-img" + (size === "small" ? " small" : ""));
    img.src = card.image;
    img.alt = card.es || card.hanzi;
    img.loading = "lazy";
    img.decoding = "async";
    // Si el archivo falta (se borró la carpeta), se cae al emoji sin romper nada
    img.onerror = function () {
      var fb = el("div", size === "small" ? "" : "card-emoji", card.emoji || "·");
      if (img.parentNode) img.parentNode.replaceChild(fb, img);
    };
    return img;
  }
  if (card.emoji) return el("div", size === "small" ? "" : "card-emoji", card.emoji);
  return null;
}

/* ───────────────────────── orden de trazos ───────────────────────── */
/* Datos de hanzi-writer-data (proyecto Make Me a Hanzi), servidos desde
   web/strokes/. Se cargan por carácter y sólo cuando hacen falta: son 1,8 MB
   en total y no tiene sentido meterlos en la caché inicial. */

var Strokes = {
  cache: {},
  writers: [],
  practicing: false,

  available: function () {
    return typeof HanziWriter !== "undefined";
  },

  isHanzi: function (ch) {
    var o = ch.charCodeAt(0);
    return (o >= 0x4E00 && o <= 0x9FFF) || (o >= 0x3400 && o <= 0x4DBF);
  },

  loadChar: function (char, onComplete, onError) {
    if (this.cache[char]) { onComplete(this.cache[char]); return; }
    var self = this;
    var code = char.codePointAt(0).toString(16);
    fetch("strokes/" + code + ".json")
      .then(function (r) {
        if (!r.ok) throw new Error("404");
        return r.json();
      })
      .then(function (data) { self.cache[char] = data; onComplete(data); })
      .catch(function () { if (onError) onError(); });
  },

  open: function (card) {
    if (!this.available()) { toast("No se pudo cargar el trazador"); return; }

    var chars = [];
    for (var i = 0; i < card.hanzi.length; i++) {
      if (this.isHanzi(card.hanzi[i])) chars.push(card.hanzi[i]);
    }
    if (!chars.length) { toast("Esta tarjeta no tiene caracteres"); return; }

    $("#stroke-title").textContent = card.hanzi.length > 10
      ? "Orden de trazos" : card.hanzi;

    var grid = $("#stroke-grid");
    grid.innerHTML = "";
    this.writers = [];
    this.practicing = false;
    $("#btn-stroke-practice").textContent = "✍️  Practicar trazando";

    var self = this;
    chars.slice(0, 12).forEach(function (ch, idx) {
      var cell = el("div", "stroke-cell");
      var target = el("div", "stroke-target");
      target.id = "hw-" + idx;
      cell.appendChild(target);
      cell.appendChild(el("div", "stroke-char hanzi", ch));
      grid.appendChild(cell);

      var writer = HanziWriter.create(target, ch, {
        width: 110,
        height: 110,
        padding: 4,
        showOutline: true,
        showCharacter: false,
        strokeAnimationSpeed: 1,
        delayBetweenStrokes: 260,
        strokeColor: "#1b7a43",
        outlineColor: "#d8dde2",
        drawingColor: "#c62828",
        charDataLoader: function (c, onComplete) {
          self.loadChar(c, onComplete, function () {
            cell.classList.add("no-data");
            target.innerHTML = "";
            cell.appendChild(el("div", "hint", "sin datos"));
          });
        },
      });
      self.writers.push(writer);

      // escalonadas, para poder seguir el orden de una en una
      setTimeout(function () { writer.animateCharacter(); }, idx * 700);

      cell.onclick = function () {
        if (self.practicing) writer.quiz(self._quizOpts(cell));
        else writer.animateCharacter();
      };
    });

    $("#stroke-sheet").hidden = false;
  },

  _quizOpts: function (cell) {
    return {
      onMistake: function () { cell.classList.add("stroke-bad"); },
      onCorrectStroke: function () { cell.classList.remove("stroke-bad"); },
      onComplete: function (info) {
        cell.classList.remove("stroke-bad");
        cell.classList.add("stroke-done");
        if (info && info.totalMistakes === 0) toast("¡Sin errores!");
      },
    };
  },

  replay: function () {
    this.practicing = false;
    $("#btn-stroke-practice").textContent = "✍️  Practicar trazando";
    $$(".stroke-cell").forEach(function (c) {
      c.classList.remove("stroke-done", "stroke-bad");
    });
    this.writers.forEach(function (w, i) {
      setTimeout(function () { w.animateCharacter(); }, i * 700);
    });
  },

  practice: function () {
    var self = this;
    this.practicing = true;
    $("#btn-stroke-practice").textContent = "✍️  Trazando… toca para reiniciar";
    $$(".stroke-cell").forEach(function (c) {
      c.classList.remove("stroke-done", "stroke-bad");
    });
    this.writers.forEach(function (w, i) {
      var cell = $$(".stroke-cell")[i];
      w.quiz(self._quizOpts(cell));
    });
  },

  close: function () {
    $("#stroke-sheet").hidden = true;
    this.writers = [];
  },
};

/* Botón de trazos, para reutilizar en cualquier tarjeta. */
function strokeButton(card) {
  var b = el("button", "icon-btn", "✍️");
  b.title = "Orden de trazos";
  b.onclick = function (e) { e.stopPropagation(); Strokes.open(card); };
  return b;
}


/* ─────────────── deslizar para pasar de tarjeta ───────────────
   Después de ver la respuesta, en vez de buscar el botón se arrastra la
   tarjeta: derecha = la sabía, izquierda = no la sabía. Los botones siguen
   ahí para quien los prefiera.

   Se usan eventos de puntero, que valen igual para dedo y ratón. Si el gesto
   arranca vertical se cancela, para no secuestrar el scroll de la página. */
function enableSwipe(node, onLeft, onRight) {
  var x0 = 0, y0 = 0, dx = 0, arrastrando = false, resuelto = false;
  var ancho = 300;

  var marca = el("div", "swipe-badge");
  node.appendChild(marca);

  function pinta() {
    var p = Math.min(1, Math.abs(dx) / (ancho * 0.3));
    node.style.transform = "translateX(" + dx + "px) rotate(" + (dx / 24) + "deg)";
    marca.textContent = dx > 0 ? "✕" : "✓";
    marca.className = "swipe-badge " + (dx > 0 ? "bad" : "ok");
    marca.style.opacity = Math.abs(dx) > 12 ? p : 0;
  }

  function suelta() {
    arrastrando = false;
    node.style.transition = "transform .18s ease, opacity .18s ease";
    node.style.transform = "";
    marca.style.opacity = 0;
  }

  node.addEventListener("pointerdown", function (e) {
    if (resuelto) return;
    if (e.target.closest && e.target.closest("button")) return;   // no robar los botones
    arrastrando = true;
    x0 = e.clientX; y0 = e.clientY; dx = 0;
    ancho = node.offsetWidth || 300;
    node.style.transition = "none";
    try { node.setPointerCapture(e.pointerId); } catch (err) {}
  });

  node.addEventListener("pointermove", function (e) {
    if (!arrastrando) return;
    dx = e.clientX - x0;
    var dy = e.clientY - y0;
    if (Math.abs(dy) > Math.abs(dx) * 1.4 && Math.abs(dy) > 24) { suelta(); return; }
    pinta();
  });

  function fin() {
    if (!arrastrando) return;
    var umbral = Math.max(70, ancho * 0.28);
    var decidido = Math.abs(dx) > umbral;
    var derecha = dx > 0;
    if (!decidido) { suelta(); return; }

    resuelto = true;
    arrastrando = false;
    node.style.transition = "transform .2s ease, opacity .2s ease";
    node.style.transform = "translateX(" + (derecha ? ancho : -ancho) * 1.4 +
                           "px) rotate(" + (derecha ? 18 : -18) + "deg)";
    node.style.opacity = 0;
    setTimeout(function () { (derecha ? onRight : onLeft)(); }, 170);
  }

  node.addEventListener("pointerup", fin);
  node.addEventListener("pointercancel", suelta);
}

/* ────────────────── comparación de lo que escribes ────────────────── */

/* Para comparar dos frases hay que ignorar la puntuación: si escribes 。 o .
   o nada, la frase es la misma. Los espacios tampoco cuentan. */
function normalizarChino(s) {
  return (s || "").replace(/[\s，。！？、；：""''（）《》…—,.!?;:()"'\[\]]/g, "");
}

/* Vocabulario para partir lo que escribe el usuario. Se construye una vez con
   todas las palabras conocidas, de más larga a más corta, para que 图书馆 gane
   a 图 + 书 + 馆. */
var _vocabCache = null;
function vocabulario() {
  if (_vocabCache) return _vocabCache;
  var set = {};
  Data.cards.forEach(function (c) {
    (c.tokens || []).forEach(function (t) {
      if (t.t === "w" && t.hanzi.length > 1) set[t.hanzi] = true;
    });
  });
  _vocabCache = Object.keys(set).sort(function (a, b) { return b.length - a.length; });
  return _vocabCache;
}

function segmentar(texto, extra) {
  var vocab = (extra || []).concat(vocabulario());
  var out = [], i = 0;
  while (i < texto.length) {
    var encontrado = null;
    for (var k = 0; k < vocab.length; k++) {
      var v = vocab[k];
      if (v && texto.substr(i, v.length) === v) { encontrado = v; break; }
    }
    if (encontrado) { out.push(encontrado); i += encontrado.length; }
    else { out.push(texto[i]); i++; }
  }
  return out;
}

/* Diferencia palabra a palabra por subsecuencia común más larga.
   Devuelve [{op: 'ok'|'falta'|'sobra', w: palabra}] */
function compararTokens(esperado, escrito) {
  var n = esperado.length, m = escrito.length;
  var dp = [];
  for (var i = 0; i <= n; i++) {
    dp.push(new Array(m + 1).fill(0));
  }
  for (i = n - 1; i >= 0; i--) {
    for (var j = m - 1; j >= 0; j--) {
      dp[i][j] = esperado[i] === escrito[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  var res = [];
  i = 0; var j2 = 0;
  while (i < n && j2 < m) {
    if (esperado[i] === escrito[j2]) {
      res.push({ op: "ok", w: esperado[i] }); i++; j2++;
    } else if (dp[i + 1][j2] >= dp[i][j2 + 1]) {
      res.push({ op: "falta", w: esperado[i] }); i++;
    } else {
      res.push({ op: "sobra", w: escrito[j2] }); j2++;
    }
  }
  while (i < n) { res.push({ op: "falta", w: esperado[i] }); i++; }
  while (j2 < m) { res.push({ op: "sobra", w: escrito[j2] }); j2++; }
  return res;
}

/* Otra tarjeta que use la misma estructura, para insistir hasta que salga. */
function otraConMismaEstructura(card) {
  if (!card.pattern) return null;
  var candidatas = Data.cards.filter(function (c) {
    return c.id !== card.id && c.pattern === card.pattern &&
           c.type === "sentence" && c.es;
  });
  if (!candidatas.length) return null;
  return shuffle(candidatas)[0];
}

/* ───────────────────────── ejercicios ───────────────────────── */
/* Cada modo declara si una tarjeta le sirve (`fits`) y cómo se dibuja.
   La sesión sólo orquesta; así añadir un ejercicio no toca el resto. */

var Modes = {

  /* ---- 1. Flashcard: pinyin -> hanzi -> significado ---- */
  flash: {
    id: "flash", icon: "🃏", name: "Flashcard",
    desc: "Ves el pinyin, recuerdas el carácter y el significado",
    fits: function () { return true; },
    render: function (ctx) {
      var c = ctx.card, body = ctx.body;
      var card = el("div", "card");

      if (Store.settings.hsk && c.hsk)
        card.appendChild(el("span", "hsk-tag card-hsk", "HSK " + c.hsk));

      var tools = el("div", "card-tools");
      var speak = el("button", "icon-btn", "🔊");
      speak.onclick = function (e) { e.stopPropagation(); Speech.speak(c.hanzi); };
      tools.appendChild(speak);
      tools.appendChild(strokeButton(c));
      card.appendChild(tools);

      var py = el("div", "card-py");
      py.appendChild(renderPinyin(c));
      card.appendChild(py);

      if (Store.settings.sandhi && c.toneHint) {
        card.appendChild(el("div", "sandhi-note", "se pronuncia " + c.toneHint));
      }

      card.appendChild(el("div", "card-divider"));

      var back = el("div", "card-back");
      back.style.display = "none";
      var illo = renderIllustration(c, "big");
      if (illo) back.appendChild(illo);
      var hz = el("div", "card-hanzi hanzi" + (c.hanzi.length > 6 ? " long" : ""), c.hanzi);
      back.appendChild(hz);
      if (c.es) back.appendChild(el("div", "card-es", c.es));
      card.appendChild(back);

      var hint = el("div", "tap-hint", "Toca para ver la respuesta");
      card.appendChild(hint);

      var revealed = false;
      function reveal() {
        if (revealed) return;
        revealed = true;
        back.style.display = "";
        hint.textContent = "Desliza ←  la sabía   ·   →  no la sabía";
        ctx.showGrading();
        // izquierda = la sabía, derecha = no la sabía (así lo pidió el usuario)
        enableSwipe(card,
          function () { Session.grade(true); },
          function () { Session.grade(false); });
        if (Store.settings.autoplay) Speech.speak(c.hanzi);
      }
      card.onclick = reveal;
      body.appendChild(card);

      ctx.setActions([{ label: "Mostrar respuesta", cls: "", onClick: reveal }]);
      if (Store.settings.autoplay) Speech.speak(c.hanzi);
    }
  },

  /* ---- 2. Significado -> carácter (opción múltiple) ---- */
  meaning: {
    id: "meaning", icon: "🇪🇸", name: "Español → chino",
    desc: "Ves el significado y eliges el carácter correcto",
    fits: function (c) { return !!c.es && c.type === "word"; },
    render: function (ctx) {
      var c = ctx.card, body = ctx.body;
      var card = el("div", "card");

      var prompt = el("div", "prompt-block");
      prompt.appendChild(el("div", "prompt-label", "¿Cómo se dice?"));
      var illo = renderIllustration(c, "big");
      if (illo) prompt.appendChild(illo);
      prompt.appendChild(el("div", "prompt-es", c.es));
      card.appendChild(prompt);

      var pool = Data.cards.filter(function (x) {
        return x.type === "word" && x.id !== c.id && x.hanzi.length === c.hanzi.length;
      });
      if (pool.length < 3)
        pool = Data.cards.filter(function (x) { return x.type === "word" && x.id !== c.id; });

      var options = shuffle(shuffle(pool).slice(0, 3).concat([c]));
      var choices = el("div", "choices");
      var done = false;

      options.forEach(function (opt) {
        var b = el("button", "choice hanzi", opt.hanzi);
        b.onclick = function () {
          if (done) return;
          done = true;
          var ok = opt.id === c.id;
          $$(".choice", choices).forEach(function (n) {
            var isRight = n.textContent === c.hanzi;
            if (isRight) n.classList.add("ok");
            else if (n === b) n.classList.add("bad");
            else n.classList.add("dim");
          });
          Speech.speak(c.hanzi);
          ctx.feedback(ok, ok ? null : buildAnswerNote(c));
          ctx.autoGrade(ok);
        };
        choices.appendChild(b);
      });
      card.appendChild(choices);
      body.appendChild(card);
      ctx.setActions([]);
    }
  },

  /* ---- 5. Reconocer el carácter ---- */
  reading: {
    id: "reading", icon: "👁️", name: "Lectura",
    desc: "Ves el carácter y recuerdas cómo se lee y qué significa",
    fits: function () { return true; },
    render: function (ctx) {
      var c = ctx.card, body = ctx.body;
      var card = el("div", "card");

      if (Store.settings.hsk && c.hsk)
        card.appendChild(el("span", "hsk-tag card-hsk", "HSK " + c.hsk));

      var rtools = el("div", "card-tools");
      rtools.appendChild(strokeButton(c));
      card.appendChild(rtools);

      card.appendChild(el("div", "card-hanzi hanzi" + (c.hanzi.length > 6 ? " long" : ""), c.hanzi));

      var back = el("div");
      back.style.display = "none";
      var py = el("div", "card-py");
      py.appendChild(renderPinyin(c));
      back.appendChild(py);
      if (Store.settings.sandhi && c.toneHint)
        back.appendChild(el("div", "sandhi-note", "se pronuncia " + c.toneHint));
      if (c.es) back.appendChild(el("div", "card-es", c.es));
      card.appendChild(back);

      var hint = el("div", "tap-hint", "Toca para ver la lectura");
      card.appendChild(hint);

      var revealed = false;
      function reveal() {
        if (revealed) return;
        revealed = true;
        back.style.display = "";
        hint.textContent = "Desliza ←  la sabía   ·   →  no la sabía";
        Speech.speak(c.hanzi);
        ctx.showGrading();
        // izquierda = la sabía, derecha = no la sabía (así lo pidió el usuario)
        enableSwipe(card,
          function () { Session.grade(true); },
          function () { Session.grade(false); });
      }
      card.onclick = reveal;
      body.appendChild(card);
      ctx.setActions([{ label: "Mostrar lectura", cls: "", onClick: reveal }]);
    }
  }
};

function countWords(c) {
  return (c.tokens || []).filter(function (t) { return t.t === "w"; }).length;
}

function pt_hanziCount(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) if (Strokes.isHanzi(s[i])) n++;
  return n;
}

function buildAnswerNote(c) {
  var box = document.createDocumentFragment();
  var line = el("div", "fb-line");
  line.appendChild(el("b", "hanzi", c.hanzi));
  line.appendChild(document.createTextNode("  "));
  line.appendChild(renderPinyin(c));
  box.appendChild(line);
  if (c.es) box.appendChild(el("div", "", c.es));
  return box;
}

/* Compara lo escrito con el pinyin correcto. Se evalúa la sílaba y el tono por
   separado: acertar las sílabas y fallar un tono no es lo mismo que no tener
   ni idea, y conviene que el feedback lo diga. */
function checkPinyin(input, target) {
  var norm = function (s) {
    return s.toLowerCase().replace(/[·'\-,.!?;:，。！？、]/g, " ")
            .replace(/\s+/g, " ").trim();
  };
  var tgtSyls = splitSyllables(norm(target));
  var inSyls  = splitSyllables(norm(input));

  var tgtBase = tgtSyls.map(function (s) { return stripTones(s); });
  var inBase  = inSyls.map(function (s) { return stripTones(s); });

  var baseOk = tgtBase.join("") === inBase.join("");
  var userTyped = inSyls.some(function (s) { return toneOf(s) !== 5; });

  var cells = [];
  var tonesOk = true;
  if (baseOk && userTyped) {
    for (var i = 0; i < tgtSyls.length; i++) {
      var want = toneOf(tgtSyls[i]);
      var got  = inSyls[i] ? toneOf(inSyls[i]) : 5;
      var good = want === got;
      if (!good) tonesOk = false;
      cells.push({ syl: tgtSyls[i], ok: good, got: got, want: want });
    }
  }

  return {
    ok: baseOk && (!userTyped || tonesOk),
    baseOk: baseOk,
    tonesChecked: baseOk && userTyped,
    tonesOk: tonesOk,
    cells: cells,
    target: target
  };
}

/* Separa el pinyin en sílabas aunque venga todo pegado ('nihao').

   La coda tiene que probar 'ng' antes que 'n', o 'háng' se parte en 'hán' y
   sobra una g. Con vocales sin marcar no se notaba; con marcas de tono sí. */
var VOWELS = "aeiouüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ";
var SYL_RE = new RegExp(
  "(?:zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?" +   // inicial
  "[" + VOWELS + "]{1,3}" +                  // medial + núcleo
  "(?:ng|n)?" +                              // coda
  "(?:r(?![" + VOWELS + "]))?",              // erhua sólo si cierra sílaba,
  "gi");                                     // si no, 生日 se parte 'shēngr|ì'

function splitSyllables(s) {
  var parts = s.split(/\s+/).filter(Boolean);
  var out = [];
  parts.forEach(function (p) {
    if (/^[a-züÀ-ǿ]+$/i.test(p)) {
      var m = p.match(SYL_RE);
      if (m && m.join("").length === p.length) { out = out.concat(m); return; }
    }
    out.push(p);
  });
  return out.filter(Boolean);
}

function buildDictationNote(c, res) {
  var box = document.createDocumentFragment();
  var line = el("div", "fb-line");
  line.appendChild(el("b", "hanzi", c.hanzi));
  line.appendChild(document.createTextNode("  "));
  line.appendChild(renderPinyin(c));
  box.appendChild(line);
  if (c.es) box.appendChild(el("div", "", c.es));

  if (res.tonesChecked && !res.tonesOk) {
    var row = el("div", "tone-diff");
    res.cells.forEach(function (cell) {
      var n = el("span", "tone-cell " + (cell.ok ? "ok" : "bad"), cell.syl);
      if (!cell.ok) n.title = "escribiste " + cell.got + "º, es " + cell.want + "º";
      row.appendChild(n);
    });
    box.appendChild(el("div", "", "Sílabas bien, revisa los tonos:"));
    box.appendChild(row);
  }
  return box;
}

/* ───────────────────────── sesión ───────────────────────── */

var Session = {
  queue: [], index: 0, mode: null, deck: null,
  results: [], startedAt: 0,

  start: function (deck, modeId) {
    var mode = Modes[modeId];
    if (!mode) return;

    var cards = deck ? Data.deckCards(deck) : Data.allDue();
    cards = cards.filter(mode.fits);

    if (!cards.length) {
      toast("No hay tarjetas para este ejercicio");
      return;
    }

    // primero lo que toca repasar, luego lo nuevo, y se corta por el límite
    var due   = cards.filter(function (c) { return SRS.isDue(c.id); });
    var fresh = cards.filter(function (c) { return SRS.isNew(c.id); });
    var rest  = cards.filter(function (c) { return !SRS.isDue(c.id) && !SRS.isNew(c.id); });

    // El tope de "tarjetas nuevas por sesión" existe para que el repaso diario
    // no se llene de material sin ver. Pero cuando abres un mazo a propósito
    // quieres ESE mazo: aplicarlo ahí dejaba 10 frases de las 59 disponibles.
    var nuevas = deck ? fresh : shuffle(fresh).slice(0, Store.settings.newPerSession);

    var picked = shuffle(due).concat(shuffle(nuevas)).concat(shuffle(rest));
    picked = picked.slice(0, Math.max(1, Store.settings.maxPerSession));

    this.queue = picked;
    this.index = 0;
    this.mode = mode;
    this.deck = deck;
    this.results = [];
    this.startedAt = Date.now();

    UI.show("session");
    this.renderCurrent();
  },

  get card() { return this.queue[this.index]; },

  renderCurrent: function () {
    var self = this;
    var card = this.card;
    if (!card) return this.finish();

    var body = $("#session-body");
    body.innerHTML = "";
    $("#session-actions").innerHTML = "";

    var total = this.queue.length;
    $("#session-counter").textContent = (this.index + 1) + " / " + total;
    var pct = Math.round(this.index / total * 100);
    $("#session-pct").textContent = pct + " %";
    $("#session-fill").style.width = pct + "%";

    var graded = false;

    var ctx = {
      card: card,
      body: body,

      setActions: function (actions) {
        var wrap = $("#session-actions");
        wrap.innerHTML = "";
        actions.forEach(function (a) {
          var b = el("button", "btn " + (a.cls || ""), a.label);
          b.onclick = a.onClick;
          wrap.appendChild(b);
        });
      },

      /* dos botones: lo supe / no lo supe */
      showGrading: function () {
        var wrap = $("#session-actions");
        wrap.innerHTML = "";
        var bad = el("button", "btn btn-bad", "✕  No lo sabía");
        var good = el("button", "btn btn-good", "✓  Lo sabía");
        bad.onclick  = function () { self.grade(false); };
        good.onclick = function () { self.grade(true); };
        wrap.appendChild(bad);
        wrap.appendChild(good);
      },

      /* el ejercicio ya sabe si estuvo bien: sólo queda continuar */
      autoGrade: function (ok) {
        if (graded) return;
        graded = true;
        var wrap = $("#session-actions");
        wrap.innerHTML = "";
        var b = el("button", "btn btn-wide " + (ok ? "btn-good" : "btn-bad"),
                   ok ? "Continuar" : "Continuar");
        b.onclick = function () { self.grade(ok); };
        wrap.appendChild(b);
        b.focus();
      },

      feedback: function (ok, extra) {
        var box = el("div", "feedback " + (ok ? "ok" : "bad"));
        box.appendChild(el("b", "", ok ? "¡Correcto!" : "Casi"));
        if (extra) box.appendChild(extra);
        body.appendChild(box);
        body.scrollTop = body.scrollHeight;
      }
    };

    this.mode.render(ctx);
  },

  grade: function (correct) {
    var card = this.card;
    SRS.grade(card.id, correct);
    this.results.push({ card: card, correct: correct });
    this.index++;
    this.renderCurrent();
  },

  /* Mete una tarjeta justo detrás de la actual sin puntuar la de ahora.
     Es lo que permite insistir con la misma estructura hasta que salga,
     en vez de dejarlo pasar y seguir con otra cosa. */
  insertNext: function (card) {
    this.queue.splice(this.index + 1, 0, card);
    this.results.push({ card: this.card, correct: false });
    SRS.grade(this.card.id, false);
    this.index++;
    this.renderCurrent();
  },

  finish: function () {
    var ok = this.results.filter(function (r) { return r.correct; }).length;
    var total = this.results.length;
    var pct = total ? Math.round(ok / total * 100) : 0;
    var wrong = this.results.filter(function (r) { return !r.correct; });
    var self = this;

    var wrap = $("#summary-wrap");
    wrap.innerHTML = "";

    wrap.appendChild(el("div", "summary-emoji",
      pct >= 90 ? "🎉" : pct >= 70 ? "👏" : pct >= 50 ? "💪" : "📖"));
    wrap.appendChild(el("div", "summary-score", pct + "%"));
    wrap.appendChild(el("div", "summary-sub",
      ok + " de " + total + " correctas · " +
      Math.round((Date.now() - self.startedAt) / 60000) + " min"));

    if (wrong.length) {
      var list = el("div", "summary-list");
      list.appendChild(el("h3", "", "Para repasar (" + wrong.length + ")"));
      wrong.forEach(function (r) {
        var row = el("div", "word-row");
        var em = el("div", "word-emoji");
        var thumb = renderIllustration(r.card, "small");
        if (thumb) em.appendChild(thumb);
        else em.textContent = r.card.emoji || "·";
        row.appendChild(em);
        var main = el("div", "word-main");
        main.appendChild(el("div", "word-hanzi hanzi", r.card.hanzi));
        var py = el("div", "word-py");
        py.appendChild(renderPinyin(r.card));
        main.appendChild(py);
        if (r.card.es) main.appendChild(el("div", "word-es", r.card.es));
        row.appendChild(main);
        var sp = el("button", "icon-btn", "🔊");
        sp.onclick = function () { Speech.speak(r.card.hanzi); };
        row.appendChild(sp);
        list.appendChild(row);
      });
      wrap.appendChild(list);
    }

    var again = el("button", "btn", "Repasar los fallos");
    again.disabled = !wrong.length;
    if (!wrong.length) again.setAttribute("disabled", "");
    again.onclick = function () {
      self.queue = wrong.map(function (r) { return r.card; });
      self.index = 0; self.results = []; self.startedAt = Date.now();
      UI.show("session");
      self.renderCurrent();
    };
    wrap.appendChild(again);

    var back = el("button", "btn ghost", "Volver");
    back.onclick = function () { UI.show("learn"); UI.renderLearn(); };
    wrap.appendChild(back);

    UI.show("summary");
  },

  quit: function () {
    if (this.results.length) { this.finish(); return; }
    UI.show("learn");
    UI.renderLearn();
  }
};

/* ───────────────────────── interfaz ───────────────────────── */

var UI = {
  currentView: "learn",
  libraryDeck: null,
  libraryFilter: "all",
  searchTerm: "",

  show: function (name) {
    ["learn", "library", "settings", "session", "summary"].forEach(function (v) {
      var node = $("#view-" + v);
      if (node) node.hidden = (v !== name);
    });
    $("#bottom-nav").style.display = (name === "session" || name === "summary") ? "none" : "";
    this.currentView = name;
    $$(".nav-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.view === name);
    });
  },

  applyColorSetting: function () {
    document.body.classList.toggle("no-colors", !Store.settings.colors);
  },

  showUpdateBanner: function (fresh, titulo) {
    if ($("#update-banner")) return;
    var bar = el("div", "update-banner");
    bar.id = "update-banner";
    var txt = el("div", "");
    txt.appendChild(el("b", "", titulo || "Hay vocabulario nuevo"));
    if (fresh) {
      var nuevas = (fresh.cards || []).length - Data.cards.length;
      txt.appendChild(el("div", "", nuevas > 0
        ? nuevas + (nuevas === 1 ? " tarjeta más" : " tarjetas más")
        : "se actualizó el contenido"));
    } else {
      txt.appendChild(el("div", "", "toca para cargarla"));
    }
    bar.appendChild(txt);
    var b = el("button", "", "Actualizar");
    b.onclick = function () {
      // el service worker ya bajó la versión nueva por detrás: al recargar la sirve
      location.reload();
    };
    bar.appendChild(b);
    document.body.appendChild(bar);
  },

  /* ---- Aprender ---- */
  renderLearn: function () {
    var totalReps = 0, totalOk = 0, learned = 0;
    Data.cards.forEach(function (c) {
      var p = Store.progress[c.id];
      if (p && p.reps) {
        totalReps += p.reps; totalOk += p.ok;
        if ((p.interval || 0) >= 7) learned++;
      }
    });
    var acc = totalReps ? Math.round(totalOk / totalReps * 100) : 0;

    var stats = $("#global-stats");
    stats.innerHTML = "";
    [[Data.cards.length, "Tarjetas"],
     [learned, "Consolidadas"],
     [acc + "%", "Precisión"]].forEach(function (s) {
      var d = el("div", "stat");
      d.appendChild(el("b", "", String(s[0])));
      d.appendChild(el("span", "", s[1]));
      stats.appendChild(d);
    });

    var due = Data.allDue();
    var box = $("#due-card");
    box.innerHTML = "";
    box.className = "due-card" + (due.length ? "" : " empty");

    if (due.length) {
      var head = el("div", "due-head");
      head.appendChild(el("b", "", String(due.length)));
      head.appendChild(el("span", "", due.length === 1 ? "tarjeta pendiente" : "tarjetas pendientes"));
      box.appendChild(head);
      box.appendChild(el("div", "due-sub", "Repasar ahora mantiene lo que ya aprendiste"));
      var b = el("button", "btn", "Empezar repaso");
      b.onclick = function () { UI.openModes(null, "Repaso de hoy"); };
      box.appendChild(b);
    } else {
      box.appendChild(el("div", "", "✅"));
      box.appendChild(el("div", "", "Nada pendiente por hoy"));
      box.appendChild(el("div", "due-sub", "Puedes adelantar con cualquier mazo"));
    }

    this.renderDecks();
  },

  renderDecks: function () {
    var list = $("#deck-list");
    list.innerHTML = "";
    var sort = $("#deck-sort").value;

    var decks = Data.decks.map(function (d) {
      return { deck: d, stats: Data.deckStats(d) };
    }).filter(function (x) { return x.stats.total > 0; });

    if (sort === "pending")
      decks.sort(function (a, b) { return (b.stats.due + b.stats.fresh) - (a.stats.due + a.stats.fresh); });
    else if (sort === "accuracy")
      decks.sort(function (a, b) {
        return (a.stats.accuracy == null ? 2 : a.stats.accuracy) -
               (b.stats.accuracy == null ? 2 : b.stats.accuracy);
      });

    decks.forEach(function (x) {
      var d = x.deck, s = x.stats;
      var node = el("div", "deck");

      var top = el("div", "deck-top");
      top.appendChild(el("div", "deck-name", d.name));
      if (s.due) {
        var badge = el("span", "hsk-tag", String(s.due) + " hoy");
        badge.style.background = "var(--warn-bg)";
        badge.style.color = "var(--warn)";
        top.appendChild(badge);
      }
      node.appendChild(top);

      var meta = el("div", "deck-meta");
      [[s.total, "Palabras"],
       [s.accuracy == null ? "—" : Math.round(s.accuracy * 100) + "%", "Precisión"],
       [s.fresh, "Sin ver"]].forEach(function (m) {
        var w = el("div");
        w.appendChild(el("b", "", String(m[0])));
        w.appendChild(document.createTextNode(m[1]));
        meta.appendChild(w);
      });
      node.appendChild(meta);

      var bar = el("div", "bar");
      var fill = el("i");
      fill.style.width = (s.total ? (s.studied / s.total * 100) : 0) + "%";
      bar.appendChild(fill);
      node.appendChild(bar);

      var btn = el("button", "btn", "▶  Estudiar");
      btn.onclick = function () { UI.openModes(d, d.name); };
      node.appendChild(btn);

      list.appendChild(node);
    });
  },

  /* ---- selector de ejercicio ---- */
  openModes: function (deck, title) {
    $("#mode-deck-name").textContent = title || "Elegir ejercicio";
    var list = $("#mode-list");
    list.innerHTML = "";

    var cards = deck ? Data.deckCards(deck) : Data.allDue();

    Object.keys(Modes).forEach(function (key) {
      var m = Modes[key];
      var usable = cards.filter(m.fits).length;
      var b = el("button", "mode");
      if (!usable) b.setAttribute("disabled", "");
      b.appendChild(el("div", "mode-ico", m.icon));
      var txt = el("div", "mode-txt");
      txt.appendChild(el("b", "", m.name));
      // lo que entra de verdad en la sesión, no el total del mazo
      var enSesion = Math.min(usable, Math.max(1, Store.settings.maxPerSession));
      txt.appendChild(el("span", "", usable
        ? m.desc + " · " + enSesion + " de " + usable
        : (m.id === "dictation" && !Speech.available()
            ? "Tu dispositivo no tiene voz en chino instalada"
            : "No hay tarjetas compatibles")));
      b.appendChild(txt);
      b.onclick = function () {
        $("#mode-sheet").hidden = true;
        Session.start(deck, m.id);
      };
      list.appendChild(b);
    });

    $("#mode-sheet").hidden = false;
  },

  /* ---- Biblioteca ---- */
  renderLibrary: function () {
    var tabs = $("#deck-tabs");
    tabs.innerHTML = "";

    var all = el("button", "tab" + (this.libraryDeck === null ? " active" : ""), "Todas");
    all.onclick = function () { UI.libraryDeck = null; UI.renderLibrary(); };
    tabs.appendChild(all);

    Data.decks.forEach(function (d) {
      if (!d.cards || !d.cards.length) return;
      var t = el("button", "tab" + (UI.libraryDeck === d.id ? " active" : ""), d.name);
      t.onclick = function () { UI.libraryDeck = d.id; UI.renderLibrary(); };
      tabs.appendChild(t);
    });

    var cards = this.libraryDeck
      ? Data.deckCards(Data.decks.filter(function (d) { return d.id === UI.libraryDeck; })[0] || { cards: [] })
      : Data.cards;

    if (this.libraryFilter === "word") cards = cards.filter(function (c) { return c.type === "word"; });
    if (this.libraryFilter === "sentence") cards = cards.filter(function (c) { return c.type === "sentence"; });
    if (this.libraryFilter === "weak") cards = cards.filter(function (c) {
      var a = SRS.accuracy(c.id); return a !== null && a < 0.7;
    });

    var term = this.searchTerm.trim().toLowerCase();
    if (term) {
      var bare = stripTones(term);
      cards = cards.filter(function (c) {
        return c.hanzi.indexOf(term) >= 0
            || stripTones((c.pinyin || "").toLowerCase()).indexOf(bare) >= 0
            || (c.es || "").toLowerCase().indexOf(term) >= 0;
      });
    }

    var list = $("#word-list");
    list.innerHTML = "";

    if (!cards.length) {
      var e = el("div", "empty-state");
      e.appendChild(el("span", "big", "🔍"));
      e.appendChild(el("div", "", "Nada por aquí"));
      list.appendChild(e);
    }

    cards.slice(0, 400).forEach(function (c) {
      var row = el("div", "word-row");

      var thumb = el("div", "word-emoji");
      var small = renderIllustration(c, "small");
      if (small) thumb.appendChild(small);
      else thumb.textContent = c.type === "sentence" ? "💬" : "·";
      row.appendChild(thumb);

      var main = el("div", "word-main");
      var h = el("div", "word-hanzi hanzi");
      h.appendChild(document.createTextNode(c.hanzi));
      if (Store.settings.hsk && c.hsk) h.appendChild(el("span", "hsk-tag", "HSK " + c.hsk));
      main.appendChild(h);
      var py = el("div", "word-py");
      py.appendChild(renderPinyin(c));
      main.appendChild(py);
      if (c.es) main.appendChild(el("div", "word-es", c.es));
      row.appendChild(main);

      var acc = SRS.accuracy(c.id);
      var score = el("div", "word-score");
      var val = el("b", "", acc === null ? "—" : Math.round(acc * 100) + "%");
      val.className = acc === null ? "score-new"
                    : acc >= 0.85 ? "score-good"
                    : acc >= 0.6  ? "score-mid" : "score-bad";
      score.appendChild(val);
      row.appendChild(score);

      row.onclick = function () { Speech.speak(c.hanzi); };
      list.appendChild(row);
    });

    $("#word-count").textContent = cards.length +
      (cards.length === 1 ? " tarjeta" : " tarjetas") +
      (cards.length > 400 ? " (mostrando 400)" : "");
  },

  /* ---- Ajustes ---- */
  fillVoices: function () {
    var sel = $("#set-voice");
    if (!sel) return;
    sel.innerHTML = "";
    if (!Speech.voices.length) {
      sel.appendChild(el("option", "", "No hay voces en chino"));
      sel.disabled = true;
      $("#voice-hint").textContent =
        "No se detectó ninguna voz en chino. En Android se instalan desde " +
        "Ajustes → Sistema → Idiomas → Salida de texto a voz; en Windows, " +
        "desde Configuración → Hora e idioma → Voz.";
      return;
    }
    sel.disabled = false;
    $("#voice-hint").textContent = "";
    Speech.voices.forEach(function (v) {
      var o = el("option", "", v.name + " (" + v.lang + ")");
      o.value = v.name;
      if (Speech.voice && v.name === Speech.voice.name) o.selected = true;
      sel.appendChild(o);
    });
  },

  renderSettings: function () {
    var s = Store.settings;
    $("#set-rate").value = s.rate;
    $("#rate-label").textContent = String(s.rate).replace(".", ",");
    $("#set-autoplay").checked = s.autoplay;
    $("#set-colors").checked = s.colors;
    $("#set-hsk").checked = s.hsk;
    $("#set-sandhi").checked = s.sandhi;
    $("#set-new").value = s.newPerSession;
    $("#set-max").value = s.maxPerSession;
    this.fillVoices();

    var studied = 0, reps = 0;
    Data.cards.forEach(function (c) {
      var p = Store.progress[c.id];
      if (p && p.reps) { studied++; reps += p.reps; }
    });
    var sum = $("#progress-summary");
    sum.innerHTML = "";
    [["Tarjetas vistas", studied + " de " + Data.cards.length],
     ["Repasos totales", String(reps)]].forEach(function (r) {
      var d = el("div");
      d.appendChild(el("span", "", r[0]));
      d.appendChild(el("b", "", r[1]));
      sum.appendChild(d);
    });

    var info = Data.raw || {};
    $("#data-info").textContent =
      "Vocabulario generado el " + (info.generated || "?").replace("T", " a las ") +
      ". " + Data.cards.length + " tarjetas, " + Data.decks.length + " mazos. " +
      "Pinyin reconstruido con CC-CEDICT; niveles HSK de la lista oficial 2.0.";
  }
};

/* ───────────────────────── arranque ───────────────────────── */

function bindEvents() {
  $$(".nav-btn").forEach(function (b) {
    b.onclick = function () {
      var v = b.dataset.view;
      UI.show(v);
      if (v === "learn") UI.renderLearn();
      if (v === "library") UI.renderLibrary();
      if (v === "settings") UI.renderSettings();
    };
  });

  $("#btn-settings-shortcut").onclick = function () {
    UI.show("settings"); UI.renderSettings();
  };

  $("#deck-sort").onchange = function () { UI.renderDecks(); };
  $("#btn-quit").onclick = function () { Session.quit(); };
  $("#btn-mode-cancel").onclick = function () { $("#mode-sheet").hidden = true; };
  $("#btn-stroke-close").onclick = function () { Strokes.close(); };
  $("#btn-stroke-replay").onclick = function () { Strokes.replay(); };
  $("#btn-stroke-practice").onclick = function () { Strokes.practice(); };
  $("#stroke-sheet").onclick = function (e) {
    if (e.target === $("#stroke-sheet")) Strokes.close();
  };
  $("#mode-sheet").onclick = function (e) {
    if (e.target === $("#mode-sheet")) $("#mode-sheet").hidden = true;
  };

  $("#btn-search").onclick = function () {
    var w = $("#search-wrap");
    w.hidden = !w.hidden;
    if (!w.hidden) $("#search-input").focus();
    else { $("#search-input").value = ""; UI.searchTerm = ""; UI.renderLibrary(); }
  };
  $("#search-input").oninput = function () {
    UI.searchTerm = this.value; UI.renderLibrary();
  };

  $$("#filter-chips .chip").forEach(function (c) {
    c.onclick = function () {
      $$("#filter-chips .chip").forEach(function (x) { x.classList.remove("active"); });
      c.classList.add("active");
      UI.libraryFilter = c.dataset.filter;
      UI.renderLibrary();
    };
  });

  /* ajustes */
  $("#set-rate").oninput = function () {
    Store.settings.rate = parseFloat(this.value);
    $("#rate-label").textContent = this.value.replace(".", ",");
    Store.saveSettings();
  };
  $("#set-voice").onchange = function () {
    Store.settings.voice = this.value;
    Speech.select(this.value);
    Store.saveSettings();
  };
  $("#btn-test-voice").onclick = function () { Speech.speak("你好，我们一起学习汉语。"); };
  $("#btn-check-updates").onclick = function () {
    toast("Buscando…");
    Data.checkForUpdates(true);
  };

  [["#set-autoplay", "autoplay"], ["#set-colors", "colors"],
   ["#set-hsk", "hsk"], ["#set-sandhi", "sandhi"]].forEach(function (pair) {
    $(pair[0]).onchange = function () {
      Store.settings[pair[1]] = this.checked;
      Store.saveSettings();
      UI.applyColorSetting();
    };
  });
  [["#set-new", "newPerSession"], ["#set-max", "maxPerSession"]].forEach(function (pair) {
    $(pair[0]).onchange = function () {
      var v = parseInt(this.value, 10);
      if (!isNaN(v)) { Store.settings[pair[1]] = v; Store.saveSettings(); }
    };
  });

  $("#btn-export").onclick = function () {
    var blob = new Blob([JSON.stringify({
      exported: new Date().toISOString(),
      progress: Store.progress,
      settings: Store.settings
    }, null, 1)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pinyin-progreso-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };

  $("#btn-import").onclick = function () { $("#import-file").click(); };
  $("#import-file").onchange = function () {
    var f = this.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(r.result);
        if (d.progress) { Store.progress = d.progress; Store.saveProgress(); }
        if (d.settings) {
          for (var k in d.settings) if (k in Store.settings) Store.settings[k] = d.settings[k];
          Store.saveSettings();
        }
        toast("Progreso importado");
        UI.renderSettings(); UI.applyColorSetting();
      } catch (e) { toast("El archivo no es válido"); }
    };
    r.readAsText(f);
    this.value = "";
  };

  $("#btn-reset").onclick = function () {
    if (!confirm("Se borrará todo tu progreso de estudio. ¿Continuar?")) return;
    Store.reset();
    Store.seedFromBackup(Data.cards);
    toast("Progreso borrado");
    UI.renderSettings();
  };

  document.addEventListener("keydown", function (e) {
    if (UI.currentView !== "session") return;
    if (e.key === "Escape") Session.quit();
  });
}

function boot() {
  Store.load();
  UI.applyColorSetting();
  Speech.init();

  Data.load().then(function () {
    bindEvents();
    UI.renderLearn();
    $("#loading").hidden = true;
    $("#app").hidden = false;

    // Un momento después, por si regeneraste el vocabulario en la PC.
    setTimeout(function () { Data.checkForUpdates(false); }, 2500);

    // En localhost no se registra: cachearía el código mientras se edita.
    // Desde el celular se entra por la IP de la red, así que ahí sí funciona.
    var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    if ("serviceWorker" in navigator && location.protocol !== "file:" && !isLocal) {
      navigator.serviceWorker.register("sw.js").then(function (reg) {
        // Aviso cuando hay una VERSIÓN NUEVA DE LA APP, no solo datos nuevos.
        // Antes solo se comparaba la fecha del vocabulario, así que una mejora
        // que no tocara los datos (un ejercicio nuevo, por ejemplo) se quedaba
        // sin avisar y había que recargar a mano.
        reg.addEventListener("updatefound", function () {
          var nuevo = reg.installing;
          if (!nuevo) return;
          nuevo.addEventListener("statechange", function () {
            if (nuevo.state === "installed" && navigator.serviceWorker.controller) {
              UI.showUpdateBanner(null, "Hay una versión nueva de la app");
            }
          });
        });
        // por si el celular lleva días con la app abierta
        setTimeout(function () { reg.update().catch(function () {}); }, 4000);
      }).catch(function () {});
    }
  }).catch(function (err) {
    $("#loading").innerHTML =
      "<p style='padding:24px;text-align:center'>No se pudo cargar el vocabulario.<br><br>" +
      "<small>" + String(err) + "</small><br><br>" +
      "<small>La app tiene que abrirse desde un servidor, no con doble clic en el archivo. " +
      "Ejecuta <code>python -m http.server</code> en la carpeta <code>web</code>.</small></p>";
  });
}

document.addEventListener("DOMContentLoaded", boot);

/* Expuesto para depurar desde la consola del navegador. */
window.Pinyin = {
  checkPinyin: checkPinyin,
  splitSyllables: splitSyllables,
  stripTones: stripTones,
  Data: Data, Store: Store, SRS: SRS, Session: Session, UI: UI, Speech: Speech
};

})();
