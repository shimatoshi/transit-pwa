/* data_worker.js — trains_v3.bin.gz の取得・解凍・CSA配列構築をメインスレッドの外でやる。
 *
 * 起動時間の内訳を測ると、8割方がこの3つ(fetch/gunzip/buildConnections)だった。
 * メインスレッドでやると読み込みが終わるまで画面が完全に固まるので、Worker に出す。
 * 出来上がった TypedArray は transfer で返すのでコピーは発生しない。
 *
 * メインとのやりとり:
 *   ← {type:'fetchBin', url}                      取得を開始する(meta を待たない)
 *   ← {type:'build', tripLine, tripMode, nStations}  meta が揃ったら構築を依頼
 *   → {type:'built', built}                       完成した配列(transfer済み)
 *   → {type:'error', message}                     失敗。メイン側は自前の経路にフォールバックする
 */
'use strict';
importScripts('router_v3.js?v=13');

// index.html と同じ理由のリトライ。電波が弱いと最初の1回だけ落ちることがよくある。
async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

async function fetchBin(url) {
  const res = await fetchWithRetry(url);
  let buf = await res.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x1f && u8[1] === 0x8b) { // gzip magic → 手動解凍
    const ds = new DecompressionStream('gzip');
    const stream = new Response(buf).body.pipeThrough(ds);
    buf = await new Response(stream).arrayBuffer();
  } else if (u8[0] === 0x3c) { // '<' で始まる = HTMLが返ってきている
    throw new Error(`${url}: データではなくHTMLが返りました(Wi-Fiのログイン画面かもしれません)`);
  }
  return buf;
}

let binPromise = null;

self.onmessage = e => {
  const m = e.data || {};
  if (m.type === 'fetchBin') {
    // meta の取得・parse と並行で走らせたいので、ここでは待たない。
    // 未処理 rejection にならないよう受け皿だけ付けておく (実際の報告は build 側で行う)
    binPromise = fetchBin(m.url);
    binPromise.catch(() => {});
    return;
  }
  if (m.type === 'build') {
    build(m).catch(err => {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    });
  }
};

async function build(m) {
  if (!binPromise) throw new Error('fetchBin が先に来ていません');
  const ab = await binPromise;
  binPromise = null;
  const built = self.RouterV3.buildConnections(ab, {
    tripLine: m.tripLine, tripMode: m.tripMode, nStations: m.nStations,
  });
  const transfer = [
    built.tripOff.buffer, built.stS.buffer, built.stA.buffer, built.stD.buffer,
    built.cDepS.buffer, built.cArrS.buffer, built.cDepT.buffer, built.cArrT.buffer,
    built.cTrip.buffer, built.cStopI.buffer, built.edgeKey.buffer, built.edgeLine.buffer,
  ];
  self.postMessage({ type: 'built', built }, transfer);
}
