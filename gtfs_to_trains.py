#!/usr/bin/env python3
"""
GTFS-JP (バス) → make_trains_v3.py が食える中間形式へ変換する。

make_trains_v3.py のバイナリは (station, arr, dep) の停車列でしかなく鉄道固有の
仮定がないので、GTFS の stop_times.txt をそのまま同じ器に載せられる。本スクリプトは

  1) stops.txt を停留所クラスタへ畳む (parent_station → 正規化名+100m の union-find)
  2) クラスタを graph_v2.json の stations 末尾へ追記 (m:1 がバス停の目印)
  3) calendar/calendar_dates を「代表日方式」で評価し 平日/土/休 の3bit へ落とす
  4) trips/stop_times を bus_trips.json (trains.json 互換の停車列) へ書き出す

代表日方式: GTFS は将来の改正ダイヤ・学休日ダイヤ等を同一フィードに多重収録している。
特定の1日に有効な service だけを採ると都営バスで stop_times が -36% になる。
平日/土/日の各曜日について直近8週間の候補日を評価し、「有効 service 集合が最も多く
出現する日」(=通常ダイヤの日)を代表日に選ぶ。祝日や学休日のような少数派の
パターンは自動的に外れる。

  python3 gtfs_to_trains.py                          # data/gtfs/ 全フィード
  python3 gtfs_to_trains.py --only toei
  python3 gtfs_to_trains.py --base-date 2026-09-01   # 代表日の探索起点(既定=今日)
  python3 gtfs_to_trains.py --no-graph               # graph_v2.json を書き換えない

出力:
  bus_trips.json   {meta, trips:[{line,type,dest,cal,stops:[{s(graph index),a,d}]}]}
  graph_v2.json    (バス停を末尾に追記。既存の鉄道駅インデックスは不変)
"""

import argparse
import csv
import io
import json
import math
import os
import re
import sys
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import date, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))

MERGE_M = 100.0          # 同名停留所を同一クラスタとみなす距離(m)
WEEKS = 8                # 代表日の候補を探す週数
ROUTE_TYPE_BUS = '3'
MAX_SYS_PER_STOP = 6     # 停留所に保持する系統名の上限(駅マスタ肥大の抑制)


def haversine_m(la1, lo1, la2, lo2):
    R, rad = 6371000.0, math.pi / 180
    dla, dlo = (la2 - la1) * rad, (lo2 - lo1) * rad
    a = math.sin(dla / 2) ** 2 + math.cos(la1 * rad) * math.cos(la2 * rad) * math.sin(dlo / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def norm_name(name):
    """クラスタリング用の正規化キー。全角/半角と空白・カッコ内注記のみ落とす。
    「〜前 / 〜口 / 〜入口」は別停留所であることが多いので剥がさない
    (鉄道側の base_name() と方針が違うのは意図的)。"""
    n = unicodedata.normalize('NFKC', name)
    n = re.sub(r'[（(].*?[)）]', '', n)
    n = re.sub(r'[\s　・･]', '', n)
    return n


def read_csv(z, name):
    if name not in z.namelist():
        return []
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, 'utf-8-sig')))


def parse_hhmmss(s):
    """GTFS の時刻。24時超え(25:30:00)を含むので 1440 で畳んで返す(器が %1440 前提)。
    戻り値は (分 % 1440, 生の分)。"""
    if not s:
        return None
    p = s.strip().split(':')
    if len(p) < 2:
        return None
    m = int(p[0]) * 60 + int(p[1])
    return m


# ---------- 代表日 ----------

def active_services(cal, cdates, d):
    """日付 d に有効な service_id 集合"""
    key = ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')[d.weekday()]
    ds = d.strftime('%Y%m%d')
    act = set()
    for sid, r in cal.items():
        if r[key] == '1' and r['start_date'] <= ds <= r['end_date']:
            act.add(sid)
    for sid, ex in cdates.get(ds, []):
        if ex == '1':
            act.add(sid)
        elif ex == '2':
            act.discard(sid)
    return act


