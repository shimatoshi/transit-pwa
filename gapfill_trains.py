#!/usr/bin/env python3
"""
Gap-fill scraper: missing_stations.json の駅の line-station ページ(両方向)から
未収集の列車URLを集め、詳細を取得して trains.json にマージする。

Phase1が「路線ごとに発車本数最多の1駅」しか見ていなかったため、
長大路線の遠隔区間のみを走る列車が丸ごと欠落していた問題の修復。

Resume: gapfill_state.json に進捗保存。何度実行しても続きから。
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrape_trains import http_get, parse_train_detail, save_json, UA, REFERER


def http_get2(url, retries=3):
    """戻り値: (html, permanent_fail)。
    404=ページ自体が無い(permanent=True, doneにしてよい)、
    ネットワーク系失敗=一時的(permanent=False, doneにしない→次回再試行)。
    http_get()は両者を区別せずNoneを返すため、DNS死亡中の実行で
    失敗ページがdone扱いされる事故があった。その再発防止。"""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Referer': REFERER,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ja,en;q=0.5',
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode('utf-8'), False
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, True
            print(f"  Retry {attempt+1}: {e}", file=sys.stderr)
        except Exception as e:
            print(f"  Retry {attempt+1}: {e}", file=sys.stderr)
        if attempt < retries - 1:
            time.sleep(3 * (attempt + 1))
    return None, False

BASE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE, 'gapfill_state.json')
DELAY = 0.8
WORKERS = 4

TRAIN_RE = re.compile(
    r'/timetable/railway/train\?sf=(\d+)&tx=([^&]+)&dw=[^&]*&dt=[^&]*'
    r'&departure=(\d{4})&SFF=([^&]+)&d=(\d+)'
)


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {'done_pages': [], 'txs': {}, 'train_data': {}}


def stage_a(state):
    """欠落駅のline-stationページ(両方向)から列車URLを収集"""
    with open(os.path.join(BASE, 'missing_stations.json')) as f:
        missing = json.load(f)
    with open(os.path.join(BASE, 'ekitan_stations.json')) as f:
        stations = json.load(f)
    with open(os.path.join(BASE, 'train_urls.json')) as f:
        known_txs = set(json.load(f)['txs'])

    pages = set()
    for sf in missing:
        for dr in stations[sf]['dirs']:
            for dd in ('d1', 'd2'):
                pages.add(f"{dr['ls']}-{dr['d']}/{dd}")
    done = set(state['done_pages'])
    todo = sorted(pages - done)
    print(f"=== Stage A: {len(todo)} pages to fetch ({len(done)} done) ===")

    lock = threading.Lock()
    count = [0]

    def fetch_page(page):
        url = f"https://ekitan.com/timetable/railway/line-station/{page}"
        html, permanent = http_get2(url)
        new = 0
        if html:
            title_m = re.search(r'<title>([^<]*)', html)
            line_hint = title_m.group(1).split('の時刻表')[0] if title_m else ''
            with lock:
                for sf, tx, dep, sff, d in TRAIN_RE.findall(html):
                    if tx not in known_txs and tx not in state['txs']:
                        state['txs'][tx] = {'sf': sf, 'dep': dep, 'sff': sff,
                                            'd': d, 'line': line_hint}
                        new += 1
        with lock:
            if html is not None or permanent:
                state['done_pages'].append(page)
            count[0] += 1
            if count[0] % 50 == 0:
                save_json(STATE_FILE, state)
                print(f"  [{count[0]}/{len(todo)}] new txs: {len(state['txs'])}")
        time.sleep(DELAY)
        return new

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = [ex.submit(fetch_page, p) for p in todo]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception as e:
                print(f"  page error: {e}", file=sys.stderr)

    save_json(STATE_FILE, state)
    print(f"Stage A done: {len(state['txs'])} new trains found")


def stage_b(state):
    """新規列車の詳細を取得"""
    todo = [(tx, m) for tx, m in state['txs'].items()
            if tx not in state['train_data']]
    print(f"=== Stage B: {len(todo)} train details to fetch ===")

    lock = threading.Lock()
    count = [0]

    def fetch_one(tx, meta):
        url = (f"https://ekitan.com/timetable/railway/train?"
               f"sf={meta['sf']}&tx={tx}&dw=&dt=&departure={meta['dep']}"
               f"&SFF={meta['sff']}&d={meta['d']}")
        html, permanent = http_get2(url)
        with lock:
            if not html:
                if permanent:
                    state['train_data'][tx] = {'error': True}
                # 一時的失敗は記録しない→次回再試行
            else:
                info, stops = parse_train_detail(html)
                state['train_data'][tx] = {
                    'info': info, 'stops': stops,
                    'line_hint': meta.get('line', ''),
                }
            count[0] += 1
            if count[0] % 100 == 0:
                save_json(STATE_FILE, state)
                eta = (len(todo) - count[0]) * DELAY / WORKERS
                print(f"  [{count[0]}/{len(todo)}] ETA {eta/60:.0f}min")
        time.sleep(DELAY)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = [ex.submit(fetch_one, tx, m) for tx, m in todo]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception as e:
                print(f"  train error: {e}", file=sys.stderr)

    save_json(STATE_FILE, state)
    ok = sum(1 for v in state['train_data'].values() if not v.get('error'))
    print(f"Stage B done: {ok} ok / {len(state['train_data'])} total")


def to_minutes(t):
    if not t:
        return None
    h, m = t.split(':')
    return int(h) * 60 + int(m)


def stage_c(state):
    """trains.json へマージ"""
    print("=== Stage C: merge into trains.json ===")
    path = os.path.join(BASE, 'trains.json')
    with open(path) as f:
        data = json.load(f)
    existing = {t['tx'] for t in data['trains']}

    added = 0
    for tx, td in state['train_data'].items():
        if tx in existing or td.get('error'):
            continue
        stops = td.get('stops', [])
        if len(stops) < 2:
            continue
        info = td.get('info', {})
        data['trains'].append({
            'tx': tx,
            'line': info.get('line', td.get('line_hint', '')),
            'type': info.get('type', ''),
            'dest': info.get('dest', ''),
            'stops': [{'s': s['s'], 'n': s['n'],
                       'a': to_minutes(s['a']), 'd': to_minutes(s['d'])}
                      for s in stops],
        })
        added += 1

    data['trains'].sort(key=lambda t: (
        t['line'], t['stops'][0].get('d') or t['stops'][0].get('a') or 0))
    data['stats'] = {
        'total_trains': len(data['trains']),
        'total_stops': sum(len(t['stops']) for t in data['trains']),
        'lines': len(set(t['line'] for t in data['trains'])),
    }
    save_json(path, data)
    print(f"Stage C done: +{added} trains -> {data['stats']}")


def main():
    state = load_state()
    stage_a(state)
    stage_b(state)
    stage_c(state)


if __name__ == '__main__':
    main()
