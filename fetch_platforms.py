#!/usr/bin/env python3
"""Wikipedia日本語版の駅記事「のりば」表から、駅ごとの
番線×路線×方面 データを抽出して platforms.json を作る。

出典: Wikipedia日本語版 (CC BY-SA 4.0)。抽出するのは事実データ
(番線番号・路線名・方面) のみ。

使い方:
  python3 fetch_platforms.py            # graph_v2.jsonの路線数>=4の駅を対象
  python3 fetch_platforms.py --min-lines 3
  python3 fetch_platforms.py --station 新宿   # 1駅だけテスト
"""
import argparse
import html as htmllib
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser

API = 'https://ja.wikipedia.org/w/api.php'
UA = 'transit-pwa-platform-fetcher/1.0 (personal project; contact via github)'
STATE = 'platforms_state.json'
# 注意: data/ は .vercelignore で除外されるため直下に置く
OUT = 'platforms.json'

# Wikipedia APIをレート制限(429)させないためのグローバル間隔制御
_rl_lock = threading.Lock()
_rl_last = [0.0]
MIN_INTERVAL = 0.5  # 秒/リクエスト(全スレッド合計)


def _rate_limit():
    with _rl_lock:
        now = time.monotonic()
        wait = _rl_last[0] + MIN_INTERVAL - now
        if wait > 0:
            time.sleep(wait)
        _rl_last[0] = time.monotonic()


def api_get(params, retries=5):
    params = dict(params, format='json', formatversion='2')
    url = API + '?' + urllib.parse.urlencode(params)
    for i in range(retries):
        _rate_limit()
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 429 and i < retries - 1:
                retry_after = int(e.headers.get('Retry-After') or 0)
                time.sleep(max(retry_after, 30))
                continue
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


# ---------------- HTMLテーブル → グリッド(rowspan/colspan展開) ----------------

class TableGridParser(HTMLParser):
    """<table>群を rowspan/colspan 展開済みの2次元配列にする。
    ネストした表は外側の表のセルテキストからは除外し、独立の表として返す。
    各表には直前の見出し階層(h2>h3>h4...)を chain として付与する。"""

    def __init__(self):
        super().__init__()
        self.tables = []      # 完成した表のリスト [{'rows': [[str]], 'chain': [str]}]
        self.stack = []       # 進行中の表
        self._hstack = {}     # 見出しレベル -> テキスト
        self._h_depth = 0
        self._h_level = 0
        self._h_buf = []

    def _chain(self):
        return [self._hstack[l] for l in sorted(self._hstack)]

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'table':
            self.stack.append({'grid': {}, 'row': -1, 'pending': [],
                               'chain': self._chain()})
        elif self.stack:
            t = self.stack[-1]
            if tag == 'tr':
                t['row'] += 1
                t['col'] = 0
            elif tag in ('td', 'th'):
                rs = int(re.sub(r'\D', '', a.get('rowspan', '1') or '1') or 1)
                cs = int(re.sub(r'\D', '', a.get('colspan', '1') or '1') or 1)
                # 既に埋まっている列を飛ばす
                while (t['row'], t['col']) in t['grid']:
                    t['col'] += 1
                t['cell'] = (t['row'], t['col'], rs, cs)
                t['buf'] = []
            elif tag == 'br' and 'buf' in t:
                t['buf'].append(' ')
        if tag in ('h2', 'h3', 'h4', 'h5'):
            self._h_depth += 1
            self._h_level = int(tag[1])
            self._h_buf = []

    def handle_endtag(self, tag):
        if tag in ('h2', 'h3', 'h4', 'h5') and self._h_depth:
            self._h_depth -= 1
            txt = re.sub(r'\[編集\]|\s+', ' ', ''.join(self._h_buf)).strip()
            if txt:
                lv = int(tag[1])
                # 同レベル以深の見出しをクリアして置き換え
                for k in [k for k in self._hstack if k >= lv]:
                    del self._hstack[k]
                self._hstack[lv] = txt
        if not self.stack:
            return
        t = self.stack[-1]
        if tag in ('td', 'th') and 'cell' in t:
            row, col, rs, cs = t.pop('cell')
            text = re.sub(r'\s+', ' ', ''.join(t.pop('buf', []))).strip()
            for dr in range(rs):
                for dc in range(cs):
                    t['grid'].setdefault((row + dr, col + dc), text)
            t['col'] = col + cs
        elif tag == 'table':
            t = self.stack.pop()
            if not t['grid']:
                return
            nrow = max(r for r, c in t['grid']) + 1
            ncol = max(c for r, c in t['grid']) + 1
            rows = [[t['grid'].get((r, c), '') for c in range(ncol)]
                    for r in range(nrow)]
            self.tables.append({'rows': rows, 'chain': t['chain']})

    def handle_data(self, data):
        if self._h_depth:
            self._h_buf.append(data)
        if self.stack and 'buf' in self.stack[-1]:
            self.stack[-1]['buf'].append(data)


