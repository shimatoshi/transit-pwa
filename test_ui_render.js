// index.html のレンダリング経路をDOM無しで叩いて、バスleg描画が壊れていないか確認する
const fs = require('fs'), vm = require('vm'), path = require('path');
const BASE = __dirname;
const el = () => new Proxy({ style: {}, dataset: {}, classList: { add(){}, remove(){}, contains(){return false;}, toggle(){return false;} },
  addEventListener(){}, querySelector(){return null;}, querySelectorAll(){return [];},
  appendChild(){}, insertBefore(){}, checked: true, value: '' }, {
  get(t, k) { return k in t ? t[k] : ''; }, set(t, k, v) { t[k] = v; return true; } });
global.addEventListener = () => {};
global.window = global;
global.document = { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
  addEventListener(){}, createElement: el, body: el() };
global.localStorage = { getItem: () => null, setItem(){} };
global.location = { search: '' };
global.navigator = { onLine: true };
global.fetch = () => Promise.reject(new Error('offline in test'));
global.alert = m => { throw new Error('alert: ' + m); };
global.RouterV3 = require(path.join(BASE, 'router_v3.js'));

const html = fs.readFileSync(path.join(BASE, 'index.html'), 'utf8');
const src = /<script>\n([\s\S]*?)\n<\/script>/.exec(html)[1] +
  '\n;globalThis.__ui = { renderOneRoute, renderCredits, searchStations, findAllByName, ' +
  'setTravelMode, getTravelMode: () => travelMode, setLastOpts: o => { lastSearchOpts = o; }, ' +
  'setGraph: g => { graph = g; } };';
vm.runInThisContext(src, { filename: 'index.html:inline' });

const g = JSON.parse(fs.readFileSync(path.join(BASE, 'graph_v2.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(BASE, 'trains_v3_meta.json'), 'utf8'));
const fares = JSON.parse(fs.readFileSync(path.join(BASE, 'fares.json'), 'utf8'));
const buf = fs.readFileSync(path.join(BASE, 'trains_v3.bin'));
RouterV3.loadBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta, g.stations, fares);
g._nameIndex = g.stations.map((s, i) => ({ id: i, name: s.n, nameEn: (s.e || '').toLowerCase(),
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

__ui.renderCredits(meta.sources);
t('renderCredits が例外を出さない', true);
console.log(fail === 0 ? '\nUI ALL OK' : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
