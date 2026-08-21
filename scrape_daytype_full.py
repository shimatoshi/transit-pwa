#!/usr/bin/env python3
"""scrape_daytype_full.py — 全line-stationを列挙し、土曜(dw=1)/休日(dw=2)に運転する
列車の安定キー(路線prefix|列車番号)を収集する。Pixel5で実行(DoHシムでDNS解決)。

ekitanの内部tx中間IDは日次で変わるため、突合は tx の (先頭=路線群, 末尾=列車番号) で行う。
出力 daytype_keys.json: {"sat":[key,...], "sun":[key,...]}
resume: daytype_full_state.json

【駅の打ち切りについて】
路線の駅は ordn=1,2,3... と連番で引くが、欠番(そのordnにページが無い)や
一時的な取得失敗が途中に挟まる。以前は「1つでも空なら即break」だったため、
路線の途中で走査が止まり、その路線群の土休キーが数本しか集まらない状態を
作っていた(ＪＲ東海道本線の京都・神戸口が ρ=0.09、札幌市営南北線が S=12 等)。
tag_calendar.py はその欠損を「土休に運転しない」と読んで路線ごと土日に消していた。
そこで
  - 取得失敗(None)は「空」と数えず、その ordn はやり直し扱いにする
  - 空が EMPTY_RUN 回**連続**したときだけ打ち切る
  - 打ち切りではなく失敗で終わった路線は done_lines に入れず、次回再走査する
の3点にした。
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
EMPTY_RUN = 4         # 連続してこの数だけ空だったら路線の終端と見なす
FAIL_LIMIT = 8        # 1路線でこれだけ取得失敗したら未完了として次回に回す


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
            if e.code == 404:
                return ''          # そのordnの駅は存在しない = 確定した「空」
            time.sleep(1.0 + a)    # 500等は一時障害の可能性があるので retry する
        except Exception:
            time.sleep(1.0 + a)
    return None                    # 取得できなかった。「空」と区別すること


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
        """1路線の全駅を列挙し、dw=1/2のtxキーと「最後まで走査できたか」を返す。

        欠番や一時障害で1駅ぶんが取れなくても打ち切らない。空が EMPTY_RUN 回
        連続したときだけ終端と見なす。取得失敗は「空」に数えない — 数えると
        路線の途中で走査が止まり、その路線群の土休キーが数本しか集まらないまま
        「土休は運転しない」と誤読されるため。"""
        out = {'1': set(), '2': set()}
        run = fails = 0
        for ordn in range(1, MAX_ORD + 1):
            found = miss = False
            for d in ('d1', 'd2'):
                for dw in ('1', '2'):
                    h = http_get(f'https://ekitan.com/timetable/railway/line-station/{lid}-{ordn}/{d}?dw={dw}')
                    if h is None:
                        miss = True
                        continue
                    ks = {stable_key(x) for x in TX.findall(h)}
                    if ks:
                        found = True
                        out[dw] |= ks
            if found:
                run = 0
            elif miss:
                fails += 1          # 取れなかっただけ。終端の判定には使わない
                if fails >= FAIL_LIMIT:
                    return lid, out, False
            else:
                run += 1
                if run >= EMPTY_RUN:
                    break
        return lid, out, fails == 0

    n = 0
    incomplete = []
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = [ex.submit(scan_line, l) for l in todo]
        for fut in as_completed(futs):
            lid, out, complete = fut.result()
            n += 1
            with lock:
                keys['1'] |= out['1']
                keys['2'] |= out['2']
                if complete:
                    done_lines.add(lid)   # 未完了は done にせず次回やり直す
                else:
                    incomplete.append(lid)
            if n % 20 == 0:
                with lock:
                    state = {'done_lines': sorted(done_lines), 'sat': sorted(keys['1']), 'sun': sorted(keys['2'])}
                    json.dump(state, open(STATE, 'w'))
                print(f'  {n}/{len(todo)}路線  土キー{len(keys["1"])} 休キー{len(keys["2"])}', flush=True)

    state = {'done_lines': sorted(done_lines), 'sat': sorted(keys['1']), 'sun': sorted(keys['2'])}
    json.dump(state, open(STATE, 'w'))
    json.dump({'sat': sorted(keys['1']), 'sun': sorted(keys['2'])}, open(OUT, 'w'))
    print(f'完了: 土キー{len(keys["1"])} 休キー{len(keys["2"])} → daytype_keys.json', flush=True)
    if incomplete:
        print(f'※ 取得失敗で未完了の路線 {len(incomplete)}件: {incomplete[:20]}\n'
              '  done_lines に入れていないので、もう一度流せば続きから再走査する。', flush=True)


if __name__ == '__main__':
    main()
