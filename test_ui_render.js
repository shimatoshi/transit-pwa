// index.html のレンダリング経路をDOM無しで叩いて、バスleg描画が壊れていないか確認する
const fs = require('fs'), vm = require('vm'), path = require('path');
const BASE = __dirname;
const el = () => new Proxy({ style: {}, dataset: {}, classList: { add(){}, remove(){}, contains(){return false;}, toggle(){return false;} },
  addEventListener(){}, querySelector(){return null;}, querySelectorAll(){return [];},
  appendChild(){}, insertBefore(){}, checked: true, value: '' }, {
  get(t, k) { return k in t ? t[k] : ''; }, set(t, k, v) { t[k] = v; return true; } });
global.addEventListener = () => {};
global.window = global;
// getElementById は id ごとに同じ要素を返す(毎回新しいProxyだと <select> の値が
// 保持されず、座席種別のように「書いて読み直す」UI状態をテストできない)
const elById = new Map();
const byId = id => { if (!elById.has(id)) elById.set(id, el()); return elById.get(id); };
global.document = { getElementById: byId, querySelector: () => null, querySelectorAll: () => [],
  addEventListener(){}, createElement: el, body: el() };
global.localStorage = { getItem: () => null, setItem(){} };
global.location = { search: '' };
global.navigator = { onLine: true };
global.fetch = () => Promise.reject(new Error('offline in test'));
global.alert = m => { throw new Error('alert: ' + m); };
global.RouterV3 = require(path.join(BASE, 'router_v3.js'));

const html = fs.readFileSync(path.join(BASE, 'index.html'), 'utf8');
const src = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1] +
  '\n;globalThis.__ui = { renderOneRoute, renderCredits, searchStations, findAllByName, normName, ' +
  'overnightHint, setTravelMode, getTravelMode: () => travelMode, setLastOpts: o => { lastSearchOpts = o; }, ' +
  'setSeat, currentSeat, ' +
  'showDropdown, hideDropdown, AC_GAP, ' +
  'setGraph: g => { graph = g; } };';
vm.runInThisContext(src, { filename: 'index.html:inline' });

