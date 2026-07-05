/* debug-note.js — 全自作アプリ共通デバッグノート
 * 使い方: <script src="debug-note.js" data-app="myapp"></script>
 * data-app 省略時は location.hostname を使う
 * 保存: localStorage "debugnote.<app>" にJSONL蓄積
 * 発行: debugnote-<app>-YYYYMMDD.jsonl をダウンロード
 */
(function () {
  'use strict';
  if (window.__debugNoteLoaded) return;
  window.__debugNoteLoaded = true;

  var script = document.currentScript;
  var APP = (script && script.dataset.app) || window.DEBUG_NOTE_APP || location.hostname || 'unknown';
  var KEY = 'debugnote.' + APP;
  var POS = (script && script.dataset.pos) || 'right'; // right | left

  function load() { return localStorage.getItem(KEY) || ''; }
  function count() { var s = load(); return s ? s.trim().split('\n').length : 0; }
  function append(text) {
    var entry = JSON.stringify({ ts: new Date().toISOString(), app: APP, url: location.pathname + location.hash, note: text });
    localStorage.setItem(KEY, load() + entry + '\n');
  }

  function publish() {
    var data = load();
    if (!data) { alert('ノートは空'); return; }
    var d = new Date();
    var name = 'debugnote-' + APP + '-' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '.jsonl';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/x-ndjson' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  var css = document.createElement('style');
  css.textContent =
    '#dbgn-btn{position:fixed;bottom:96px;' + POS + ':6px;z-index:2147483646;width:26px;height:26px;' +
    'border-radius:50%;background:rgba(80,80,80,.30);color:rgba(255,255,255,.75);font-size:15px;' +
    'line-height:26px;text-align:center;user-select:none;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '#dbgn-panel{position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#222;color:#eee;' +
    'padding:8px;box-sizing:border-box;font:14px sans-serif;display:none;border-top:1px solid #555}' +
    '#dbgn-panel textarea{width:100%;height:72px;box-sizing:border-box;background:#111;color:#eee;' +
    'border:1px solid #555;border-radius:4px;padding:6px;font:14px sans-serif}' +
    '#dbgn-panel .dbgn-row{display:flex;gap:8px;margin-top:6px;align-items:center}' +
    '#dbgn-panel button{background:#444;color:#eee;border:none;border-radius:4px;padding:8px 14px;font-size:13px}' +
    '#dbgn-panel .dbgn-cnt{margin-left:auto;color:#888;font-size:12px}';
  document.head.appendChild(css);

  var btn = document.createElement('div');
  btn.id = 'dbgn-btn';
  btn.textContent = '\u270E';

  var panel = document.createElement('div');
  panel.id = 'dbgn-panel';
  panel.innerHTML =
    '<textarea placeholder="こうしたい・気づいたことをここに"></textarea>' +
    '<div class="dbgn-row">' +
    '<button data-act="save">保存</button>' +
    '<button data-act="pub">発行</button>' +
    '<button data-act="close">閉じる</button>' +
    '<span class="dbgn-cnt"></span></div>';

  function refresh() { panel.querySelector('.dbgn-cnt').textContent = count() + '件'; }

  btn.addEventListener('click', function () {
    var open = panel.style.display === 'block';
    panel.style.display = open ? 'none' : 'block';
    if (!open) { refresh(); panel.querySelector('textarea').focus(); }
  });

  panel.addEventListener('click', function (e) {
    var act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    var ta = panel.querySelector('textarea');
    if (act === 'save') {
      var t = ta.value.trim();
      if (t) { append(t); ta.value = ''; refresh(); }
    } else if (act === 'pub') {
      publish();
    } else if (act === 'close') {
      panel.style.display = 'none';
    }
  });

  function mount() { document.body.appendChild(btn); document.body.appendChild(panel); }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
