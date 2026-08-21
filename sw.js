// Service Worker — オフライン動作用キャッシュ。
//
// 設計上の大前提が2つある。踏むと「たまにデータが飛んでオフラインで動かない」に直結する。
//
//  1. ASSETS のURLは index.html が実際に投げるURLと1文字も違ってはいけない。
//     Cache API の照合はクエリ文字列まで含めた完全一致なので、index.html が
//     'graph_v2.json?v=5' を取りに行くのに './graph_v2.json' をプリキャッシュしても
//     絶対にヒットしない。?v= を上げたら下の DATA も必ず同時に上げること。
//     逆に、中身を差し替えたのに ?v= を据え置くのも禁止。実データは cacheFirst で
//     配るので (「?v= が変われば別URL」という前提に乗っている)、URLが同じままだと
//     更新が永久に届かない。
//     (取りこぼし保険として、ページ側から CACHE_URLS メッセージでも登録できるようにしてある)
//
//  2. 「壊れたレスポンス」でキャッシュを上書きしないこと。
//     ネットワーク優先で無条件に cache.put すると、キャプティブポータルのログイン画面
//     (200 OK + text/html) が graph_v2.json の中身として保存され、次のオフライン起動で
//     JSON.parse が落ちる。これがユーザー報告の「データが飛ぶ」の正体。
//
// そのうえで、初回起動を速くするための取り決めがもう1つある。
//
//  3. install で DATA をネットワークから取りに行かないこと。
//     ページ自身が同じ11MBを取っている最中に install が同じURLを no-cache で叩くと、
//     初回訪問だけ通信量が丸ごと2倍になり、細い回線ではページ側の取得まで遅くなる。
//     install は SHELL(数十KB)だけ確保して即終わらせ、DATA はページが読み終わってから
//     CACHE_URLS で拾う。そのときには同じURLがHTTPキャッシュ(vercel.json で immutable)に
//     載っているので、実質ネットワークを使わずにコピーできる。
//     その代わり「新キャッシュが揃うまで旧キャッシュを消さない」を activate で守る。
//
// v42 = オフラインキャッシュ修正(v41) と マイナー路線QA(v41) の統合。
// 両ブランチが独立に v41 を名乗ってしまったので、どちらのクライアントから見ても
// 新しい世代になるよう v42 にする。
// v43 = サジェストが到着欄を覆ってフォーカスを奪う不具合の修正(index.html)。
// v44 = 初期ロード短縮(install二段階化・data_worker.js化)の統合。
// v45 = 特急/新幹線の指定席・自由席の料金差(fares.json に express.seat を追加、?v=11)。
// v46 = 連結成分プルーニング廃止で40路線514駅を復元(Issue #11。graph/meta/bin 全更新)。
// v47 = 駅の読みがな(r)・英字名(e)補完 (#12)。graph_v2、bus再同期で bin/meta も更新。
//       #11(PR #22) と #12(PR #23) が独立に v46 を名乗ったため、release/v1.1 で v47 に繰り上げた。
// v48 = 片方向しか収録されていなかった区間の逆方向を再取得(+8,066本、#13)。
//       PR #27 も独立に v46 を名乗っていたため v48 に繰り上げた。
// v49 = 土休ダイヤの運転日タグを本数ベースで振り直し(#10)。
//       PR #21 も独立に v46 を名乗っていたため v49 に繰り上げた。
// v50 = 同名別駅の誤座標修正+徒歩連絡の張り直し、駅名の全角/半角ゆれ吸収と
//       祝日カレンダーの計算化、ＪＲ関西空港線/宮崎空港線の会社判定 (QA第3ラウンド)。
//       PR #16 も独立に v46 を名乗っていたため v50 に繰り上げた。
//
// 注記: #22/#23/#27/#21/#16/#19 の6本が並行して v46 を名乗っていたため、release/v1.1 では
//       取り込み順に v46〜v50 を割り当て直している。最終的な世代は下の VERSION が唯一の正。
// v51 = バスGTFSの全国展開(1事業者 → 297フィード / 268事業者 / 41都道府県)。
//       PR #19 も独立に v46 を名乗っていたため v51 に繰り上げた。
// v52 = 予算(運賃上限)を指定した経路検索 (router_v3.js ?v=14)。
//       PR #17 も独立に v46 を名乗っていたため v52 に繰り上げた。
// v53 = 路線種別指定(JRのみ/私鉄のみ)と私鉄の事業者絞り込み。
//       PR #9 も独立に v46 を名乗っていたため v53 に繰り上げた。
// v54 = 駅の会社判定をＪＲ実路線名リストの照合に修正 (#15)。
//       PR #24 も独立に v46 を名乗っていたため v54 に繰り上げた。
// v55 = 経路検索結果に乗車・降車のホーム番号(のりば)を表示 (platforms.json / platform_match.js)。
//       PR #20 も独立に v46 を名乗っていたため v55 に繰り上げた。
// v56 = 複数日ロールオーバー探索(宿泊を挟む超長距離、data_worker.js ?v=2)。
//       PR #26 も独立に v46 を名乗っていたため v56 に繰り上げた。
const VERSION = 'v56';
const CACHE_NAME = `transit-${VERSION}`;

