#!/usr/bin/env python3
"""gapfill_reverse.py — 「片方向しか列車が無い有向区間」の逆方向を再取得して trains.json に足す。

背景:
  scrape_trains.py の Phase1 は「路線ごとに発車本数が最多の1駅」の **/d1 だけ** を見る
  (scrape_trains.py:83-92)。line-station ページは
    /line-station/<路線ID>-<駅序数>/<d1|d2>   = その駅の、その方面の時刻表
  なので、d2 側や別の駅から出る方向は列挙されない。
  gapfill_trains.py は missing_stations.json(=駅そのものが落ちている駅)を両方向で
  埋めたが、「駅は在るが片方向の列車だけ落ちている」ケースは対象外だった。
  結果、東武大師線 西新井→大師前 や 西信貴ケーブル 高安山→信貴山口 のような
  逆方向 0本の有向区間が 328本 残っていた。

やること:
  Stage A: 片方向欠落区間の両端駅の駅ページから line-station ページ(全方面)を列挙
  Stage B: 各 line-station ページから列車詳細URL(tx)を収集。既知txは捨てる
  Stage C: 新規txの詳細ページを取得
  Stage D: trains.json へマージ

Usage:
  python3 gapfill_reverse.py                 取得した列車を全部マージ(既定)
  python3 gapfill_reverse.py --only-missing   欠落有向区間を埋める列車だけマージ

Resume: gapfill_rev_state.json に進捗保存。何度実行しても続きから。
"""

import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gapfill_trains import http_get2, TRAIN_RE
from scrape_trains import parse_train_detail, save_json

BASE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE, 'gapfill_rev_state.json')
TRAINS = os.path.join(BASE, 'trains.json')
GRAPH = os.path.join(BASE, 'graph_v2.json')

DELAY = 0.5
WORKERS = 6

LS_RE = re.compile(r'/timetable/railway/line-station/(\d+-\d+)/(d\d)')


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {'done_stations': [], 'pages': [], 'done_pages': [],
            'txs': {}, 'train_data': {}}


def oneway_edges(trains, k2i):
    """trains.json から片方向しか列車が無い有向区間を出す(qa_direction.js と同じ定義)。
    返り値: [(a_idx, b_idx, 本数)] — a→b は在るが b→a が無い。"""
    edges = {}
    for t in trains:
        ss = [k2i[s['s']] for s in t['stops'] if s['s'] in k2i]
        for i in range(len(ss) - 1):
            edges[(ss[i], ss[i + 1])] = edges.get((ss[i], ss[i + 1]), 0) + 1
    return [(a, b, n) for (a, b), n in edges.items() if (b, a) not in edges]


def stage_a(state, sids):
    """欠落区間の関係駅の駅ページから line-station ページURLを列挙"""
    done = set(state['done_stations'])
    todo = sorted(sids - done)
    print(f"=== Stage A: 駅ページ {len(todo)}件 ({len(done)}件済) ===", flush=True)
    if not todo:
        return

    pages = set(state['pages'])
    lock = threading.Lock()
    count = [0]

    def fetch(sid):
        html, permanent = http_get2(f"https://ekitan.com/timetable/railway/station/{sid}")
        with lock:
            if html:
                for ls, d in LS_RE.findall(html):
                    pages.add(f"{ls}/{d}")
            if html is not None or permanent:
                state['done_stations'].append(sid)
            count[0] += 1
            if count[0] % 50 == 0:
                state['pages'] = sorted(pages)
                save_json(STATE_FILE, state)
                print(f"  [{count[0]}/{len(todo)}] pages={len(pages)}", flush=True)
        time.sleep(DELAY)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for f in as_completed([ex.submit(fetch, s) for s in todo]):
            try:
                f.result()
            except Exception as e:
                print(f"  station error: {e}", file=sys.stderr)

    state['pages'] = sorted(pages)
    save_json(STATE_FILE, state)
    print(f"Stage A done: line-station ページ {len(pages)}件", flush=True)