def strip_refs(html):
    # 脚注・注釈([1]等)と編集リンクを落とす
    html = re.sub(r'<sup[^>]*class="[^"]*reference[^"]*"[^>]*>.*?</sup>', '', html, flags=re.S)
    html = re.sub(r'<span class="mw-editsection">.*?</span>', '', html, flags=re.S)
    # style/scriptを落とす(セル内に混入するため)
    html = re.sub(r'<(style|script)[^>]*>.*?</\1>', '', html, flags=re.S)
    return html


TRACK_HDR = ('番線', 'のりば', 'ホーム', '乗り場')
LINE_HDR = ('路線',)
DIR_HDR = ('方向',)
DEST_HDR = ('行先', '行き先', '方面', '発着列車')
TYPE_HDR = ('種別',)
# 過去のホーム・バスのりば等を除外する見出しパターン
BAD_CHAIN = re.compile(r'当時|変遷|旧|バス|廃止|歴史|移転|計画|改良工事以前|配線|信号')


def clean_text(s):
    s = htmllib.unescape(s)
    s = s.replace(' ', ' ')
    s = re.sub(r'[■□◆●○▲△]', '', s)
    s = re.sub(r'\s*・\s*', '・', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def parse_platform_tables(html):
    """のりば表らしきテーブルから [{'t','line','dir','dest'}] を抽出"""
    p = TableGridParser()
    p.feed(strip_refs(html))
    out = []
    for tbl in p.tables:
        rows = tbl['rows']
        if not rows or len(rows) < 2:
            continue
        chain = tbl.get('chain') or []
        if any(BAD_CHAIN.search(c) for c in chain):
            continue
        header = [clean_text(c) for c in rows[0]]
        # バスのりば表(系統列あり)は対象外
        if any('系統' in h for h in header):
            continue
        cols = {}
        for i, h in enumerate(header):
            if any(k in h for k in TRACK_HDR) and 'track' not in cols:
                cols['track'] = i
            elif any(k in h for k in LINE_HDR) and 'line' not in cols:
                cols['line'] = i
            elif any(k == h for k in DIR_HDR) and 'dir' not in cols:
                cols['dir'] = i
            elif any(k in h for k in DEST_HDR) and 'dest' not in cols:
                cols['dest'] = i
            elif any(k in h for k in TYPE_HDR) and 'type' not in cols:
                cols['type'] = i
        if 'track' not in cols or ('dest' not in cols and 'dir' not in cols):
            continue
        # 事業者コンテキスト: のりば見出しより上の階層で最後の意味のある見出し
        op = ''
        for c in chain:
            if ('のりば' in c or '乗り場' in c or c in ('駅構造', '駅概要', '構造')
                    or 'ホーム' in c):
                continue
            op = c
        if op in ('概要', '歴史', '利用状況', '駅周辺', '隣の駅', 'その他'):
            op = ''
        for row in rows[1:]:
            cells = [clean_text(c) for c in row]
            if len(cells) <= cols['track']:
                continue
            track = cells[cols['track']]
            # 番線らしい値のみ(数字を含む短い文字列)
            if not re.search(r'\d', track) or len(track) > 12:
                continue
            e = {'t': track}
            for key in ('line', 'dir', 'dest', 'type'):
                if key in cols and cols[key] < len(cells) and cells[cols[key]]:
                    e[key] = cells[cols[key]][:80]
            dest = e.get('dest', '')
            if '未使用' in dest or '降車' in dest:
                continue
            # 「1階ホーム」等の区切り行(colspanで全列同値になる)を除外
            vals = [v for k, v in e.items() if k != 't']
            if vals and all(v == e['t'] for v in vals):
                continue
            if '階' in e['t']:
                continue
            if op:
                e['op'] = op[:30]
            if e.get('dest') or e.get('dir'):
                out.append(e)
    return out


def fetch_page_html(title):
    """通常のWikipediaページ(CDN配信・api.phpよりレート制限が緩い)を取得"""
    url = 'https://ja.wikipedia.org/wiki/' + urllib.parse.quote(title.replace(' ', '_'))
    for i in range(4):
        _rate_limit()
        try:
            req = urllib.request.Request(
                url, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip'})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    import gzip
                    body = gzip.decompress(body)
                return body.decode('utf-8')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429 and i < 3:
                time.sleep(max(int(e.headers.get('Retry-After') or 0), 30))
                continue
            if i == 3:
                raise
            time.sleep(2 * (i + 1))
        except Exception:
            if i == 3:
                raise
            time.sleep(2 * (i + 1))


def fetch_station_platforms(title):
    """記事タイトル→のりば表エントリ抽出。(entries, title) を返す"""
    html = fetch_page_html(title)
    if html is None:
        return None, None
    if 'dmbox' in html:  # 曖昧さ回避ページ(テンプレートの箱)
        return None, title
    entries = parse_platform_tables(html)
    # 重複除去
    seen = set()
    uniq = []
    for e in entries:
        k = json.dumps(e, ensure_ascii=False, sort_keys=True)
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    return uniq, title


def candidate_titles(stn):
    """駅データから記事タイトル候補を返す"""
    # "大宮(埼玉)" のような曖昧回避サフィックスを外す
    plain = re.sub(r'[（(].*?[)）]$', '', stn['n'])
    cands = []
    for w in stn.get('wl', []):
        if w.endswith('駅') and plain in w:
            cands.append(w)
    base = plain + '駅'
    if base not in cands:
        cands.append(base)
    pref = stn.get('p')
    if pref:
        cands.append(f'{base} ({pref})')
    return cands


def process_station(stn):
    for title in candidate_titles(stn):
        try:
            entries, resolved = fetch_station_platforms(title)
        except Exception:
            continue
        if entries:
            return stn['n'], entries
    return stn['n'], None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--min-lines', type=int, default=4)
    ap.add_argument('--station', help='駅名を指定して1駅だけ処理(デバッグ)')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()

    g = json.load(open('graph_v2.json'))
    stations = g['stations']
    if args.station:
        targets = [s for s in stations if s['n'] == args.station]
    else:
        targets = [s for s in stations if len(s.get('l', [])) >= args.min_lines]
    # 路線数の多い順(主要駅から先に)
    targets.sort(key=lambda s: -len(s.get('l', [])))
    if args.limit:
        targets = targets[:args.limit]

    state = {}
    if os.path.exists(STATE):
        state = json.load(open(STATE))
    todo = [s for s in targets if state.get(s['n']) is None]
    print(f'targets={len(targets)} done={len(targets)-len(todo)} todo={len(todo)}',
          file=sys.stderr)

    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_station, s): s for s in todo}
        for fut in as_completed(futs):
            name, entries = fut.result()
            state[name] = entries  # None = 取得失敗/表なし
            done += 1
            if done % 20 == 0:
                json.dump(state, open(STATE, 'w'), ensure_ascii=False)
                ok = sum(1 for v in state.values() if v)
                print(f'{done}/{len(todo)} (ok={ok})', file=sys.stderr)
    json.dump(state, open(STATE, 'w'), ensure_ascii=False)

    out = {k: v for k, v in state.items() if v}
    os.makedirs('data', exist_ok=True)
    json.dump(out, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
    total = sum(len(v) for v in out.values())
    print(f'saved {OUT}: {len(out)} stations, {total} entries', file=sys.stderr)

    if args.station:
        print(json.dumps(state.get(args.station), ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