const g = JSON.parse(fs.readFileSync(path.join(BASE, 'graph_v2.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(BASE, 'trains_v3_meta.json'), 'utf8'));
const fares = JSON.parse(fs.readFileSync(path.join(BASE, 'fares.json'), 'utf8'));
const buf = fs.readFileSync(path.join(BASE, 'trains_v3.bin'));
RouterV3.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, g.stations, fares);
// norm は index.html 側の normName で作る。ここで別途組み直すと本体と定義がずれる
// (実際、全角/半角の正規化を入れたときに norm を足し忘れてこのテストだけ落ちた)。
g._nameIndex = g.stations.map((s, i) => ({ id: i, name: s.n, norm: __ui.normName(s.n),
  nameEn: (s.e || '').toLowerCase(),
  pref: s.p, lines: s.m ? (s.sys || []) : s.l, mode: s.m ? 1 : 0 }));
__ui.setGraph(g);

const S = g.stations;
const rid = n => S.findIndex(s => !s.m && s.n === n);
const bid = n => S.findIndex(s => s.m && s.n === n);
let fail = 0;
const t = (name, ok, extra) => { if (!ok) fail++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); };

const j = RouterV3.query(rid('新橋'), bid('晴海三丁目'), 600, { day: 0 });
const h = __ui.renderOneRoute(j, 0);
t('バス経路カードが描画できる', typeof h === 'string' && h.length > 500, `${h.length}字`);
t('バス専用色が使われている', h.includes('#2e7d32'));
t('バスアイコンが出る', h.includes('&#128652;'));
t('「停留所」表記になる', /停留所/.test(h));
t('系統番号が line-tag に出る', h.includes('都０５－１'));
t('「バス運賃別途」が出る', h.includes('バス運賃別途'));
t('サマリに「バス1回」が出る', h.includes('バス1回'));
t('undefined が混ざっていない', !/undefined/.test(h), (/undefined/.exec(h) || [])[0] || '');

const jr = RouterV3.query(rid('柏'), rid('東京'), 540, { day: 0 });
const hr = __ui.renderOneRoute(jr, 0);
t('鉄道のみの経路カードにバス表記が出ない',
  !hr.includes('&#128652;') && !hr.includes('バス運賃別途') && !/停留所/.test(hr));
t('鉄道カードに undefined が無い', !/undefined/.test(hr));

const sug = __ui.searchStations('新橋');
t('サジェストで鉄道駅がバス停より上', sug.length > 1 && sug[0].mode === 0,
  sug.slice(0, 3).map(s => `${s.name}(${s.mode})`).join(', '));
t('findAllByName は鉄道駅のみ返す',
  __ui.findAllByName('新橋').every(i => !S[i].m), JSON.stringify(__ui.findAllByName('新橋')));
t('バス停専用名は findAllByName でバス停を返す',
  __ui.findAllByName('晴海三丁目').every(i => S[i].m));
// 鉄道駅名が括弧付きで、括弧なしの同名バス停がある駅(大手町/日本橋/早稲田/大曲 等16件)。
// 完全一致だけ見るとバス停に隠れ、?from=大手町 のディープリンクが停留所に解決されていた。
for (const [q, want] of [['大手町', '大手町(東京)'], ['日本橋', '日本橋(東京)'],
                         ['早稲田', '早稲田(メトロ)'], ['大曲', '大曲(秋田)']]) {
  const ids = __ui.findAllByName(q);
  t(`「${q}」が同名バス停でなく鉄道駅に解決される`,
    ids.length > 0 && ids.every(i => !S[i].m) && ids.some(i => S[i].n === want),
    ids.map(i => S[i].n).join('/'));
}

// 全角/半角の表記ゆれ。データ側が全角で持っている駅(羽田空港第１・第２ターミナル、
// 成田空港(空港第２ビル)、札幌(ＪＲ)、ＪＲ淡路 ほか鉄道66駅)は、素の includes/=== だと
// 利用者が半角で打った瞬間に0件になっていた。羽田は半角で打つのが自然な駅名で、
// ?from=羽田空港第2ターミナル のディープリンクも同じ理由で外れる。
for (const [q, want] of [
  ['羽田空港第2ターミナル', '羽田空港第２ターミナル(東京モノレール)'],
  ['羽田空港第3ターミナル', '羽田空港第３ターミナル(京急)'],
  ['羽田空港第1・第2ターミナル', '羽田空港第１・第２ターミナル(京急)'],
  ['成田空港(空港第2ビル)', '成田空港(空港第２ビル)'],
  ['札幌(JR)', '札幌(ＪＲ)'],
  ['JR淡路', 'ＪＲ淡路'],
]) {
  const ids = __ui.findAllByName(q);
  t(`半角入力「${q}」が全角の駅名に解決される`,
    ids.length > 0 && ids.some(i => S[i].n === want),
    ids.map(i => S[i].n).join('/') || '(0件)');
  const sg = __ui.searchStations(q);
  t(`半角入力「${q}」がサジェストに出る`,
    sg.length > 0 && sg.some(s => s.name === want),
    sg.slice(0, 3).map(s => s.name).join('/') || '(0件)');
}
// 全角のまま打っても従来通り引ける(正規化で壊していないこと)
t('全角のまま「羽田空港第２ターミナル」も引ける',
  __ui.findAllByName('羽田空港第２ターミナル(東京モノレール)').length > 0);
// 畳みすぎて別駅を巻き込んでいないこと
t('「丸の内」と「丸ノ内」は別駅のまま',
  !__ui.findAllByName('丸の内').some(i => S[i].n.includes('丸ノ内')));

// --- 1日で着かない超長距離の「経路なし」ヒント ---
// 稚内→博多 等は当日中の列車では到達できず必ず経路なしになる。素の「見つかりません」だと
// データ欠落と区別できないので、遠距離ODでは理由を出す。近距離では出してはいけない。
t('超長距離(稚内→博多)は宿泊ヒントが出る',
  /宿泊を挟む行程/.test(__ui.overnightHint(rid('稚内'), rid('博多'))));
t('中距離(東京→博多)では宿泊ヒントを出さない',
  __ui.overnightHint(rid('東京'), rid('博多')) === '');
t('近距離(志布志→都城)では宿泊ヒントを出さない',
  __ui.overnightHint(rid('志布志'), rid('都城')) === '');

// --- 指定席/自由席 ---
// 新幹線カードは席種と、もう一方の席種の総額(差額つき)を出す。全車指定席の列車
// (はやぶさ/あずさ等)は選択の余地が無いので席種を出さない。
const findByType = (from, to, hint) => {
  for (const at of [480, 540, 600, 660]) {
    for (const cand of RouterV3.findJourneys(rid(from), rid(to), at, { day: 0 })) {
      if (cand.legs.some(l => l.kind === 'ride' && (l.type || '').includes(hint))) return cand;
    }
  }
  return null;
};
const jn = findByType('東京', '新大阪', 'のぞみ');
t('のぞみ経路が見つかる', !!jn);
t('初期状態は指定席', __ui.currentSeat() === 'reserved');
const hnR = __ui.renderOneRoute(jn, 0);
const fnR = RouterV3.journeyFare(jn, { seat: 'reserved' });
const fnN = RouterV3.journeyFare(jn, { seat: 'nonreserved' });
t('指定席カードに「うち特急料金 …(指定席)」が出る', /うち特急料金 ¥[\d,]+\(指定席\)/.test(hnR));
t('指定席カードに自由席の総額と差額が出る',
  hnR.includes('自由席 ¥' + fnN.total.toLocaleString()) &&
  hnR.includes('(' + (fnN.total - fnR.total).toLocaleString() + ')'),
  `自由席¥${fnN.total} 差${fnN.total - fnR.total}`);
t('自由席は指定席より安い', fnN.total < fnR.total, `${fnR.total} → ${fnN.total}`);

__ui.setSeat('nonreserved');
t('setSeat で自由席に切り替わる', __ui.currentSeat() === 'nonreserved');
const hnN = __ui.renderOneRoute(jn, 0);
t('自由席カードの総額が自由席運賃になる', hnN.includes('¥' + fnN.total.toLocaleString()));
t('自由席カードに「うち特急料金 …(自由席)」が出る', /うち特急料金 ¥[\d,]+\(自由席\)/.test(hnN));
t('自由席カードから指定席に戻すリンクが出る', hnN.includes('指定席 ¥' + fnR.total.toLocaleString()));
__ui.setSeat('reserved');

// 全車指定席: はやぶさは自由席が無いので席種の表示も切替リンクも出さない
const jh = findByType('東京', '仙台', 'はやぶさ');
t('はやぶさ経路が見つかる', !!jh);
const hh = __ui.renderOneRoute(jh, 0);
t('全車指定席の経路は「うち特急料金」に席種を付けない',
  /うち特急料金 ¥[\d,]+</.test(hh) && !hh.includes('(指定席)') && !hh.includes('(自由席)'));
t('全車指定席の経路に席種の切替リンクが出ない', !/自由席 ¥/.test(hh));
t('席種カードに undefined が無い', !/undefined/.test(hnR) && !/undefined/.test(hh));

// --- バス限定モード ---
const jb = RouterV3.findJourneys(rid('渋谷'), rid('六本木'), 600, { day: 0, busOnly: true })[0];
t('バス限定で渋谷→六本木の経路が出る', !!jb);
const hb = __ui.renderOneRoute(jb, 0);
t('バス限定カードに鉄道legが無い', jb.legs.every(l => l.kind !== 'ride' || l.mode === 1));
t('バス限定カードは ¥0 を出さず「運賃別途」にする',
  !hb.includes('¥0') && hb.includes('運賃別途'));
t('バス限定カードで「運賃別途」が二重に出ない',
  (hb.match(/運賃別途/g) || []).length === 1);
t('バス限定カードに undefined が無い', !/undefined/.test(hb));

t('交通手段の初期値は all', __ui.getTravelMode() === 'all');
__ui.setTravelMode('bus');
t('setTravelMode でモードが切り替わる', __ui.getTravelMode() === 'bus');
const sugBus = __ui.searchStations('新橋');
t('バス限定モードのサジェストは停留所が上', sugBus.length > 1 && sugBus[0].mode === 1,
  sugBus.slice(0, 3).map(s => `${s.name}(${s.mode})`).join(', '));
__ui.setTravelMode('all');
t('all に戻すとサジェストも鉄道駅が上', __ui.searchStations('新橋')[0].mode === 0);
t('不正なモードは all に落ちる', (__ui.setTravelMode('zzz'), __ui.getTravelMode() === 'all'));

// --- サジェストが下の入力欄を覆ってフォーカスを奪う不具合の再発防止 ---
// 候補リストは position:absolute で浮くので、何もしないと出発欄の候補が到着欄や
// 検索ボタンを完全に隠す。隠れた到着欄をタップすると実際に触るのは .ac-item で、
// その mousedown の preventDefault がフォーカス移動を打ち消すため、
// 「到着欄をタップしたのに出発欄にフォーカスが戻り、出発駅が書き換わる」ことになる。
// 表示中は行の下に候補リストぶんの余白を確保して、他の欄が隠れないようにしてある。
function makeDropdownStub(h) {
  const dd = { offsetHeight: h, shown: false };
  dd.classList = { add: c => { if (c === 'show') dd.shown = true; },
                   remove: c => { if (c === 'show') dd.shown = false; } };
  return dd;
}
const acRow = { style: {} }, acDd = makeDropdownStub(220);
__ui.showDropdown(acRow, acDd);
t('サジェスト表示で show が付く', acDd.shown);
t('サジェスト表示中は行の下に候補リストぶんの余白を確保する(下の欄を覆わない)',
  parseInt(acRow.style.marginBottom, 10) >= acDd.offsetHeight, acRow.style.marginBottom);
t('確保する余白は候補の高さ + 行間ちょうど',
  acRow.style.marginBottom === (220 + __ui.AC_GAP) + 'px', acRow.style.marginBottom);
__ui.hideDropdown(acRow, acDd);
t('サジェストを閉じたら余白も元に戻す', !acDd.shown && acRow.style.marginBottom === '',
  JSON.stringify(acRow.style.marginBottom));

__ui.renderCredits(meta.sources);
t('renderCredits が例外を出さない', true);
console.log(fail === 0 ? '\nUI ALL OK' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
