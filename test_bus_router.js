#!/usr/bin/env node
/* test_bus_router.js — バス(GTFS)取り込みの回帰テスト
 *
 *   node test_bus_router.js                    通常実行(バス入りデータを検証)
 *   node test_bus_router.js --data /tmp/rail   別ディレクトリのデータを使う
 *   node test_bus_router.js --write-baseline   鉄道経路の期待値を test_rail_baseline.json へ
 *
 * 検証すること:
 *   A) 鉄道駅どうしの経路がバス投入で劣化しないこと。
 *      (--write-baseline をバス投入前のビルドに対して実行して golden を作る)
 *        A1 平日に変化したクエリは必ずバス leg を含む
 *        A2 全クエリで到着時刻が baseline より遅くならない
 *        A3 変化したクエリは必ずバス leg を含む(=変化の原因がバス投入であることの確認)
 *
 *      golden は「鉄道データを直したら意図的に取り直す」もの。取り直す前に
 *      node qa_baseline_diff.js で全差分が改善であることを目視すること。
 *      直近の取り直し: 運転日タグのフォールバック修正(土休に東京メトロ各線が
 *      丸ごと消えていたのを解消)。土休41件が改善し、平日は0件変化だった。
 *      それ以前の golden には「土休はダイヤが薄くバスが空白を埋める」前提が
 *      焼き込まれていたが、それは取り込み漏れであってダイヤの実態ではない。
 *   B) 鉄道→バスの乗換を含む経路が実際に引けること
 *   C) opts.noBus でバスが完全に消えること
 *   D) データ構造の不変条件(モードフラグ / バス停 / 徒歩連絡 / 運賃の扱い)
 *   E) opts.busOnly (バス限定モード) — 鉄道が完全に消え、都内のODでバスだけの
 *      経路が引けること。営業エリア外では経路なしになること。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const dataDir = (() => {
  const i = argv.indexOf('--data');
  return i >= 0 ? argv[i + 1] : __dirname;
})();
const WRITE_BASELINE = argv.includes('--write-baseline');
const BASELINE_PATH = path.join(__dirname, 'test_rail_baseline.json');

const R = require('./router_v3.js');
const graph = JSON.parse(fs.readFileSync(path.join(dataDir, 'graph_v2.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'trains_v3_meta.json'), 'utf8'));
const fares = JSON.parse(fs.readFileSync(path.join(__dirname, 'fares.json'), 'utf8'));
const buf = fs.readFileSync(path.join(dataDir, 'trains_v3.bin'));
R.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  meta, graph.stations, fares);

const S = graph.stations;
const isBusStop = i => !!S[i].m;
const fmt = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// 鉄道駅を優先して引く(バス停に同名があっても鉄道側を返す)。
// 駅名は「札幌(ＪＲ)」「中野(東京)」のように事業者/都道府県の注記が付くのでカッコを外して再照合
const strip = s => s.replace(/[（(].*?[）)]/g, '');
function railId(name) {
  for (let i = 0; i < S.length; i++) if (!S[i].m && S[i].n === name) return i;
  for (let i = 0; i < S.length; i++) if (!S[i].m && strip(S[i].n) === strip(name)) return i;
  return -1;
}
// 停留所名は全国で衝突する(「六本木」は岩手県にも、「浅草」は愛知県にもある)ので
// near を渡して最寄りのものを選ぶ。near から MAX_MATCH_KM 以上離れていたら別物と
// みなして -1 (呼び出し側は同名の鉄道駅へフォールバックする)。
const MAX_MATCH_KM = 100;
function busId(name, near) {
  let best = -1, bestKm = Infinity;
  for (let i = 0; i < S.length; i++) {
    if (!S[i].m || S[i].n !== name) continue;
    if (near == null) return i;
    const km = distKm(i, near);
    if (km < bestKm) { best = i; bestKm = km; }
  }
  return bestKm <= MAX_MATCH_KM ? best : -1;
}
function distKm(i, j) {
  const a = S[i], b = S[j];
  if (a.la == null || b.la == null) return Infinity;
  const rad = Math.PI / 180, dla = (b.la - a.la) * rad, dlo = (b.lo - a.lo) * rad;
  const h = Math.sin(dla / 2) ** 2 +
    Math.cos(a.la * rad) * Math.cos(b.la * rad) * Math.sin(dlo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function sig(j) {
  if (!j) return null;
  return j.legs.map(l => l.kind === 'walk'
    ? `w${l.from}>${l.to}:${l.min}`
    : `${l.line}/${l.type}/${l.from}>${l.to}@${l.dep}-${l.arr}`).join('|');
}
function describe(j) {
  return j.legs.map(l => l.kind === 'walk'
    ? `徒歩${l.min}分`
    : `${l.mode === 1 ? '🚌' : ''}${l.line}${l.type ? '[' + l.type + ']' : ''} ` +
      `${S[l.from].n}${fmt(l.dep)}→${S[l.to].n}${fmt(l.arr)}`).join(' / ');
}

// --- 鉄道回帰の対象OD (バス投入の影響が出やすい都内を厚めに) ---
const RAIL_PAIRS = [
  ['高柳', '上野'], ['高柳', '北千住'], ['柏', '東京'], ['北千住', 'つくば'],
  ['新宿', '横浜'], ['東京', '新大阪'], ['渋谷', '吉祥寺'], ['札幌', '小樽'],
  ['上野', '日暮里'], ['鹿児島中央', '博多'],
  // 都営バスの営業エリア(23区)を通る鉄道OD
  ['東京', '渋谷'], ['東京', '新宿'], ['東京', '池袋'], ['東京', '品川'],
  ['東京', '上野'], ['東京', '錦糸町'], ['東京', '豊洲'], ['東京', '門前仲町'],
  ['新宿', '池袋'], ['新宿', '渋谷'], ['新宿', '東京'], ['新宿', '中野'],
  ['新宿', '練馬'], ['新宿', '荻窪'], ['新宿', '四ツ谷'], ['新宿', '高田馬場'],
  ['渋谷', '品川'], ['渋谷', '恵比寿'], ['渋谷', '六本木'], ['渋谷', '新橋'],
  ['渋谷', '目黒'], ['渋谷', '中目黒'], ['渋谷', '大井町'], ['渋谷', '浅草'],
  ['池袋', '上野'], ['池袋', '赤羽'], ['池袋', '巣鴨'], ['池袋', '大塚'],
  ['池袋', '王子'], ['池袋', '北千住'], ['池袋', '錦糸町'], ['池袋', '飯田橋'],
  ['品川', '大井町'], ['品川', '田町'], ['品川', '浜松町'], ['品川', '蒲田'],
  ['上野', '浅草'], ['上野', '北千住'], ['上野', '南千住'], ['上野', '田端'],
  ['上野', '西日暮里'], ['上野', '御徒町'], ['上野', '秋葉原'], ['上野', '押上'],
  ['錦糸町', '亀戸'], ['錦糸町', '両国'], ['錦糸町', '新木場'], ['錦糸町', '住吉'],
  ['豊洲', '月島'], ['豊洲', '有明'], ['豊洲', '銀座'], ['豊洲', '新橋'],
  ['新橋', '浜松町'], ['新橋', '有楽町'], ['新橋', '大門'], ['新橋', '汐留'],
  ['大崎', '五反田'], ['五反田', '目黒'], ['目黒', '白金台'], ['白金高輪', '三田'],
  ['田町', '浜松町'], ['浜松町', '天王洲アイル'], ['蒲田', '川崎'], ['川崎', '横浜'],
  ['赤羽', '王子'], ['王子', '田端'], ['田端', '駒込'], ['駒込', '巣鴨'],
  ['中野', '高円寺'], ['高円寺', '阿佐ケ谷'], ['荻窪', '吉祥寺'], ['三鷹', '国分寺'],
  ['北千住', '綾瀬'], ['綾瀬', '亀有'], ['亀有', '金町'], ['金町', '松戸'],
  ['押上', '曳舟'], ['浅草', '北千住'], ['門前仲町', '木場'], ['木場', '東陽町'],
  ['西葛西', '葛西'], ['葛西', '浦安'], ['大手町', '大崎'], ['日本橋', '茅場町'],
  ['九段下', '飯田橋'], ['市ケ谷', '四ツ谷'], ['神保町', '大手町'], ['三越前', '日本橋'],
  ['清澄白河', '住吉'], ['両国', '浅草橋'], ['秋葉原', '御茶ノ水'], ['御茶ノ水', '四ツ谷'],
  ['目白', '高田馬場'], ['大久保', '新大久保'], ['代々木', '原宿'], ['原宿', '表参道'],
  // 地方(バスの無い領域が壊れていないことの確認)
  ['名古屋', '金沢'], ['京都', '大阪'], ['広島', '岡山'], ['仙台', '福島'],
  ['長野', '松本'], ['熊本', '大分'], ['高松', '松山'], ['青森', '盛岡'],
];
// 時刻 × 運転日の組合せ (day: 0平日 1土 2休)
const RAIL_WHENS = [
  { at: 480, day: 0 }, { at: 780, day: 0 }, { at: 1290, day: 0 },
  { at: 600, day: 1 }, { at: 600, day: 2 },
];

function railResults() {
  const out = {};
  for (const [a, b] of RAIL_PAIRS) {
    const s = railId(a), g = railId(b);
    if (s < 0 || g < 0) { out[`${a}>${b}`] = 'NOSTATION'; continue; }
    for (const w of RAIL_WHENS) {
      const j = R.query(s, g, w.at, { day: w.day });
      out[`${a}>${b}@${w.at}d${w.day}`] = j
        ? { sig: sig(j), arr: j.arr, bus: j.legs.some(l => l.kind === 'ride' && l.mode === 1) }
        : null;
    }
  }
  return out;
}

if (WRITE_BASELINE) {
  const res = railResults();
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({
    note: 'test_bus_router.js の鉄道回帰テストの期待値。'
        + '初版はバス投入前(鉄道のみ)。運転日タグのフォールバック修正で土休の鉄道ダイヤが'
        + '復活したため取り直した(qa_baseline_diff.js で 短縮36/悪化0/平日変化0 を確認)',
    stations: S.length,
    trips: meta.trips.l.length,
    results: res,
  }, null, 0) + '\n');
  const n = Object.keys(res).length;
  const found = Object.values(res).filter(v => v && v !== 'NOSTATION').length;
  console.log(`baseline written: ${BASELINE_PATH} (${n} queries, ${found} routed)`);
  process.exit(0);
}

let fail = 0;
function check(name, ok, detail) {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

// ---------- D) データ構造 ----------
const nBus = S.filter(s => s.m).length;
const firstBus = S.findIndex(s => s.m);
check('バス停が graph_v2.json に入っている', nBus > 0, `${nBus}停留所`);
check('鉄道駅インデックスが不変(バス停は末尾に連続して並ぶ)',
  firstBus > 0 && S.slice(firstBus).every(s => s.m === 1),
  `rail 0..${firstBus - 1} / bus ${firstBus}..${S.length - 1}`);
check('駅数が uint16 の上限内', S.length <= 65535, `${S.length}駅`);
check('meta.trips.m が全 trip 分ある',
  Array.isArray(meta.trips.m) && meta.trips.m.length === meta.trips.l.length,
  `${meta.trips.m ? meta.trips.m.length : 0} / ${meta.trips.l.length}`);
const nBusTrips = (meta.trips.m || []).filter(x => x === 1).length;
check('バス trip がある', nBusTrips > 0, `${nBusTrips}本`);
check('バス trip の停車が全てバス停',
  (() => {
    for (let t = 0; t < meta.trips.l.length; t++) {
      if (meta.trips.m[t] !== 1) continue;
      for (let i = R.data.tripOff[t]; i < R.data.tripOff[t + 1]; i++) {
        if (!isBusStop(R.data.stS[i])) return false;
      }
    }
    return true;
  })());
const mixedFoot = meta.footpaths.filter(([a, b]) => isBusStop(a) !== isBusStop(b));
const busFoot = meta.footpaths.filter(([a, b]) => isBusStop(a) && isBusStop(b));
check('鉄道⇄バスの徒歩連絡が生成されている', mixedFoot.length > 100, `${mixedFoot.length}ペア`);
check('バス停同士の徒歩連絡は作らない', busFoot.length === 0, `${busFoot.length}ペア`);
{
  // 300近いフィードを1行に並べると読めないので、ライセンス別の件数だけ出す
  const srcs = Object.values(meta.sources || {});
  const byLicense = {};
  for (const s of srcs) byLicense[s.license] = (byLicense[s.license] || 0) + 1;
  check('出典(CC BY)がメタに入っている',
    srcs.length > 0 && srcs.every(s => s.license && s.attribution),
    srcs.length ? `${srcs.length}フィード: ` +
      Object.entries(byLicense).map(([l, n]) => `${l}×${n}`).join(', ') : '無し');
  // 再配布不可のライセンスが混ざっていないこと(オフライン同梱の前提)
  const bad = srcs.filter(s => !/^(CC BY|CC-BY|CC0)/.test(s.license));
  check('再配布可能なライセンスのフィードだけを同梱している', bad.length === 0,
    bad.length ? bad.map(s => `${s.name}(${s.license})`).join(', ') : '');
}

// ---------- A) 鉄道回帰 ----------
if (!fs.existsSync(BASELINE_PATH)) {
  check('鉄道回帰の baseline が存在する', false, `${BASELINE_PATH} が無い(--write-baseline で作る)`);
} else {
  const base = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const now = railResults();
  const wdDiff = [], worse = [], noBusCause = [], changed = [];
  for (const [k, b] of Object.entries(base.results)) {
    const n = now[k];
    if (b === 'NOSTATION' || n === 'NOSTATION') continue;
    const bSig = b && b.sig, nSig = n && n.sig;
    if (bSig === nSig) continue;
    changed.push(k);
    if (/d0$/.test(k)) wdDiff.push(k);
    if (!n || (b && n.arr > b.arr)) worse.push(k);
    if (!n || !n.bus) noBusCause.push(k);
  }
  const nq = Object.keys(base.results).length;
  // A1: バスが全国展開(1事業者→約300フィード)する前は「平日の鉄道経路は1件も
  // 変化しない」を要求していた。都営バスは23区内=鉄道データが密な領域にしか無く、
  // バスが鉄道より速いことが有り得なかったため成立していた条件。地方をカバーした
  // 今は、鉄道が疎な区間で「駅前→バス→駅前」が鉄道と同着・先着することが普通に
  // 起きる(青森→盛岡 で 奥羽本線 の代わりに青森市営バス浪岡線を使い新幹線に同じ
  // 便で接続する等)ので、「変化してよいが、原因は必ずバスで、到着は悪化しない」
  // まで緩める。到着の悪化が無いことは A2、変化の原因は A3 が見ている。
  const wdNoBus = wdDiff.filter(k => !now[k] || !now[k].bus);
  check(`A1 平日に変化した経路は全てバス由来 (${nq} クエリ)`, wdNoBus.length === 0,
    wdNoBus.length ? `バス無しで変化 ${wdNoBus.length}件: ${wdNoBus.slice(0, 5).join(', ')}`
                   : `(平日の変化 ${wdDiff.length}件 / 全体 ${changed.length}件)`);
  check('A2 到着が baseline より遅くなった経路が無い', worse.length === 0,
    worse.length ? `${worse.length}件: ${worse.slice(0, 5).join(', ')}` : `(${nq} queries)`);
  check('A3 変化した経路は全てバス leg を含む', noBusCause.length === 0,
    noBusCause.length ? `${noBusCause.length}件: ${noBusCause.slice(0, 5).join(', ')}`
                      : `(変化 ${changed.length}件 = 土休のバス経由改善)`);
}

// ---------- B) 鉄道→バスの乗換 ----------
// 鉄道駅から「鉄道では行けない/遠回りな」バス停へ。バス leg を含むことを要求する。
// 行き先は「鉄道では届かないバス停」を選ぶ。needRail:true は鉄道→バスの乗換を要求する
const BUS_CASES = [
  { from: '東京', to: '岩蔵温泉', at: 480, day: 0, needRail: true },        // 中央線→梅77→梅74
  { from: '立川', to: '成木市民センター前', at: 540, day: 0, needRail: true }, // 青梅線→梅77→梅74
  { from: '新宿', to: '海の森水上競技場', at: 540, day: 0, needRail: true },  // りんかい線→波01
  { from: '渋谷', to: '早稲田', at: 600, day: 0, needRail: true },           // メトロ→上58
  { from: '新橋', to: '晴海三丁目', at: 600, day: 0, needRail: true },       // 銀座線→都05-1
  { from: '錦糸町', to: '東京都現代美術館前', at: 600, day: 0 },              // バスのみ
  { from: '品川', to: '天王洲アイル', at: 600, day: 0 },                     // バスのみ
  { from: '新橋', to: '晴海三丁目', at: 600, day: 2 },                       // 休日ダイヤ
  { from: '立川', to: '成木市民センター前', at: 540, day: 2, needRail: true }, // 休日ダイヤ+鉄道乗換
];
let nTransfer = 0;
for (const c of BUS_CASES) {
  const label = `${c.from}→${c.to}${c.day ? '(休)' : ''}`;
  const s = railId(c.from);
  const g = busId(c.to, s) >= 0 ? busId(c.to, s) : railId(c.to);
  if (s < 0 || g < 0) { check(label, false, '駅/停留所が見つからない'); continue; }
  const j = R.query(s, g, c.at, { day: c.day });
  if (!j) { check(label, false, '経路なし'); continue; }
  const busLegs = j.legs.filter(l => l.kind === 'ride' && l.mode === 1);
  const railLegs = j.legs.filter(l => l.kind === 'ride' && l.mode === 0);
  check(`${label} でバスに乗る`, busLegs.length > 0,
    `${fmt(j.dep)}→${fmt(j.arr)} ${j.arr - j.dep}分 / ${describe(j)}`);
  if (c.needRail) {
    // 鉄道→バスの乗換が実際に成立していることの直接確認
    const rides = j.legs.filter(l => l.kind === 'ride');
    let ok = false;
    for (let i = 1; i < rides.length; i++) {
      if (rides[i].mode === 1 && rides[i - 1].mode === 0) { ok = true; nTransfer++; }
    }
    check(`  ${label} が鉄道 leg → バス leg の乗換を含む`, ok,
      `鉄道${railLegs.length}区間 + バス${busLegs.length}区間`);
  }
  const fare = R.journeyFare(j);
  check(`  ${label} の運賃はバス区間を含まない`,
    fare.busLegs === busLegs.length &&
    fare.breakdown.every(b => !busLegs.some(l => b.company === l.line)),
    `¥${fare.total} (バス${fare.busLegs}区間は別途)`);
}
check('鉄道 leg → バス leg の乗換が成立するケースがある', nTransfer > 0, `${nTransfer}件`);

// ---------- C) noBus ----------
{
  const c = BUS_CASES[5];
  const s = railId(c.from), g = busId(c.to, railId(c.from));
  const j = R.query(s, g, c.at, { day: c.day, noBus: true });
  check('noBus:true でバス leg が消える',
    !j || j.legs.every(l => l.kind !== 'ride' || l.mode !== 1),
    j ? describe(j) : '経路なし(バス停へはバスでしか行けない → 期待どおり)');
  let anyBus = false;
  for (const [a, b] of RAIL_PAIRS.slice(0, 40)) {
    const x = railId(a), y = railId(b);
    if (x < 0 || y < 0) continue;
    const k = R.query(x, y, 600, { day: 0, noBus: true });
    if (k && k.legs.some(l => l.kind === 'ride' && l.mode === 1)) anyBus = true;
  }
  check('noBus:true の鉄道OD検索にバスが1件も混ざらない', !anyBus);
}

// ---------- E) busOnly (バス限定モード) ----------
{
  const hasRail = j => j.legs.some(l => l.kind === 'ride' && l.mode !== 1);
  const hasBus  = j => j.legs.some(l => l.kind === 'ride' && l.mode === 1);

  // E1) 都営バスの営業エリア内。駅名で指定しても徒歩連絡で停留所まで届く
  const BUS_ONLY_OK = [
    { from: '渋谷', to: '六本木', at: 600, day: 0 },
    { from: '品川', to: '天王洲アイル', at: 600, day: 0 },
    { from: '東京', to: '豊洲', at: 600, day: 0 },
    { from: '上野', to: '浅草', at: 600, day: 0 },
    { from: '池袋', to: '大塚', at: 600, day: 0 },
    { from: '錦糸町', to: '東京都現代美術館前', at: 600, day: 0 },
    { from: '新橋', to: '晴海三丁目', at: 600, day: 0 },
    { from: '渋谷', to: '六本木', at: 600, day: 2 },   // 休日ダイヤ
  ];
  for (const c of BUS_ONLY_OK) {
    // E1 は「駅名で指定しても徒歩連絡で停留所まで届く」の確認なので鉄道駅を優先する
    // (東京都現代美術館前・晴海三丁目のように鉄道駅が無い行き先だけ停留所を引く)
    const s = railId(c.from);
    const g = railId(c.to) >= 0 ? railId(c.to) : busId(c.to, s);
    if (s < 0 || g < 0) { check(`E1 ${c.from}→${c.to}`, false, '駅/停留所が見つからない'); continue; }
    const j = R.query(s, g, c.at, { day: c.day, busOnly: true });
    check(`E1 ${c.from}→${c.to}${c.day ? '(休)' : ''} をバスだけで引ける`,
      !!j && hasBus(j) && !hasRail(j),
      j ? `${fmt(j.dep)}→${fmt(j.arr)} ${j.arr - j.dep}分 / ${describe(j)}` : '経路なし');
  }

  // E2) findJourneys の候補が1本残らず鉄道抜きであること(多様化・優等抜き候補も含めて)
  {
    const js = R.findJourneys(railId('渋谷'), railId('六本木'), 600, { day: 0, busOnly: true });
    check('E2 findJourneys(busOnly) の全候補が鉄道 leg を含まない',
      js.length > 0 && js.every(j => !hasRail(j) && hasBus(j)), `${js.length}候補`);
  }

  // E3) 都営バスの営業エリア外/遠距離はバス限定では出ない(鉄道に化けない)
  const BUS_ONLY_NG = [['札幌', '小樽'], ['東京', '新大阪'], ['柏', '東京'], ['新宿', '横浜']];
  for (const [a, b] of BUS_ONLY_NG) {
    const s = railId(a), g = railId(b);
    if (s < 0 || g < 0) continue;
    const j = R.query(s, g, 600, { day: 0, busOnly: true });
    check(`E3 ${a}→${b} はバス限定で経路なし(鉄道に化けない)`, !j, j ? describe(j) : '');
  }

  // E4) busOnly と noBus の同時指定。両立しないので busOnly を優先する
  {
    const j = R.query(railId('渋谷'), railId('六本木'), 600, { day: 0, busOnly: true, noBus: true });
    check('E4 busOnly+noBus は busOnly が勝つ', !!j && hasBus(j) && !hasRail(j),
      j ? describe(j) : '経路なし');
  }

  // E5) 前後の便・始発終バス・到着逆算も busOnly を尊重する
  {
    const s = railId('渋谷'), g = railId('六本木'), o = { day: 0, busOnly: true };
    const base = R.query(s, g, 600, o);
    const nj = R.nextJourney(s, g, base.dep, o);
    const pj = R.prevJourney(s, g, base.dep, o);
    const fl = R.firstLastOfDay(s, g, o);
    const ld = R.latestDeparture(s, g, 700, o);
    const all = [nj, pj, fl.first, fl.last, ld].filter(Boolean);
    check('E5 next/prev/firstLast/latestDeparture が busOnly を尊重する',
      all.length === 5 && all.every(j => !hasRail(j) && hasBus(j)),
      `${all.length}/5本 取得 / 始発${fl.first ? fmt(fl.first.dep) : '-'} 終バス${fl.last ? fmt(fl.last.dep) : '-'}`);
  }

  // E6) バス限定スキャン用の添字配列がバスconnを過不足なく、depT昇順で持っている
  {
    R.query(railId('渋谷'), railId('六本木'), 600, { day: 0, busOnly: true }); // 遅延生成を走らせる
    const d = R.data, idx = d.busConn;
    let want = 0;
    for (let c = 0; c < d.nConn; c++) if (d.tripMode[d.cTrip[c]] === 1) want++;
    let sorted = true, allBus = true;
    for (let i = 0; i < idx.length; i++) {
      if (d.tripMode[d.cTrip[idx[i]]] !== 1) allBus = false;
      if (i && d.cDepT[idx[i - 1]] > d.cDepT[idx[i]]) sorted = false;
    }
    check('E6 busConn 添字がバスconnを過不足なく持つ', idx.length === want && allBus,
      `${idx.length} / ${want} (全conn ${d.nConn})`);
    check('E6 busConn 添字が出発時刻昇順', sorted);
  }

  // E7) バス限定の運賃は全区間が対象外(=鉄道運賃0円)で、本数だけ返る
  {
    const j = R.query(railId('渋谷'), railId('六本木'), 600, { day: 0, busOnly: true });
    const f = R.journeyFare(j);
    check('E7 バス限定の運賃は鉄道分0円+バス本数', f.total === 0 && f.busLegs > 0 && !f.breakdown.length,
      `¥${f.total} / バス${f.busLegs}区間`);
  }
}

console.log(fail === 0 ? '\nALL OK' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
