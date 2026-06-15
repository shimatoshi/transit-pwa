#!/usr/bin/env python3
"""scrape_daytype.py — 既存スクレイプ済み駅ページ(done_pages)を dw=1(土曜)/dw=2(休日)
で再取得し、各日種別に運転する列車tx集合を収集する。
(/dN はURL上は方向、?dw=N が曜日種別。元スクレイプは dw 無し=平日のみだった)

出力 daytype_tx.json: {"sat":[tx,...], "sun":[tx,...], "weekday_only":[...], "weekend_new":[...]}
resume: daytype_state.json に進捗保存。
"""
import json, os, re, sys, time, threading
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = os.path.dirname(os.path.abspath(__file__))
UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'
REF = 'https://ekitan.com/timetable/railway'
STATE = os.path.join(BASE, 'daytype_state.json')
OUT = os.path.join(BASE, 'daytype_tx.json')

TX_RE = re.compile(r'tx=([^&"\']+)&dw')


def http_get(url, retries=3):
    for a in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': REF,
                'Accept-Language': 'ja,en;q=0.5'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return ''
        except Exception:
            time.sleep(1.0 + a)
    return None


def load_pages():
    pages = set()
    for f in ['gapfill2_state.json', 'gapfill_state.json']:
        p = os.path.join(BASE, f)
        if os.path.exists(p):
            try:
                pages |= set(json.load(open(p)).get('done_pages', []))
            except Exception:
                pass
    return sorted(pages)


def main():
    pages = load_pages()
    print(f'対象駅ページ: {len(pages)} × dw[1,2]')
    state = {'done': {}, 'tx': {'1': [], '2': []}}
    if os.path.exists(STATE):
        state = json.load(open(STATE))
    done = state['done']                      # f"{page}|{dw}" -> True
    tx_sets = {'1': set(state['tx']['1']), '2': set(state['tx']['2'])}
    lock = threading.Lock()

    jobs = [(p, dw) for p in pages for dw in ('1', '2') if f'{p}|{dw}' not in done]
    print(f'残ジョブ: {len(jobs)}')

    def work(job):
        page, dw = job
        url = f'https://ekitan.com/timetable/railway/line-station/{page}?dw={dw}'
        html = http_get(url)
        if html is None:
            return job, None
        return job, set(TX_RE.findall(html))

    n = 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = [ex.submit(work, j) for j in jobs]
        for fut in as_completed(futs):
            job, txs = fut.result()
            page, dw = job
            n += 1
            if txs is None:
                continue
            with lock:
                tx_sets[dw] |= txs
                done[f'{page}|{dw}'] = True
            if n % 300 == 0:
                with lock:
                    state['tx'] = {'1': sorted(tx_sets['1']), '2': sorted(tx_sets['2'])}
                    json.dump(state, open(STATE, 'w'))
                print(f'  {n}/{len(jobs)} 完了  土tx={len(tx_sets["1"])} 休tx={len(tx_sets["2"])}', flush=True)

    state['tx'] = {'1': sorted(tx_sets['1']), '2': sorted(tx_sets['2'])}
    json.dump(state, open(STATE, 'w'))

    # 平日(既存train_data)との突合
    weekday_tx = set()
    g2 = os.path.join(BASE, 'gapfill2_state.json')
    if os.path.exists(g2):
        for t in json.load(open(g2)).get('train_data', []):
            weekday_tx.add(t.get('tx') if isinstance(t, dict) else t)
    sat, sun = tx_sets['1'], tx_sets['2']
    out = {
        'sat': sorted(sat), 'sun': sorted(sun),
        'weekend_new': sorted((sat | sun) - weekday_tx),   # 土休のみ運転(要詳細取得)
        'weekday_only': sorted(weekday_tx - sat - sun),     # 平日のみ運転
    }
    json.dump(out, open(OUT, 'w'))
    print(f'\n完了: 土{len(sat)} 休{len(sun)} / 平日のみ{len(out["weekday_only"])} '
          f'土休のみ新規{len(out["weekend_new"])}  → daytype_tx.json')


if __name__ == '__main__':
    main()