// アプリの外枠。これが無いと起動すらできない。
const SHELL = [
  './',
  './index.html',
  './router_v3.js?v=14',
  './platform_match.js?v=1',
  './data_worker.js?v=3',
  './manifest.json',
];

// 大きい実データ。壊れた/古いものを混ぜて配ると誤った時刻を表示しかねないので、
// これらは常に完全一致でしか返さない (ignoreSearch フォールバックの対象外)。
const DATA = [
  './graph_v2.json?v=7',
  './trains_v3_meta.json?v=5',
  './fares.json?v=11',
  './trains_v3.bin.gz?v=5',
];

// 無くても起動はできるもの。取得に失敗しても install を失敗させない。
// platforms.json はのりば表示用(無くても検索は動く)。
const OPTIONAL = [
  './debug-note.js',
  './icon-192.png',
  './icon-512.png',
  './platforms.json?v=1',
];

const REQUIRED = [...SHELL, ...DATA];

// DATA のパス集合。クエリを剥がした形で持つ (?v= が変わっても判定はぶれない)
const DATA_PATHS = new Set(DATA.map(u => new URL(u, self.location.href).pathname));

const isDataAsset = url => DATA_PATHS.has(url.pathname);

// ---------------------------------------------------------------- 検証 & 保存

// 「200 OK だが中身が別物」を弾く。
// JSON/バイナリを要求したのに text/html が返るのは、ほぼ確実にキャプティブポータルか
// プロキシのエラーページ。これをキャッシュに書くと正常なデータが破壊される。
function looksLikeInterstitial(url, response) {
  if (!/\.(json|gz|bin|png|js)$/.test(url.pathname)) return false;
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  return ct.includes('text/html');
}

function isCacheable(request, response) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin !== self.location.origin) return false;
  // .ok は 206 Partial Content も true にしてしまう。
  // 部分レスポンスをフルURLのキーで保存すると、オフライン時に千切れたファイルを配ることになる。
  if (response.status !== 200) return false;
  if (response.type === 'opaque' || response.type === 'error') return false;
  if (looksLikeInterstitial(url, response)) return false;
  return true;
}

// 容量不足はリトライしても直らないので、一度当たったら以降の再試行を打ち切る。
let quotaHit = false;

async function reportQuota() {
  if (quotaHit) return;
  quotaHit = true;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: 'CACHE_QUOTA_EXCEEDED' });
}

// キャッシュへの安全な書き込み。
//
// cache.put(req, resp) にストリームを直接渡すと、本文の途中で回線が切れた場合に
// 「古い正常なエントリを消した後で新しい書き込みに失敗する」形になり得る。4MB超の
// trains_v3.bin.gz では現実に起きる。先に本文を最後まで読み切り、成功した時だけ
// put することで、書き込みは実質アトミックになる (失敗しても既存エントリは無傷)。
async function safePut(cache, request, response) {
  if (!isCacheable(request, response)) return false;
  let body;
  try {
    body = await response.clone().blob();
  } catch (err) {
    // 本文が途中で切れた。キャッシュには一切触れていないので既存データは守られる。
    console.warn('[sw] body read failed, keeping existing cache entry:', request.url, err);
    return false;
  }
  // Content-Length があるなら実際に読めたバイト数と突き合わせる。
  // ヘッダだけ来て本文が短い、という切断パターンをここで捕まえる。
  //
  // ただし Content-Length は「転送された(=圧縮後の)バイト数」で、body.size は
  // 展開後のバイト数。gzip/br で配られたものを単純比較すると必ず食い違うので、
  // 正常なレスポンスを軒並み truncated 扱いして何ひとつキャッシュできなくなる。
  // (vercel は text/json を自動で圧縮するので、圧縮を考慮しない実装では
  //  install が毎回失敗し、オフライン対応が事実上死ぬ)
  // 圧縮がかかっているときは「宣言より短い」= 明らかな切断だけを弾く。
  const declared = response.headers.get('content-length');
  if (declared) {
    const n = Number(declared);
    const encoded = !!response.headers.get('content-encoding');
    if (encoded ? body.size < n : body.size !== n) {
      console.warn(`[sw] truncated response (${body.size}/${declared}):`, request.url);
      return false;
    }
  }
  try {
    await cache.put(request, new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: response.headers,
    }));
    return true;
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      console.error('[sw] quota exceeded, cannot cache:', request.url);
      await reportQuota();
    } else {
      console.warn('[sw] cache.put failed:', request.url, err);
    }
    return false;
  }
}

