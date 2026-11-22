/*
 * KasKu AI — core logic (pure functions, no DOM).
 * Works in the browser (window.KasKu) and in Node (module.exports) so the
 * parsing / forecasting / insight engine can be unit-tested headlessly.
 *
 * Transaction model:
 *   { id, ts, type, amount, category, note, person }
 *   type: 'in'      cash received (sales, other income)
 *         'out'     cash spent (stock, operations, transport, ...)
 *         'debt'    a customer bought on credit -> receivable, cash unchanged
 *         'debtpay' a customer settled a debt -> cash in, receivable reduced
 */
(function (global) {
  'use strict';

  var DAY_MS = 24 * 60 * 60 * 1000;
  var DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  /* ---------------- formatting & dates ---------------- */

  function fmtRp(n) {
    var neg = n < 0;
    var abs = Math.round(Math.abs(n));
    var s = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-Rp' : 'Rp') + s;
  }

  function fmtShort(n) {
    var abs = Math.abs(n);
    if (abs >= 1e6) return 'Rp' + trimNum(n / 1e6) + ' jt';
    if (abs >= 1e3) return 'Rp' + trimNum(n / 1e3) + ' rb';
    return fmtRp(n);
  }
  function trimNum(x) {
    return (Math.round(x * 10) / 10).toString().replace('.', ',');
  }

  function startOfDay(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function dayLabel(ts) {
    var d = new Date(ts);
    return DAY_NAMES[d.getDay()] + ', ' + d.getDate() + ' ' + MONTH_NAMES[d.getMonth()];
  }
  function dayShort(ts) {
    var d = new Date(ts);
    return d.getDate() + ' ' + MONTH_NAMES[d.getMonth()];
  }

  /* ---------------- amount parsing ---------------- */

  // Parses Indonesian money shorthands: "50rb", "50 ribu", "15k", "1,5jt",
  // "Rp50.000", "150.000", "75000". Returns { amount, rest } or null.
  function parseAmount(text) {
    var t = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
    var m;
    // juta: 1,5jt / 2 juta / 1.25jt
    m = t.match(/(\d+(?:[.,]\d+)?)\s*(jt|juta)\b/);
    if (m) return { amount: Math.round(parseFloat(m[1].replace(',', '.')) * 1e6), rest: clean(t.replace(m[0], ' ')) };
    // ribu: 50rb / 50 ribu / 15k
    m = t.match(/(\d+(?:[.,]\d+)?)\s*(rb|ribu|k)\b/);
    if (m) return { amount: Math.round(parseFloat(m[1].replace(',', '.')) * 1e3), rest: clean(t.replace(m[0], ' ')) };
    // Rp-prefixed or dot-grouped: Rp50.000 / 1.250.000
    m = t.match(/(?:rp\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d+)?)\b/);
    if (m) return { amount: Math.round(parseFloat(m[1].replace(/\./g, '').replace(',', '.'))), rest: clean(t.replace(m[0], ' ')) };
    // plain number >= 1000
    m = t.match(/\b(\d{4,})\b/);
    if (m) return { amount: parseInt(m[1], 10), rest: clean(t.replace(m[0], ' ')) };
    // small plain number (e.g. "kopi 5000" handled above; "gula 500" unlikely) -> accept >= 100
    m = t.match(/\b(\d{3})\b/);
    if (m) return { amount: parseInt(m[1], 10), rest: clean(t.replace(m[0], ' ')) };
    return null;
  }
  function clean(s) { return s.replace(/\s+/g, ' ').trim(); }

  /* ---------------- natural-language entry ---------------- */

  var STOCK_WORDS = ['beras', 'gula', 'kopi', 'teh', 'minyak', 'telur', 'tepung', 'mie', 'indomie',
    'rokok', 'susu', 'gas', 'elpiji', 'sabun', 'deterjen', 'shampo', 'sampo', 'ayam', 'daging',
    'sayur', 'cabai', 'bawang', 'garam', 'kecap', 'saus', 'roti', 'snack', 'jajanan', 'aqua',
    'galon', 'air mineral', 'plastik', 'kresek', 'stok', 'kulakan', 'belanja', 'bahan', 'sembako'];
  var OPS_WORDS = ['listrik', 'token', 'air', 'pdam', 'sewa', 'kontrak', 'gaji', 'upah', 'wifi',
    'internet', 'pulsa', 'paket data', 'iuran', 'retribusi', 'sampah', 'keamanan', 'servis', 'perbaikan'];
  var TRANSPORT_WORDS = ['bensin', 'solar', 'pertalite', 'pertamax', 'parkir', 'ojek', 'ongkir',
    'ongkos', 'tol', 'ban', 'oli', 'transport'];
  var IN_WORDS = ['jual', 'terjual', 'laku', 'penjualan', 'terima', 'dapat', 'pemasukan', 'masuk', 'cair', 'orderan', 'pesanan'];
  var OUT_WORDS = ['beli', 'belanja', 'bayar', 'keluar', 'ongkos', 'sewa', 'gaji', 'isi', 'top up',
    'topup', 'kulakan', 'pengeluaran', 'modal'];

  function hasWord(text, words) {
    for (var i = 0; i < words.length; i++) {
      if (text.indexOf(words[i]) !== -1) return words[i];
    }
    return null;
  }

  function categorize(text, type) {
    if (type === 'debt' || type === 'debtpay') return 'Piutang';
    if (hasWord(text, STOCK_WORDS)) return 'Stok & Bahan';
    if (hasWord(text, OPS_WORDS)) return 'Operasional';
    if (hasWord(text, TRANSPORT_WORDS)) return 'Transport';
    if (type === 'in') return 'Penjualan';
    return 'Lainnya';
  }

  // Extract a person's name around "utang": "Budi utang 50rb" / "utang Budi 50rb"
  // / "Budi bayar utang 50rb".
  function extractPerson(original) {
    var stop = ['saya', 'dia', 'toko', 'warung', 'kas', 'uang', 'hari', 'kemarin',
      'bayar', 'lunas', 'cicil', 'pelunasan', 'punya', 'masih', 'utang', 'sudah', 'belum'];
    function ok(name) {
      if (!name || stop.indexOf(name.toLowerCase()) !== -1) return null;
      return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }
    var m = original.match(/utang\s+(?:ke\s+|kepada\s+)?([A-Za-z]{3,})/i);
    if (m && ok(m[1])) return ok(m[1]);
    m = original.match(/([A-Za-z]{3,})\s+utang/i);
    if (m && ok(m[1])) return ok(m[1]);
    m = original.match(/^\s*([A-Za-z]{3,})\b/); // sentence-initial name: "Budi bayar utang ..."
    if (m && ok(m[1])) return ok(m[1]);
    return null;
  }

  // parseNatural("jual kopi 15rb") ->
  //   { amount:15000, type:'in', category:'Stok & Bahan', note:'jual kopi', person:null, kind:'tx' }
  // Returns null when no amount can be found.
  function parseNatural(text) {
    var amt = parseAmount(text);
    if (!amt) return null;
    var low = text.toLowerCase();
    var person = extractPerson(text);
    var isDebtWord = /\butang\b/.test(low);
    var isPayWord = /(bayar|lunas|pelunasan|cicil)/.test(low);

    if (isDebtWord && isPayWord) {
      return { amount: amt.amount, type: 'debtpay', category: 'Piutang', note: clean(text), person: person, kind: 'tx' };
    }
    if (isDebtWord) {
      return { amount: amt.amount, type: 'debt', category: 'Piutang', note: clean(text), person: person, kind: 'tx' };
    }
    var type = null;
    if (hasWord(low, IN_WORDS)) type = 'in';
    else if (hasWord(low, OUT_WORDS)) type = 'out';
    else if (hasWord(low, STOCK_WORDS)) type = 'out'; // "beras 50rb" most likely a purchase
    return {
      amount: amt.amount,
      type: type, // may be null -> UI asks the user
      category: categorize(low, type),
      note: clean(text),
      person: null,
      kind: 'tx'
    };
  }

  /* ---------------- summaries ---------------- */

  function isCashIn(tx) { return tx.type === 'in' || tx.type === 'debtpay'; }
  function isCashOut(tx) { return tx.type === 'out'; }

  function sumRange(txs, from, to) {
    var inn = 0, out = 0;
    txs.forEach(function (tx) {
      if (tx.ts >= from && tx.ts < to) {
        if (isCashIn(tx)) inn += tx.amount;
        else if (isCashOut(tx)) out += tx.amount;
      }
    });
    return { in: inn, out: out, net: inn - out };
  }

  function receivables(txs) {
    var per = {};
    txs.forEach(function (tx) {
      if (!tx.person) return;
      if (tx.type === 'debt') per[tx.person] = (per[tx.person] || 0) + tx.amount;
      if (tx.type === 'debtpay') per[tx.person] = (per[tx.person] || 0) - tx.amount;
    });
    var list = Object.keys(per)
      .filter(function (k) { return per[k] > 0; })
      .map(function (k) { return { person: k, amount: per[k] }; })
      .sort(function (a, b) { return b.amount - a.amount; });
    var total = list.reduce(function (s, r) { return s + r.amount; }, 0);
    return { list: list, total: total };
  }

  function summarize(txs, now) {
    var today = startOfDay(now);
    var balance = 0;
    txs.forEach(function (tx) {
      if (isCashIn(tx)) balance += tx.amount;
      else if (isCashOut(tx)) balance -= tx.amount;
    });
    // daily series, oldest -> newest, 14 days ending today
    var series = [];
    for (var i = 13; i >= 0; i--) {
      var from = today - i * DAY_MS;
      var r = sumRange(txs, from, from + DAY_MS);
      series.push({ ts: from, in: r.in, out: r.out, net: r.net });
    }
    var week = sumRange(txs, today - 6 * DAY_MS, today + DAY_MS);
    var prevWeek = sumRange(txs, today - 13 * DAY_MS, today - 6 * DAY_MS);
    var todaySum = sumRange(txs, today, today + DAY_MS);
    // expense by category (last 30 days)
    var byCat = {};
    txs.forEach(function (tx) {
      if (isCashOut(tx) && tx.ts >= now - 30 * DAY_MS) {
        byCat[tx.category] = (byCat[tx.category] || 0) + tx.amount;
      }
    });
    var catList = Object.keys(byCat).map(function (k) { return { category: k, amount: byCat[k] }; })
      .sort(function (a, b) { return b.amount - a.amount; });
    var biggest = null;
    txs.forEach(function (tx) {
      if (isCashOut(tx) && tx.ts >= now - 30 * DAY_MS && (!biggest || tx.amount > biggest.amount)) biggest = tx;
    });
    // best weekday for sales over the series
    var byDow = {};
    series.forEach(function (d) {
      var dow = new Date(d.ts).getDay();
      byDow[dow] = byDow[dow] || { inSum: 0, days: 0 };
      byDow[dow].inSum += d.in; byDow[dow].days += 1;
    });
    var bestDow = null;
    Object.keys(byDow).forEach(function (k) {
      var avg = byDow[k].inSum / Math.max(1, byDow[k].days);
      if (!bestDow || avg > bestDow.avg) bestDow = { dow: +k, name: DAY_NAMES[+k], avg: avg };
    });
    return {
      balance: balance,
      today: todaySum,
      week: week,
      prevWeek: prevWeek,
      series: series,
      byCategory: catList,
      biggestExpense: biggest,
      bestDow: bestDow,
      receivables: receivables(txs)
    };
  }

  /* ---------------- forecast ---------------- */

  // Projects the cash balance `days` ahead from the recent daily net trend
  // (least-squares over the last 14 days of daily net, damped toward the
  // 7-day mean so one wild day does not dominate).
  function forecast(txs, now, days) {
    days = days || 7;
    var s = summarize(txs, now);
    var nets = s.series.map(function (d) { return d.net; });
    var n = nets.length;
    var mean = nets.reduce(function (a, b) { return a + b; }, 0) / n;
    var xMean = (n - 1) / 2, num = 0, den = 0;
    nets.forEach(function (y, x) { num += (x - xMean) * (y - mean); den += (x - xMean) * (x - xMean); });
    var slope = den ? num / den : 0;
    var last7 = nets.slice(-7).reduce(function (a, b) { return a + b; }, 0) / 7;
    var dailyNet = 0.6 * last7 + 0.4 * (mean + slope * (n - xMean)); // blended, trend-aware
    var points = [{ ts: startOfDay(now), balance: s.balance }];
    var bal = s.balance;
    for (var i = 1; i <= days; i++) {
      bal += dailyNet;
      points.push({ ts: startOfDay(now) + i * DAY_MS, balance: Math.round(bal) });
    }
    var runway = null;
    if (dailyNet < 0 && s.balance > 0) runway = Math.floor(s.balance / Math.abs(dailyNet));
    if (dailyNet < 0 && s.balance <= 0) runway = 0;
    return {
      points: points,
      avgDailyNet: Math.round(dailyNet),
      endBalance: points[points.length - 1].balance,
      runwayDays: runway,
      balanceNow: s.balance
    };
  }

  /* ---------------- insights ---------------- */

  function pctChange(cur, prev) {
    if (!prev) return null;
    return Math.round(((cur - prev) / prev) * 100);
  }

  function genInsights(txs, now) {
    var out = [];
    if (!txs.length) return out;
    var s = summarize(txs, now);
    var f = forecast(txs, now, 7);

    // 1) Runway danger first — the most actionable signal.
    if (f.runwayDays !== null && f.runwayDays <= 10) {
      out.push({
        tone: 'bad', icon: '⚠️', title: 'Kas bisa habis dalam ' + f.runwayDays + ' hari',
        body: 'Dengan pola 14 hari terakhir (rata-rata ' + fmtRp(Math.abs(f.avgDailyNet)) + ' keluar per hari), saldo ' +
          fmtRp(s.balance) + ' diperkirakan habis sekitar ' + f.runwayDays + ' hari lagi. Kurangi belanja stok yang tidak mendesak dan percepat penagihan piutang.'
      });
    }
    // 2) Receivables waiting to be collected.
    if (s.receivables.total > 0) {
      var names = s.receivables.list.slice(0, 3).map(function (r) { return r.person + ' ' + fmtShort(r.amount); }).join(', ');
      out.push({
        tone: 'warn', icon: '🧾', title: 'Piutang belum tertagih ' + fmtRp(s.receivables.total),
        body: 'Terbesar: ' + names + '. Menagih piutang adalah cara tercepat menambah kas tanpa menjual apa pun. Coba kirim pengingat halus hari ini.'
      });
    }
    // 3) Week-over-week sales movement.
    var chg = pctChange(s.week.in, s.prevWeek.in);
    if (chg !== null && Math.abs(chg) >= 5) {
      out.push({
        tone: chg >= 0 ? 'good' : 'warn', icon: chg >= 0 ? '📈' : '📉',
        title: 'Penjualan minggu ini ' + (chg >= 0 ? 'naik ' : 'turun ') + Math.abs(chg) + '%',
        body: 'Pemasukan 7 hari terakhir ' + fmtRp(s.week.in) + ', dibanding ' + fmtRp(s.prevWeek.in) + ' pada 7 hari sebelumnya. ' +
          (chg >= 0 ? 'Pertahankan pola hari-hari ramai dan siapkan stok sebelum hari tersibukmu.'
                    : 'Cek apakah ada hari yang kosong transaksi — sering kali penyebabnya stok habis atau warung tutup lebih awal.')
      });
    }
    // 4) Biggest expense category.
    if (s.byCategory.length) {
      var top = s.byCategory[0];
      var totalOut = s.byCategory.reduce(function (a, c) { return a + c.amount; }, 0);
      var share = totalOut ? Math.round((top.amount / totalOut) * 100) : 0;
      if (share >= 35) {
        out.push({
          tone: 'info', icon: '🔍', title: top.category + ' menyerap ' + share + '% pengeluaran',
          body: 'Total ' + fmtRp(top.amount) + ' dalam 30 hari terakhir. ' +
            (top.category === 'Stok & Bahan'
              ? 'Bandingkan harga di 2–3 grosir dan beli ukuran besar untuk item yang paling cepat habis — selisih kecil per item terasa besar di akhir bulan.'
              : 'Tinjau pos ini satu per satu; biasanya ada 1–2 pengeluaran rutin yang bisa dinego atau dijadwalkan ulang.')
        });
      }
    }
    // 5) Best sales weekday.
    if (s.bestDow && s.bestDow.avg > 0) {
      out.push({
        tone: 'good', icon: '🗓️', title: 'Hari ' + s.bestDow.name + ' adalah hari terbaikmu',
        body: 'Rata-rata pemasukan hari ' + s.bestDow.name + ' mencapai ' + fmtRp(Math.round(s.bestDow.avg)) + '. Pastikan stok dan jam buka maksimal di hari itu.'
      });
    }
    // 6) Positive streak -> savings suggestion.
    if (f.avgDailyNet > 0 && f.runwayDays === null) {
      var save = Math.round(f.avgDailyNet * 0.1);
      out.push({
        tone: 'good', icon: '💰', title: 'Arus kas sehat — sisihkan sedikit tiap hari',
        body: 'Rata-rata kas bertambah ' + fmtRp(f.avgDailyNet) + ' per hari. Menyisihkan 10% saja (' + fmtShort(save) + '/hari) menjadi dana darurat ' + fmtShort(save * 30) + ' dalam sebulan, tanpa terasa.'
      });
    }
    return out.slice(0, 5);
  }

  /* ---------------- chat brain ("Tanya KasKu") ---------------- */

  function answerQuestion(q, txs, now) {
    var low = ' ' + q.toLowerCase() + ' ';
    var s = summarize(txs, now);
    var f = forecast(txs, now, 7);

    if (/(halo|hai|hei|pagi|siang|malam|hello)/.test(low)) {
      return 'Halo! Aku KasKu, asisten arus kas warungmu. Saldo saat ini ' + fmtRp(s.balance) +
        '. Tanya saja, misalnya "berapa pemasukan minggu ini?" atau "kapan kas saya habis?".';
    }
    if (/(saldo|kas sekarang|uang sekarang|sisa kas|sisa uang)/.test(low)) {
      return 'Saldo kas saat ini ' + fmtRp(s.balance) + '. Hari ini masuk ' + fmtRp(s.today.in) +
        ' dan keluar ' + fmtRp(s.today.out) + '.';
    }
    if (/(prediksi|ramalan|forecast|minggu depan|7 hari ke depan|tujuh hari)/.test(low)) {
      return 'Prediksi 7 hari ke depan: dengan tren saat ini (rata-rata ' +
        (f.avgDailyNet >= 0 ? '+' : '') + fmtRp(f.avgDailyNet) + '/hari), saldo diperkirakan menjadi ' +
        fmtRp(f.endBalance) + ' pada ' + dayLabel(f.points[f.points.length - 1].ts) + '. Lihat grafiknya di tab Wawasan.';
    }
    if (/(kapan.*habis|bertahan berapa|runway|kas habis|uang habis)/.test(low)) {
      if (f.runwayDays === null) {
        return 'Kabar baik: dengan tren 14 hari terakhir kasmu justru bertambah rata-rata ' + fmtRp(f.avgDailyNet) +
          ' per hari, jadi tidak ada tanda kas akan habis dalam waktu dekat.';
      }
      return 'Hati-hati: dengan pola belanja dan penjualan 14 hari terakhir, kas ' + fmtRp(s.balance) +
        ' bisa habis dalam sekitar ' + f.runwayDays + ' hari. Kurangi pengeluaran stok non-mendesak dan tagih piutang yang sudah jatuh tempo.';
    }
    if (/(piutang|utang|siapa.*ngutang|belum bayar)/.test(low)) {
      if (!s.receivables.total) return 'Tidak ada piutang yang belum lunas. Semua pelanggan sudah bayar — bagus!';
      var lines = s.receivables.list.map(function (r) { return '• ' + r.person + ': ' + fmtRp(r.amount); }).join('\n');
      return 'Total piutang belum tertagih ' + fmtRp(s.receivables.total) + ':\n' + lines;
    }
    if (/(pengeluaran terbesar|belanja terbesar|paling boros|pengeluaran.*banyak)/.test(low)) {
      if (!s.biggestExpense) return 'Belum ada pengeluaran yang tercatat dalam 30 hari terakhir.';
      var b = s.biggestExpense;
      return 'Pengeluaran terbesar 30 hari terakhir: ' + fmtRp(b.amount) + ' untuk "' + b.note +
        '" (' + b.category + ', ' + dayLabel(b.ts) + '). Kategori pengeluaran terbesarmu: ' +
        (s.byCategory[0] ? s.byCategory[0].category + ' ' + fmtRp(s.byCategory[0].amount) : '-') + '.';
    }
    if (/(pemasukan|penjualan|omzet|omset)/.test(low)) {
      if (/(hari ini)/.test(low)) return 'Pemasukan hari ini ' + fmtRp(s.today.in) + ' (pengeluaran ' + fmtRp(s.today.out) + ').';
      if (/(kemarin)/.test(low)) {
        var y = sumRange(txs, startOfDay(now) - DAY_MS, startOfDay(now));
        return 'Pemasukan kemarin ' + fmtRp(y.in) + ' (pengeluaran ' + fmtRp(y.out) + ').';
      }
      var chg = pctChange(s.week.in, s.prevWeek.in);
      return 'Pemasukan 7 hari terakhir ' + fmtRp(s.week.in) + ', pengeluaran ' + fmtRp(s.week.out) +
        ' (bersih ' + fmtRp(s.week.net) + ').' +
        (chg !== null ? ' Dibanding minggu sebelumnya, penjualan ' + (chg >= 0 ? 'naik ' : 'turun ') + Math.abs(chg) + '%.' : '');
    }
    if (/(pengeluaran|belanja)/.test(low)) {
      return 'Pengeluaran 7 hari terakhir ' + fmtRp(s.week.out) + '. Terbesar di kategori ' +
        (s.byCategory[0] ? s.byCategory[0].category + ' (' + fmtRp(s.byCategory[0].amount) + ' dalam 30 hari)' : '-') + '.';
    }
    if (/(hari terbaik|hari.*ramai|kapan.*ramai|hari.*laku)/.test(low)) {
      if (!s.bestDow) return 'Belum cukup data untuk melihat pola hari. Catat transaksi beberapa hari lagi ya.';
      return 'Hari dengan penjualan rata-rata tertinggi adalah ' + s.bestDow.name + ' (' +
        fmtRp(Math.round(s.bestDow.avg)) + '/hari). Siapkan stok ekstra menjelang hari itu.';
    }
    if (/(saran|tips|hemat|nasihat|gimana|bagaimana)/.test(low)) {
      var ins = genInsights(txs, now);
      if (!ins.length) return 'Catat dulu beberapa transaksi, nanti aku bisa memberi saran yang spesifik untuk warungmu.';
      return 'Saranku berdasarkan datamu:\n' + ins.slice(0, 3).map(function (i) { return i.icon + ' ' + i.title + ' — ' + i.body; }).join('\n');
    }
    if (/(stok)/.test(low)) {
      var stok = s.byCategory.filter(function (c) { return c.category === 'Stok & Bahan'; })[0];
      return 'Belanja stok & bahan 30 hari terakhir total ' + fmtRp(stok ? stok.amount : 0) +
        '. Hari penjualan terbaikmu ' + (s.bestDow ? s.bestDow.name : '-') + ' — idealnya kulakan 1 hari sebelumnya supaya tidak kehabisan saat ramai.';
    }
    if (/(bisa apa|fitur|bantuan|help|tolong|menu)/.test(low)) {
      return 'Aku bisa menjawab soal: saldo kas, pemasukan/pengeluaran (hari ini, kemarin, minggu ini), prediksi kas 7 hari, kapan kas habis, daftar piutang, pengeluaran terbesar, hari penjualan terbaik, dan saran hemat. Coba tanya salah satu ya.';
    }
    if (/(terima kasih|makasih|thanks)/.test(low)) {
      return 'Sama-sama! Semoga warungnya makin laris. Jangan lupa catat transaksi hari ini ya — datanya bikin saranku makin akurat.';
    }
    return 'Aku belum paham pertanyaan itu, tapi aku jago soal angka warungmu. Coba tanya: "berapa saldo saya?", "pemasukan minggu ini?", "kapan kas habis?", atau "siapa saja yang masih punya utang?".';
  }

  var api = {
    fmtRp: fmtRp, fmtShort: fmtShort, dayLabel: dayLabel, dayShort: dayShort,
    startOfDay: startOfDay, DAY_MS: DAY_MS, DAY_NAMES: DAY_NAMES,
    parseAmount: parseAmount, parseNatural: parseNatural, categorize: categorize,
    summarize: summarize, forecast: forecast, genInsights: genInsights,
    receivables: receivables, answerQuestion: answerQuestion, sumRange: sumRange
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.KasKu = api;
})(typeof window !== 'undefined' ? window : globalThis);
