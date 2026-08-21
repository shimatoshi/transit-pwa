// のりば付与のカバレッジQA。主要駅間の実経路を検索し、
// 乗車/降車ホームがどの程度付与されるかを集計する。
// 実行: node qa_platforms.js
const fs = require('fs');
const RouterV3 = require('./router_v3.js');

const g = JSON.parse(fs.readFileSync('graph_v2.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('trains_v3_meta.json', 'utf8'));
const fares = JSON.parse(fs.readFileSync('fares.json', 'utf8'));
const buf = fs.readFileSync('trains_v3.bin');
RouterV3.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, g.stations, fares);
const platforms = JSON.parse(fs.readFileSync('platforms.json', 'utf8'));

const rid = n => g.stations.findIndex(s => !s.m && s.n === n);
const name = i => g.stations[i].n;

const ODS = [
  ['新宿', '渋谷'], ['新宿', '東京'], ['東京', '品川'], ['渋谷', '横浜'],
  ['池袋', '上野'], ['新宿', '横浜'], ['東京', '大宮(埼玉)'], ['新宿', '立川'],
  ['新宿', '町田'], ['渋谷', '吉祥寺'], ['上野', '柏'], ['東京', '千葉'],
  ['東京', '新大阪'], ['東京', '仙台'], ['大阪', '京都'], ['大阪', '三ノ宮'],
  ['名古屋', '岐阜'], ['札幌', '小樽'], ['博多', '小倉(福岡)'], ['新宿', '八王子'],
  ['東京', '成田空港'], ['品川', '羽田空港第１・第２ターミナル'], ['池袋', '川越'], ['北千住', '大手町(東京)'],
];

let rideLegs = 0, withDep = 0, withArr = 0, either = 0;
const samples = [];
for (const [a, b] of ODS) {
  const ia = rid(a), ib = rid(b);
  if (ia < 0 || ib < 0) { console.log(`SKIP ${a}→${b} (駅が見つからない: ${ia < 0 ? a : b})`); continue; }
  for (const at of [480, 600, 840]) {
    const js = RouterV3.findJourneys(ia, ib, at, { day: 0 });
    for (const j of js.slice(0, 2)) {
      RouterV3.attachPlatforms(j, platforms);
      for (const l of j.legs) {
        if (l.kind !== 'ride' || l.mode === 1) continue;
        rideLegs++;
        if (l.depPlat) withDep++;
        if (l.arrPlat) withArr++;
        if (l.depPlat || l.arrPlat) either++;
        if (samples.length < 40 && (l.depPlat || l.arrPlat)) {
          samples.push(`${name(l.from)}${l.depPlat ? `[${l.depPlat}番線発]` : ''} →(${(l.lineLabel || l.line)}/${l.type || ''})→ ${name(l.to)}${l.arrPlat ? `[${l.arrPlat}番線着]` : ''}`);
        }
      }
    }
  }
}
console.log(`\n乗車leg総数: ${rideLegs}`);
console.log(`乗車ホーム付与: ${withDep} (${(withDep / rideLegs * 100).toFixed(0)}%)`);
console.log(`降車ホーム付与: ${withArr} (${(withArr / rideLegs * 100).toFixed(0)}%)`);
console.log(`どちらか付与: ${either} (${(either / rideLegs * 100).toFixed(0)}%)`);
console.log('\n--- サンプル ---');
for (const s of new Set(samples)) console.log(' ', s);

// データ全体の統計
const nSt = Object.keys(platforms).length;
const nEnt = Object.values(platforms).reduce((a, v) => a + v.length, 0);
const bytes = fs.statSync('platforms.json').size;
console.log(`\nplatforms.json: ${nSt}駅 / ${nEnt}エントリ / ${(bytes / 1024).toFixed(0)}KB`);
