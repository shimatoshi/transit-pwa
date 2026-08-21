#!/usr/bin/env node
/* test_station_company.js — 駅の会社判定と運賃の会社分割の回帰テスト (Issue #15)
 *
 *   node test_station_company.js
 *
 * 検証すること:
 *   A) stationCompanies — JR/私鉄が同居する駅で両方の会社が引けること。
 *      wl が素の路線名(東海道本線・関西空港線)でも実体リスト照合で JR になること
 *   B) 誤爆ガード — 三セク・地下鉄が JR/東京メトロに化けないこと
 *      (旧regex方式は 711駅に誤って JR を付けていた)
 *   C) 運賃の会社分割 — JR完結の行程に私鉄運賃が混入しないこと
 *      (Issue #15 の実例: 京都→関西空港 はるかが 南海運賃+空港加算に化けていた)
 *   D) カバレッジ — 路線タグ(l)がJRの鉄道駅のうち wl から JR が引けない駅が
 *      増えていないこと(閾値監視)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const R = require('./router_v3.js');
const graph = JSON.parse(fs.readFileSync(path.join(__dirname, 'graph_v2.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'trains_v3_meta.json'), 'utf8'));
const fares = JSON.parse(fs.readFileSync(path.join(__dirname, 'fares.json'), 'utf8'));
const buf = fs.readFileSync(path.join(__dirname, 'trains_v3.bin'));
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  meta, graph.stations, fares);

const S = graph.stations;
const strip = s => s.replace(/[（(].*?[）)]/g, '');
const id = n => {
  let i = S.findIndex(s => !s.m && s.n === n);
  if (i < 0) i = S.findIndex(s => !s.m && strip(s.n) === strip(n));
  return i;
};
const cos = n => R.stationCompanies(id(n));

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

// ---- A) JR/私鉄同居駅で両方の会社が引ける ----
{
  const cases = [
    // [駅名, 必須会社..., ]  wl は素の路線名でも JR が引けること
    ['東京', 'JR', '東京メトロ'],
    ['新宿', 'JR', '京王', '小田急'],
    ['渋谷', 'JR', '東急', '東京メトロ'],
    ['横浜', 'JR', '東急', '相鉄'],
    ['京都', 'JR', '近鉄'],
    ['天王寺', 'JR', '大阪メトロ'],
    ['関西空港', 'JR', '南海'],   // Issue #15 の実例(旧: 関西空港線が引けず南海のみ)
  ];
  for (const [n, ...want] of cases) {
    const cs = cos(n);
    check(`A ${n} = {${[...cs]}}`, want.every(w => cs.has(w)));
  }
  // wl が素のJR路線名だけの駅(東京圏外の幹線)
  check('A 旭川(石北本線・宗谷本線等の素の名前)はJR', cos('旭川').has('JR'));
  check('A 弁天町(大阪環状線)はJR', cos('弁天町').has('JR'));
}

// ---- B) 誤爆ガード ----
{
  // 「〜線」で終わるだけの三セク路線をJRにしない
  check('B 会津田島(会津鉄道会津線)はJRでない', !cos('会津田島').has('JR'));
  check('B 仙台空港(仙台空港鉄道)はJRでない', !cos('仙台空港').has('JR'));
  // 接頭辞を剥がすと地下鉄と同名になる「東西線」「中央線」を照合から除外している
  check('B 烏丸御池(京都市営東西線)はJR/東京メトロでない',
    !cos('烏丸御池').has('JR') && !cos('烏丸御池').has('東京メトロ'), `{${[...cos('烏丸御池')]}}`);
  check('B 堺筋本町(大阪メトロ中央線)はJRでない', !cos('堺筋本町').has('JR'));
  check('B 二条(ＪＲ山陰本線+京都市営東西線)はJRのみ',
    cos('二条').has('JR') && !cos('二条').has('東京メトロ'), `{${[...cos('二条')]}}`);
}

// ---- C) 運賃の会社分割: JR完結の行程に私鉄が混入しない ----
{
  const q = (f, t, dep, opts) => R.findJourneys(id(f), id(t), dep, opts || {});
  // Issue #15 の実例: 京都→関西空港 はるか(JR完結・乗換0)
  const js = q('京都', '関西空港', 540);
  const haruka = js.find(j => {
    const rides = j.legs.filter(l => l.kind === 'ride');
    return rides.length === 1 && /^(ＪＲ|JR)/.test(rides[0].line);
  });
  check('C 京都→関西空港 JR直通(はるか)が存在', !!haruka);
  if (haruka) {
    const fr = R.journeyFare(haruka);
    const bd = fr.breakdown.map(b => b.company).join('+');
    check('C はるかの内訳に南海が混入しない', !/南海/.test(bd), bd + ' ¥' + fr.total);
    check('C はるかの運賃会社はJR', fr.breakdown.some(b => /^JR/.test(b.company)), bd);
  }
  // 天王寺→関西空港 JR阪和線・関西空港線完結
  const js2 = q('天王寺', '関西空港', 540, { express: false, shinkansen: false });
  const jrOnly = js2.find(j => j.legs.filter(l => l.kind === 'ride')
    .every(l => /^(ＪＲ|JR)/.test(l.line)));
  check('C 天王寺→関西空港 JR完結経路が存在', !!jrOnly);
  if (jrOnly) {
    const bd = R.journeyFare(jrOnly).breakdown.map(b => b.company).join('+');
    check('C 天王寺→関西空港(JR)に南海が混入しない', !/南海/.test(bd), bd);
  }
  // 逆に南海経路は南海のまま(空港加算含む)であること
  const js3 = q('難波', '関西空港', 540, { express: false, shinkansen: false });
  const nankai = js3.find(j => j.legs.filter(l => l.kind === 'ride')
    .every(l => /南海/.test(l.line)));
  check('C 難波→関西空港 南海経路が存在', !!nankai);
  if (nankai) {
    const fr = R.journeyFare(nankai);
    check('C 南海経路は南海運賃+空港加算のまま',
      fr.breakdown.some(b => b.company === '南海') &&
      fr.breakdown.some(b => /南海空港加算/.test(b.company)),
      fr.breakdown.map(b => b.company + '¥' + b.fare).join('+'));
  }
}

// ---- D) カバレッジの閾値監視 ----
{
  let jrTagged = 0, jrMiss = 0, falseJR = 0;
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    if (s.m) continue;
    const tagged = (s.l || []).some(x => /^(ＪＲ|JR)/.test(x));
    const hasJR = R.stationCompanies(i).has('JR');
    if (tagged) { jrTagged++; if (!hasJR) jrMiss++; }
    else if (hasJR) falseJR++;
  }
  // 現状値: jrMiss=332(全て三セク/BRT等、路線タグ側の直通汚染), falseJR=32(実際はJR駅)
  check(`D JRタグ駅のJR未解決が400駅以下 (${jrMiss}/${jrTagged})`, jrMiss <= 400);
  check(`D 非JRタグ駅へのJR付与が60駅以下 (${falseJR})`, falseJR <= 60);
}

console.log(fail === 0 ? '\nALL OK' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