def representative_days(cal, cdates, base, svc_trips):
    """平日/土/休 それぞれの代表日と有効service集合を返す。

    候補日は基準日から WEEKS 週ぶん。各曜日区分で「その日に走る trip 数が最大の日」を
    代表日にする(同数なら最も早い日)。祝日は平日候補に混ざるが休日ダイヤなので
    本数が少なく、この基準で自然に外れる。"""
    buckets = {0: [], 1: [], 2: []}   # 0=平日 1=土 2=休(日)
    for i in range(WEEKS * 7):
        d = base + timedelta(days=i)
        w = d.weekday()
        slot = 0 if w <= 4 else (1 if w == 5 else 2)
        buckets[slot].append(d)

    out = {}
    for slot, days in buckets.items():
        best, best_score, best_svcs = None, -1, set()
        for d in days:
            svcs = active_services(cal, cdates, d)
            score = sum(svc_trips.get(s, 0) for s in svcs)
            if score > best_score:
                best, best_score, best_svcs = d, score, svcs
        out[slot] = (best, best_svcs, best_score)
    return out


# ---------- 停留所クラスタ ----------

class UF:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def cluster_stops(stops):
    """stops: [{'id','name','lat','lon','parent'}] → (stop_id -> cluster局所index, clusters)
    1) parent_station があればそれを代表にする
    2) 残りを「正規化名一致 + 100m以内」で union-find
    """
    by_id = {s['id']: s for s in stops}
    # 1) parent 解決 (多段 parent も辿る)
    root_of = {}
    for s in stops:
        cur, seen = s['id'], set()
        while True:
            p = by_id.get(cur, {}).get('parent')
            if not p or p not in by_id or p in seen:
                break
            seen.add(cur)
            cur = p
        root_of[s['id']] = cur

    roots = sorted({r for r in root_of.values()})
    ridx = {r: i for i, r in enumerate(roots)}

    # 2) 正規化名 + 100m で union
    uf = UF(len(roots))
    byname = defaultdict(list)
    for r in roots:
        byname[norm_name(by_id[r]['name'])].append(r)
    for group in byname.values():
        if len(group) < 2:
            continue
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = by_id[group[i]], by_id[group[j]]
                if a['lat'] is None or b['lat'] is None:
                    continue
                if haversine_m(a['lat'], a['lon'], b['lat'], b['lon']) <= MERGE_M:
                    uf.union(ridx[group[i]], ridx[group[j]])

    # 3) クラスタ確定。代表点はメンバー(子stopを含む)の重心
    members = defaultdict(list)
    for s in stops:
        members[uf.find(ridx[root_of[s['id']]])].append(s)

    clusters, cid_of_root = [], {}
    for cr in sorted(members):
        ms = members[cr]
        pts = [(m['lat'], m['lon']) for m in ms if m['lat'] is not None]
        # 6桁(≒0.1m)で丸める。重心をそのまま書くと循環小数で駅マスタが膨らむ
        la = round(sum(p[0] for p in pts) / len(pts), 6) if pts else None
        lo = round(sum(p[1] for p in pts) / len(pts), 6) if pts else None
        # 表示名は最頻の名前(のりば別名が混ざる場合の代表)
        name = Counter(m['name'] for m in ms).most_common(1)[0][0]
        cid_of_root[cr] = len(clusters)
        clusters.append({'n': name, 'la': la, 'lo': lo})

    stop2cluster = {s['id']: cid_of_root[uf.find(ridx[root_of[s['id']]])] for s in stops}
    return stop2cluster, clusters


# ---------- 路線ラベル ----------

BRACKET_NO = re.compile(r'^[【\[［](.+?)[】\]］]')


def route_label(r):
    """系統番号の格納位置はフィードによって違う。
    route_short_name → 無ければ long_name 先頭の【NN】 → 無ければ long_name 全体。"""
    sn = (r.get('route_short_name') or '').strip()
    if sn:
        return sn
    ln = (r.get('route_long_name') or '').strip()
    m = BRACKET_NO.match(ln)
    if m:
        return m.group(1).strip()
    return ln or (r.get('route_id') or '')


# ---------- 本体 ----------

