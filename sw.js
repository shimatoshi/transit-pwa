// Service Worker — オフライン動作用キャッシュ。
//
// 設計上の大前提が2つある。踏むと「たまにデータが飛んでオフラインで動かない」に直結する。
//
//  1. ASSETS のURLは index.html が実際に投げるURLと1文字も違ってはいけない。
//     Cache API の照合はクエリ文字列まで含めた完全一致なので、index.html が
//     'graph_v2.json?v=4' を取りに行くのに './graph_v2.json' をプリキャッシュしても
//     絶対にヒットしない。?v= を上げたら下の DATA も必ず同時に上げること。
//     (取りこぼし保険として、ページ側から CACHE_URLS メッセージでも登録できるようにしてある)
//
//  2. 「壊れたレスポンス」でキャッシュを上書きしないこと。
//     ネットワーク優先で無条件に cache.put すると、キャプティブポータルのログイン画面
//     (200 OK + text/html) が graph_v2.json の中身として保存され、次のオフライン起動で
//     JSON.parse が落ちる。これがユーザー報告の「データが飛ぶ」の正体。
const VERSION = 'v41';
const CACHE_NAME = `transit-${VERSION}`;

// アプリの外枠。これが無いと起動すらできない。
const SHELL = [
  './',
  './index.html',
  './router_v3.js?v=11',
  './manifest.json',
];

// 大きい実データ。壊れた/古いものを混ぜて配ると誤った時刻を表示しかねないので、
// これらは常に完全一致でしか返さない (ignoreSearch フォールバックの対象外)。
const DATA = [
  './graph_v2.json?v=4',
  './trains_v3_meta.json?v=3',
  './fares.json?v=10',
  './trains_v3.bin.gz?v=3',
];

// 無くても起動はできるもの。取得に失敗しても install を失敗させない。
const OPTIONAL = [
  './debug-note.js',
  './icon-192.png',
  './icon-512.png',
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
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) !== body.size) {
    console.warn(`[sw] truncated response (${body.size}/${declared}):`, request.url);
    return false;
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
async function fetchAndStore(cache, url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const req = new Request(url, { cache: 'no-cache' });
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
async function ensureCached(cache, url) {
  if (await cache.match(url)) return true;
  if (await fetchAndStore(cache, url)) return true;
  return copyFromOldCache(cache, url);
}

async function fillCache(cache, urls) {
  const oks = await Promise.all(urls.map(u => ensureCached(cache, u)));
  return urls.filter((_, i) => !oks[i]);
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const missing = await fillCache(cache, REQUIRED);
    if (missing.length) {
      // ここで例外を投げると install が失敗し、activate は走らない。
      // 結果として旧キャッシュが消されずに残り、旧SWがオフライン動作を続けられる。
      // 中途半端な新キャッシュに切り替えて全滅させるより、更新を見送るほうが安全。
      throw new Error(`[sw] precache incomplete, aborting update: ${missing.join(', ')}`);
    }
    await fillCache(cache, OPTIONAL); // 欠けても続行
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // ここに到達した = install が完走した = 新キャッシュは必須アセットを全部持っている。
    // この順序が保証されて初めて旧キャッシュを消してよい。
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('transit-') && k !== CACHE_NAME).map(k => caches.delete(k))
    );
    await self.clients.claim();
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

// ページ側から「実際に使っているURL」を送ってもらい、取りこぼしを埋める。
// index.html の ?v= と上の DATA がズレても、オンラインで一度開けば自己修復する。
async function cacheUrls(urls) {
  const cache = await caches.open(CACHE_NAME);
  return fillCache(cache, urls);
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
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE_NAME);
      const targets = [...REQUIRED, ...(msg.urls || [])];
      for (const u of targets) await cache.delete(u);
      const missing = await fillCache(cache, targets);
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
