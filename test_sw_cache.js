// sw.js のキャッシュ挙動を Cache API のモック上で検証する。
// 「たまにデータが飛んでオフラインで動かない」の再現ケースを、修正前は落ちる形で並べてある。
//
//   node test_sw_cache.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const BASE_DIR = __dirname;
const ORIGIN = 'https://transit.example';
const BASE = ORIGIN + '/';

let fail = 0;
const t = (name, ok, extra) => { if (!ok) fail++; console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`); };

// ---------------------------------------------------------------- Cache API モック

const abs = u => new URL(typeof u === 'string' ? u : u.url, BASE).href;

class MockCache {
  constructor() { this.entries = new Map(); } // href -> {status, headers, body:Buffer}
  async put(req, resp) {
    const href = abs(req);
    if (typeof req !== 'string' && req.method && req.method !== 'GET') {
      throw new TypeError('Request method must be GET');
    }
    const body = Buffer.from(await resp.arrayBuffer());
    this.entries.set(href, { status: resp.status, headers: [...resp.headers], body });
  }
  _make(rec) {
    return new Response(rec.body, { status: rec.status, headers: rec.headers });
  }
  async match(req, opts = {}) {
    const href = abs(req);
    if (this.entries.has(href)) return this._make(this.entries.get(href));
    if (opts.ignoreSearch) {
      const bare = href.split('?')[0];
      for (const [k, v] of this.entries) if (k.split('?')[0] === bare) return this._make(v);
    }
    return undefined;
  }
  async delete(req) { return this.entries.delete(abs(req)); }
  async keys() { return [...this.entries.keys()].map(h => new Request(h)); }
}

class MockCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new MockCache());
    return this.caches.get(name);
  }
  async keys() { return [...this.caches.keys()]; }
  async delete(name) { return this.caches.delete(name); }
  async match(req, opts) {
    for (const c of this.caches.values()) { const r = await c.match(req, opts); if (r) return r; }
    return undefined;
  }
}

// ---------------------------------------------------------------- SW ロード

// sw.js を毎回まっさらな環境で読み込み、登録されたハンドラを取り出す。
function loadSW({ fetchImpl }) {
  const handlers = {};
  const posted = [];
  const sandbox = {
    console,
    URL, URLSearchParams, Response, Blob, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, Promise, Number, Error, TypeError, Array, Set, Map, JSON, Object,
  };
  // SW では相対URLが self.location 基準で解決される。Node の Request は絶対URLしか
  // 受け付けないので、そこだけ合わせる。
  sandbox.Request = class extends Request {
    constructor(input, init) { super(typeof input === 'string' ? abs(input) : input, init); }
  };
  const self = {
    location: new URL(BASE + 'sw.js'),
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: m => posted.push(m) }],
    },
  };
  sandbox.self = self;
  sandbox.caches = new MockCacheStorage();
  sandbox.fetch = fetchImpl;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(BASE_DIR, 'sw.js'), 'utf8'), sandbox, { filename: 'sw.js' });
  return { handlers, caches: sandbox.caches, posted, self };
}

// waitUntil で渡された promise を待てるイベントオブジェクト
function evt(extra = {}) {
  const waits = [];
  return Object.assign({ waitUntil: p => waits.push(p), _done: () => Promise.all(waits) }, extra);
}
function fetchEvt(request) {
  let responded;
  return { request, respondWith: p => { responded = p; }, _resp: () => responded };
}

const json = (obj, init = {}) => new Response(JSON.stringify(obj),
  { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const html = (status = 200) => new Response('<html>Wi-Fi ログイン</html>',
  { status, headers: { 'content-type': 'text/html' } });

// sw.js が要求する必須アセット一覧を実物から読む
const SW_SRC = fs.readFileSync(path.join(BASE_DIR, 'sw.js'), 'utf8');
const listOf = name => {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(SW_SRC);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
};
const SW_SHELL = listOf('SHELL'), SW_DATA = listOf('DATA'), SW_OPTIONAL = listOf('OPTIONAL');
const SW_REQUIRED = [...SW_SHELL, ...SW_DATA];

// 実データは install ではなく、ページが読み終わったあとの CACHE_URLS で入る。
// 「全部揃った端末」を作りたいテストはこの手順を通す。
async function installAndFill(sw, urls = SW_DATA) {
  await evtRun(sw.handlers.install);
  const e = evt({ data: { type: 'CACHE_URLS', urls } });
  sw.handlers.message(e);
  await e._done();
  await evtRun(sw.handlers.activate);
}

// 全部成功する fetch (正しい Content-Type を返す正常なサーバ)
const okFetch = async req => {
  const p = new URL(abs(req)).pathname;
  if (/\.json$/.test(p)) return json({ ok: p });
  if (/\.js$/.test(p)) return new Response(`/* ${p} */`,
    { status: 200, headers: { 'content-type': 'application/javascript' } });
  if (/\.(gz|bin|png)$/.test(p)) return new Response(Buffer.from([0x1f, 0x8b, 1, 2, 3]),
    { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  return new Response('<html>app</html>', { status: 200, headers: { 'content-type': 'text/html' } });
};
const offlineFetch = async () => { throw new TypeError('Failed to fetch'); };

// あるSWインスタンスのキャッシュ内容を別インスタンスへ複製する
// (「同じ端末で、サーバの応答だけが変わった」状況を作るため)
async function copyCaches(from, to) {
  for (const name of await from.keys()) {
    const src = await from.open(name), dst = await to.open(name);
    for (const [k, v] of src.entries) dst.entries.set(k, v);
  }
}

// ================================================================ テスト

(async () => {

// --- 1. プリキャッシュのキーと index.html の要求URLが一致しているか --------------
// これがズレると Cache API は完全一致照合なので永久にヒットせず、
// 「オンラインでは動くがオフラインでは動かない」という形で表面化する。
{
  const idx = fs.readFileSync(path.join(BASE_DIR, 'index.html'), 'utf8');
  const wanted = new Set();
  for (const m of idx.matchAll(/(?:src|href)="([^"${}]+)"/g)) {
    if (!/^(https?:|data:|#)/.test(m[1])) wanted.add('./' + m[1].replace(/^\.\//, ''));
  }
  // DATA_URLS の各値
  const du = /const DATA_URLS = \{([\s\S]*?)\};/.exec(idx);
  if (du) for (const m of du[1].matchAll(/'([^']+)'/g)) wanted.add('./' + m[1].replace(/^\.\//, ''));
  // Worker は new Worker(...) で読まれるので src= 属性には出てこない。
  // ここを見落とすとオフラインで Worker が作れず、毎回フォールバック経路に落ちる。
  const wu = /const WORKER_URL = '([^']+)'/.exec(idx);
  if (wu) wanted.add('./' + wu[1].replace(/^\.\//, ''));
  // その Worker が importScripts するものも同じく必要
  const workerSrc = fs.readFileSync(path.join(BASE_DIR, 'data_worker.js'), 'utf8');
  for (const m of workerSrc.matchAll(/importScripts\('([^']+)'\)/g)) {
    wanted.add('./' + m[1].replace(/^\.\//, ''));
  }

  const precached = new Set([...SW_REQUIRED, ...SW_OPTIONAL].map(u => u.replace(/^\.\//, './')));
  const missing = [...wanted].filter(u => u !== './sw.js' && !precached.has(u));
  t('index.html が要求する全URLが sw.js のプリキャッシュ対象に入っている',
    missing.length === 0, missing.length ? '未登録: ' + missing.join(', ') : '');

  // 逆向き: sw.js の DATA が index.html の DATA_URLS と ?v= まで一致するか
  const swData = new Set(SW_DATA.map(u => u.replace(/^\.\//, '')));
  const pageData = du ? [...du[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
  const drift = pageData.filter(u => !swData.has(u));
  t('データURLの ?v= が index.html と sw.js で一致している',
    pageData.length > 0 && drift.length === 0, drift.length ? 'ズレ: ' + drift.join(', ') : '');
}

// --- 2. キャプティブポータルのHTMLでデータを上書きしない ------------------------
// ユーザー報告の「データが飛ぶ」の主因。fetch は 200 で成功するので、素朴な
// network-first 実装だと graph_v2.json のキャッシュがログインページに置き換わる。
{
  const good = json({ stations: ['正常なデータ'] });
  let phase = 'ok';
  const sw = loadSW({ fetchImpl: async req => (phase === 'ok' ? good.clone() : html()) });
  await installAndFill(sw);
  phase = 'captive';

  const url = SW_DATA.find(u => u.includes('graph_v2')) || SW_DATA[0];
  // 実データはキャッシュ優先なので、そもそもネットワークを見に行かない
  const e = fetchEvt(new Request(abs(url)));
  sw.handlers.fetch(e);
  const resp = await e._resp();
  const body = await resp.text();
  t('キャプティブポータル中でも実データはキャッシュから返る', body.includes('正常なデータ'),
    body.slice(0, 40));

  const cache = await sw.caches.open([...await sw.caches.keys()][0]);
  const stored = await cache.match(url);
  t('キャッシュ上の実データがHTMLで上書きされていない',
    (await stored.text()).includes('正常なデータ'));
}

// --- 3. シェル資産(network-first)でもHTMLでキャッシュを潰さない ----------------
{
  const good = loadSW({ fetchImpl: okFetch });
  await installAndFill(good);

  // 同じ端末のまま、サーバの応答だけがキャプティブポータルに変わった状況
  const sw = loadSW({ fetchImpl: async () => html() });
  await copyCaches(good.caches, sw.caches);
  const name = (await sw.caches.keys())[0];
  const cache = await sw.caches.open(name);
  const url = './router_v3.js?v=12';

  const e = fetchEvt(new Request(abs(url)));
  sw.handlers.fetch(e);
  await e._resp();          // 呼び出し元にはサーバの応答をそのまま渡す(嘘はつかない)

  const stored = await cache.match(url);
  const body = await stored.text();
  t('JSを要求してHTMLが返ってもキャッシュ上のJSが壊れない',
    body.includes('router_v3.js') && !body.includes('<html>'), body.slice(0, 40));
}

// --- 3b. HTMLが返るサーバでは install を中断し、旧キャッシュを温存する ----------
{
  const sw = loadSW({ fetchImpl: async () => html() });
  let failed = false;
  await evtRun(sw.handlers.install).catch(() => { failed = true; });
  t('JS/JSONにHTMLが返るサーバでは install が中断される', failed);
}

// --- 4. 206 Partial Content を保存しない ---------------------------------------
// resp.ok は 206 でも true。素朴な実装は千切れたファイルをフルURLのキーで保存してしまう。
{
  // サーバが常に 206 を返す状況。resp.ok は true なので、status を見ない実装は
  // 千切れた本文をフルURLのキーで保存してしまう。
  const partial = loadSW({ fetchImpl: async () => new Response(Buffer.from([1, 2]),
    { status: 206, headers: { 'content-type': 'image/png' } }) });
  await evtRun(partial.handlers.install).catch(() => {}); // 何も保存できず install は失敗する
  const pc = await partial.caches.open((await partial.caches.keys())[0]);
  t('206 Partial Content はキャッシュされない', (await pc.match('./icon-192.png')) === undefined);
}

// --- 5. 本文が途中で切れたら既存エントリを壊さない ------------------------------
// 4MB超の trains_v3.bin.gz を弱電波で取りに行くと現実に起きる。ヘッダだけ先に来て
// 本文が最後まで届かないパターン。ストリームをそのまま cache.put に渡す実装だと、
// 「古いエントリを消した後に書き込みが失敗」してデータが消える。
{
  const good = loadSW({ fetchImpl: okFetch });
  await installAndFill(good);

  // Content-Length は 9999 と言うのに本文は2バイトしか来ないサーバ
  const sw = loadSW({ fetchImpl: async () => new Response(Buffer.from([0x1f, 0x8b]),
    { status: 200, headers: { 'content-type': 'application/javascript', 'content-length': '9999' } }) });
  await copyCaches(good.caches, sw.caches);
  const cache = await sw.caches.open((await sw.caches.keys())[0]);
  const url = './router_v3.js?v=12';
  const before = await (await cache.match(url)).text();

  const e = fetchEvt(new Request(abs(url)));
  sw.handlers.fetch(e);
  await e._resp();
  const after = await (await cache.match(url)).text();
  t('本文が途中で切れても既存キャッシュが壊れない', after === before,
    `${after.length}B (元 ${before.length}B)`);
}

// --- 5b. データ資産はキャッシュ優先なのでネットワークの影響を受けない ------------
{
  const good = loadSW({ fetchImpl: okFetch });
  await installAndFill(good);
  const sw = loadSW({ fetchImpl: async () => html() });
  await copyCaches(good.caches, sw.caches);
  const binUrl = SW_DATA.find(u => u.includes('.bin.gz'));
  const cache = await sw.caches.open((await sw.caches.keys())[0]);
  const before = Buffer.from(await (await cache.match(binUrl)).arrayBuffer());

  const e = fetchEvt(new Request(abs(binUrl)));
  sw.handlers.fetch(e);
  const got = Buffer.from(await (await e._resp()).arrayBuffer());
  t('大きいデータはネットワークの不調に影響されない', got.equals(before),
    `${got.length}B vs ${before.length}B`);
}

// --- 6. オフライン中にSWが更新されても手持ちデータが消えない --------------------
// 旧実装は activate で無条件に旧キャッシュを削除していたため、新キャッシュが
// 空のまま切り替わって全部飛んだ。
{
  const sw = loadSW({ fetchImpl: offlineFetch });
  // 旧世代のキャッシュに必須アセットが全部入っている状態を作る
  const old = await sw.caches.open('transit-v40');
  for (const u of SW_REQUIRED) await old.put(u, new Response('旧世代:' + u, { status: 200 }));

  await evtRun(sw.handlers.install);  // オフラインなので fetch は全滅 → 旧キャッシュから引き継ぎ
  await evtRun(sw.handlers.activate);

  const names = await sw.caches.keys();
  const current = names.find(n => n !== 'transit-v40') || names[0];
  const cache = await sw.caches.open(current);
  const missing = [];
  for (const u of SW_REQUIRED) if (!(await cache.match(u))) missing.push(u);
  t('オフライン中のSW更新でも必須アセットが引き継がれる', missing.length === 0,
    missing.length ? '消えた: ' + missing.join(', ') : `${SW_REQUIRED.length}件を保持`);
}

// --- 7. 必須アセットが揃わないなら更新を見送り、旧キャッシュを残す --------------
{
  const sw = loadSW({ fetchImpl: offlineFetch });
  const old = await sw.caches.open('transit-v40');
  await old.put('./index.html', new Response('旧世代のアプリ', { status: 200 }));
  // 旧キャッシュには index.html しか無い = 引き継ぎでも必須アセットを満たせない

  let installFailed = false;
  await evtRun(sw.handlers.install).catch(() => { installFailed = true; });
  t('必須アセットを揃えられないとき install は失敗する', installFailed);

  // install が失敗した以上 activate は走らない → 旧キャッシュは無傷
  t('install 失敗時に旧キャッシュが削除されない',
    (await sw.caches.keys()).includes('transit-v40') &&
    (await (await sw.caches.open('transit-v40')).match('./index.html')) !== undefined);
}

// --- 8. deep-link 付きナビゲーションがオフラインで開ける ------------------------
// ?from=&to= 付きURLは完全一致では絶対にヒットしない。旧実装はここで 503 を返し、
// map-app からのリンクをオフラインで開くと真っ白になっていた。
{
  const sw = loadSW({ fetchImpl: okFetch });
  await installAndFill(sw);

  // 以降オフラインにする
  const swOff = loadSW({ fetchImpl: offlineFetch });
  await copyCaches(sw.caches, swOff.caches);

  const req = new Request(ORIGIN + '/?from=東京&to=横浜', {});
  Object.defineProperty(req, 'mode', { value: 'navigate' });
  const e = fetchEvt(req);
  swOff.handlers.fetch(e);
  const resp = await e._resp();
  t('オフラインでも deep-link 付きURLでアプリが開ける',
    resp.status === 200, `status=${resp.status}`);
}

// --- 9. 非GET / 別オリジンは横取りしない ---------------------------------------
// 旧実装は全部 respondWith していたため、POST に対して cache.put が TypeError を投げ
// 未処理の rejection を出していた。
{
  const sw = loadSW({ fetchImpl: okFetch });
  const post = fetchEvt(new Request(ORIGIN + '/api', { method: 'POST', body: 'x' }));
  sw.handlers.fetch(post);
  t('POST は SW が横取りしない', post._resp() === undefined);

  const cross = fetchEvt(new Request('https://other.example/a.json'));
  sw.handlers.fetch(cross);
  t('別オリジンは SW が横取りしない', cross._resp() === undefined);
}

// --- 10. 容量超過をページに通知する -------------------------------------------
{
  const sw = loadSW({ fetchImpl: okFetch });
  const cache = await sw.caches.open('transit-quota');
  cache.put = async () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; };
  // install 経由で quota に当てる
  const swq = loadSW({ fetchImpl: okFetch });
  const orig = swq.caches.open.bind(swq.caches);
  swq.caches.open = async n => {
    const c = await orig(n);
    if (!c.__patched) { c.__patched = true; c.put = async () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }; }
    return c;
  };
  await evtRun(swq.handlers.install).catch(() => {});
  t('QuotaExceededError がページに通知される',
    swq.posted.some(m => m.type === 'CACHE_QUOTA_EXCEEDED'),
    JSON.stringify(swq.posted));
}

// --- 11. CACHE_URLS でページ側から取りこぼしを埋められる ------------------------
{
  const sw = loadSW({ fetchImpl: okFetch });
  await evtRun(sw.handlers.install);
  const name = (await sw.caches.keys())[0];
  const cache = await sw.caches.open(name);
  // ?v= が上がった新URLはまだ入っていない
  const newUrl = './graph_v2.json?v=99';
  t('新しい ?v= はまだ未キャッシュ', (await cache.match(newUrl)) === undefined);

  const e = evt({ data: { type: 'CACHE_URLS', urls: [newUrl] } });
  sw.handlers.message(e);
  await e._done();
  t('CACHE_URLS でバージョンのズレを自己修復できる', (await cache.match(newUrl)) !== undefined);
}

// --- 12. CACHE_STATUS が実際の充足状況を返す -----------------------------------
{
  const sw = loadSW({ fetchImpl: okFetch });
  await installAndFill(sw);
  let got = null;
  const e = evt({ data: { type: 'CACHE_STATUS' }, ports: [{ postMessage: m => { got = m; } }] });
  sw.handlers.message(e);
  await e._done();
  t('CACHE_STATUS が欠品なしを報告する', got && got.missing.length === 0 && got.have.length === SW_REQUIRED.length,
    got ? `have=${got.have.length} missing=${got.missing.length}` : 'no reply');
}

// --- 12b. gzip で配られたレスポンスを truncated と誤判定しない ------------------
// Content-Length は圧縮後のバイト数、本文は展開後のバイト数。単純比較すると必ず
// 食い違うので、正常なレスポンスを全部弾いて install が毎回失敗する
// (= vercel 本番のように text/json を自動圧縮する環境でオフライン対応が死ぬ)。
{
  const zlib = require('zlib');
  const sw = loadSW({ fetchImpl: async req => {
    const p = new URL(abs(req)).pathname;
    const raw = Buffer.from(/\.(gz|bin|png)$/.test(p)
      ? [0x1f, 0x8b, 1, 2, 3] : Buffer.from(`/* ${p} ${'x'.repeat(200)} */`));
    const body = zlib.gzipSync(raw);
    return new Response(body, { status: 200, headers: {
      'content-type': /\.json$/.test(p) ? 'application/json'
        : /\.js$/.test(p) ? 'application/javascript'
        : /\.(gz|bin)$/.test(p) ? 'application/octet-stream'
        : /\.png$/.test(p) ? 'image/png' : 'text/html',
      // Node の Response は content-encoding を見て勝手に展開しないので、
      // 「圧縮後の長さを名乗り、本文は展開後」というブラウザと同じ形を手で作る
      'content-encoding': 'gzip',
      'content-length': String(body.length),
    } });
  } });
  // ここが壊れていると install が例外で落ちる
  let installOk = true;
  await evtRun(sw.handlers.install).catch(() => { installOk = false; });
  t('gzip配信でも install が完走する(圧縮長と展開長を混同しない)', installOk);

  const cache = await sw.caches.open((await sw.caches.keys())[0]);
  const missing = [];
  for (const u of SW_SHELL) if (!(await cache.match(u))) missing.push(u);
  t('gzip配信のシェルがキャッシュされる', missing.length === 0,
    missing.length ? '欠け: ' + missing.join(', ') : `${SW_SHELL.length}件`);
}

// --- 13. install は実データをネットワークから取りに行かない ----------------------
// 初回訪問ではページ自身が同じ11MBを取っている。install がそこに重ねて取りに行くと
// 通信量が丸ごと2倍になり、細い回線ではページ側の取得まで遅くなる。
{
  const fetched = [];
  const sw = loadSW({ fetchImpl: async req => { fetched.push(new URL(abs(req)).pathname); return okFetch(req); } });
  await evtRun(sw.handlers.install);
  const dataPaths = SW_DATA.map(u => new URL(u, BASE).pathname);
  const hit = fetched.filter(p => dataPaths.includes(p));
  t('install が実データを取りに行かない(初回の二重ダウンロードが無い)', hit.length === 0,
    hit.length ? '取りに行った: ' + hit.join(', ') : `シェル${fetched.length}件のみ`);

  // シェルは install で確保されている(これが無いと起動できない)
  const cache = await sw.caches.open((await sw.caches.keys())[0]);
  const shellMissing = [];
  for (const u of SW_SHELL) if (!(await cache.match(u))) shellMissing.push(u);
  t('シェルは install で確保される', shellMissing.length === 0,
    shellMissing.length ? '欠け: ' + shellMissing.join(', ') : `${SW_SHELL.length}件`);
}

// --- 14. CACHE_URLS はHTTPキャッシュ経由で取る ---------------------------------
// ページが直前に落としたものを拾い直すだけなので no-cache にしてはいけない。
// no-cache だと本文をもう一度サーバから引き直すことになり、二重取得が復活する。
{
  const modes = [];
  const sw = loadSW({ fetchImpl: async req => { modes.push(req.cache); return okFetch(req); } });
  await evtRun(sw.handlers.install);
  modes.length = 0;
  const e = evt({ data: { type: 'CACHE_URLS', urls: SW_DATA } });
  sw.handlers.message(e);
  await e._done();
  t('CACHE_URLS はHTTPキャッシュを使う', modes.length > 0 && modes.every(m => m === 'default'),
    JSON.stringify(modes));

  // 逆に RECACHE(壊れたデータの修復)はサーバに取り直させないと直らない
  const modes2 = [];
  const sw2 = loadSW({ fetchImpl: async req => { modes2.push(req.cache); return okFetch(req); } });
  await evtRun(sw2.handlers.install);
  modes2.length = 0;
  const e2 = evt({ data: { type: 'RECACHE' }, ports: [{ postMessage() {} }] });
  sw2.handlers.message(e2);
  await e2._done();
  t('RECACHE はHTTPキャッシュを迂回する', modes2.length > 0 && modes2.every(m => m === 'no-cache'),
    JSON.stringify([...new Set(modes2)]));
}

// --- 15. 実データが揃うまで旧世代のキャッシュを消さない --------------------------
// install で実データを取らなくなった分、activate で無条件に旧世代を消すと
// 「新旧どちらのデータも無い」瞬間ができてしまう。
{
  const sw = loadSW({ fetchImpl: offlineFetch });
  const old = await sw.caches.open('transit-v40');
  // 旧世代は ?v= が1つ前のデータを持っている(= 新URLとしては引き継げない)
  for (const u of SW_SHELL) await old.put(u, new Response('旧世代:' + u, { status: 200 }));
  await old.put('./graph_v2.json?v=3', new Response('旧世代データ', { status: 200 }));

  await evtRun(sw.handlers.install);
  await evtRun(sw.handlers.activate);
  t('新データが揃うまで旧世代キャッシュを残す', (await sw.caches.keys()).includes('transit-v40'));
  t('旧世代の実データが消えていない',
    (await (await sw.caches.open('transit-v40')).match('./graph_v2.json?v=3')) !== undefined);

  // オンラインに戻ってページが読み終われば CACHE_URLS が来て、そこで初めて片付く
  const sw2 = loadSW({ fetchImpl: okFetch });
  await copyCaches(sw.caches, sw2.caches);
  await evtRun(sw2.handlers.install);
  const e = evt({ data: { type: 'CACHE_URLS', urls: SW_DATA } });
  sw2.handlers.message(e);
  await e._done();
  t('揃った時点で旧世代キャッシュが片付く', !(await sw2.caches.keys()).includes('transit-v40'),
    JSON.stringify(await sw2.caches.keys()));
}

console.log(fail === 0 ? '\nすべて成功' : `\n${fail} 件失敗`);
process.exit(fail ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });

async function evtRun(handler) {
  const e = evt();
  handler(e);
  return e._done();
}