def convert_feed(key, spec, zpath, base_date, log):
    z = zipfile.ZipFile(zpath)

    routes = {}
    for r in read_csv(z, 'routes.txt'):
        if (r.get('route_type') or '').strip() != ROUTE_TYPE_BUS:
            continue
        routes[r['route_id']] = route_label(r)
    log(f'  routes: {len(routes)} (route_type=3)')

    stops = []
    for s in read_csv(z, 'stops.txt'):
        try:
            la, lo = float(s['stop_lat']), float(s['stop_lon'])
        except (ValueError, KeyError, TypeError):
            la = lo = None
        stops.append({'id': s['stop_id'], 'name': s['stop_name'], 'lat': la, 'lon': lo,
                      'parent': (s.get('parent_station') or '').strip()})
    stop2cluster, clusters = cluster_stops(stops)
    log(f'  stops: {len(stops)} → clusters: {len(clusters)}')

    cal = {}
    for r in read_csv(z, 'calendar.txt'):
        cal[r['service_id']] = r
    cdates = defaultdict(list)
    for r in read_csv(z, 'calendar_dates.txt'):
        cdates[r['date']].append((r['service_id'], r['exception_type']))

    raw_trips = [t for t in read_csv(z, 'trips.txt') if t['route_id'] in routes]
    svc_trips = Counter(t['service_id'] for t in raw_trips)

    reps = representative_days(cal, cdates, base_date, svc_trips)
    svc_bit = defaultdict(int)
    rep_meta = {}
    for slot, (d, svcs, ntr) in reps.items():
        label = ('平日', '土', '休')[slot]
        log(f'  代表日[{label}]: {d} services={len(svcs)} trips={ntr}')
        rep_meta[label] = d.isoformat() if d else None
        for s in svcs:
            svc_bit[s] |= (1 << slot)

    trips = {}
    for t in raw_trips:
        cal_bit = svc_bit.get(t['service_id'], 0)
        if cal_bit == 0:
            continue    # 代表日のいずれにも走らない(将来改正ダイヤ・学休日ダイヤ等)
        trips[t['trip_id']] = {
            'line': routes[t['route_id']],
            'type': '',
            'dest': (t.get('trip_headsign') or '').strip(),
            'cal': cal_bit,
            'rid': t['route_id'],
            'seq': [],
        }
    log(f'  trips: {len(trips)} (代表日に走るもののみ)')

    # stop_times は数百万行になりうるので DictReader を使わず列index直読み
    with z.open('stop_times.txt') as f:
        rd = csv.reader(io.TextIOWrapper(f, 'utf-8-sig'))
        head = next(rd)
        ci = {name: i for i, name in enumerate(head)}
        i_trip, i_arr, i_dep = ci['trip_id'], ci['arrival_time'], ci['departure_time']
        i_stop, i_seq = ci['stop_id'], ci['stop_sequence']
        i_pu = ci.get('pickup_type')
        n_rows = n_dropoff_only = 0
        for row in rd:
            tr = trips.get(row[i_trip])
            if tr is None:
                continue
            cl = stop2cluster.get(row[i_stop])
            if cl is None:
                continue
            # pickup_type=1(降車専用) は「そこで乗れない」だけで通過はする。器には
            # 停車単位の乗降可否が無く、発時刻を落とすと connection がそこで切れて
            # 先の停留所へ行けなくなる(都営の学０３等が実際に切れた)ので時刻は残す。
            # 結果として降車専用停留所からの乗車を許してしまうが、経路が消えるより軽い。
            if i_pu is not None and row[i_pu] == '1':
                n_dropoff_only += 1
            tr['seq'].append((int(row[i_seq]), cl,
                              parse_hhmmss(row[i_arr]), parse_hhmmss(row[i_dep])))
            n_rows += 1
    log(f'  stop_times: {n_rows} (降車専用 {n_dropoff_only} — 乗車可否は器が持てないため無視)')

    # 系統名の停留所別集計(駅マスタの sys 用)
    sysmap = defaultdict(set)
    out_trips = []
    dropped = 0
    for tr in trips.values():
        seq = sorted(tr['seq'])
        # のりば違いで同一クラスタが連続する場合は1停車に畳む
        stops_out = []
        for _, cl, a, d in seq:
            if stops_out and stops_out[-1][0] == cl:
                if d is not None:
                    stops_out[-1][2] = d       # 発は後勝ち
                if stops_out[-1][1] is None:
                    stops_out[-1][1] = a       # 着は先勝ち
                continue
            stops_out.append([cl, a, d])
        if len(stops_out) < 2:
            dropped += 1
            continue
        stops_out[0][1] = None                 # 始発は着時刻なし(鉄道側の慣習に合わせる)
        stops_out[-1][2] = None                # 終着は発時刻なし
        # 着=発の停車は着を落とす。router は「着が無ければ発を着として使う」ので
        # 情報は失われず、bin の着時刻列が 65535 の長い連なりになって gzip がよく効く
        # (バスは通過時刻1点しか持たないフィードが大半なのでほぼ全停車が該当する)
        for st in stops_out[:-1]:
            if st[1] is not None and st[1] == st[2]:
                st[1] = None
        for cl, _, _ in stops_out:
            sysmap[cl].add(tr['line'])
        out_trips.append({
            'line': tr['line'], 'type': tr['type'], 'dest': tr['dest'], 'cal': tr['cal'],
            'stops': [{'s': cl, 'a': a if a is None else a % 1440,
                       'd': d if d is None else d % 1440} for cl, a, d in stops_out],
        })
    if dropped:
        log(f'  dropped {dropped} trips (停車2未満)')

    for cid, c in enumerate(clusters):
        c['sys'] = sorted(sysmap.get(cid, ()))[:MAX_SYS_PER_STOP]
        c['p'] = spec.get('pref', '')
        c['src'] = key
    return clusters, out_trips, rep_meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gtfs', default=os.path.join(BASE, 'data', 'gtfs'))
    ap.add_argument('--graph', default=os.path.join(BASE, 'graph_v2.json'))
    ap.add_argument('--out', default=os.path.join(BASE, 'bus_trips.json'))
    ap.add_argument('--only', action='append')
    ap.add_argument('--base-date', default=None, help='代表日の探索起点 YYYY-MM-DD (既定=今日)')
    ap.add_argument('--no-graph', action='store_true', help='graph_v2.json を書き換えない')
    args = ap.parse_args()

    with open(os.path.join(args.gtfs, '_manifest.json')) as f:
        manifest = json.load(f)
    keys = args.only or sorted(manifest)

    base_date = date.today()
    if args.base_date:
        base_date = date.fromisoformat(args.base_date)

    with open(args.graph) as f:
        g = json.load(f)
    stations = g['stations']
    n_rail = sum(1 for s in stations if not s.get('m'))
    if any(s.get('m') for s in stations[:n_rail]):
        sys.exit('graph_v2.json: バス停が鉄道駅の途中に混ざっている。再生成が必要')
    # 再実行時は前回追記したバス停を捨ててから作り直す(インデックスの安定のため
    # 鉄道駅 0..n_rail-1 は常に不変)
    del stations[n_rail:]

    all_trips = []
    feeds_meta = {}
    for key in keys:
        spec = manifest[key]
        zpath = os.path.join(args.gtfs, spec['file'])
        print(f'[{key}] {spec["name"]} ({spec["license"]})')
        clusters, trips, rep_days = convert_feed(key, spec, zpath, base_date, lambda s: print(s))
        offset = len(stations)
        for c in clusters:
            stations.append({'n': c['n'], 'la': c['la'], 'lo': c['lo'], 'p': c['p'],
                             'l': [], 'm': 1, 'sys': c['sys'], 'src': c['src']})
        for t in trips:
            for st in t['stops']:
                st['s'] += offset
            all_trips.append(t)
        feeds_meta[key] = {
            'name': spec['name'], 'operator': spec['operator'],
            'license': spec['license'], 'license_url': spec['license_url'],
            'attribution': spec['attribution'], 'catalog': spec['catalog'],
            'feed_version': spec.get('feed_version', ''),
            'rep_days': rep_days,
            'stops': len(clusters), 'trips': len(trips),
        }
        print(f'  → graph stations {offset}..{len(stations) - 1}')

    n_bus = len(stations) - n_rail
    n_stop_times = sum(len(t['stops']) for t in all_trips)
    print(f'bus stops: {n_bus}, bus trips: {len(all_trips)}, stop_times: {n_stop_times}')
    if len(stations) > 65535:
        sys.exit(f'駅数 {len(stations)} が uint16 上限を超えた。TV4(uint32)化が必要')

    g['stats'] = dict(g.get('stats') or {})
    g['stats']['bus_stops'] = n_bus
    if not args.no_graph:
        with open(args.graph, 'w') as f:
            json.dump(g, f, ensure_ascii=False, separators=(',', ':'))
        print(f'{args.graph}: {len(stations)} stations '
              f'(rail {n_rail} + bus {n_bus}), {os.path.getsize(args.graph)/1e6:.2f}MB')

    out = {
        'meta': {
            'base_date': base_date.isoformat(),
            'rail_stations': n_rail,
            'bus_stops': n_bus,
            'feeds': feeds_meta,
        },
        'trips': all_trips,
    }
    with open(args.out, 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{args.out}: {os.path.getsize(args.out)/1e6:.2f}MB')


if __name__ == '__main__':
    main()