// ---------------------------------------------------------------- プリキャッシュ

// 大きいファイルは1回の失敗で諦めない。addAll が「1つコケたら全滅」なのを避けるため、
// 1件ずつ取得してリトライする。
//
// cacheMode:
//   'default'  ページが直前に取ったものをHTTPキャッシュから拾う (通信を増やさない)。
//              実データURLは ?v= 付き＋immutable なので、内容が変われば別URLになる。
//   'no-cache' 壊れたものを掴んでいる可能性があるとき用 (RECACHE)。必ずサーバに確認する。
async function fetchAndStore(cache, url, { attempts = 3, cacheMode = 'default' } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const req = new Request(url, { cache: cacheMode });
      const resp = await fetch(req);
      if (await safePut(cache, req, resp)) return true;
      if (quotaHit) return false; // 容量不足。何度やっても同じ
    } catch (err) {
      console.warn(`[sw] fetch failed (${i + 1}/${attempts}):`, url, err);
    }
  }
  return false;
}

// 旧世代のキャッシュから同一URLのエントリを引き継ぐ。
// オフライン中にSWが更新された場合、これが無いと新キャッシュが空のまま activate され
// 手持ちのデータが全部消える。「たまにデータが飛ぶ」の主因のひとつ。
async function copyFromOldCache(cache, url) {
  const keys = await caches.keys();
  for (const key of keys) {
    if (key === CACHE_NAME || !key.startsWith('transit-')) continue;
    const old = await caches.open(key);
    const hit = await old.match(url);
    if (hit) {
      try {
        await cache.put(url, hit);
        console.log('[sw] carried over from', key, url);
        return true;
      } catch (err) {
        console.warn('[sw] carry-over failed:', url, err);
      }
    }
  }
  return false;
}

// ネットワーク → 旧キャッシュ の順で1件確保する。
// network:false なら通信せず、旧世代からの引き継ぎだけを試す。
async function ensureCached(cache, url, { network = true, cacheMode = 'default' } = {}) {
  if (await cache.match(url)) return true;
  if (network && await fetchAndStore(cache, url, { cacheMode })) return true;
  return copyFromOldCache(cache, url);
}

async function fillCache(cache, urls, opts) {
  const oks = await Promise.all(urls.map(u => ensureCached(cache, u, opts)));
  return urls.filter((_, i) => !oks[i]);
}

// 新キャッシュに必須アセットが全部揃っているか
async function missingFrom(cache, urls) {
  const found = await Promise.all(urls.map(u => cache.match(u)));
  return urls.filter((_, i) => !found[i]);
}

// 旧世代のキャッシュを片付ける。
// 「新キャッシュが必須アセットを全部持っている」ことが確認できたときだけ実行する。
// ここを無条件にすると、?v= が上がった直後のオフライン起動で、まだ落とせていない新データと
// 消してしまった旧データの両方が無い状態になる。
async function cleanupOldCaches() {
  const cache = await caches.open(CACHE_NAME);
  const missing = await missingFrom(cache, REQUIRED);
  if (missing.length) return missing;
  const keys = await caches.keys();
  await Promise.all(
    keys.filter(k => k.startsWith('transit-') && k !== CACHE_NAME).map(k => caches.delete(k))
  );
  return [];
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // シェルは必須。取れないなら更新を見送る (例外を投げれば activate は走らず、
    // 旧キャッシュが消されないまま旧SWがオフライン動作を続けられる)。
    const missing = await fillCache(cache, SHELL);
    if (missing.length) {
      throw new Error(`[sw] precache incomplete, aborting update: ${missing.join(', ')}`);
    }
    // 実データはここでは取りに行かない (上の注意書き3)。旧世代からの引き継ぎだけ行う。
    // オフライン中のSW更新で手持ちデータが消えないのは、この引き継ぎが担保している。
    await fillCache(cache, DATA, { network: false });
    await fillCache(cache, OPTIONAL, { network: false });
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // 新キャッシュが必須アセットを全部持っているときだけ旧世代を消す。
    // 足りないときは残しておき、ページから CACHE_URLS が来て揃った時点で片付ける。
    await cleanupOldCaches();
    await self.clients.claim();
    // シェル以外の飾り物は、起動を邪魔しないようここで後追いする
    const cache = await caches.open(CACHE_NAME);
    await fillCache(cache, OPTIONAL);
  })());
});

