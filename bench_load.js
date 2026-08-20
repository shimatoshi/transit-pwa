/* bench_load.js — 初期ロードの計測。Before/After を同じ物差しで比べるための道具。
 *
 *   node bench_load.js              データ読み込みパイプラインを Node 上で段階別に計測
 *   node bench_load.js --browser    ヘッドレスChromeで「起動→検索可能」までを実測
 *
 * --browser は google-chrome (または CHROME 環境変数) と Node18+ の fetch/WebSocket を使う。
 * 追加の npm 依存は無い。
 *
 * 計測の定義:
 *   起動時間      = ナビゲーション開始 → 検索ボタンが有効になるまで (= 検索可能になるまで)
 *   FCP           = First Contentful Paint (画面に何か出るまで)
 *   ブロック時間  = 読み込み中にメインスレッドが50ms以上専有された合計 (long task)
 *   転送量        = そのロードで実際にネットワークから受け取ったバイト数
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const BASE = __dirname;
const ms = n => `${n.toFixed(0)}ms`;

// ---------------------------------------------------------------- Node パイプライン計測

function benchNode() {
  const R = require('./router_v3.js');
  const phases = [];
  let t = process.hrtime.bigint();
  const mark = name => {
    const now = process.hrtime.bigint();
    phases.push([name, Number(now - t) / 1e6]);
    t = now;
  };

  const graphText = fs.readFileSync(path.join(BASE, 'graph_v2.json'), 'utf8');
  const metaText = fs.readFileSync(path.join(BASE, 'trains_v3_meta.json'), 'utf8');
  const faresText = fs.readFileSync(path.join(BASE, 'fares.json'), 'utf8');
  const gz = fs.readFileSync(path.join(BASE, 'trains_v3.bin.gz'));
  mark('ファイル読み出し(キャッシュ命中相当)');

  const graph = JSON.parse(graphText);
  mark('JSON.parse graph_v2.json');
  const meta = JSON.parse(metaText);
  mark('JSON.parse trains_v3_meta.json');
  const fares = JSON.parse(faresText);
  mark('JSON.parse fares.json');

  const raw = zlib.gunzipSync(gz);
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  mark('gunzip trains_v3.bin.gz');

  const nameIndex = [];
  for (let i = 0; i < graph.stations.length; i++) {
    const s = graph.stations[i];
    nameIndex.push({ id: i, name: s.n, nameEn: (s.e || '').toLowerCase(), pref: s.p,
      lines: s.m ? (s.sys || []) : s.l, mode: s.m ? 1 : 0 });
  }
  mark('駅名インデックス構築');

  // 重い部分。buildConnections がある版では Worker に出せる部分と残る部分を分けて出す。
  let workerPart = null;
  if (typeof R.buildConnections === 'function' && typeof R.adoptBuild === 'function') {
    const built = R.buildConnections(ab, {
      tripLine: meta.trips.l, tripMode: meta.trips.m || null, nStations: graph.stations.length,
    });
    mark('buildConnections (Workerに出せる部分)');
    workerPart = phases[phases.length - 1][1];
    R.adoptBuild(built, meta, graph.stations, fares);
    mark('adoptBuild (メインスレッドに残る部分)');
  } else {
    R.loadBinary(ab, meta, graph.stations, fares);
    mark('loadBinary');
  }

  const total = phases.reduce((a, b) => a + b[1], 0);
  console.log('--- Node パイプライン (' + os.cpus()[0].model.trim() + ')');
  for (const [n, v] of phases) console.log(`  ${n.padEnd(42)} ${ms(v).padStart(9)}`);
  console.log(`  ${'合計'.padEnd(42)} ${ms(total).padStart(9)}`);
  if (workerPart != null) {
    console.log(`  ${'うちメインスレッド占有(Worker化した場合)'.padEnd(38)} ${ms(total - workerPart).padStart(9)}`);
  }
  console.log(`  conn数 ${R.data.nConn}`);
  return { phases, total, nConn: R.data.nConn };
}

// ---------------------------------------------------------------- 静的サーバ (vercel.json 相当)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.gz': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
};
// vercel.json は全体を must-revalidate にしているが、?v= 付きの実データだけは
// immutable にしている(= この設定を bench でも再現する)。vercel.json を読んで従う。
function cacheControlFor(pathname) {
  try {
    const vc = JSON.parse(fs.readFileSync(path.join(BASE, 'vercel.json'), 'utf8'));
    let hit = null;
    for (const rule of vc.headers || []) {
      if (!new RegExp('^' + rule.source + '$').test(pathname)) continue;
      const cc = (rule.headers || []).find(h => h.key.toLowerCase() === 'cache-control');
      if (cc) hit = cc.value;
    }
    return hit || 'public, max-age=0, must-revalidate';
  } catch { return 'public, max-age=0, must-revalidate'; }
}

function startServer() {
  // 圧縮結果はプロセス内でキャッシュする。毎リクエストで数MBを gzip すると
  // サーバ側のCPUが計測に混入して、アプリの改善が見えなくなる。
  const cache = new Map();
  const load = file => {
    if (cache.has(file)) return cache.get(file);
    const body = fs.readFileSync(file);
    const st = fs.statSync(file);
    const ext = path.extname(file);
    const compress = ext !== '.gz' && ext !== '.png' && body.length > 1024;
    const rec = {
      body, ext, etag: `"${st.size}-${Math.floor(st.mtimeMs)}"`,
      gz: compress ? zlib.gzipSync(body, { level: 6 }) : null,
    };
    cache.set(file, rec);
    return rec;
  };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(BASE, p);
    if (!file.startsWith(BASE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const rec = load(file);
    const headers = {
      'Content-Type': MIME[rec.ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(p),
      'ETag': rec.etag,
    };
    if (req.headers['if-none-match'] === rec.etag) { res.writeHead(304, headers); res.end(); return; }
    const acceptsGzip = /gzip/.test(req.headers['accept-encoding'] || '');
    if (acceptsGzip && rec.gz) {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = rec.gz.length;
      res.writeHead(200, headers); res.end(rec.gz);
    } else {
      headers['Content-Length'] = rec.body.length;
      res.writeHead(200, headers); res.end(rec.body);
    }
  });
  // 大きいファイルを4本並行で配るので、同時接続で詰まらないようにしておく
  server.keepAliveTimeout = 30000;
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---------------------------------------------------------------- 最小 CDP クライアント

async function connectCDP(port) {
  let info;
  for (let i = 0; i < 100; i++) {
    try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!info) throw new Error('Chrome の CDP に繋がりません');
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) {
      for (const fn of listeners) fn(m);
    }
  };
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });
  return { send, on: fn => listeners.push(fn), close: () => ws.close() };
}

// ページのスクリプトより前に仕込む計測器。
// Runtime.evaluate を navigate の後に投げると、重い処理が終わった後に観測を始めることに
// なって long task を取りこぼす。addScriptToEvaluateOnNewDocument で先に仕掛ける。
const INSTRUMENT = `(() => {
  const longTasks = [];
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) longTasks.push(e.duration); })
      .observe({ type: 'longtask', buffered: true });
  } catch {}
  const snapshot = () => {
    const paint = performance.getEntriesByType('paint');
    const fcp = (paint.find(p => p.name === 'first-contentful-paint') || {}).startTime || null;
    return {
      ready: performance.now(), fcp,
      blocked: longTasks.reduce((a, b) => a + b, 0),
      longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,
      status: (document.getElementById('status') || {}).textContent || '',
      // index.html が打つ起動シーケンスの印 (perfMark)
      marks: performance.getEntriesByType('mark')
        .filter(m => m.name.indexOf('transit:') === 0)
        .map(m => [m.name.slice(8), m.startTime]),
    };
  };
  // 「検索可能」= 検索ボタンが有効になった瞬間
  window.__benchReady = new Promise(resolve => {
    const iv = setInterval(() => {
      const b = document.getElementById('search-btn');
      if (b && !b.disabled) { clearInterval(iv); resolve(snapshot()); }
      else if (performance.now() > 120000) { clearInterval(iv); resolve(snapshot()); }
    }, 10);
  });
})()`;

// 実機に近づけるための負荷条件。
// ループバック+デスクトップCPUだと、初期ロードで実際に効いている要素
// (回線・端末の遅さ・並行ダウンロード)がほとんど見えなくなる。
const SCENARIOS = [
  { name: '据え置き(回線・CPU無制限)', net: null, cpu: 1 },
  // 屋外の4G相当。下り10Mbps / RTT 80ms、端末は手元PCの1/4の速さ
  { name: 'スマホ相当(10Mbps/RTT80ms/CPU 1/4)',
    net: { downloadThroughput: 10e6 / 8, uploadThroughput: 1e6 / 8, latency: 80 }, cpu: 4 },
];

async function benchBrowser(scenario, server, portBase) {
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'transit-bench-'));
  const chrome = process.env.CHROME || 'google-chrome';
  const dbg = portBase;
  const proc = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox',
    // プロキシ自動検出やコンポーネント更新が初回ナビゲーションを20秒以上止めることがある。
    // 計測にそのまま乗ってしまうので全部切る。
    '--no-proxy-server', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-default-apps', '--metrics-recording-only',
    'about:blank',
  ], { stdio: 'ignore' });

  const results = {};
  try {
    const cdp = await connectCDP(dbg);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);
    await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable');
    await S('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });

    // BENCH_TRACE=1 のときは Service Worker / Worker 側のログも拾う。
    // 「SWが黙って install に失敗していて、実は毎回ネットワークから取っていた」のような
    // 事故はページ側から全く見えないので、切り分けにはこれが要る。
    if (process.env.BENCH_TRACE) {
      cdp.on(async m => {
        if (m.method !== 'Target.attachedToTarget') return;
        const sid = m.params.sessionId;
        const type = m.params.targetInfo.type;
        if (type !== 'service_worker' && type !== 'worker') return;
        await cdp.send('Runtime.enable', {}, sid).catch(() => {});
        cdp.on(x => {
          if (x.sessionId !== sid || x.method !== 'Runtime.consoleAPICalled') return;
          const args = (x.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
          console.log(`    [${type}] ${x.params.type}: ${args}`);
        });
      });
      cdp.on(x => {
        if (x.sessionId !== sessionId || x.method !== 'Runtime.consoleAPICalled') return;
        const args = (x.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
        console.log(`    [page] ${x.params.type}: ${args}`);
      });
    }

    // ネットワーク実測。
    //
    // 注意: ページの fetch が SW を経由すると、実際にサーバへ出て行くリクエストは
    // SW のターゲット側に現れる。ページのセッションだけ見ていると「通信量ゼロ」に
    // 見えてしまい、二重ダウンロードのような問題が丸ごと隠れる。SW/Worker の
    // ターゲットにも Network を張って合算する。
    let net = 0, served = 0;
    const fromCache = new Set();
    const watched = new Set([sessionId]);
    cdp.on(async m => {
      if (m.method === 'Target.attachedToTarget') {
        const type = m.params.targetInfo.type;
        if (type !== 'service_worker' && type !== 'worker') return;
        const sid = m.params.sessionId;
        watched.add(sid);
        await cdp.send('Network.enable', {}, sid).catch(() => {});
        // 回線の制限はセッション単位。SW と Worker にも同じ条件を掛けないと、
        // 一番大きい trains_v3.bin.gz (Worker が取る) だけ無制限になってしまう。
        if (scenario.net) {
          await cdp.send('Network.emulateNetworkConditions',
            { offline: false, ...scenario.net }, sid).catch(() => {});
        }
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
      }
    });
    await cdp.send('Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

    cdp.on(m => {
      if (!watched.has(m.sessionId)) return;
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        // fromServiceWorker はページ側の見かけ上のヒット。実際の通信はSW側で数える。
        if (r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache) fromCache.add(m.params.requestId);
      }
      if (m.method === 'Network.loadingFinished') {
        const n = m.params.encodedDataLength || 0;
        served += n;
        if (!fromCache.has(m.params.requestId)) net += n;
      }
      // BENCH_TRACE=1 で待ち時間の内訳(どのリクエストがいつ始まり、いつ終わったか)を出す
      if (process.env.BENCH_TRACE) {
        if (m.method === 'Network.requestWillBeSent') {
          started.set(m.params.requestId, [m.params.timestamp, m.params.request.url]);
        } else if (m.method === 'Network.loadingFinished') {
          const s = started.get(m.params.requestId);
          if (s) console.log(`    [trace] +${((m.params.timestamp - s[0]) * 1000).toFixed(0)}ms ` +
            `${(m.params.encodedDataLength / 1024).toFixed(0)}KB ${s[1].split('/').pop()}`);
        }
      }
    });
    const started = new Map();

    const run = async label => {
      net = 0; served = 0; fromCache.clear();
      await S('Page.navigate', { url: origin });
      const r = await S('Runtime.evaluate', {
        expression: 'window.__benchReady', awaitPromise: true, returnByValue: true, timeout: 180000,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      results[label] = { ...r.result.value, net, served };
      return results[label];
    };

    // 初回ナビゲーションはネットワークスタックの初期化コストが乗るので、
    // アプリと無関係な404を1回踏んで暖めてから測る (アセットはキャッシュされない)。
    await S('Page.navigate', { url: origin + '__warmup' });
    await new Promise(r => setTimeout(r, 300));

    // 暖機のあとで絞る。回線とCPUの両方を落とさないと実機の体感にならない。
    if (scenario.net) await S('Network.emulateNetworkConditions', { offline: false, ...scenario.net });
    if (scenario.cpu > 1) await S('Emulation.setCPUThrottlingRate', { rate: scenario.cpu });

    // 1回目: まっさらなプロファイル = SWもHTTPキャッシュも空の初回訪問
    await run('初回訪問(キャッシュ空)');
    // SW のインストール/データ保存が終わるのを少し待つ
    await new Promise(r => setTimeout(r, scenario.net ? 20000 : 8000));
    // 2回目: SWキャッシュ命中の再訪問
    await run('再訪問(SWキャッシュ命中)');

    // 3回目: 機内モード。SWキャッシュだけで起動できるかの合否判定を兼ねる。
    // (HTTPキャッシュに助けられて再訪問だけ速い、という状態をここで暴く)
    for (const sid of watched) {
      await cdp.send('Network.emulateNetworkConditions',
        { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 }, sid).catch(() => {});
    }
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId).catch(() => {});
    await run('オフライン(機内モード・HTTPキャッシュ無効)');

    cdp.close();
  } finally {
    proc.kill();
    // Chrome がプロファイルを掴んだままだと消せないことがある。計測結果より優先しない。
    await new Promise(r => setTimeout(r, 500));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  console.log(`--- ヘッドレスChrome 実測 / ${scenario.name}`);
  for (const [label, r] of Object.entries(results)) {
    console.log(`  ${label}`);
    console.log(`    検索可能まで      ${ms(r.ready).padStart(9)}`);
    console.log(`    FCP               ${(r.fcp == null ? '-' : ms(r.fcp)).padStart(9)}`);
    console.log(`    メイン占有(50ms超) ${ms(r.blocked).padStart(9)}  最長 ${ms(r.longTaskMax)}`);
    console.log(`    通信量            ${(r.net / 1048576).toFixed(2)}MB` +
                `  (キャッシュ込み総読込 ${(r.served / 1048576).toFixed(2)}MB)`);
    if (r.status) console.log(`    ステータス表示    ${r.status}`);
    if (r.marks && r.marks.length) {
      let prev = 0;
      const parts = r.marks.map(([n, at]) => { const d = at - prev; prev = at; return `${n} +${ms(d)}`; });
      console.log(`    内訳              ${parts.join(' → ')}`);
    }
  }
  return results;
}

// ----------------------------------------------------------------

(async () => {
  if (!process.argv.includes('--browser')) { benchNode(); return; }
  const only = process.argv.includes('--fast') ? SCENARIOS.slice(0, 1) : SCENARIOS;
  const server = await startServer();
  try {
    let i = 0;
    for (const sc of only) await benchBrowser(sc, server, 9333 + (process.pid % 400) + (i++) * 2);
  } finally { server.close(); }
})().catch(e => { console.error(e); process.exit(1); });