def stage_b(state, known_txs):
    """line-station ページから未知の列車URLを収集"""
    done = set(state['done_pages'])
    todo = [p for p in state['pages'] if p not in done]
    print(f"=== Stage B: line-station {len(todo)}件 ({len(done)}件済) ===", flush=True)
    if not todo:
        return

    lock = threading.Lock()
    count = [0]

    def fetch(page):
        url = f"https://ekitan.com/timetable/railway/line-station/{page}"
        html, permanent = http_get2(url)
        with lock:
            if html:
                m = re.search(r'<title>([^<]*)', html)
                hint = m.group(1).split('の時刻表')[0] if m else ''
                # "西新井駅(東武大師線 大師前方面)" → 路線名だけ残す
                lm = re.search(r'[(（]([^\s　]+)[\s　]', hint)
                line = lm.group(1) if lm else ''
                for sf, tx, dep, sff, d in TRAIN_RE.findall(html):
                    if tx not in known_txs and tx not in state['txs']:
                        state['txs'][tx] = {'sf': sf, 'dep': dep, 'sff': sff,
                                            'd': d, 'line': line}
            if html is not None or permanent:
                state['done_pages'].append(page)
            count[0] += 1
            if count[0] % 100 == 0:
                save_json(STATE_FILE, state)
                print(f"  [{count[0]}/{len(todo)}] 新規tx={len(state['txs'])}", flush=True)
        time.sleep(DELAY)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for f in as_completed([ex.submit(fetch, p) for p in todo]):
            try:
                f.result()
            except Exception as e:
                print(f"  page error: {e}", file=sys.stderr)

    save_json(STATE_FILE, state)
    print(f"Stage B done: 新規tx {len(state['txs'])}件", flush=True)


def stage_c(state):
    """新規列車の詳細を取得"""
    todo = [(tx, m) for tx, m in state['txs'].items() if tx not in state['train_data']]
    print(f"=== Stage C: 列車詳細 {len(todo)}件 ===", flush=True)
    if not todo:
        return

    lock = threading.Lock()
    count = [0]

    def fetch(tx, meta):
        url = (f"https://ekitan.com/timetable/railway/train?"
               f"sf={meta['sf']}&tx={tx}&dw=&dt=&departure={meta['dep']}"
               f"&SFF={meta['sff']}&d={meta['d']}")
        html, permanent = http_get2(url)
        with lock:
            if html:
                info, stops = parse_train_detail(html)
                state['train_data'][tx] = {'info': info, 'stops': stops,
                                           'line_hint': meta.get('line', '')}
            elif permanent:
                state['train_data'][tx] = {'error': True}
            # 一時的失敗は記録しない→次回再試行
            count[0] += 1
            if count[0] % 200 == 0:
                save_json(STATE_FILE, state)
                eta = (len(todo) - count[0]) * DELAY / WORKERS
                print(f"  [{count[0]}/{len(todo)}] ETA {eta/60:.0f}min", flush=True)
        time.sleep(DELAY)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for f in as_completed([ex.submit(fetch, tx, m) for tx, m in todo]):
            try:
                f.result()
            except Exception as e:
                print(f"  train error: {e}", file=sys.stderr)

    save_json(STATE_FILE, state)
    ok = sum(1 for v in state['train_data'].values() if not v.get('error'))
    print(f"Stage C done: {ok} ok / {len(state['train_data'])}", flush=True)


def to_minutes(t):
    if not t:
        return None
    h, m = t.split(':')
    return int(h) * 60 + int(m)


def missing_directed(trains, k2i, edges_json):
    """埋めたい有向区間の集合を返す(ekitan駅IDのペア)。
      - a→b は在るが b→a が無い ... その b→a
      - graph_v2.edges の隣接で両方向とも列車が無い ... 両方向"""
    have = set()
    for t in trains:
        ss = [k2i[s['s']] for s in t['stops'] if s['s'] in k2i]
        for i in range(len(ss) - 1):
            have.add((ss[i], ss[i + 1]))
    want = {(b, a) for (a, b) in have if (b, a) not in have}
    for k, arr in edges_json.items():
        a = int(k)
        for e in arr:
            b = e[0]
            for p in ((a, b), (b, a)):
                if p not in have:
                    want.add(p)
    i2k = {v: kk for kk, v in k2i.items()}
    return {(i2k[a], i2k[b]) for a, b in want if a in i2k and b in i2k}


def stable_key(tx):
    p = tx.split('-')
    return p[0] + '|' + p[-1] if len(p) >= 2 else tx


