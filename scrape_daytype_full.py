#!/usr/bin/env python3
"""scrape_daytype_full.py — 全line-stationを列挙し、土曜(dw=1)/休日(dw=2)に運転する
列車の安定キー(路線prefix|列車番号)を収集する。Pixel5で実行(DoHシムでDNS解決)。

ekitanの内部tx中間IDは日次で変わるため、突合は tx の (先頭=路線群, 末尾=列車番号) で行う。
出力 daytype_keys.json: {"sat":[key,...], "sun":[key,...]}
resume: daytype_full_state.json
"""
import json, os, re, sys, time, threading
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

# DNS: Pixel5 の bionic リゾルバが死んでいるため DoH シムを先に読み込む
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import dnsshim  # noqa
except Exception as e:
    print('dnsshim読込失敗(ローカル実行なら無視):', e)

UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'
REF = 'https://ekitan.com/timetable/railway'
BASE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(BASE, 'daytype_full_state.json')
OUT = os.path.join(BASE, 'daytype_keys.json')
TX = re.compile(r'tx=([^&"\']+)&dw')
MAX_ORD = 90          # 1路線あたり最大駅数(打ち切り)


def stable_key(tx):
    p = tx.split('-')
    return p[0] + '|' + p[-1] if len(p) >= 2 else tx


def http_get(url, retries=3):
    for a in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': REF,
                'Accept-Language': 'ja,en;q=0.5'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code in (404, 500):
                return ''
        except Exception:
            time.sleep(1.0 + a)
    return None


def load_lines():
    u = json.load(open(os.path.join(BASE, 'train_urls.json')))
    dl = u['done_lines']
    return [str(x) for x in (dl if isinstance(dl, list) else list(dl))]


def main():
    lines = load_lines()
    print(f'路線数: {len(lines)} を全駅×方向(d1,d2)×曜日(dw1,dw2)で列挙', flush=True)
    state = {'done_lines': [], 'sat': [], 'sun': []}
    if os.path.exists(STATE):
        state = json.load(open(STATE))
    done_lines = set(state['done_lines'])
    keys = {'1': set(state['sat']), '2': set(state['sun'])}
    lock = threading.Lock()
    todo = [l for l in lines if l not in done_lines]
    print(f'残路線: {len(todo)}', flush=True)

    def scan_line(lid):
        """1路線の全駅を列挙し、dw=1/2のtxキーを返す"""
        out = {'1': set(), '2': set()}
        for ordn in range(1, MAX_ORD + 1):
            empty = True
            for d in ('d1', 'd2'):
                for dw in ('1', '2'):
                    h = http_get(f'https://ekitan.com/timetable/railway/line-station/{lid}-{ordn}/{d}?dw={dw}')
                    if h:
                        ks = {stable_key(x) for x in TX.findall(h)}
                        if ks:
                            empty = False
                            out[dw] |= ks
            if empty and ordn > 2:
                break
        return lid, out

    n = 0
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = [ex.submit(scan_line, l) for l in todo]
        for fut in as_completed(futs):
            lid, out = fut.result()
            n += 1
            with lock:
                keys['1'] |= out['1']
                keys['2'] |= out['2']
                done_lines.add(lid)
            if n % 20 == 0:
                with lock:
                    state = {'done_lines': sorted(done_lines), 'sat': sorted(keys['1']), 'sun': sorted(keys['2'])}
                    json.dump(state, open(STATE, 'w'))
                print(f'  {n}/{len(todo)}路線  土キー{len(keys["1"])} 休キー{len(keys["2"])}', flush=True)

    state = {'done_lines': sorted(done_lines), 'sat': sorted(keys['1']), 'sun': sorted(keys['2'])}
    json.dump(state, open(STATE, 'w'))
    json.dump({'sat': sorted(keys['1']), 'sun': sorted(keys['2'])}, open(OUT, 'w'))
    print(f'完了: 土キー{len(keys["1"])} 休キー{len(keys["2"])} → daytype_keys.json', flush=True)


if __name__ == '__main__':
    main()
