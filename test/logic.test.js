'use strict';
const K = require('../logic.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log('FAIL', name, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); }
}
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('FAIL', name, extra || ''); } }

// --- parseAmount ---
eq('50rb', K.parseAmount('jual kopi 50rb').amount, 50000);
eq('50 ribu', K.parseAmount('bayar listrik 50 ribu').amount, 50000);
eq('15k', K.parseAmount('bensin 15k').amount, 15000);
eq('1,5jt', K.parseAmount('kulakan 1,5jt').amount, 1500000);
eq('2 juta', K.parseAmount('modal 2 juta').amount, 2000000);
eq('Rp50.000', K.parseAmount('Rp50.000').amount, 50000);
eq('150.000', K.parseAmount('beli beras 150.000').amount, 150000);
eq('75000', K.parseAmount('gula 75000').amount, 75000);
eq('no amount', K.parseAmount('jual kopi'), null);

// --- parseNatural ---
let p = K.parseNatural('jual kopi 15rb');
eq('jual type', p.type, 'in'); eq('jual amount', p.amount, 15000);
p = K.parseNatural('beli beras 25kg 460 ribu');
eq('beli type', p.type, 'out'); eq('beli amount', p.amount, 460000); eq('beli cat', p.category, 'Stok & Bahan');
p = K.parseNatural('bayar listrik 200rb');
eq('listrik type', p.type, 'out'); eq('listrik cat', p.category, 'Operasional');
p = K.parseNatural('Budi utang 50rb');
eq('utang type', p.type, 'debt'); eq('utang person', p.person, 'Budi'); eq('utang amount', p.amount, 50000);
p = K.parseNatural('Budi bayar utang 50rb');
eq('bayar utang type', p.type, 'debtpay'); eq('bayar utang person', p.person, 'Budi');
p = K.parseNatural('isi bensin pertalite 30rb');
eq('bensin cat', p.category, 'Transport');
p = K.parseNatural('penjualan hari ini 350rb');
eq('penjualan type', p.type, 'in'); eq('penjualan cat', p.category, 'Penjualan');
p = K.parseNatural('sesuatu tanpa angka');
eq('no amount natural', p, null);

// --- ledger math on synthetic data ---
const now = Date.now();
const D = K.DAY_MS;
function tx(daysAgo, type, amount, category, note, person) {
  return { id: Math.random() + '', ts: K.startOfDay(now) - daysAgo * D + 3600e3, type, amount, category: category || 'Penjualan', note: note || '', person: person || null };
}
const txs = [];
for (let i = 13; i >= 0; i--) {
  txs.push(tx(i, 'in', 300000 + (i % 3) * 50000, 'Penjualan', 'penjualan harian'));
  txs.push(tx(i, 'out', 180000, 'Stok & Bahan', 'kulakan'));
}
txs.push(tx(2, 'debt', 75000, 'Piutang', 'Budi utang', 'Budi'));
txs.push(tx(1, 'debt', 40000, 'Piutang', 'Sari utang', 'Sari'));
txs.push(tx(0, 'debtpay', 75000, 'Piutang', 'Budi bayar utang', 'Budi'));

const s = K.summarize(txs, now);
eq('receivable total', s.receivables.total, 40000);
eq('receivable person', s.receivables.list[0].person, 'Sari');
// balance = 14*(300k..400k in) - 14*180k out + 75k debtpay
const expectedIn = txs.filter(t => t.type === 'in').reduce((a, t) => a + t.amount, 0);
eq('balance', s.balance, expectedIn - 14 * 180000 + 75000);
eq('series len', s.series.length, 14);
ok('today in > 0', s.today.in > 0);

const f = K.forecast(txs, now, 7);
eq('forecast points', f.points.length, 8);
ok('forecast end > now (positive trend)', f.endBalance > f.balanceNow, JSON.stringify(f));
eq('runway null when healthy', f.runwayDays, null);

// declining business -> runway appears
const bad = [];
for (let i = 13; i >= 0; i--) { bad.push(tx(i, 'in', 100000, 'Penjualan', 'jual')); bad.push(tx(i, 'out', 300000, 'Stok & Bahan', 'beli')); }
const fb = K.forecast(bad, now, 7);
ok('runway finite when bleeding', fb.runwayDays !== null && fb.runwayDays >= 0, JSON.stringify(fb));

const ins = K.genInsights(txs, now);
ok('insights >= 2', ins.length >= 2, 'got ' + ins.length);
ok('insights mention piutang', ins.some(i => /Piutang/.test(i.title)), JSON.stringify(ins.map(i => i.title)));

const a1 = K.answerQuestion('berapa saldo saya?', txs, now);
ok('chat saldo', /Saldo kas saat ini Rp/.test(a1), a1);
const a2 = K.answerQuestion('siapa saja yang masih punya utang?', txs, now);
ok('chat piutang lists Sari', /Sari/.test(a2), a2);
const a3 = K.answerQuestion('kapan kas saya habis?', txs, now);
ok('chat runway healthy', /bertambah/.test(a3), a3);
const a4 = K.answerQuestion('pemasukan minggu ini berapa?', txs, now);
ok('chat pemasukan', /Pemasukan 7 hari terakhir Rp/.test(a4), a4);
const a5 = K.answerQuestion('halo', txs, now);
ok('chat halo', /Halo!/.test(a5), a5);

eq('fmtRp', K.fmtRp(1500000), 'Rp1.500.000');
eq('fmtRp neg', K.fmtRp(-25000), '-Rp25.000');
eq('fmtShort jt', K.fmtShort(1500000), 'Rp1,5 jt');
eq('fmtShort rb', K.fmtShort(75000), 'Rp75 rb');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
