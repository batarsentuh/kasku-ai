/* KasKu AI — UI layer. All intelligence lives in logic.js (KasKu). */
(function () {
  'use strict';
  var K = window.KasKu;
  var STORE_KEY = 'kasku_ai_v1';
  var state = load();
  var txFilter = 'all';
  var pendingParse = null;
  var chatStarted = false;

  /* ---------------- storage & seed ---------------- */

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fresh start */ }
    var seeded = { txs: seedData() };
    save(seeded);
    return seeded;
  }
  function save(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s || state)); } catch (e) {}
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // Deterministic pseudo-random so the demo data is stable per day.
  function rng(seed) {
    var t = seed + 0x6D2B79F5;
    return function () {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedData() {
    var now = Date.now();
    var today = K.startOfDay(now);
    var rand = rng(20261122);
    var txs = [];
    function add(daysAgo, hour, type, amount, category, note, person) {
      txs.push({
        id: uid() + daysAgo + hour, ts: today - daysAgo * K.DAY_MS + hour * 3600e3,
        type: type, amount: amount, category: category, note: note, person: person || null
      });
    }
    add(14, 7, 'in', 2000000, 'Lainnya', 'Modal awal usaha');
    var stockNotes = ['kulakan beras & gula', 'kulakan indomie, kopi & rokok', 'kulakan minyak, telur & tepung',
      'kulakan sembako grosir', 'kulakan snack & minuman', 'kulakan beras 25kg'];
    for (var d = 13; d >= 1; d--) {
      var dow = new Date(today - d * K.DAY_MS).getDay();
      var weekend = (dow === 0 || dow === 6) ? 1.35 : 1;
      var base = Math.round((300000 + rand() * 110000) * weekend / 1000) * 1000;
      add(d, 12, 'in', Math.round(base * 0.55 / 1000) * 1000, 'Penjualan', 'penjualan pagi–siang');
      add(d, 19, 'in', base - Math.round(base * 0.55 / 1000) * 1000, 'Penjualan', 'penjualan sore–malam');
      if (d % 2 === 0) {
        add(d, 8, 'out', 340000 + Math.round(rand() * 160000 / 1000) * 1000, 'Stok & Bahan', stockNotes[d % stockNotes.length]);
        add(d, 8, 'out', 25000, 'Transport', 'bensin motor ke grosir');
      }
    }
    add(10, 9, 'out', 200000, 'Operasional', 'bayar listrik & token');
    add(7, 9, 'out', 50000, 'Operasional', 'iuran kebersihan & keamanan');
    add(4, 9, 'out', 100000, 'Operasional', 'token listrik');
    add(6, 17, 'debt', 75000, 'Piutang', 'Budi utang rokok & kopi', 'Budi');
    add(3, 16, 'debt', 120000, 'Piutang', 'Pak Haji utang sembako', 'Pak Haji');
    add(2, 18, 'debtpay', 25000, 'Piutang', 'Budi bayar utang sebagian', 'Budi');
    add(1, 15, 'debt', 40000, 'Piutang', 'Sari utang gula & telur', 'Sari');
    // today so far
    add(0, 10, 'in', 185000, 'Penjualan', 'penjualan pagi–siang');
    add(0, 8, 'out', 25000, 'Transport', 'bensin motor ke grosir');
    return txs.sort(function (a, b) { return a.ts - b.ts; });
  }

  /* ---------------- helpers ---------------- */

  function $(id) { return document.getElementById(id); }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.add('hidden'); }, 2400);
  }
  function addTx(draft, ts) {
    state.txs.push({
      id: uid(), ts: ts || Date.now(), type: draft.type, amount: draft.amount,
      category: draft.category, note: draft.note || '', person: draft.person || null
    });
    state.txs.sort(function (a, b) { return a.ts - b.ts; });
    save();
    renderAll();
  }
  function typeLabel(type) {
    return { in: 'Uang masuk', out: 'Uang keluar', debt: 'Piutang', debtpay: 'Bayar utang' }[type] || type;
  }
  function typeIcon(tx) {
    if (tx.type === 'debt') return '🧾';
    if (tx.type === 'debtpay') return '✅';
    if (tx.type === 'in') return '💵';
    if (tx.category === 'Stok & Bahan') return '📦';
    if (tx.category === 'Operasional') return '💡';
    if (tx.category === 'Transport') return '🛵';
    return '🧾';
  }
  function signedAmount(tx) {
    if (tx.type === 'in' || tx.type === 'debtpay') return '+' + K.fmtRp(tx.amount);
    if (tx.type === 'out') return '−' + K.fmtRp(tx.amount);
    return K.fmtRp(tx.amount); // debt: no cash movement yet
  }

  /* ---------------- charts ---------------- */

  function setupCanvas(canvas, height) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || canvas.parentElement.clientWidth - 32;
    canvas.width = w * dpr;
    canvas.height = height * dpr;
    canvas.style.height = height + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: height };
  }

  function drawFlowChart() {
    var canvas = $('flowChart');
    if (!canvas || !canvas.clientWidth) return;
    var s = K.summarize(state.txs, Date.now());
    var c = setupCanvas(canvas, 180), ctx = c.ctx;
    var max = 1;
    s.series.forEach(function (d) { max = Math.max(max, d.in, d.out); });
    var plotH = c.h - 34, base = plotH + 6;
    var slot = c.w / s.series.length;
    var bw = Math.min(11, slot / 3.4);
    ctx.strokeStyle = '#e2eae6'; ctx.beginPath(); ctx.moveTo(0, base + 0.5); ctx.lineTo(c.w, base + 0.5); ctx.stroke();
    s.series.forEach(function (d, i) {
      var x = i * slot + slot / 2;
      var hi = d.in / max * plotH, ho = d.out / max * plotH;
      ctx.fillStyle = '#0e9f6e';
      ctx.fillRect(x - bw - 1.5, base - hi, bw, hi);
      ctx.fillStyle = '#f3b04c';
      ctx.fillRect(x + 1.5, base - ho, bw, ho);
      if (i % 2 === 0) {
        ctx.fillStyle = '#6b7d76'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(new Date(d.ts).getDate().toString(), x, base + 16);
      }
    });
    ctx.fillStyle = '#6b7d76'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('maks ' + K.fmtShort(max), c.w - 2, 10);
  }

  function drawForecastChart() {
    var canvas = $('forecastChart');
    if (!canvas || !canvas.clientWidth) return;
    var f = K.forecast(state.txs, Date.now(), 7);
    var c = setupCanvas(canvas, 190), ctx = c.ctx;
    var vals = f.points.map(function (p) { return p.balance; });
    var min = Math.min.apply(null, vals.concat([0]));
    var max = Math.max.apply(null, vals);
    var pad = (max - min) * 0.12 || 10000;
    min -= pad; max += pad;
    var plotH = c.h - 40, plotW = c.w - 8;
    function X(i) { return 4 + (i / (f.points.length - 1)) * plotW; }
    function Y(v) { return 8 + (1 - (v - min) / (max - min)) * plotH; }
    // zero line
    if (min < 0 && max > 0) {
      ctx.strokeStyle = '#e02424'; ctx.setLineDash([4, 4]); ctx.beginPath();
      ctx.moveTo(0, Y(0)); ctx.lineTo(c.w, Y(0)); ctx.stroke(); ctx.setLineDash([]);
    }
    // area + line
    ctx.beginPath();
    f.points.forEach(function (p, i) { i ? ctx.lineTo(X(i), Y(p.balance)) : ctx.moveTo(X(i), Y(p.balance)); });
    ctx.strokeStyle = '#0b7a55'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.lineTo(X(f.points.length - 1), Y(min)); ctx.lineTo(X(0), Y(min)); ctx.closePath();
    ctx.fillStyle = 'rgba(14,159,110,0.12)'; ctx.fill();
    f.points.forEach(function (p, i) {
      ctx.beginPath(); ctx.arc(X(i), Y(p.balance), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#07332a' : '#0e9f6e'; ctx.fill();
      ctx.fillStyle = '#6b7d76'; ctx.font = '10px sans-serif';
      ctx.textAlign = i === 0 ? 'left' : (i === f.points.length - 1 ? 'right' : 'center');
      var lbl = i === 0 ? 'kini' : new Date(p.ts).getDate().toString();
      ctx.fillText(lbl, X(i), Y(min) + 16);
    });
    ctx.fillStyle = '#07332a'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(K.fmtShort(f.endBalance), c.w - 4, Y(f.endBalance) - 8);
  }

  /* ---------------- render: home ---------------- */

  function renderHome() {
    var now = Date.now();
    var s = K.summarize(state.txs, now);
    $('shopLine').textContent = 'Warung Berkah Bu Sari • ' + K.dayLabel(now);
    $('balanceValue').textContent = K.fmtRp(s.balance);
    $('balanceDate').textContent = 'Per ' + K.dayLabel(now);
    $('todayIn').textContent = K.fmtRp(s.today.in);
    $('todayOut').textContent = K.fmtRp(s.today.out);
    $('weekNet').textContent = (s.week.net >= 0 ? '+' : '') + K.fmtRp(s.week.net);
    drawFlowChart();
    var ins = K.genInsights(state.txs, now);
    $('topInsight').innerHTML = ins.length ? insightHTML(ins[0])
      : '<p class="fineprint">Catat beberapa transaksi dulu — AI akan membaca pola kasmu di sini.</p>';
    if (s.receivables.total > 0) {
      $('recvCard').classList.remove('hidden');
      $('recvTotal').textContent = K.fmtRp(s.receivables.total);
      $('recvList').innerHTML = s.receivables.list.map(function (r) {
        return '<li><span>👤 ' + esc(r.person) + '</span><b>' + K.fmtRp(r.amount) + '</b></li>';
      }).join('');
    } else {
      $('recvCard').classList.add('hidden');
    }
  }

  function insightHTML(i) {
    return '<div class="insight ' + i.tone + '"><h3>' + i.icon + ' ' + esc(i.title) + '</h3><p>' + esc(i.body) + '</p></div>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* ---------------- render: transactions ---------------- */

  function renderTx() {
    var list = state.txs.slice().sort(function (a, b) { return b.ts - a.ts; });
    if (txFilter === 'in') list = list.filter(function (t) { return t.type === 'in' || t.type === 'debtpay'; });
    if (txFilter === 'out') list = list.filter(function (t) { return t.type === 'out'; });
    if (txFilter === 'debt') list = list.filter(function (t) { return t.type === 'debt' || t.type === 'debtpay'; });
    if (!list.length) {
      $('txList').innerHTML = '<p class="empty-note">Belum ada transaksi pada filter ini.</p>';
      return;
    }
    var html = '', lastDay = '';
    list.forEach(function (tx) {
      var day = K.dayLabel(tx.ts);
      if (day !== lastDay) { html += '<p class="tx-day">' + day + '</p>'; lastDay = day; }
      html += '<div class="tx-item ' + tx.type + '">' +
        '<div class="tx-ic">' + typeIcon(tx) + '</div>' +
        '<div class="tx-main"><div class="tx-note">' + esc(tx.note || typeLabel(tx.type)) + '</div>' +
        '<div class="tx-meta">' + tx.category + (tx.person ? ' • ' + esc(tx.person) : '') + ' • ' + typeLabel(tx.type) + '</div></div>' +
        '<div class="tx-amt ' + tx.type + '">' + signedAmount(tx) + '</div>' +
        '<button class="tx-del" data-del="' + tx.id + '" title="Hapus">✕</button></div>';
    });
    $('txList').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (btn) {
      btn.addEventListener('click', function () {
        state.txs = state.txs.filter(function (t) { return t.id !== btn.getAttribute('data-del'); });
        save(); renderAll(); toast('Transaksi dihapus.');
      });
    });
  }

  /* ---------------- render: insights ---------------- */

  function renderInsights() {
    var now = Date.now();
    var f = K.forecast(state.txs, now, 7);
    drawForecastChart();
    $('fcDaily').textContent = (f.avgDailyNet >= 0 ? '+' : '') + K.fmtRp(f.avgDailyNet);
    $('fcDaily').style.color = f.avgDailyNet >= 0 ? 'var(--green-dark)' : 'var(--red)';
    $('fcEnd').textContent = K.fmtRp(f.endBalance);
    $('fcRunway').textContent = f.runwayDays === null ? 'Aman — kas bertumbuh' : ('± ' + f.runwayDays + ' hari lagi');
    $('fcRunway').style.color = f.runwayDays === null ? 'var(--green-dark)' : 'var(--red)';
    var ins = K.genInsights(state.txs, now);
    $('insightList').innerHTML = ins.length ? ins.map(insightHTML).join('')
      : '<p class="fineprint">Belum cukup data. Catat transaksi beberapa hari untuk membuka wawasan AI.</p>';
    var s = K.summarize(state.txs, now);
    var maxCat = s.byCategory.length ? s.byCategory[0].amount : 1;
    $('catBars').innerHTML = s.byCategory.length ? s.byCategory.map(function (c) {
      return '<div class="catbar"><div class="cb-head"><span>' + esc(c.category) + '</span><b>' + K.fmtRp(c.amount) + '</b></div>' +
        '<div class="cb-track"><div class="cb-fill" style="width:' + Math.round(c.amount / maxCat * 100) + '%"></div></div></div>';
    }).join('') : '<p class="fineprint">Belum ada pengeluaran tercatat.</p>';
  }

  /* ---------------- quick add ---------------- */

  function refreshPreview() {
    var text = $('qaInput').value.trim();
    var box = $('qaPreview');
    if (!text) { box.classList.add('hidden'); pendingParse = null; return; }
    var p = K.parseNatural(text);
    if (!p) {
      box.classList.remove('hidden');
      box.innerHTML = 'Hmm, aku tidak menemukan jumlah uangnya. Coba sertakan angka, misalnya <b>"jual kopi 15rb"</b>.';
      pendingParse = null;
      return;
    }
    pendingParse = p;
    var html = 'Terdeteksi: <span class="pv-amount">' + K.fmtRp(p.amount) + '</span> • ' +
      esc(p.category) + (p.person ? ' • 👤 ' + esc(p.person) : '') + ' • <i>"' + esc(p.note) + '"</i>';
    if (p.type) {
      html += '<br>Jenis: <b>' + typeLabel(p.type) + '</b>';
    } else {
      html += '<br>Ini uang masuk atau keluar?' +
        '<span class="pv-type-toggle">' +
        '<button data-pt="in">💵 Masuk</button><button data-pt="out">🛒 Keluar</button></span>';
    }
    box.classList.remove('hidden');
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-pt]'), function (b) {
      b.addEventListener('click', function () {
        pendingParse.type = b.getAttribute('data-pt');
        pendingParse.category = K.categorize(pendingParse.note.toLowerCase(), pendingParse.type);
        refreshPreviewSoft();
      });
    });
  }
  function refreshPreviewSoft() {
    // re-render preview text after a type toggle without losing the parsed draft
    var p = pendingParse;
    if (!p) return refreshPreview();
    $('qaPreview').innerHTML = 'Terdeteksi: <span class="pv-amount">' + K.fmtRp(p.amount) + '</span> • ' +
      esc(p.category) + (p.person ? ' • 👤 ' + esc(p.person) : '') + ' • <i>"' + esc(p.note) + '"</i>' +
      '<br>Jenis: <b>' + typeLabel(p.type) + '</b>';
  }

  function submitQuickAdd() {
    if (!pendingParse) { refreshPreview(); if (!pendingParse) { toast('Tulis jumlahnya dulu ya, contoh: "jual kopi 15rb".'); return; } }
    if (!pendingParse.type) { toast('Pilih dulu: ini uang masuk atau keluar.'); return; }
    var draft = pendingParse;
    if ((draft.type === 'debt' || draft.type === 'debtpay') && !draft.person) draft.person = 'Pelanggan';
    addTx(draft);
    $('qaInput').value = '';
    pendingParse = null;
    $('qaPreview').classList.add('hidden');
    toast('Tersimpan: ' + typeLabel(draft.type) + ' ' + K.fmtRp(draft.amount) + ' ✓');
  }

  /* ---------------- chat ---------------- */

  function appendMsg(text, who) {
    var log = $('chatLog');
    var div = document.createElement('div');
    div.className = 'msg ' + who;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  function askChat(text) {
    appendMsg(text, 'me');
    var answer = K.answerQuestion(text, state.txs, Date.now());
    setTimeout(function () { appendMsg(answer, 'bot'); }, 250);
  }
  function startChat() {
    if (chatStarted) return;
    chatStarted = true;
    var s = K.summarize(state.txs, Date.now());
    appendMsg('Halo Bu Sari! Aku KasKu 🤖 Saldo warung saat ini ' + K.fmtRp(s.balance) +
      ', dan ada piutang ' + K.fmtRp(s.receivables.total) + ' yang belum tertagih. ' +
      'Tanya apa saja soal keuangan warungmu — atau tap salah satu contoh di bawah.', 'bot');
  }

  /* ---------------- navigation & wiring ---------------- */

  function switchView(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) { v.classList.remove('active'); });
    $('view-' + name).classList.add('active');
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-view') === name);
    });
    if (name === 'home') renderHome();
    if (name === 'insights') renderInsights();
    if (name === 'chat') startChat();
    window.scrollTo(0, 0);
  }

  function renderAll() {
    renderHome();
    renderTx();
    if ($('view-insights').classList.contains('active')) renderInsights();
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { switchView(t.getAttribute('data-view')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
      b.addEventListener('click', function () { switchView(b.getAttribute('data-goto')); });
    });
    $('qaInput').addEventListener('input', refreshPreview);
    $('qaInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitQuickAdd(); } });
    $('qaAdd').addEventListener('click', submitQuickAdd);
    Array.prototype.forEach.call(document.querySelectorAll('.chip.ex'), function (ch) {
      ch.addEventListener('click', function () { $('qaInput').value = ch.textContent.trim(); refreshPreview(); $('qaInput').focus(); });
    });
    $('manualForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var amt = K.parseAmount($('mfAmount').value);
      if (!amt) { toast('Jumlahnya belum terbaca. Coba format "150rb" atau "150000".'); return; }
      var type = $('mfType').value;
      addTx({
        type: type, amount: amt.amount, category: $('mfCategory').value,
        note: $('mfNote').value.trim() || typeLabel(type),
        person: $('mfPerson').value.trim() || ((type === 'debt' || type === 'debtpay') ? 'Pelanggan' : null)
      });
      e.target.reset();
      toast('Transaksi manual tersimpan ✓');
    });
    Array.prototype.forEach.call(document.querySelectorAll('#txFilters .chip'), function (ch) {
      ch.addEventListener('click', function () {
        txFilter = ch.getAttribute('data-f');
        Array.prototype.forEach.call(document.querySelectorAll('#txFilters .chip'), function (c) { c.classList.remove('active'); });
        ch.classList.add('active');
        renderTx();
      });
    });
    $('chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = $('chatInput').value.trim();
      if (!v) return;
      $('chatInput').value = '';
      askChat(v);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.chip.q'), function (ch) {
      ch.addEventListener('click', function () { askChat(ch.textContent.trim()); });
    });
    $('resetBtn').addEventListener('click', function () {
      if (confirm('Muat ulang data demo dari awal? Transaksi yang kamu tambahkan akan hilang.')) {
        localStorage.removeItem(STORE_KEY);
        state = { txs: seedData() };
        save();
        renderAll();
        toast('Data demo dimuat ulang.');
      }
    });
    window.addEventListener('resize', function () {
      drawFlowChart();
      if ($('view-insights').classList.contains('active')) drawForecastChart();
    });
  }

  wire();
  renderAll();
})();
