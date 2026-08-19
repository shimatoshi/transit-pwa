#!/usr/bin/env python3
"""
verify_bus_times.py — 生の GTFS zip と trains_v3.bin を突き合わせる。

検証するのは「GTFS の stop_times.txt に書いてある時刻が、そのまま bin から
取り出せること」。パース→のりば統合→%1440→着=発の間引き→バイナリ詰め→展開 の
往復で時刻や停車順が壊れていないかを見る。

  python3 verify_bus_times.py            # 300 trip をランダム抽出して照合
  python3 verify_bus_times.py -n 2000

停留所クラスタリング自体は gtfs_to_trains.py の実装を使うので独立検証ではない
(そこは build 側の責務)。名称は stops.txt の生の値と突き合わせる。
"""

import argparse
import io
import json
import os
import random
import struct
import sys
import zipfile
from collections import defaultdict

import gtfs_to_trains as G

BASE = os.path.dirname(os.path.abspath(__file__))


def load_bin(path):
    with open(path, 'rb') as f:
        buf = f.read()
    assert buf[:4] == b'TV3\x00', 'bad magic'
    ntrips, nstops = struct.unpack_from('<II', buf, 4)
    off = 12
    offsets = struct.unpack_from(f'<{ntrips + 1}I', buf, off)
    off = (off + (ntrips + 1) * 4 + 3) & ~3
    st_s = struct.unpack_from(f'<{nstops}H', buf, off); off = (off + nstops * 2 + 3) & ~3
    st_a = struct.unpack_from(f'<{nstops}H', buf, off); off = (off + nstops * 2 + 3) & ~3
    st_d = struct.unpack_from(f'<{nstops}H', buf, off)
    return offsets, st_s, st_a, st_d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-n', type=int, default=300)
    ap.add_argument('--seed', type=int, default=20260819)
    ap.add_argument('--gtfs', default=os.path.join(BASE, 'data', 'gtfs'))
    ap.add_argument('--only', default='toei')
    args = ap.parse_args()

    with open(os.path.join(BASE, 'graph_v2.json')) as f:
        stations = json.load(f)['stations']
    with open(os.path.join(BASE, 'trains_v3_meta.json')) as f:
        meta = json.load(f)
    with open(os.path.join(BASE, 'bus_trips.json')) as f:
        bus = json.load(f)
    offsets, st_s, st_a, st_d = load_bin(os.path.join(BASE, 'trains_v3.bin'))

    modes = meta['trips']['m']
    lines = meta['lines']
    n_bus_trips = sum(modes)
    print(f'bin: {len(modes)} trips ({n_bus_trips} bus), {len(st_s)} stop_times')

    # bin 側のバス trip を (系統, 行先, 発時刻列) で索引
    index = defaultdict(list)
    for t, m in enumerate(modes):
        if m != 1:
            continue
        i0, i1 = offsets[t], offsets[t + 1]
        deps = tuple(st_d[i] for i in range(i0, i1))
        index[(lines[meta['trips']['l'][t]], meta['trips']['d'][t], deps)].append(t)

    with open(os.path.join(args.gtfs, '_manifest.json')) as f:
        manifest = json.load(f)
    spec = manifest[args.only]
    z = zipfile.ZipFile(os.path.join(args.gtfs, spec['file']))

    routes = {r['route_id']: G.route_label(r)
              for r in G.read_csv(z, 'routes.txt') if r.get('route_type') == '3'}
    raw_stops = []
    for s in G.read_csv(z, 'stops.txt'):
        try:
            la, lo = float(s['stop_lat']), float(s['stop_lon'])
        except (ValueError, KeyError, TypeError):
            la = lo = None
        raw_stops.append({'id': s['stop_id'], 'name': s['stop_name'], 'lat': la, 'lon': lo,
                          'parent': (s.get('parent_station') or '').strip()})
    stop_name = {s['id']: s['name'] for s in raw_stops}
    stop2cluster, _clusters = G.cluster_stops(raw_stops)

    cal = {r['service_id']: r for r in G.read_csv(z, 'calendar.txt')}
    cdates = defaultdict(list)
    for r in G.read_csv(z, 'calendar_dates.txt'):
        cdates[r['date']].append((r['service_id'], r['exception_type']))
    from datetime import date
    base_date = date.fromisoformat(bus['meta']['base_date'])
    raw_trips = [t for t in G.read_csv(z, 'trips.txt') if t['route_id'] in routes]
    from collections import Counter
    svc_trips = Counter(t['service_id'] for t in raw_trips)
    reps = G.representative_days(cal, cdates, base_date, svc_trips)
    live = set()
    for _slot, (_d, svcs, _n) in reps.items():
        live |= svcs

    keep = {t['trip_id']: t for t in raw_trips if t['service_id'] in live}
    print(f'gtfs: {len(raw_trips)} trips → {len(keep)} on 代表日')

    random.seed(args.seed)
    sample = set(random.sample(sorted(keep), min(args.n, len(keep))))

    seq = defaultdict(list)
    with z.open('stop_times.txt') as f:
        import csv
        rd = csv.reader(io.TextIOWrapper(f, 'utf-8-sig'))
        head = next(rd)
        ci = {n: i for i, n in enumerate(head)}
        for row in rd:
            tid = row[ci['trip_id']]
            if tid in sample:
                seq[tid].append((int(row[ci['stop_sequence']]), row[ci['stop_id']],
                                 row[ci['arrival_time']], row[ci['departure_time']]))

    ok = bad = 0
    problems = []
    for tid in sorted(sample):
        t = keep[tid]
        rows = sorted(seq[tid])
        # gtfs_to_trains.py と同じ手順で期待値を作る(のりば統合 → 始発着/終着発を落とす)
        stops = []
        for _s, sid, a, d in rows:
            cl = stop2cluster[sid]
            am, dm = G.parse_hhmmss(a), G.parse_hhmmss(d)
            if stops and stops[-1][0] == cl:
                if dm is not None:
                    stops[-1][2] = dm
                if stops[-1][1] is None:
                    stops[-1][1] = am
                continue
            stops.append([cl, am, dm])
        if len(stops) < 2:
            continue
        stops[0][1] = None
        stops[-1][2] = None
        exp_deps = tuple(65535 if d is None else d % 1440 for _c, _a, d in stops)
        key = (routes[t['route_id']], (t.get('trip_headsign') or '').strip(), exp_deps)
        cands = index.get(key)
        if not cands:
            bad += 1
            problems.append(f'{tid}: bin に一致する trip が無い ({key[0]} {key[1]} {len(stops)}停留所)')
            continue
        # 停車列(駅index)と着時刻も一致するものが1本以上あること
        hit = False
        for bt in cands:
            i0, i1 = offsets[bt], offsets[bt + 1]
            if i1 - i0 != len(stops):
                continue
            got_s = [st_s[i] for i in range(i0, i1)]
            got_a = [st_a[i] for i in range(i0, i1)]
            exp_s = [bus['meta']['rail_stations'] + c for c, _a, _d in stops]
            # 着=発の停車は着を落としてあるので、落ちている場合は発と一致するはず
            exp_a = []
            for k, (_c, a, d) in enumerate(stops):
                if a is None:
                    exp_a.append(65535)
                elif k < len(stops) - 1 and a == d:
                    exp_a.append(65535)
                else:
                    exp_a.append(a % 1440)
            if got_s == exp_s and got_a == exp_a:
                hit = True
                break
        if hit:
            ok += 1
        else:
            bad += 1
            problems.append(f'{tid}: 停車列/着時刻が一致しない')

    # 停留所名: graph_v2 の代表名は、そのクラスタに属する stop のいずれかの名称であること。
    # (都営は同名別区を「千石一丁目(せんごくいっちょうめ（ぶんきょうく）)」のように
    #  よみがな付きで区別する stop があり、代表名には最頻の表記を採る)
    cluster_names = defaultdict(set)
    for sid, cl in stop2cluster.items():
        cluster_names[cl].add(stop_name[sid])
    name_bad = sum(1 for cl, names in cluster_names.items()
                   if stations[bus['meta']['rail_stations'] + cl]['n'] not in names)
    variants = sum(1 for cl, names in cluster_names.items() if len(names) > 1)

    print(f'照合: {ok} OK / {bad} NG (sample {len(sample)})')
    print(f'代表名がクラスタ内に存在しない: {name_bad} / {len(cluster_names)} クラスタ '
          f'(表記ゆれを含むクラスタ {variants}件)')
    for p in problems[:20]:
        print('  ' + p)
    sys.exit(0 if bad == 0 else 1)


if __name__ == '__main__':
    main()
