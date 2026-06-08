#!/usr/bin/env node
/* verify_fares.js — 運賃の実測アンカー照合
 * 各アンカー: [出発, 到着, 期待会社(主区間), 実IC運賃, 実営業キロ(主区間)]
 * 期待会社が主区間のジャーニーを探して運賃と距離を比較する。
 * 実運賃は各社公式の現行テーブル(2026-06時点)×実営業キロから算出した確定値。
 */
'use strict';
const fs = require('fs');
const R = require('./router_v3.js');

const graph = JSON.parse(fs.readFileSync('graph_v2.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('trains_v3_meta.json', 'utf8'));
const fares = JSON.parse(fs.readFileSync('fares.json', 'utf8'));
const buf = fs.readFileSync('trains_v3.bin');
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, graph.stations, fares);

const id = n => {
  const strip = s => s.replace(/[（(].*?[）)]/g, '');
  let i = graph.stations.findIndex(s => s.n === n);
  if (i < 0) i = graph.stations.findIndex(s => strip(s.n) === strip(n));
  return i;
};

// [from, to, mainCompany, realIC, realKm]
const ANCHORS = [
  ['上野', '日暮里', 'JR東日本', 155, 2.2],
  ['柏', '東京', 'JR東日本', 616, 32.7],
  ['渋谷', '吉祥寺', 'JR東日本', 253, 15.6],     // 渋谷-新宿-吉祥寺 実乗車キロ
  ['東京', '横浜', 'JR東日本', 528, 28.8],
  ['北千住', 'つくば', 'つくばエクスプレス', 1123, 50.9],
  ['秋葉原', '北千住', 'つくばエクスプレス', 320, 7.4],
  ['渋谷', '横浜', '東急', 309, 24.2],
  ['渋谷', '自由が丘(東京)', '東急', 180, 7.0],
  ['品川', '横浜', '京急', 347, 22.2],
  ['品川', '羽田空港第１・第２ターミナル(京急)', '京急', 327, 14.5], // +50込
  ['池袋', '所沢', '西武', 402, 24.8],
  ['新宿', '町田', '小田急', 387, 30.8],
  ['新宿', '京王八王子', '京王', 409, 37.9],
  ['中目黒', '北千住', '東京メトロ', 293, 20.3],
  ['池袋', '大手町(東京)', '東京メトロ', 209, 6.5],
  ['浜松町', '羽田空港第２ターミナル(東京モノレール)', '東京モノレール', 519, 17.8],
  ['横浜', '元町・中華街', 'みなとみらい線', 224, 4.1],
  ['大宮(埼玉)', '柏', '東武', 607, 42.9],       // 東武野田線(41-45km帯)
  ['船橋', '京成上野', '京成', 387, 22.1],
  ['日暮里', '成田空港', '京成スカイアクセス', 1235, 64.1],
  ['押上', '成田空港', '京成スカイアクセス', 1162, 60.5],
  ['お台場海浜公園', '豊洲', 'ゆりかもめ', 325, 8.6],
  ['天王洲アイル', '新木場', 'りんかい線', 335, 7.7],
  ['横浜', 'あざみ野', '横浜市営地下鉄', 367, 19.7], // ブルーライン(20-23km帯=367)
  // ===== 関西以西 (実IC運賃、2025-2026各社現行) =====
  ['大阪', '京都', 'JR西日本', 580, 42.8],        // 特定運賃
  ['大阪', '三ノ宮', 'JR西日本', 420, 30.6],       // 特定運賃
  ['大阪', '姫路', 'JR西日本', 1460, 87.9],        // 特定運賃
  ['大阪', '宝塚', 'JR西日本', 340, 25.5],         // 特定運賃
  ['天王寺', '和歌山', 'JR西日本', 900, 61.3],      // 特定運賃
  ['三ノ宮', '姫路', 'JR西日本', 970, 54.8],       // 電特対キロ
  ['大阪難波', '近鉄奈良', '近鉄', 680, 32.8],
  ['淀屋橋', '出町柳', '京阪', 550, 51.6],         // 鴨東線加算で-60既知
  ['大阪梅田', '神戸三宮', '阪急', 330, 32.3],
  ['難波', '関西空港', '南海', 926, 42.8],         // +空港加算
  ['名鉄名古屋', '金山', '名鉄', 210, 3.3],
  ['西鉄福岡', '大牟田', '西鉄', 1140, 74.8],      // 2026-04改定
  ['天神', '博多', '福岡市地下鉄', 210, 3.0],
];

let hit = 0, off1 = 0, miss = 0;
const rows = [];
for (const [f, t, co, real, realKm] of ANCHORS) {
  const s = id(f), g = id(t);
  if (s < 0 || g < 0) { rows.push([f + '→' + t, ' 駅なし']); miss++; continue; }
  let found = null;
  for (const at of [540, 600, 660]) {
    const js = R.findJourneys(s, g, at, {});
    for (const j of js) {
      const fr = R.journeyFare(j);
      const main = fr.breakdown.filter(b => b.dist > 0).sort((a, b) => b.dist - a.dist)[0];
      // 主区間会社が一致(JR西日本(特定)/電特も'JR西日本'指定で拾う)
      const mc = main ? main.company.replace(/\(.*$/, '').replace(/電特$/, '') : '';
      if (main && (mc === co || main.company === co)) { found = { j, fr, main }; break; }
    }
    if (found) break;
  }
  if (!found) { rows.push([`${f}→${t}`, `経路なし(${co})`]); miss++; continue; }
  const { fr, main } = found;
  const diff = fr.total - real;
  const kmRatio = main.dist / realKm;
  if (diff === 0) hit++;
  else if (Math.abs(diff) <= 110) off1++;
  else miss++;
  rows.push([`${f}→${t}`,
    `実${real} 算${fr.total} 差${diff >= 0 ? '+' : ''}${diff}`,
    `km実${realKm} 算${main.dist.toFixed(1)} 比${kmRatio.toFixed(3)}`,
    co]);
}
for (const r of rows) console.log(r.join('  '));
console.log(`\n一致: ${hit}/${ANCHORS.length}, ±110円以内: ${off1}, 大外し/欠測: ${miss}`);
