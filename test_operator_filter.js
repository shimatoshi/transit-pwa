#!/usr/bin/env node
/* test_operator_filter.js — 路線種別(JR/私鉄)・事業者フィルタの回帰テスト
 *
 *   node test_operator_filter.js
 *
 * 検証すること:
 *   A) lineOperator の分類 — JR(新幹線・ＪＲ東西線含む) / fares.json 収録の私鉄 /
 *      未収録の地方私鉄(路線名からの事業者切り出し) / 会社キーの畳み込み
 *   B) railOperators の一覧 — JR・バス系統が混ざらず、私鉄事業者が揃っていること
 *   C) opts.rail='jr' — 全レグがJR。私鉄しか無い区間は経路なし
 *   D) opts.rail='private' — JRレグ・バスレグが混ざらない
 *   E) opts.operators — 指定事業者のレグだけになる。未知の事業者は経路なし
 *   F) busOnly との優先関係 — busOnly が勝ち、事業者フィルタは無視される
 *   G) findJourneys / nextJourney / prevJourney / firstLastOfDay / latestDeparture
 *      への opts 伝播
 *   H) フィルタ未指定の検索は従来と完全一致(既存動作を変えない)
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
function railId(name) {
  for (let i = 0; i < S.length; i++) if (!S[i].m && S[i].n === name) return i;
  for (let i = 0; i < S.length; i++) if (!S[i].m && strip(S[i].n) === strip(name)) return i;
  return -1;
}
const fmt = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
function describe(j) {
  if (!j) return '(経路なし)';
  return j.legs.map(l => l.kind === 'walk'
    ? `徒歩${l.min}分`
    : `${l.line} ${S[l.from].n}${fmt(l.dep)}→${S[l.to].n}${fmt(l.arr)}`).join(' / ');
}
function sig(j) {
  if (!j) return null;
  return j.legs.map(l => l.kind === 'walk'
    ? `w${l.from}>${l.to}:${l.min}`
    : `${l.line}/${l.from}>${l.to}@${l.dep}-${l.arr}`).join('|');
}
// 乗車レグの検査: pred(事業者名, レグ) が全レグで真か
function ridesOk(j, pred) {
  if (!j) return false;
  return j.legs.every(l => l.kind !== 'ride' || pred(R.lineOperator(l.line), l));
}

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

// ---- A) lineOperator の分類 ----
{
  check('A1 ＪＲ在来線はJR', R.lineOperator('ＪＲ山手線') === 'JR');
  check('A2 新幹線はJR', R.lineOperator('ＪＲ東海道・山陽新幹線') === 'JR');
  check('A3 ＪＲ東西線(関西)はJR(東京メトロ東西線への誤マッチ回避)',
    R.lineOperator('ＪＲ東西線') === 'JR');
  check('A4 東京メトロ', R.lineOperator('東京メトロ東西線') === '東京メトロ');
  check('A5 fares収録の大手私鉄', R.lineOperator('東急東横線') === '東急' &&
    R.lineOperator('京王井の頭線') === '京王' && R.lineOperator('近鉄名古屋線') === '近鉄');
  check('A6 会社キーの畳み込み(世田谷線→東急)', R.lineOperator('東急世田谷線') === '東急');
  check('A7 未収録私鉄は路線名から事業者を切り出す',
    R.lineOperator('富山地方鉄道本線') === '富山地方鉄道' &&
    R.lineOperator('しなの鉄道北しなの線') === 'しなの鉄道' &&
    R.lineOperator('北越急行ほくほく線') === '北越急行');
  check('A8 切り出せないブランド名はそのまま',
    R.lineOperator('あおなみ線') === 'あおなみ線' && R.lineOperator('リニモ') === 'リニモ');
  check('A9 全路線が空でない事業者名を持つ(バス系統除く)', (() => {
    const d = R.data;
    if (!d.tripMode) return false;
    const isBusLine = new Uint8Array(d.lines.length);
    for (let t = 0; t < d.tripLine.length; t++) if (d.tripMode[t] === 1) isBusLine[d.tripLine[t]] = 1;
    return d.lines.every((l, i) => isBusLine[i] || R.lineOperator(l) !== '');
  })());
}

// ---- B) railOperators の一覧 ----
{
  const ops = R.railOperators();
  check('B1 私鉄事業者が100社以上並ぶ', ops.length >= 100, `${ops.length}社`);
  check('B2 JRが混ざらない', ops.every(o => o.name !== 'JR' && o.name.indexOf('JR') !== 0));
  check('B3 都営バス系統が混ざらない', ops.every(o => !/^[市黒品橋浜田井反波学渋都宿飯上早高池王梅草里茶東白練北端錦亀急直陽秋平両門新西臨葛船木業海豊江][０-９]/.test(o.name)));
  check('B4 主要どころが入っている', ['東急', '京王', '小田急', '東京メトロ', '近鉄', '阪急'].every(
    n => ops.some(o => o.name === n)));
  check('B5 路線数が付いている', ops.every(o => o.lines >= 1));
}

// ---- C) JRのみ ----
{
  const j = R.query(railId('渋谷'), railId('横浜'), 600, { day: 0, rail: 'jr' });
  check('C1 渋谷→横浜 JRのみで経路が引ける', !!j, describe(j));
  check('C2 全レグがJR', ridesOk(j, op => op === 'JR'));
  const far = R.query(railId('東京'), railId('新大阪'), 480, { day: 0, rail: 'jr' });
  check('C3 東京→新大阪 JRのみ(新幹線が使える)', !!far && ridesOk(far, op => op === 'JR'),
    describe(far));
  // 多摩モノレールの中間駅どうしはJRだけでは到達できない
  const none = R.query(railId('万願寺'), railId('程久保'), 600, { day: 0, rail: 'jr' });
  check('C4 私鉄しか無い区間はJRのみだと経路なし', none === null, describe(none));
  const bus = R.query(railId('渋谷'), railId('六本木'), 600, { day: 0, rail: 'jr' });
  check('C5 JRのみにバスは混ざらない', !bus || bus.legs.every(l => l.kind !== 'ride' || l.mode !== 1));
}

// ---- D) 私鉄のみ ----
{
  const j = R.query(railId('渋谷'), railId('横浜'), 600, { day: 0, rail: 'private' });
  check('D1 渋谷→横浜 私鉄のみで経路が引ける(東横線)', !!j, describe(j));
  check('D2 JRレグが混ざらない', ridesOk(j, op => op !== 'JR'));
  const j2 = R.query(railId('新宿'), railId('吉祥寺'), 600, { day: 0, rail: 'private' });
  check('D3 新宿→吉祥寺 私鉄のみ(京王/小田急経由)', !!j2 && ridesOk(j2, op => op !== 'JR'),
    describe(j2));
  check('D4 バスレグが混ざらない',
    [j, j2].every(x => !x || x.legs.every(l => l.kind !== 'ride' || l.mode !== 1)));
}

// ---- E) 特定事業者のみ ----
{
  const j = R.query(railId('渋谷'), railId('横浜'), 600, { day: 0, operators: ['東急'] });
  check('E1 東急のみ: 渋谷→横浜', !!j && ridesOk(j, op => op === '東急'), describe(j));
  const j2 = R.query(railId('新宿'), railId('吉祥寺'), 600, { day: 0, operators: ['京王'] });
  check('E2 京王のみ: 新宿→吉祥寺', !!j2 && ridesOk(j2, op => op === '京王'), describe(j2));
  const j3 = R.query(railId('渋谷'), railId('横浜'), 600,
    { day: 0, rail: 'private', operators: ['東急', 'みなとみらい線'] });
  check('E3 複数事業者(東急+みなとみらい線)', !!j3 &&
    ridesOk(j3, op => op === '東急' || op === 'みなとみらい線'), describe(j3));
  const none = R.query(railId('渋谷'), railId('横浜'), 600, { day: 0, operators: ['存在しない鉄道'] });
  check('E4 未知の事業者は経路なし', none === null);
  const set = R.query(railId('渋谷'), railId('横浜'), 600, { day: 0, operators: new Set(['東急']) });
  check('E5 operators は Set でも渡せる', !!set && ridesOk(set, op => op === '東急'));
}

// ---- F) busOnly との優先関係 ----
{
  const j = R.query(railId('渋谷'), railId('六本木'), 600, { day: 0, busOnly: true, rail: 'jr' });
  check('F1 busOnly が事業者フィルタより優先(バス経路が返る)',
    !!j && j.legs.every(l => l.kind !== 'ride' || l.mode === 1), describe(j));
}

// ---- G) opts の伝播 ----
{
  const opts = { day: 0, rail: 'private' };
  const src = railId('渋谷'), dst = railId('横浜');
  const list = R.findJourneys(src, dst, 600, opts);
  check('G1 findJourneys の全候補が私鉄のみ', list.length > 0 &&
    list.every(j => ridesOk(j, op => op !== 'JR')), `${list.length}候補`);
  const first = list[0];
  const nj = R.nextJourney(src, dst, first.dep, opts);
  check('G2 nextJourney も私鉄のみ', !!nj && ridesOk(nj, op => op !== 'JR'), describe(nj));
  const pj = R.prevJourney(src, dst, first.dep, opts);
  check('G3 prevJourney も私鉄のみ', !pj || ridesOk(pj, op => op !== 'JR'), describe(pj));
  const fl = R.firstLastOfDay(src, dst, opts);
  check('G4 始発・終電も私鉄のみ', !!fl && [fl.first, fl.last].every(
    j => !j || ridesOk(j, op => op !== 'JR')));
  const ld = R.latestDeparture(src, dst, 720, opts);
  check('G5 到着逆算も私鉄のみ', !!ld && ridesOk(ld, op => op !== 'JR'), describe(ld));
}

// ---- H) フィルタ未指定の検索は変わらない ----
{
  const pairs = [['渋谷', '横浜'], ['新宿', '吉祥寺'], ['東京', '新大阪'], ['柏', '東京']];
  let same = true;
  for (const [f, t] of pairs) {
    const a = R.query(railId(f), railId(t), 600, { day: 0 });
    const b = R.query(railId(f), railId(t), 600, { day: 0, rail: 'all', operators: [] });
    if (sig(a) !== sig(b)) { same = false; console.log(`  差分: ${f}→${t}`); }
  }
  check('H1 rail:"all"/operators:[] はフィルタ無しと完全一致', same);
}

console.log(fail === 0 ? '\nALL OK' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