def make_cal_tagger(trains):
    """新規列車の運転日bitを決める。
    tag_calendar.py を流し直さないのは、コミット済み daytype_keys.json が
    現 trains.json のタグ付けに使われたものより不完全で、流し直すと既存29,733本の
    土休日運転が消えるため(平日のみ率 7.6%→34%)。既存列車のcalには触らない。
      1) 同じ安定キーの既存列車があればその値を継ぐ
      2) daytype_keys.json が土/休を知っていればそれを使う
      3) どちらも無ければ 7(毎日) — make_trains_v3.py と同じ安全側の既定"""
    known = {}
    for t in trains:
        c = t.get('cal')
        if c is not None:
            known.setdefault(stable_key(t['tx']), c)
    dt = json.load(open(os.path.join(BASE, 'daytype_keys.json')))
    sat, sun = set(dt['sat']), set(dt['sun'])

    def cal_of(tx):
        k = stable_key(tx)
        if k in known:
            return known[k]
        if k in sat or k in sun:
            return 1 | (2 if k in sat else 0) | (4 if k in sun else 0)
        return 7
    return cal_of


def stage_d(state, want=None):
    """trains.json へマージ。want を渡すと、欠落有向区間を1つ以上埋める列車だけ入れる。"""
    print("=== Stage D: trains.json へマージ ===", flush=True)
    with open(TRAINS) as f:
        data = json.load(f)
    existing = {t['tx'] for t in data['trains']}
    cal_of = make_cal_tagger(data['trains'])
    # 同一列車の重複防止: (安定キー, 始発駅, 終着駅, 始発時刻)
    def sig(tx, stops):
        return (stable_key(tx), stops[0]['s'], stops[-1]['s'],
                stops[0].get('d') or stops[0].get('a'))
    seen = {sig(t['tx'], t['stops']) for t in data['trains']}

    added = skipped_scope = 0
    for tx, td in sorted(state['train_data'].items()):
        if tx in existing or td.get('error'):
            continue
        stops = td.get('stops', [])
        if len(stops) < 2:
            continue
        cs = [{'s': s['s'], 'n': s['n'],
               'a': to_minutes(s['a']), 'd': to_minutes(s['d'])} for s in stops]
        g = sig(tx, cs)
        if g in seen:
            continue
        if want is not None and not any(
                (cs[i]['s'], cs[i + 1]['s']) in want for i in range(len(cs) - 1)):
            skipped_scope += 1
            continue
        seen.add(g)
        info = td.get('info', {})
        data['trains'].append({
            'tx': tx,
            'line': info.get('line', td.get('line_hint', '')),
            'type': info.get('type', ''),
            'dest': info.get('dest', ''),
            'stops': cs,
            'cal': cal_of(tx),
        })
        added += 1

    data['trains'].sort(key=lambda t: (
        t['line'], t['stops'][0].get('d') or t['stops'][0].get('a') or 0))
    hist = {}
    for t in data['trains']:
        hist[t.get('cal', 7)] = hist.get(t.get('cal', 7), 0) + 1
    data['stats'] = {
        'total_trains': len(data['trains']),
        'total_stops': sum(len(t['stops']) for t in data['trains']),
        'lines': len(set(t['line'] for t in data['trains'])),
        'calendar': hist,
    }
    save_json(TRAINS, data)
    print(f"Stage D done: +{added}本 (対象外で見送り {skipped_scope}本) -> {data['stats']}",
          flush=True)


def main():
    # 既定は取得した列車を全部入れる(欠落区間の両端駅は他方向も取りこぼしていることが多く、
    # そちらも実在の列車なので落とす理由が無い)。--only-missing で欠落区間を埋める分だけに絞る。
    scope_all = '--only-missing' not in sys.argv
    with open(GRAPH) as f:
        gj = json.load(f)
    stations = gj['stations']
    k2i = {s['k']: i for i, s in enumerate(stations) if s.get('k')}
    i2k = {v: k for k, v in k2i.items()}

    with open(TRAINS) as f:
        data = json.load(f)
    trains = data['trains']
    known_txs = {t['tx'] for t in trains}

    one = oneway_edges(trains, k2i)
    print(f"片方向のみの有向区間: {len(one)}本", flush=True)
    # 欠落しているのは b→a。その列車は b 発なので b は必須。
    # a 側も、逆方向列車が a より手前で折り返す場合の取りこぼし対策に入れる。
    sids = {i2k[b] for _, b, _ in one} | {i2k[a] for a, _, _ in one}
    print(f"対象駅: {len(sids)}駅", flush=True)

    state = load_state()
    stage_a(state, sids)
    stage_b(state, known_txs)
    stage_c(state)
    want = None if scope_all else missing_directed(trains, k2i, gj['edges'])
    if want is not None:
        print(f"埋めたい有向区間: {len(want)}本", flush=True)
    stage_d(state, want)


if __name__ == '__main__':
    main()
