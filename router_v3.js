/* router_v3.js — 実在列車ベースの経路検索 (Connection Scan Algorithm).
 *
 * v2までの「グラフ最短路＋時刻を後付け」近似と違い、trains.json由来の
 * 全列車(trips)の停車時刻をそのまま辿るので、出る時刻・着く時刻が
 * 時刻表どおりになる。
 *
 * データ: trains_v3.bin (make_trains_v3.py 参照) + trains_v3_meta.json
 *         + graph_v2.json の stations (駅名・座標・駅名検索用)
 *
 * Works in browser (window.RouterV3) and node (module.exports).
 */
(function (global) {
'use strict';

const MIN_TRANSFER = 4;   // 同一駅乗換の標準バッファ(分)
// バスが絡む乗換は道路事情で遅れるうえ、CSAは最早到着しか見ないので「1区間だけ
// バスに乗って数分早い」経路が上位に出やすい。バッファを厚くして抑制する。
const BUS_TRANSFER = 6;
// 直線距離→営業キロの補正係数。2026-06に実営業キロ25区間で再校正(旧1.12は過大)。
// 線形がうねる会社は fares.json の km_scale で追加補正
const RAIL_KM_FACTOR = 1.06;
const INF = 0x3fffffff;

// 有料優等判定。日本の私鉄「特急」は大半が無料(京急/京成/南海/阪神/山陽/東急/名鉄等)、
// JR/近鉄の特急と固有名の有料列車のみ特急券が要る。誤って無料快速(大和路快速/関空快速等)を
// 課金しないよう、有料は「allowlist(固有名) + JR/近鉄の特急」で判定する。
// 特急を含むが無料の優等(準特急/通勤特急/快速特急/直通特急/アクセス特急/区間特急/川越特急)。
const FREE_EXPRESS_RE = /(準特急|通勤特急|快速特急|直通特急|アクセス特急|区間特急|川越特急)/;
// 固有名の有料特急・有料ライナー(allowlist)。ここに無い名前は無料扱い(取りこぼしは過小=安全側)。
const PAID_NAME_RE = new RegExp([
  // JR在来線特急
  'あずさ','かいじ','富士回遊','はちおうじ','おうめ','ひたち','ときわ','踊り子','湘南',
  'サフィール','成田エクスプレス','しおさい','わかしお','さざなみ','しなの','ひだ','南紀',
  '伊那路','ふじかわ','サンダーバード','しらさぎ','びわこエクスプレス','らくラク','はるか',
  'くろしお','こうのとり','きのさき','まいづる','はしだて','スーパーはくと','はまかぜ',
  'スーパーいなば','やくも','スーパーおき','スーパーまつかぜ','北斗','おおぞら','とかち',
  'オホーツク','大雪','宗谷','サロベツ','カムイ','ライラック','すずらん','ソニック','にちりん',
  'ひゅうが','きりしま','かもめ','みどり','ハウステンボス','かささぎ','きらめき','ゆふ',
  '九州横断特急','かわせみ','やませみ','海幸山幸','指宿のたまて箱','南風','しまんと','あしずり',
  'うずしお','剣山','むろと','しおかぜ','いしづち','宇和海','いなほ','つがる','草津','四万',
  'あかぎ','日光','きぬがわ','スペーシア',
  // 私鉄有料特急・有料ライナー
  'スカイライナー','イブニングライナー','モーニングライナー','ロマンスカー','はこね','さがみ',
  'えのしま','ホームウェイ','モーニングウェイ','メトロはこね','ふじさん','フジサン特急',
  '富士山ビュー','ミュースカイ','りょうもう','リバティ','けごん','きぬ','ちちぶ','むさし',
  '小江戸','京王ライナー','拝島ライナー','泉北ライナー','ラピート','りんかん','こうや','天空',
  'スノーモンキー','ゆけむり','しまかぜ','ひのとり','あをによし',
].join('|'));

function isJRLine(line) { return /^(ＪＲ|JR)/.test(line); }

// 列車が有料か。'shinkansen' | 'paid'(在来線有料特急/ライナー) | null(無料)
function expressKind(line, type) {
  if (!type) return null;
  if (line.includes('新幹線')) return 'shinkansen';
  if (FREE_EXPRESS_RE.test(type)) return null;       // 準特急/通勤特急/直通特急等は無料
  if (PAID_NAME_RE.test(type)) return 'paid';         // 固有名の有料列車
  if (/特急/.test(type)) {                            // 素の「特急」はJR/近鉄のみ有料
    if (isJRLine(line)) return 'paid';
    if (lineCompany(line) === '近鉄') return 'paid';
  }
  return null;
}

const D = {
  stations: null,   // graph_v2 stations
  lines: null, types: null,
  tripLine: null, tripType: null, tripDest: null,
  tripOff: null, stS: null, stA: null, stD: null, // 正規化済み(単調増加)
  // connections (depT昇順)
  cDepS: null, cDepT: null, cArrS: null, cArrT: null, cTrip: null, cStopI: null,
  nConn: 0,
  foot: null,       // station -> [[to, walkMin], ...]
  fares: null,
  tripPaid: null, tripShink: null, // Uint8 per trip
  busConn: null,    // バス限定検索用のconn添字(遅延生成)
};

// trains_v3.bin の展開 → connection配列の構築。
//
// 起動時間のほぼ全部がここに集中していたので、meta本体に依存しない形に切り出してある。
// 必要なのは trip→路線添字 (tripLine) と trip→鉄道/バス (tripMode) と駅数だけなので、
// この関数は Worker 上でも動く。返り値の TypedArray は全て独立したバッファで、
// そのまま postMessage の transfer リストに載せられる (data_worker.js が使う)。
//
// 速度上の要点:
//   * depT昇順の並べ替えを Array.from(2.7M要素) + comparator sort から計数ソートに変えた。
//     depT は「分」の小さい整数なのでバケット法が使える。バケット内は生成順のままなので
//     安定ソートと結果が1要素も変わらない (旧実装の Array#sort も ES2019以降は安定)。
//   * 並べ替え後の並び替えコピーを廃止し、最初から確定位置へ書き込む。
//     中間バッファ(約55MB)と添字配列(約22MB)を丸ごと作らずに済む。
//   * 個数の数え上げは1パスに統合した (旧実装は n と extra で全走査を2回していた)。
function buildConnections(arrayBuffer, opts) {
  const tripLine = opts.tripLine;
  const tripMode = opts.tripMode || null;
  const NS = opts.nStations;
  if (NS * NS > Number.MAX_SAFE_INTEGER) throw new Error('駅数が多すぎてedgeDomのキーが壊れる');

  const dv = new DataView(arrayBuffer);
  if (dv.getUint8(0) !== 0x54 || dv.getUint8(1) !== 0x56 || dv.getUint8(2) !== 0x33) {
    throw new Error('bad trains_v3.bin magic');
  }
  const ntrips = dv.getUint32(4, true);
  const nstops = dv.getUint32(8, true);
  let off = 12;
  const align4 = x => (x + 3) & ~3;
  const srcOff = new Uint32Array(arrayBuffer, off, ntrips + 1);
  off = align4(off + (ntrips + 1) * 4);
  const rawS = new Uint16Array(arrayBuffer, off, nstops); off = align4(off + nstops * 2);
  const rawA = new Uint16Array(arrayBuffer, off, nstops); off = align4(off + nstops * 2);
  const rawD = new Uint16Array(arrayBuffer, off, nstops); off = align4(off + nstops * 2);

  // 保持し続けるものは arrayBuffer を手放せるよう独立バッファへ複製する
  // (Worker から transfer したあと、17MB の元バッファをGCに返せるようにするため)
  const tripOff = new Uint32Array(srcOff);
  const stS = new Uint16Array(rawS);

  // 時刻正規化: trip内で時刻が戻ったら日跨ぎ(+1440)。65535=なし
  const A = new Int32Array(nstops), Dp = new Int32Array(nstops);
  let maxDep = 0;
  for (let t = 0; t < ntrips; t++) {
    let base = 0, prev = -1;
    for (let i = tripOff[t]; i < tripOff[t + 1]; i++) {
      let a = rawA[i] === 65535 ? -1 : rawA[i] + base;
      if (a >= 0 && prev >= 0 && a < prev) { base += 1440; a += 1440; }
      if (a >= 0) prev = a;
      let d = rawD[i] === 65535 ? -1 : rawD[i] + base;
      if (d >= 0 && prev >= 0 && d < prev) { base += 1440; d += 1440; }
      if (d >= 0) prev = d;
      A[i] = a; Dp[i] = d;
      if (d > maxDep) maxDep = d;
    }
  }

  // --- パス1: depT のヒストグラム。深夜跨ぎ用の複製(dep<360 を +1440)も同時に数える
  const NBUCKET = maxDep + 1440 + 2;   // 使う添字は d と d+1440 (d<360) の両方
  const bucket = new Int32Array(NBUCKET);
  let total = 0;
  for (let t = 0; t < ntrips; t++) {
    for (let i = tripOff[t]; i < tripOff[t + 1] - 1; i++) {
      const d = Dp[i];
      if (d >= 0 && (A[i + 1] >= 0 || Dp[i + 1] >= 0)) {
        bucket[d]++; total++;
        if (d < 360) { bucket[d + 1440]++; total++; }
      }
    }
  }
  // 累積和 → 各depTの書き込み開始位置。以降 bucket[] は「次にどこへ書くか」として使い回す。
  let acc = 0;
  for (let b = 0; b < NBUCKET; b++) { const c = bucket[b]; bucket[b] = acc; acc += c; }

  // --- パス2: 確定位置へ直接書き込む (= depT昇順、同時刻内は生成順)
  const cDepS = new Uint16Array(total), cArrS = new Uint16Array(total);
  const cDepT = new Int32Array(total), cArrT = new Int32Array(total);
  const cTrip = new Int32Array(total), cStopI = new Int32Array(total);

  // エッジ(駅間)ごとの路線多数決マップ。直通列車は1本の路線ラベルが全区間に付くため
  // (例:内房線快速が横浜→逗子の横須賀線区間も内房線表記)、区間ごとに最も多く走る路線で
  // 表示を訂正する。専用線の列車が直通より多数なので多数決で正しい路線が選ばれる。
  const edgeCount = new Map();   // dep*NS+arr -> Map(lineIdx->count)
  for (let t = 0; t < ntrips; t++) {
    const li = tripLine[t];
    // バスは直通の誤ラベルが無いので多数決は不要。全国投入時に数十万エントリを
    // 積むだけの純コストになるのでスキップする
    const isBus = tripMode ? tripMode[t] === 1 : false;
    for (let i = tripOff[t]; i < tripOff[t + 1] - 1; i++) {
      const d = Dp[i];
      if (d < 0 || (A[i + 1] < 0 && Dp[i + 1] < 0)) continue;
      const arr = A[i + 1] >= 0 ? A[i + 1] : Dp[i + 1];
      const ds = stS[i], as = stS[i + 1];
      let k = bucket[d]++;
      cDepS[k] = ds; cArrS[k] = as; cDepT[k] = d; cArrT[k] = arr; cTrip[k] = t; cStopI[k] = i;
      if (d < 360) {
        k = bucket[d + 1440]++;
        cDepS[k] = ds; cArrS[k] = as; cDepT[k] = d + 1440; cArrT[k] = arr + 1440;
        cTrip[k] = t; cStopI[k] = i;
      }
      if (isBus) continue;
      const ek = ds * NS + as;
      let lm = edgeCount.get(ek);
      if (!lm) { lm = new Map(); edgeCount.set(ek, lm); }
      lm.set(li, (lm.get(li) || 0) + 1);
    }
  }

  // edgeDom は数万件程度。Map のままだと transfer できないので配列で返す。
  const edgeKey = new Float64Array(edgeCount.size);
  const edgeLine = new Int32Array(edgeCount.size);
  let e = 0;
  for (const [ek, lm] of edgeCount) {
    let best = -1, bc = -1;
    for (const [li, c] of lm) if (c > bc) { bc = c; best = li; }
    edgeKey[e] = ek; edgeLine[e] = best; e++;
  }

  return {
    ntrips, nstops, nConn: total,
    tripOff, stS, stA: A, stD: Dp,
    cDepS, cArrS, cDepT, cArrT, cTrip, cStopI,
    edgeKey, edgeLine,
  };
}

// buildConnections の結果は transfer で受け取れるので、その中身はコピーせずそのまま使う。
// ここに残るのは meta を突き合わせる軽い処理だけ (数十ms)。
function adoptBuild(built, meta, stations, fares) {
  D.stations = stations;
  D.busConn = null;   // データを差し替えたら遅延生成キャッシュを捨てる
  D.fares = fares || null;
  D.lines = meta.lines;
  D.types = meta.types;
  D.tripLine = meta.trips.l;
  D.tripType = meta.trips.t;
  D.tripDest = meta.trips.d;
  D.tripCal = meta.trips.c || null;   // 運転日bit(1平日2土4休)。無ければ無視
  D.tripMode = meta.trips.m || null;  // 0=鉄道 1=バス。無ければ全て鉄道扱い(後方互換)
  D.sources = meta.sources || null;   // バス等の出典表示(CC BY の表示義務)

  D.tripOff = built.tripOff;
  D.stS = built.stS; D.stA = built.stA; D.stD = built.stD;
  D.cDepS = built.cDepS; D.cArrS = built.cArrS;
  D.cDepT = built.cDepT; D.cArrT = built.cArrT;
  D.cTrip = built.cTrip; D.cStopI = built.cStopI;
  D.nConn = built.nConn;

  D.edgeDom = new Map();         // dep*NS+arr -> 最多路線lineIdx
  for (let i = 0; i < built.edgeLine.length; i++) D.edgeDom.set(built.edgeKey[i], built.edgeLine[i]);

  // trip属性 (有料特急/新幹線)
  const ntrips = built.ntrips;
  const paid = new Uint8Array(ntrips), shink = new Uint8Array(ntrips);
  for (let t = 0; t < ntrips; t++) {
    const line = D.lines[D.tripLine[t]] || '';
    const type = D.types[D.tripType[t]] || '';
    const k = expressKind(line, type);
    if (k === 'shinkansen') shink[t] = 1;
    else if (k === 'paid') paid[t] = 1;
  }
  D.tripPaid = paid; D.tripShink = shink;

  // footpaths
  D.foot = {};
  for (const [a, b, w] of meta.footpaths) {
    (D.foot[a] = D.foot[a] || []).push([b, w]);
    (D.foot[b] = D.foot[b] || []).push([a, w]);
  }
}

// 一発で読み込む従来API (node のテスト・スクリプト用。ブラウザは Worker 経由の
// buildConnections + adoptBuild を使う)
function loadBinary(arrayBuffer, meta, stations, fares) {
  adoptBuild(buildConnections(arrayBuffer, {
    tripLine: meta.trips.l,
    tripMode: meta.trips.m || null,
    nStations: stations.length,
  }), meta, stations, fares);
}

function firstConnAfter(t) {
  let lo = 0, hi = D.nConn;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (D.cDepT[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// バス限定検索用のconnection添字(depT昇順を保つ)。全connの3/4は鉄道なので、
// 毎回それを読み飛ばすより添字配列を1本作って舐めるほうが速い。初回検索時に遅延生成。
function busConnIndex() {
  if (D.busConn) return D.busConn;
  const mode = D.tripMode;
  let n = 0;
  for (let c = 0; c < D.nConn; c++) if (mode[D.cTrip[c]] === 1) n++;
  const idx = new Int32Array(n);
  let k = 0;
  for (let c = 0; c < D.nConn; c++) if (mode[D.cTrip[c]] === 1) idx[k++] = c;
  D.busConn = idx;
  return idx;
}

// 添字配列 idx(D.cDepT昇順) の中で cDepT >= t になる最初の位置
function firstIdxAfter(idx, t) {
  let lo = 0, hi = idx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (D.cDepT[idx[mid]] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// CSA earliest-arrival。返値: journey or null
function query(srcIdx, dstIdx, depMin, opts) {
  opts = opts || {};
  const useExpress = opts.express !== false;
  const useShink = opts.shinkansen !== false;
  const banTrips = opts.banTrips || null; // Set of trip ids
  const banLines = opts.banLines || null; // Set of line names (経路多様化用)
  // 運転日フィルタ: opts.day = 0平日/1土曜/2休日。該当日に走る列車のみ。
  const dayMask = (opts.day != null && D.tripCal) ? (1 << opts.day) : 0;
  const mode = D.tripMode;
  // busOnly はバス限定(鉄道を全部落とす)。noBus と同時指定は「バスも鉄道も無し」に
  // なって必ず経路なしになるので、意図が明確な busOnly を優先する。
  const busOnly = !!opts.busOnly && !!mode;
  const noBus = !busOnly && !!opts.noBus && !!mode;   // バスを使わない

  const ns = D.stations.length;
  const arr = new Int32Array(ns).fill(INF);
  const inConn = new Int32Array(ns).fill(-1);   // 到着connインデックス
  const inBoard = new Int32Array(ns).fill(-1);  // そのtripに乗ったconn
  const inFoot = new Int32Array(ns).fill(-1);   // 徒歩で来た場合の元駅
  const tripBoard = new Int32Array(D.tripLine.length).fill(-1);

  arr[srcIdx] = depMin;
  if (D.foot[srcIdx]) {
    for (const [to, w] of D.foot[srcIdx]) {
      if (depMin + w < arr[to]) { arr[to] = depMin + w; inFoot[to] = srcIdx; }
    }
  }

  // バス限定時はバスconnだけを並べた添字配列を走査する(鉄道connを読み飛ばさない)
  const scan = busOnly ? busConnIndex() : null;
  const nScan = scan ? scan.length : D.nConn;
  const c0 = scan ? firstIdxAfter(scan, depMin) : firstConnAfter(depMin);

  for (let ci = c0; ci < nScan; ci++) {
    const c = scan ? scan[ci] : ci;
    const dT = D.cDepT[c];
    if (dT > arr[dstIdx]) break; // これ以降は改善不可
    const trip = D.cTrip[c];
    if (banTrips && banTrips.has(trip)) continue;
    if (banLines && banLines.has(D.lines[D.tripLine[trip]])) continue;
    if (dayMask && !(D.tripCal[trip] & dayMask)) continue;   // 該当運転日でない列車を除外
    if (noBus && mode[trip] === 1) continue;
    if (!useShink && D.tripShink[trip]) continue;
    if (!useExpress && D.tripPaid[trip]) continue;

    const dS = D.cDepS[c];
    let board = tripBoard[trip] !== -1;
    if (!board && arr[dS] < INF) {
      // 同一駅乗換バッファ。出発駅(=直接歩いて来た/検索起点)はバッファ0。
      // バスが絡む乗換(乗る側・降りた側のどちらか)は厚めのバッファを使う
      let buf = 0;
      if (!((dS === srcIdx || inFoot[dS] >= 0) && inConn[dS] === -1)) {
        const prevBus = inConn[dS] >= 0 && mode && mode[D.cTrip[inConn[dS]]] === 1;
        buf = (mode && mode[trip] === 1) || prevBus ? BUS_TRANSFER : MIN_TRANSFER;
      }
      if (arr[dS] + buf <= dT) board = true;
    }
    if (!board) continue;
    if (tripBoard[trip] === -1) tripBoard[trip] = c;

    const aS = D.cArrS[c], aT = D.cArrT[c];
    if (aT < arr[aS]) {
      arr[aS] = aT;
      inConn[aS] = c;
      inBoard[aS] = tripBoard[trip];
      inFoot[aS] = -1;
      if (D.foot[aS]) {
        for (const [to, w] of D.foot[aS]) {
          if (aT + w < arr[to]) {
            arr[to] = aT + w;
            inConn[to] = c;          // 徒歩元の到着conn
            inBoard[to] = tripBoard[trip];
            inFoot[to] = aS;
          }
        }
      }
    }
  }

  if (arr[dstIdx] >= INF) return null;

  // 経路復元
  const legs = [];
  let cur = dstIdx;
  while (cur !== srcIdx) {
    if (inFoot[cur] >= 0 && inConn[cur] === -1) {
      // 起点からの徒歩
      legs.unshift({ kind: 'walk', from: inFoot[cur], to: cur, min: arr[cur] - depMin });
      cur = inFoot[cur];
      continue;
    }
    const viaFoot = inFoot[cur] >= 0;
    const rideEnd = viaFoot ? inFoot[cur] : cur;
    const cEnd = inConn[cur], cStart = inBoard[cur];
    if (cEnd === -1 || cStart === -1) return null; // 整合性エラー
    if (viaFoot) {
      legs.unshift({ kind: 'walk', from: rideEnd, to: cur, min: arr[cur] - D.cArrT[cEnd] });
    }
    const trip = D.cTrip[cEnd];
    // trip内の停車列を stopI で抽出
    const i0 = D.cStopI[cStart], i1 = D.cStopI[cEnd] + 1;
    const shift = D.cDepT[cStart] - D.stD[i0]; // +1440複製conn対応
    const stops = [];
    for (let i = i0; i <= i1; i++) {
      stops.push({
        st: D.stS[i],
        a: D.stA[i] >= 0 ? D.stA[i] + shift : null,
        d: D.stD[i] >= 0 ? D.stD[i] + shift : null,
      });
    }
    // 表示用路線: この乗車区間の各エッジの多数決路線(直通の誤ラベル訂正)。
    // 運賃計算は原ラベル(line)を使うため lineLabel は表示専用。
    const rawLine = D.lines[D.tripLine[trip]];
    let lineLabel = rawLine;
    if (D.edgeDom && stops.length >= 2) {
      const NS = D.stations.length, cnt = new Map();
      for (let s = 0; s + 1 < stops.length; s++) {
        const dom = D.edgeDom.get(stops[s].st * NS + stops[s + 1].st);
        if (dom != null && dom >= 0) cnt.set(dom, (cnt.get(dom) || 0) + 1);
      }
      let best = -1, bc = 0;
      for (const [li, c] of cnt) if (c > bc) { bc = c; best = li; }
      if (best >= 0) lineLabel = D.lines[best];
    }
    legs.unshift({
      kind: 'ride', trip,
      mode: (D.tripMode && D.tripMode[trip]) || 0,   // 0=鉄道 1=バス
      line: rawLine,
      lineLabel,
      type: D.types[D.tripType[trip]],
      dest: D.tripDest[trip],
      stops,
      dep: D.cDepT[cStart], arr: D.cArrT[cEnd],
      from: D.cDepS[cStart], to: rideEnd,
    });
    cur = D.cDepS[cStart];
  }

  // ループ簡約: あるrideが起点を再通過するなら、そこから乗る形に直す
  // (同着タイで「一駅戻って同じ列車に乗る」経路が出るのを防ぐ)
  let trimLeg = -1, trimStop = -1;
  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li];
    if (leg.kind !== 'ride') continue;
    for (let si = 0; si < leg.stops.length - 1; si++) {
      if (leg.stops[si].st === srcIdx && leg.stops[si].d != null && (li > 0 || si > 0)) {
        trimLeg = li; trimStop = si;
      }
    }
  }
  if (trimLeg >= 0) {
    const leg = legs[trimLeg];
    leg.stops = leg.stops.slice(trimStop);
    leg.from = srcIdx;
    leg.dep = leg.stops[0].d;
    legs.splice(0, trimLeg);
  }

  const rides = legs.filter(l => l.kind === 'ride');
  if (!rides.length) return null;
  return {
    legs,
    dep: legs[0].kind === 'walk' ? journeyWalkAdjustedDep(legs) : rides[0].dep,
    arr: arr[dstIdx],
    transfers: rides.length - 1,
  };
}

function journeyWalkAdjustedDep(legs) {
  // 先頭が徒歩の場合: 最初の乗車に間に合う出発時刻
  const ride = legs.find(l => l.kind === 'ride');
  let walk = 0;
  for (const l of legs) {
    if (l.kind === 'ride') break;
    walk += l.min;
  }
  return ride.dep - walk;
}

// --- 距離・運賃 (router.jsの方式を踏襲: 停車列に沿ったhaversine×1.12) ---
function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371, rad = Math.PI / 180;
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
  const a = Math.sin(dLa / 2) ** 2 +
    Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function legKm(leg) {
  // 座標欠損駅はスキップし、直前の座標既知駅からブリッジして距離を落とさない
  let km = 0, prev = null;
  for (let i = 0; i < leg.stops.length; i++) {
    const s = D.stations[leg.stops[i].st];
    if (s.la == null) continue;
    if (prev) km += haversineKm(prev.la, prev.lo, s.la, s.lo) * RAIL_KM_FACTOR;
    prev = s;
  }
  return km;
}

function canonLine(s) {
  if (!s) return '';
  return s
    .replace(/ＪＲ|JR/g, '')
    .replace(/東京メトロ/g, '')
    .replace(/都営地下鉄/g, '都営')
    .replace(/京浜急行電鉄/g, '京急')
    .replace(/東武鉄道/g, '東武')
    .replace(/西武鉄道/g, '西武')
    .replace(/京成電鉄/g, '京成')
    .replace(/京王電鉄/g, '京王')
    .replace(/小田急電鉄/g, '小田急')
    .replace(/東急電鉄/g, '東急')
    .replace(/相模鉄道/g, '相鉄')
    .replace(/北総鉄道北総線/g, '北総鉄道')
    .replace(/[ 　]/g, '');
}

let _companyCanon = null, _companyPrefix = null;
function lineCompany(line) {
  if (!D.fares) return '';
  if (!_companyCanon) {
    _companyCanon = {};
    _companyPrefix = [];
    for (const [company, data] of Object.entries(D.fares.companies)) {
      for (const name of (data.match || [])) _companyCanon[canonLine(name)] = company;
      for (const p of (data.prefix || [])) _companyPrefix.push([canonLine(p), company]);
    }
    // 最長プレフィクス優先 (例: 「京成スカイアクセス」>「京成」)
    _companyPrefix.sort((a, b) => b[0].length - a[0].length);
  }
  const c = canonLine(line);
  if (_companyCanon[c]) return _companyCanon[c]; // 例外はexact優先
  for (const [p, company] of _companyPrefix) {
    if (c.startsWith(p)) return company;
  }
  // 事業者プレフィクスで判定 (上野東京ライン・京浜東北・根岸線など
  // テーブルの路線名と一致しないＪＲ系統名対策)
  if (/^(ＪＲ|JR)/.test(line)) {
    if (line.includes('東海道新幹線') || line.includes('東海道・山陽')) {
      return D.fares.companies['JR東海'] ? 'JR東海' : 'JR東日本';
    }
    return 'JR東日本';
  }
  if (line.includes('東京メトロ')) return '東京メトロ';
  if (line.includes('都営')) return '都営地下鉄';
  return '';
}

// JR地域会社の判定: 路線名は「ＪＲ東海道本線」のように会社を跨ぐため、
// レグの停車駅重心から最近傍アンカー都市で会社を決める
const JR_ANCHORS = [
  ['JR北海道', 43.07, 141.35], ['JR北海道', 41.77, 140.73],
  ['JR東日本', 39.70, 141.14], ['JR東日本', 38.26, 140.88],
  ['JR東日本', 37.91, 139.06], ['JR東日本', 35.68, 139.77],
  ['JR東日本', 36.65, 138.19], ['JR東日本', 34.97, 139.09], // 伊東(伊豆=JR東)
  ['JR東日本', 35.67, 138.57], // 甲府
  ['JR東海', 35.17, 136.88], ['JR東海', 34.97, 138.39],
  ['JR東海', 36.14, 137.25], ['JR東海', 35.16, 138.68], // 高山・富士
  ['JR西日本', 36.56, 136.66], ['JR西日本', 35.31, 136.29],
  ['JR西日本', 34.70, 135.50], ['JR西日本', 35.49, 134.22],
  ['JR西日本', 34.66, 133.92], ['JR西日本', 34.40, 132.47],
  ['JR西日本', 33.95, 130.94], // 下関
  ['JR四国', 34.35, 134.05], ['JR四国', 33.84, 132.77],
  ['JR四国', 33.57, 133.54], ['JR四国', 34.07, 134.55],
  ['JR九州', 33.89, 130.88], ['JR九州', 33.59, 130.42],
  ['JR九州', 32.79, 130.69], ['JR九州', 31.59, 130.54],
  ['JR九州', 33.24, 131.61],
];

function jrCompanyByGeo(stops) {
  let la = 0, lo = 0, n = 0;
  for (const s of stops) {
    const st = D.stations[s.st];
    if (st.la != null) { la += st.la; lo += st.lo; n++; }
  }
  if (!n) return 'JR東日本';
  la /= n; lo /= n;
  let best = 'JR東日本', bd = Infinity;
  for (const [co, ala, alo] of JR_ANCHORS) {
    const dla = la - ala, dlo = (lo - alo) * 0.82; // 経度の距離補正(緯度35度付近)
    const d = dla * dla + dlo * dlo;
    if (d < bd) { bd = d; best = co; }
  }
  return (D.fares && D.fares.companies[best]) ? best : 'JR東日本';
}

// 京阪神電車特定区間の座標ボックス(2025-04拡大後を内包する近似)。
// 網干(東経134.5)〜野洲/草津(東経136.05)、和歌山(北緯34.2)〜京都/草津(北緯35.1)
//
// 判定は「全停車駅がボックス内」。重心で見ると、区間の一部が京阪神を通るだけの
// 長距離(東京→博多は重心が神戸あたりに落ちる)まで電車特定区間の安いテーブルに
// 化けてしまい、1175km の乗車券が ¥3,200 になっていた。電特は区間限定の特例なので、
// 区間がエリアからはみ出したら通常の幹線テーブルに戻すのが正しい。
function inKeihanshin(stops) {
  let n = 0;
  for (const s of stops) {
    const st = D.stations[s.st];
    if (st.la == null) continue;
    n++;
    if (!(st.la >= 34.2 && st.la <= 35.1 && st.lo >= 134.5 && st.lo <= 136.05)) return false;
  }
  return n > 0;
}

// JR特定運賃(私鉄競合区間): セグメント端点の駅名ペアで照合(両順)
function jrSpecialFare(stops) {
  if (!D.fares || !D.fares.jr_special || stops.length < 2) return null;
  const a = D.stations[stops[0].st].n, b = D.stations[stops[stops.length - 1].st].n;
  const sp = D.fares.jr_special;
  const v = sp[a + '|' + b];
  if (v != null) return v;
  const v2 = sp[b + '|' + a];
  return v2 != null ? v2 : null;
}

function lookupFare(company, distKm) {
  if (!D.fares) return Math.round(distKm * 25);
  const cd = D.fares.companies[company];
  if (!cd) return Math.round(distKm * (D.fares.default_fare_per_km || 25));
  if (cd.km_scale) distKm *= cd.km_scale; // 会社別の線形補正(野田線・京成本線等)
  const km = Math.ceil(distKm); // 運賃計算は営業キロ切り上げ
  for (const [maxDist, fare] of cd.ic_fare) {
    if (km <= maxDist) return fare;
  }
  return cd.ic_fare[cd.ic_fare.length - 1][1];
}

// 加算運賃(空港アクセス等): 乗車起点/降車終点が対象駅かつ該当会社の利用なら加算。
// 会社はレグのラベルではなく解決済みセグメント(スカイライナーの本線ラベル誤り対策)
function journeySurcharge(journey, firstCompany, lastCompany) {
  if (!D.fares || !D.fares.surcharges) return [];
  const rides = journey.legs.filter(l => l.kind === 'ride' && l.mode !== 1);
  if (!rides.length) return [];
  const first = rides[0], last = rides[rides.length - 1];
  const oName = D.stations[first.stops[0].st].n;
  const dName = D.stations[last.stops[last.stops.length - 1].st].n;
  const out = [];
  for (const rule of D.fares.surcharges) {
    // company指定があれば該当会社の乗車時のみ(成田空港はJR利用なら加算なし)。
    // 駅名で一意な場合(羽田(京急)等)はcompany省略で直通列車のラベル揺れに耐える
    const hit =
      (rule.stations.includes(oName) && (!rule.company || firstCompany === rule.company)) ||
      (rule.stations.includes(dName) && (!rule.company || lastCompany === rule.company));
    if (hit) out.push({ company: rule.label || rule.company + '(加算)', dist: 0, fare: rule.yen });
  }
  return out;
}

// === wl(Wikidata路線名)のJR判定 — 実在するＪＲ路線名リストとの照合 (Issue #15) ===
// wl は事業者接頭辞の無い素の名前(東海道本線・関西空港線)で入るため、ＪＲ接頭辞付き
// 前提の lineCompany では解決できない。D.lines の全ＪＲ系統が「ＪＲ」始まりである事実
// (PR #9 の lineOperator と同じデータ検証)を使い、接頭辞を剥がした実体リストを作る。

// 運行系統名(D.lines)からは導出できないが wl に現れる実在のＪＲ名(貨物線・支線・愛称)
const JR_WL_ALIASES = [
  '赤羽線', '品鶴線', '山手貨物線', '高島線', '梅田貨物線', '美濃赤坂線',
  '和田岬線', '海峡線', '利府線', '琵琶湖線', '大和路線', '瀬戸大橋線',
  '福北ゆたか線', '中央・総武緩行線', 'ガーラ湯沢線',
];
// 接頭辞を剥がすと地下鉄路線と同名になるもの。wl が素の「東西線」「中央線」を使うのは
// 地下鉄側(京都市営・大阪メトロ)で、ＪＲ東西線・ＪＲ中央線の駅は wl にＪＲ接頭辞付きか
// 「中央本線」等で入るため、bare照合からは除外して誤爆を防ぐ
const JR_BARE_AMBIGUOUS = ['東西線', '中央線'];
let _jrBareNames = null, _jrBareFrom = null;
function jrBareNames() {
  if (_jrBareNames && _jrBareFrom === D.lines) return _jrBareNames;
  const set = new Set();
  for (const name of (D.lines || [])) {
    const m = name.match(/^(?:ＪＲ|JR)(.+)$/);
    if (!m) continue;
    const bare = m[1].replace(/[ 　]/g, '');
    set.add(bare);
    // 「京浜東北・根岸線」のような連結系統名は wl では「京浜東北線」「根岸線」で現れる
    if (bare.includes('・')) {
      for (let part of bare.split('・')) {
        if (!part) continue;
        if (!/線$/.test(part)) part += '線';
        if (part.length >= 3) set.add(part);
      }
    }
  }
  for (const a of JR_WL_ALIASES) set.add(a);
  for (const a of JR_BARE_AMBIGUOUS) set.delete(a);
  _jrBareNames = set;
  _jrBareFrom = D.lines;
  return set;
}
// wl の路線名 → 照合キー。区間注記や括弧書きを落とす
// ('根室本線: 釧路 => 根室' → '根室本線', '東海道本線（美濃赤坂線）' → '東海道本線')
function isJRBareLine(ln) {
  if (/^(ＪＲ|JR)/.test(ln)) return true;
  const key = ln.split(/[:：（(]/)[0].replace(/[ 　]/g, '');
  if (/新幹線$/.test(key)) return true;   // 新幹線は全社JR(「東海道新幹線」等も素の名前)
  const jr = jrBareNames();
  if (jr.has(key)) return true;
  // 「成田線我孫子支線」「鶴見線海芝浦支線」は本体の「成田線」「鶴見線」で照合
  const m = key.match(/^(.+線).+支線$/);
  return !!(m && jr.has(m[1]));
}

// 駅の所属会社集合 (wl=Wikidata由来の実乗り入れ路線→会社。JR各社は'JR'に丸めて通算扱い)
// 注意: st.l は直通列車のラベル路線で汚染されている(みなとみらい駅に西武池袋線等)ので使わない
let _stCompanies = null;
function stationCompanies(stIdx) {
  if (!_stCompanies) _stCompanies = new Map();
  let cs = _stCompanies.get(stIdx);
  if (cs !== undefined) return cs;
  const st = D.stations[stIdx];
  cs = new Set();
  for (const ln of (st.wl || [])) {
    let c = lineCompany(ln);
    if (!c) {
      if (isJRBareLine(ln)) c = 'JR';
      else continue;
    } else if (c.startsWith('JR') || /^(ＪＲ|JR)/.test(ln)) {
      c = 'JR';
    } else if (c === '東京メトロ' && !ln.includes('東京メトロ')) {
      // canonLine が「東京メトロ」を剥ぐため、京都市営・札幌市営の素の「東西線」「南北線」
      // も東京メトロに exact 一致してしまう。東京メトロ駅の wl は全て接頭辞付きなので、
      // 素の名前からの東京メトロ判定は捨てる(該当駅は legC フォールバックで正しく付く)
      continue;
    }
    cs.add(c);
  }
  _stCompanies.set(stIdx, cs);
  return cs;
}

// 直通列車レグを会社境界で分割 (浅草線⇄京急/京成、副都心線⇄東横線等)。
// 区間(i-1,i)の会社 = 両駅の所属会社の積集合。複数候補は直前区間との連続性優先、
// それも無ければ「この先で最も長く続く会社」(先読み)
function lookaheadPick(cands, stops, i) {
  let best = cands[0], bestRun = -1;
  for (const c of cands) {
    let run = 0;
    for (let j = i; j < stops.length; j++) {
      if (stationCompanies(stops[j].st).has(c)) run++;
      else break;
    }
    if (run > bestRun) { bestRun = run; best = c; }
  }
  return best;
}

function legParts(leg) {
  const legC0 = lineCompany(leg.line);
  const legIsJR = /^(ＪＲ|JR)/.test(leg.line) || legC0.startsWith('JR');
  const legC = legIsJR ? 'JR' : legC0;
  // 新幹線legは単一JR(会社跨ぎも運賃は距離通算)。運賃距離も営業キロΔで正確に。
  // 直線距離だと東京-新大阪が440km(営業552)になり運賃を1000円超過小評価する。
  if (leg.line && leg.line.includes('新幹線')) {
    return [{ company: legC, dist: shinkansenKm(leg), stops: leg.stops.slice() }];
  }
  const parts = [];
  let cur = null;
  let prevGeo = null; // 直前の座標既知駅 (欠損ブリッジ)
  for (let i = 0; i < leg.stops.length; i++) {
    const stI = leg.stops[i].st, st = D.stations[stI];
    if (i > 0) {
      const a = stationCompanies(leg.stops[i - 1].st);
      const b = stationCompanies(stI);
      // 区間(i-1,i)の運賃会社を決める。wlは直通乗り入れ(中目黒にMM線等)や欠落
      // (なんばに無し)で汚れるため、列車ラベルlegCと駅wlを突き合わせて頑健に判定:
      //  1) 両駅共通会社にlegCがある → legC(その社の自社線区間で確実)
      //  2) 共通会社が別にある → それ(直通でラベルが別社になってる区間。例:渋谷→中目黒)
      //  3) 共通ゼロ: ラベル社が片方にあればlegC(例:浜松町JR→モノ)、
      //     両駅とも別社判明なら直通境界(継続)、片方wl欠落なら実在側の単一社(例:梅田→なんば)
      const cands = [...a].filter(x => b.has(x));
      let c;
      if (cands.indexOf(legC) >= 0) {
        c = legC;
      } else if (cands.length) {
        if (cands.length === 1) c = cands[0];
        else if (cur && cands.indexOf(cur.company) >= 0) c = cur.company;
        else c = lookaheadPick(cands, leg.stops, i);
      } else if (a.has(legC) || b.has(legC)) {
        c = legC;
      } else if (a.size && b.size) {
        c = cur ? cur.company : legC; // 両駅とも別社=直通境界
      } else {
        const k = a.size ? a : b;     // 片方wl欠落 → 実在側の単一社
        c = k.size === 1 ? [...k][0] : legC;
      }
      let km = 0;
      if (st.la != null && prevGeo) {
        km = haversineKm(prevGeo.la, prevGeo.lo, st.la, st.lo) * RAIL_KM_FACTOR;
      }
      if (!cur || cur.company !== c) {
        cur = { company: c, dist: 0, stops: [leg.stops[i - 1]] };
        parts.push(cur);
      }
      cur.dist += km;
      cur.stops.push(leg.stops[i]);
    }
    if (st.la != null) prevGeo = st;
  }
  if (!parts.length) parts.push({ company: legC, dist: 0, stops: leg.stops.slice() });
  return parts;
}

// 通算グループ: グループ内は会社が変わっても距離を通算して1枚のテーブルで引く。
// JR6社(実制度も通算ベース)、京成⇄スカイアクセス(SA運賃は京成の通し体系で、
// SAテーブル自体を上野/日暮里発の全行程実額でフィットしてあるため)
function fareGroup(c) {
  if (c === 'JR') return 'JR';
  if (c === '京成' || c === '京成スカイアクセス') return '京成G';
  return c;
}

// --- 特急料金 (乗車券への加算: 新幹線/在来線有料特急) ---
function bandLookup(table, km) {
  const k = Math.ceil(km);
  for (const [mx, yen] of table) if (k <= mx) return yen;
  return table[table.length - 1][1];
}

function shinkansenGroup(line) {
  const ex = D.fares && D.fares.express;
  if (!ex) return null;
  for (const [sub, key] of ex.shinkansen_groups) if (line.includes(sub)) return key;
  return null;
}

// legの新幹線系統を決める。ミニ新幹線は種別で(こまち=秋田/つばさ=山形)、
// 山陽内(新大阪以西)は東海道より安い独自体系なので営業キロ位置で振り分け。
function shinkansenGroupFor(leg) {
  const ex = D.fares && D.fares.express;
  const t = leg.type || '';
  const strip = n => n.replace(/[（(].*?[）)]/g, '');
  const ekm = ex && ex.eigyo_km;
  const a = ekm ? ekm[strip(D.stations[leg.from].n)] : null;
  const b = ekm ? ekm[strip(D.stations[leg.to].n)] : null;
  // ミニ新幹線: 秋田(盛岡535以遠)/山形(福島273以遠)区間に入る時のみ通し体系。
  // 東北区間のみ(東京→仙台のこまち等)は東北base。
  if (t.includes('こまち') && a != null && b != null && Math.max(a, b) > 535) return 'akita';
  if (t.includes('つばさ') && a != null && b != null && Math.max(a, b) > 273) return 'yamagata';
  let g = shinkansenGroup(leg.line) || 'tokaido';
  if (g === 'tokaido' && a != null && b != null && Math.min(a, b) >= 550) g = 'sanyo'; // 新大阪以西
  return g;
}

// 新幹線legの営業キロ: 始終点駅を営業キロ表で引いて差分。直線距離(haversine)は
// 路線の曲がり・停車駅疎で誤差が大きいため、特急料金は実営業キロで計算する。
function shinkansenKm(leg) {
  const ex = D.fares && D.fares.express;
  const ekm = ex && ex.eigyo_km;
  if (!ekm) return legKm(leg);
  const strip = n => n.replace(/[（(].*?[）)]/g, '');
  const a = ekm[strip(D.stations[leg.from].n)];
  const b = ekm[strip(D.stations[leg.to].n)];
  if (a != null && b != null) return Math.abs(b - a);
  return legKm(leg);
}

// 在来線/私鉄有料列車の料金: 固有名定額→会社別table。不明な私鉄特急は0(安全側)
function convExpressFare(type, line, km) {
  const ex = D.fares.express;
  for (const [name, yen] of Object.entries(ex.conv_by_name || {})) {
    if (type.includes(name)) return yen;
  }
  const c = lineCompany(line);
  const key = isJRLine(line) ? 'JR' : (ex.conventional[c] ? c : null);
  if (!key) return 0;
  return bandLookup(ex.conventional[key], km);
}

// --- 座席種別(指定席/自由席) ---
const SEAT_RESERVED = 'reserved';
const SEAT_NONRESERVED = 'nonreserved';

// 課金単位uに自由席があるなら指定席料金からの控除額(負値)、無ければ null。
// fares.json の express.seat に系統/会社のbandが無い = その列車に自由席の設定が無い、
// という約束にしてある(私鉄の座席指定制列車・ミニ新幹線・全車指定席のJR特急)。
function seatDelta(u) {
  const ex = D.fares && D.fares.express;
  const seat = ex && ex.seat;
  if (!seat) return null;
  const type = u.type || '';
  if ((seat.reserved_only || []).some(n => type.includes(n))) return null;
  if (u.kind === 'shinkansen') {
    const tb = (seat.shinkansen || {})[u.group];
    return tb ? bandLookup(tb, u.km) : null;
  }
  // 固有名で定額を引く列車(スカイライナー/ミュースカイ等)は全て座席指定制
  for (const name of Object.keys(ex.conv_by_name || {})) if (type.includes(name)) return null;
  const key = isJRLine(u.line) ? 'JR' : lineCompany(u.line);
  const tb = (seat.conventional || {})[key];
  return tb ? bandLookup(tb, u.km) : null;
}

// journey全体の特急料金内訳。連続する同系統の新幹線legは通算1枚にまとめ、
// 新幹線に隣接するJR在来線特急は乗継割引(半額)。
// seat: 'reserved'(既定) | 'nonreserved'。自由席の設定が無い列車(全車指定席)は
// seat に関わらず指定席料金のまま出す。
function expressFares(journey, seat) {
  const ex = D.fares && D.fares.express;
  if (!ex) return [];
  const rides = journey.legs.filter(l => l.kind === 'ride');
  // 各legの課金単位を構築
  const units = [];
  rides.forEach((leg, j) => {
    const k = expressKind(leg.line, leg.type);
    if (!k) return;
    const km = k === 'shinkansen' ? shinkansenKm(leg) : legKm(leg);
    if (k === 'shinkansen') {
      const group = shinkansenGroupFor(leg);
      const last = units[units.length - 1];
      if (last && last.kind === 'shinkansen' && last.group === group && last.j === j - 1) {
        last.km += km; last.j = j;                 // 同系統の通し乗車は通算
        if (premiumYen(ex, last.group, leg.type, last.km) > premiumYen(ex, last.group, last.type, last.km)) last.type = leg.type;
      } else {
        units.push({ kind: 'shinkansen', group, km, type: leg.type, j });
      }
    } else {
      units.push({ kind: 'paid', type: leg.type, line: leg.line, km, j });
    }
  });
  const out = [];
  units.forEach((u, k) => {
    const delta = seatDelta(u);            // null=自由席なし(全車指定席)
    const nonres = delta != null && seat === SEAT_NONRESERVED;
    // 自由席がある列車だけ席種を明記する。全車指定席は種別名で自明なので付けない。
    const suffix = delta == null ? '' : (nonres ? '(自由席)' : '(指定席)');
    if (u.kind === 'shinkansen') {
      const base = bandLookup(ex.groups[u.group], u.km);
      // 自由席には速達加算(のぞみ/はやぶさ等)が乗らないので base+delta で引き直す
      const fare = nonres ? base + delta : base + premiumYen(ex, u.group, u.type, u.km);
      out.push({ company: (u.type || '新幹線') + '特急料金' + suffix, dist: 0, fare,
                 seat: nonres ? SEAT_NONRESERVED : SEAT_RESERVED, seatOptional: delta != null });
    } else {
      let fare = convExpressFare(u.type, u.line, u.km);
      if (!fare) return;
      if (nonres) fare = Math.max(0, fare + delta);
      // 乗継割引: 新幹線と隣接するJR在来線特急は半額
      const adjShink = (units[k - 1] && units[k - 1].kind === 'shinkansen') ||
                       (units[k + 1] && units[k + 1].kind === 'shinkansen');
      if (adjShink && isJRLine(u.line)) fare = Math.floor(fare / 2 / 10) * 10;
      out.push({ company: (u.type || '特急') + '料金' + suffix, dist: 0, fare,
                 seat: nonres ? SEAT_NONRESERVED : SEAT_RESERVED, seatOptional: delta != null });
    }
  });
  return out;
}

function premiumYen(ex, group, type, km) {
  if (!type || !ex.premium) return 0;
  for (const [name, table] of Object.entries(ex.premium)) {
    if (type.includes(name)) return bandLookup(table, km);
  }
  return 0;
}

// opts.seat: 'reserved'(既定) | 'nonreserved'。乗車券部分は席種で変わらないので、
// 席種の効くのは特急料金だけ。戻り値の seatFares は「自由席を選べる列車を含む場合のみ」
// {reserved, nonreserved} が入る(全車指定席だけの経路や特急なしの経路では null)。
function journeyFare(journey, opts) {
  const seat = (opts && opts.seat) === SEAT_NONRESERVED ? SEAT_NONRESERVED : SEAT_RESERVED;
  // レグ→会社分割パーツ→隣接同グループをマージして運賃合算。
  // バスレグは fares.json(鉄道の営業キロ制)の対象外なので運賃計算から外し、
  // 本数だけ返す(UIは「バス運賃別途」と出す)。
  const segs = [];
  let busLegs = 0;
  for (const leg of journey.legs) {
    if (leg.kind !== 'ride') continue;
    if (leg.mode === 1) { busLegs++; continue; }
    for (const p of legParts(leg)) {
      const isJR = p.company === 'JR';
      const last = segs[segs.length - 1];
      if (last && fareGroup(last.company) === fareGroup(p.company)) {
        last.dist += p.dist;
        last.stops = last.stops.concat(p.stops);
        // 京成グループはSA区間を含むならSAテーブル(空港加算込み)を採用
        if (p.company === '京成スカイアクセス') last.company = '京成スカイアクセス';
      } else {
        segs.push({ company: p.company, dist: p.dist, jr: isJR, stops: p.stops.slice() });
      }
    }
  }
  let total = 0;
  const breakdown = [];
  for (const s of segs) {
    if (s.dist <= 0) continue;
    if (s.jr) {
      const co = jrCompanyByGeo(s.stops); // 重心で地域会社を確定
      // 1) 特定運賃(私鉄競合区間)が端点ペアにあれば最優先
      const sp = jrSpecialFare(s.stops);
      if (sp != null) {
        s.company = co;
        total += sp; breakdown.push({ company: co + '(特定)', dist: s.dist, fare: sp });
        continue;
      }
      // 2) JR西の京阪神エリアは電車特定区間テーブル
      s.company = (co === 'JR西日本' && inKeihanshin(s.stops)) ? 'JR西日本電特' : co;
    }
    const fare = lookupFare(s.company, s.dist);
    total += fare; breakdown.push({ company: s.company, dist: s.dist, fare });
  }
  const fc = segs.length ? segs[0].company : '';
  const lc = segs.length ? segs[segs.length - 1].company : '';
  for (const s of journeySurcharge(journey, fc, lc)) {
    total += s.fare; breakdown.push(s);
  }
  // 乗継割引(運賃側): 隣接セグが対象会社ペアなら控除/加算 (メトロ⇄都営-70等)
  const td = D.fares && D.fares.transfer_discounts;
  if (td) {
    const usedCos = new Set(segs.map(s => s.company));
    for (const rule of td) {
      // 経路が両社を含めば1回だけ適用(乗継割引は通しで1回)
      if (rule.companies.every(c => usedCos.has(c))) {
        total += rule.yen;
        breakdown.push({ company: rule.label, dist: 0, fare: rule.yen });
      }
    }
  }
  // 特急料金(乗車券への加算)
  const exFares = expressFares(journey, seat);
  for (const e of exFares) {
    total += e.fare; breakdown.push(e);
  }
  // 席種を選べる列車が1本でもあれば、両方の総額を出して UI に選ばせる。
  let seatFares = null;
  if (exFares.some(e => e.seatOptional)) {
    const sum = arr => arr.reduce((a, b) => a + b.fare, 0);
    const ticket = total - sum(exFares);
    seatFares = {
      reserved: ticket + sum(seat === SEAT_RESERVED ? exFares : expressFares(journey, SEAT_RESERVED)),
      nonreserved: ticket + sum(seat === SEAT_NONRESERVED ? exFares : expressFares(journey, SEAT_NONRESERVED)),
    };
  }
  return { total, breakdown, busLegs, seat, seatFares };
}

function journeyKm(journey) {
  let km = 0;
  for (const leg of journey.legs) if (leg.kind === 'ride') km += legKm(leg);
  return km;
}

// --- 複数候補検索 ---
// 1) 最早到着 2) 次発(出発+1) 3) その次 4) 有料優等抜き — を集めて重複排除
function findJourneys(srcIdx, dstIdx, depMin, opts) {
  opts = opts || {};
  const out = [];
  const sigs = new Set();

  // 重複判定は「利用者に見えるもの」で行う。原ラベル(line)は直通運転で系統名が
  // ブレる(横浜線の列車がＪＲ京浜東北・根岸線と記録される等)ため、原ラベルで
  // 区別すると同じ列車・同じ時刻の経路が別物として2本並び、候補枠を食い潰す。
  // 表示用に多数決補正済みの lineLabel と発着駅・発着時刻で判定する。
  function sig(j) {
    return j.legs.map(l => l.kind === 'ride'
      ? `${l.lineLabel || l.line}:${l.type}:${l.from}@${l.dep}>${l.to}@${l.arr}`
      : `w${l.from}-${l.to}`).join('|');
  }
  function add(j) {
    if (!j) return false;
    if (j.arr <= j.dep) return false;      // 日跨ぎ計算崩れの不正経路(到着≦出発)を排除
    const s = sig(j);
    if (sigs.has(s)) return false;
    sigs.add(s);
    out.push(j);
    return true;
  }

  const first = query(srcIdx, dstIdx, depMin, opts);
  if (!first) return out;
  add(first);

  // 次発以降を複数本(発車時刻の異なる候補を増やす)
  let t = first.dep + 1;
  for (let i = 0; i < 4; i++) {
    const j = query(srcIdx, dstIdx, t, opts);
    if (!j) break;
    add(j);
    t = j.dep + 1;
  }
  // 優等抜き候補 (firstが有料優等/新幹線を使っている場合)
  const usesPaid = first.legs.some(l => l.kind === 'ride' &&
    (D.tripPaid[l.trip] || D.tripShink[l.trip]));
  if (usesPaid && opts.express !== false) {
    add(query(srcIdx, dstIdx, depMin, Object.assign({}, opts, { express: false, shinkansen: false })));
  }
  // 最初の乗車tripを禁止した別経路
  const ban = new Set([first.legs.find(l => l.kind === 'ride').trip]);
  add(query(srcIdx, dstIdx, depMin, Object.assign({}, opts, { banTrips: ban })));

  // 経路多様化: これまでの候補が使った路線を禁止して再探索し、別系統の直通
  // (例: 柏→大宮の東武野田線、船橋→五反田の京成本線直通)を発掘する。最速優先CSAだと
  // 速い迂回に隠れて直通が出ないため。junkはランキング+slice(下記)で落ちる。
  // ただし出発駅から出る唯一の足(フィーダー路線=各経路の最初の乗車路線)はbanしない。
  // banすると始発駅が孤立して以後の多様化が全滅する(高柳の東武野田線など)。
  for (let iter = 0; iter < 6; iter++) {
    const keep = new Set();   // 各候補の最初の乗車路線=フィーダーは温存
    const banLines = new Set();
    for (const j of out) {
      const first = j.legs.find(l => l.kind === 'ride');
      if (first) keep.add(first.line);
    }
    for (const j of out) for (const l of j.legs) {
      if (l.kind === 'ride' && !keep.has(l.line)) banLines.add(l.line);
    }
    if (banLines.size === 0) break;
    if (!add(query(srcIdx, dstIdx, depMin, Object.assign({}, opts, { banLines })))) break;
  }

  // ランキング: 「実効到着時刻」= 到着 + 乗換ペナルティ + 割高分の時間換算 で比較する。
  //
  // 以前は有料優等に一律+18分の固定ペナルティを課していたが、固定値では
  // 「¥2500払って4分速い新横浜→品川の新幹線一駅」と「¥5700払って6時間速い
  // 東京→新大阪」を区別できず、前者が上位に残っていた(菊名→五反田、町田→品川、
  // 大宮→横浜などで新幹線一駅・二駅が1〜3位を占めていた)。
  // 実際の運賃差を時間に換算すれば、料金に見合う時だけ優等が上に来る。
  // 同時に、所要時間が同じで運賃だけ高い経路(川崎→新宿のりんかい線経由 ¥628 と
  // 埼京線経由 ¥440 が同着)も安い方が上に来る。
  const YEN_PER_MIN = 40;    // 時間価値≒¥2400/時。¥40余分に払う価値があるのは1分speedupから
  const PAID_PENALTY = 18;   // 運賃を算出できない経路(バス絡み)向けのフォールバック
  const TRANSFER_PEN = 4;    // 乗換1回=+4分扱い
  const MAX_FARE_PEN = 120;  // 換算ペナルティの上限(長距離で運賃差が支配しないように)

  function usesPaidJ(j) {
    return j.legs.some(l => l.kind === 'ride' &&
      (D.tripPaid[l.trip] || D.tripShink[l.trip]));
  }
  // バスを含む経路は fares.json の対象外で総額が出ない(journeyFareがbusLegsを返す)。
  // 運賃不明の経路は基準にも入れず、従来どおり固定ペナルティで扱う。
  function fareOf(j) {
    let f;
    try { f = journeyFare(j, { seat: opts.seat }); } catch (e) { return null; }
    if (!f || f.busLegs) return null;
    return (Number.isFinite(f.total) && f.total > 0) ? f.total : null;
  }
  const fareCache = out.map(fareOf);
  const knownFares = fareCache.filter(f => f != null);
  const baseFare = knownFares.length ? Math.min.apply(null, knownFares) : null;

  function farePen(j, i) {
    const paid = usesPaidJ(j);
    const f = fareCache[i];
    if (f == null || baseFare == null) return paid ? PAID_PENALTY : 0;
    const pen = Math.min((f - baseFare) / YEN_PER_MIN, MAX_FARE_PEN);
    // 特急料金テーブルに載っていない列車(例: 原ラベルが「箱根登山電車」になっている
    // 小田急ロマンスカー)は総額に料金が乗らず、換算ペナルティが0になってしまう。
    // 有料優等は最低でも従来の固定ペナルティを負う、を下限として担保する。
    return paid ? Math.max(pen, PAID_PENALTY) : pen;
  }
  const score = out.map((j, i) => j.arr + j.transfers * TRANSFER_PEN + farePen(j, i));
  const key = new Map(out.map((j, i) => [j, score[i]]));

  // 比較は必ず推移的にする。旧実装は「Math.abs(差) > 5 なら差で比較、さもなくば
  // 乗換数で比較」という閾値比較だったため A≈B, B≈C, A<C のような非推移的な順序に
  // なり、Array#sort の結果が候補の生成順に依存して安定しなかった
  // (同じ検索条件でも候補の集まり方次第で並びが変わりうる)。
  // 乗換の重みは既に TRANSFER_PEN としてスコアに入っているので、閾値を設けず
  // スコアそのもので比較する(同点時のみ副次条件)。これで全順序になる。
  out.sort((a, b) => {
    const sa = key.get(a), sb = key.get(b);
    if (sa !== sb) return sa - sb;                                     // 実効到着が早い方
    if (a.transfers !== b.transfers) return a.transfers - b.transfers; // 乗換少
    if (a.arr !== b.arr) return a.arr - b.arr;                         // 早く着く方
    return b.dep - a.dep;                                              // 同着なら遅く出て待たない
  });
  return out.slice(0, 12);   // 多様化で増えた候補のうち上位のみ(junk除去)
}

// 指定発時刻curDepの「次の便」=curDepより後に発車する最速到達経路。
function nextJourney(srcIdx, dstIdx, curDep, opts) {
  const j = query(srcIdx, dstIdx, curDep + 1, opts || {});
  return (j && j.dep > curDep) ? j : null;
}

// 指定発時刻curDepの「前の便」=curDepより前に発車する経路のうち最も遅く出るもの。
// query(L)はL以降の最速発を返す(Lについて非減少)。L<curDepを保つ最大Lを二分探索。
function prevJourney(srcIdx, dstIdx, curDep, opts, windowMin) {
  opts = opts || {};
  const win = windowMin || 180;
  let lo = curDep - win, hi = curDep;
  let jlo = query(srcIdx, dstIdx, lo, opts);
  if (!jlo || jlo.dep >= curDep) return null;   // 窓内に前の便なし
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const jm = query(srcIdx, dstIdx, mid, opts);
    if (jm && jm.dep < curDep) { lo = mid; jlo = jm; }
    else hi = mid;
  }
  return jlo;
}

// その区間の当日の始発(最初の出発)・終電(最後の出発)。
function firstLastOfDay(srcIdx, dstIdx, opts) {
  // 始発: 00:00起点で探すと前夜の終電の残り(乗継先を逃して未明まで待つ経路等)が
  // 深夜0時台の出発として紛れ込む。運行の空白帯(概ね01:00〜04:00)を過ぎた
  // 04:00起点で探し、正味の朝一番だけを拾う。
  const first = query(srcIdx, dstIdx, 240, opts);

  // 終電: 単純に「その日出せる最も遅い出発」を求めると、乗継先の終電を逃して
  // 未明まで数時間待つ劣化ルートが「終電」として出てしまうことがある
  // (例: 23:54発だが乗継失敗で翌04:50着、のような経路)。
  // 夕方以降を1本ずつ次発へ辿り、所要時間が直前の便から急に跳ね上がった
  // (=乗継先の終電切れの合図)時点の手前までを実質的な終電とする。
  let start = null;
  for (const anchor of [1260, 1080, 900, 720, 480, 240]) { // 21/18/15/12/8/4時
    start = query(srcIdx, dstIdx, anchor, opts);
    if (start) break;
  }
  let last = start;
  if (start) {
    let cur = start;
    for (let i = 0; i < 80; i++) {
      const nj = nextJourney(srcIdx, dstIdx, cur.dep, opts);
      if (!nj || nj.dep >= 1440) break;   // 日付が変わったら打ち切り
      const curDur = cur.arr - cur.dep, njDur = nj.arr - nj.dep;
      if (njDur > curDur * 1.8 + 30) break;  // 乗継先の終電切れ=劣化ルートは不採用
      last = cur = nj;
    }
  }
  return { first, last };
}

/**
 * arriveBy(分)までに dst へ着ける便のうち、最も遅く出るもの。
 * 「何時までにここに着きたい」の逆算に使う。
 *
 * query() の到着時刻は出発キーに対して単調非減少なので二分探索できる。
 * firstLastOfDay が警戒している「乗継を逃して未明まで待つ劣化ルート」は、
 * ここでは arriveBy を超える到着になるため制約側で自然に落ちる。
 *
 * notBefore を省略すると arriveBy の8時間前(ただし04:00以降)から探す。
 */
function latestDeparture(srcIdx, dstIdx, arriveBy, opts, notBefore) {
  opts = opts || {};
  let lo = notBefore != null ? notBefore : Math.max(240, arriveBy - 480);
  let hi = arriveBy;
  let best = query(srcIdx, dstIdx, lo, opts);
  if (!best || best.arr > arriveBy) return null;   // 窓の先頭の便でも間に合わない
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const jm = query(srcIdx, dstIdx, mid, opts);
    if (jm && jm.arr <= arriveBy) { lo = mid; best = jm; }
    else hi = mid;
  }
  return best;
}

// --- 駅の発車時刻表 ---
// connection(駅間)ではなく trip の停車列を直接走査する。connectionは出発時刻順に
// 並んでいるが「その駅を出る便」を引くには全件走査が要るうえ深夜跨ぎの複製が混ざるため、
// 素直に trip を辿るほうが正確で速い。終着(発車しない停車)は除く。
// opts.day: 0=平日 1=土 2=休日。省略時は運転日で絞らない。
function timetable(stIdx, opts) {
  opts = opts || {};
  const dayMask = (opts.day != null && D.tripCal) ? (1 << opts.day) : 0;
  const ntrips = D.tripOff.length - 1;
  const out = [];
  for (let t = 0; t < ntrips; t++) {
    if (dayMask && !(D.tripCal[t] & dayMask)) continue;
    const s0 = D.tripOff[t], s1 = D.tripOff[t + 1];
    for (let i = s0; i < s1 - 1; i++) {
      if (D.stS[i] !== stIdx) continue;
      const dep = D.stD[i];
      if (dep < 0) continue;
      const nextSt = D.stations[D.stS[i + 1]];
      // 路線名は「この駅→次駅」区間の多数決(edgeDom)を優先する。直通列車には全区間に
      // 1本の路線ラベルが付くため、素のtripLineだと成田線直通が柏でも「成田線」になり、
      // 同じ列車が常磐線/成田線の2本に見えてしまう。区間の実態に合わせると1本に畳まれる。
      const ek = D.stS[i] * D.stations.length + D.stS[i + 1];
      const dom = D.edgeDom ? D.edgeDom.get(ek) : undefined;
      const lineIdx = (dom != null && dom >= 0) ? dom : D.tripLine[t];
      out.push({
        dep: ((dep % 1440) + 1440) % 1440,   // 日跨ぎ正規化を時計時刻へ戻す
        line: D.lines[lineIdx] || '',
        type: D.types[D.tripType[t]] || '',
        dest: D.tripDest[t] || '',
        next: nextSt ? nextSt.n : '',
        paid: !!(D.tripPaid && D.tripPaid[t]),
        shinkansen: !!(D.tripShink && D.tripShink[t]),
        trip: t,
      });
    }
  }
  out.sort((a, b) => a.dep - b.dep || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  // 元データには同一列車が運転日パターン違いで二重登録されている個体がある
  // (例: 柏 00:06 常磐線快速上野行 = trip92224(cal=1) と trip92225(cal=7) が停車列まで同一)。
  // 経路検索では最速1本が選ばれるので無害だが、時刻表は二重に並ぶので畳む。
  // 同一分・同一路線・同一種別・同一行先・同一次駅の別列車は実在しないため、これをキーにする。
  const seen = new Set();
  return out.filter(d => {
    const k = d.dep + '|' + d.line + '|' + d.type + '|' + d.dest + '|' + d.next;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const RouterV3 = {
  loadBinary,
  buildConnections,
  adoptBuild,
  query,
  findJourneys,
  nextJourney,
  prevJourney,
  firstLastOfDay,
  latestDeparture,
  journeyFare,
  journeyKm,
  legKm,
  haversineKm,
  lineCompany,
  stationCompanies,   // qa_company.js から検査する
  timetable,
  get data() { return D; },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RouterV3;
}
global.RouterV3 = RouterV3;

})(typeof window !== 'undefined' ? window : globalThis);
