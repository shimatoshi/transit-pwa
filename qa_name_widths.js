#!/usr/bin/env node
/* qa_names.js — 駅名の表記ゆれ(全角/半角・カナ)と英字名の欠落を数える。
 *
 * searchStations()/findAllByName() は s.n / s.e に対して素の includes / === を
 * 使うだけなので、データ側が全角数字なら利用者が半角で打った瞬間に引けなくなる。
 * (例: 羽田空港第１・第２ターミナル ← "羽田空港第2ターミナル" では0件)
 */
'use strict';
const fs = require('fs');
const g = JSON.parse(fs.readFileSync(__dirname + '/graph_v2.json', 'utf8'));
const S = g.stations;

const FW_DIGIT = /[０-９]/, FW_LATIN = /[Ａ-Ｚａ-ｚ]/, KATA = /[ァ-ヶー]/, HIRA = /[ぁ-ん]/;

const rail = S.filter(s => !s.m), bus = S.filter(s => s.m);
console.log(`駅・停留所 計${S.length} (鉄道${rail.length} / バス${bus.length})`);

const fwd = S.filter(s => FW_DIGIT.test(s.n));
const fwl = S.filter(s => FW_LATIN.test(s.n));
console.log(`\n=== 全角数字を含む名前: ${fwd.length} (鉄道${fwd.filter(s => !s.m).length}) ===`);
fwd.filter(s => !s.m).slice(0, 40).forEach(s => console.log(`  ${s.n}`));
console.log(`\n=== 全角ラテン字を含む名前: ${fwl.length} (鉄道${fwl.filter(s => !s.m).length}) ===`);
const byPrefix = new Map();
fwl.filter(s => !s.m).forEach(s => {
  const mm = s.n.match(/[Ａ-Ｚａ-ｚ]+/g) || [];
  mm.forEach(x => byPrefix.set(x, (byPrefix.get(x) || 0) + 1));
});
[...byPrefix].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, v]) => console.log(`  "${k}" ×${v}`));

// 英字名(s.e)の埋まり具合
const noEn = S.filter(s => !s.e);
console.log(`\n=== 英字名(e)が無い: ${noEn.length} / ${S.length} (鉄道 ${noEn.filter(s => !s.m).length}/${rail.length}) ===`);
console.log('  鉄道の例: ' + noEn.filter(s => !s.m).slice(0, 25).map(s => s.n).join(' '));

// 正規化したら初めて一致するペア(= 表記ゆれで別駅に見えているもの)
const norm = s => s
  .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[ぁ-ん]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
  .replace(/[・･\s'’ｰー―‐-]/g, '')
  .toLowerCase();
const byNorm = new Map();
S.forEach((s, i) => {
  const k = norm(s.n.replace(/[（(].*?[）)]/g, ''));
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k).push(i);
});
let variant = 0;
const samples = [];
for (const [, ids] of byNorm) {
  const raw = new Set(ids.map(i => S[i].n.replace(/[（(].*?[）)]/g, '')));
  if (raw.size > 1) { variant++; if (samples.length < 20) samples.push([...raw].join(' ≡ ')); }
}
console.log(`\n=== 正規化して初めて同一と分かる表記ゆれ: ${variant}組 ===`);
samples.forEach(x => console.log('  ' + x));

// 利用者が打ちそうな半角表記で実際に引けるか
console.log('\n=== 素の includes で引けるか(利用者入力の想定) ===');
const QUERIES = ['羽田空港第2ターミナル', '羽田空港第1ターミナル', '羽田空港第3ターミナル',
  '空港第2ビル', '札幌(JR)', 'JR淡路', 'ＪＲ淡路', '西大寺', 'とうきょうスカイツリー'];
for (const q of QUERIES) {
  const hitN = S.filter(s => s.n.includes(q)).length;
  const hitNorm = S.filter(s => norm(s.n).includes(norm(q))).length;
  console.log(`  "${q}"  素=${hitN}件  正規化=${hitNorm}件 ${hitN === 0 && hitNorm > 0 ? '  ← 正規化しないと引けない' : ''}`);
  if (hitN === 0 && hitNorm > 0) {
    console.log('       ' + S.filter(s => norm(s.n).includes(norm(q))).slice(0, 4).map(s => s.n).join(' / '));
  }
}