// ---------------------------------------------------------------- fetch 戦略

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request);
  if (hit) {
    // URLに ?v= が入っている＝内容が変われば別URLになる。
    // よって裏での再取得は不要で、古いものを配る心配もない。
    return hit;
  }
  const resp = await fetch(request);
  await safePut(cache, request, resp.clone());
  return resp;
}

async function networkFirst(request, { allowIgnoreSearch }) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const resp = await fetch(request);
    // 検証を通ったものだけ保存する。ダメなレスポンスでも呼び出し元には素通しするが、
    // キャッシュ上の正常なコピーは絶対に壊さない。
    await safePut(cache, request, resp.clone());
    return resp;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    if (allowIgnoreSearch) {
      // シェル資産だけの救済措置。?v= がズレていても、とりあえず起動はさせる。
      // DATA には適用しない (バージョン違いを混ぜると誤った時刻を出しかねないため)。
      const loose = await cache.match(request, { ignoreSearch: true });
      if (loose) return loose;
    }
    throw err;
  }
}

// ナビゲーション。deep-link (?from=&to=) 付きで開かれることがあるので、
// クエリ込みの完全一致に失敗したら index.html 本体にフォールバックする。
// 旧実装はここで 503 を返していたため、オフラインでdeep-linkを開くと真っ白になっていた。
async function handleNavigate(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const resp = await fetch(request);
    // 保存先は常に ./index.html に固定する。リクエストURLをそのままキーにすると
    // deep-link の from/to の組み合わせごとにエントリが増え、容量を食い潰す。
    await safePut(cache, new Request('./index.html'), resp.clone());
    return resp;
  } catch (err) {
    return (await cache.match(request)) ||
           (await cache.match('./index.html')) ||
           (await cache.match('./')) ||
           new Response('オフラインです。オンラインで一度開き直してください。', {
             status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
           });
  }
}

self.addEventListener('fetch', e => {
  const request = e.request;
  // 非GET と別オリジンは触らない。
  // 旧実装は全部を respondWith で横取りし、POST や chrome-extension: に対して
  // cache.put が TypeError を投げて未処理の rejection を撒き散らしていた。
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate') {
    e.respondWith(handleNavigate(request));
    return;
  }
  if (isDataAsset(url)) {
    // 実データはキャッシュ優先。ネットワークを見に行かないので、回線が不安定でも
    // 壊れたレスポンスで上書きされる余地がそもそも無い。
    e.respondWith(cacheFirst(request));
    return;
  }
  e.respondWith(networkFirst(request, { allowIgnoreSearch: true }));
});

// ---------------------------------------------------------------- メッセージ

// ページ側から「実際に使っているURL」を送ってもらい、オフライン用に保存する。
//
// これが実データの本来の保存経路。ページが読み終わってから走るので、同じURLは
// もうHTTPキャッシュ(immutable)に載っていて、通信をほぼ増やさずにコピーできる。
// index.html の ?v= と上の DATA がズレていても、ここで実URLが入るので自己修復もする。
async function cacheUrls(urls) {
  const cache = await caches.open(CACHE_NAME);
  const missing = await fillCache(cache, urls);
  // 揃ったなら、activate で残しておいた旧世代をここで片付ける
  await cleanupOldCaches();
  return missing;
}

self.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'CACHE_URLS' && Array.isArray(msg.urls)) {
    e.waitUntil(cacheUrls(msg.urls).then(missing => {
      if (missing.length) console.warn('[sw] could not cache:', missing);
    }));
    return;
  }
  if (msg.type === 'RECACHE') {
    // 復旧用。壊れたエントリを捨てて必須アセットを取り直す。
    // ここだけはHTTPキャッシュも信用しない (壊れたものが載っている可能性がある)。
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const targets = [...REQUIRED, ...(msg.urls || [])];
      for (const u of targets) await cache.delete(u);
      const missing = await fillCache(cache, targets, { cacheMode: 'no-cache' });
      const port = e.ports && e.ports[0];
      if (port) port.postMessage({ type: 'RECACHE_DONE', missing });
    })());
    return;
  }
  if (msg.type === 'CACHE_STATUS') {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const have = [];
      const missing = [];
      for (const u of REQUIRED) ((await cache.match(u)) ? have : missing).push(u);
      const port = e.ports && e.ports[0];
      if (port) port.postMessage({ type: 'CACHE_STATUS', version: CACHE_NAME, have, missing });
    })());
  }
});
