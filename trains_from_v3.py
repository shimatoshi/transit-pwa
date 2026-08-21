#!/usr/bin/env python3
"""
trains_v3.bin(.gz) + trains_v3_meta.json + graph_v2.json → trains.json を復元する。

make_trains_v3.py の入力である trains.json は巨大なのでリポジトリに置いておらず、
GitHub Release の版は最新のスクレイプ結果に追いついていない(そちらから作り直すと
鉄道の経路が退行する)。コミット済みの trains_v3.bin が現時点で唯一の正となる
鉄道ダイヤなので、そこから逆変換して trains.json を復元できるようにしておく。

バス trip (meta.trips.m == 1) は gtfs_to_trains.py 側で作り直すので落とす。

  python3 trains_from_v3.py                 # trains_v3.bin.gz → trains.json
  python3 trains_from_v3.py --bin foo.bin
"""

import argparse
import gzip
import json
import os
import struct

BASE = os.path.dirname(os.path.abspath(__file__))
NONE = 65535


def read_bin(path):
    data = gzip.open(path, 'rb').read() if path.endswith('.gz') else open(path, 'rb').read()
    if data[:4] != b'TV3\x00':
        raise SystemExit(f'{path}: magic が TV3 でない')
    ntrips, nstops = struct.unpack_from('<II', data, 4)
    off = 12
    offsets = struct.unpack_from(f'<{ntrips + 1}I', data, off)
    off += 4 * (ntrips + 1)
    off += -off % 4
    st_s = struct.unpack_from(f'<{nstops}H', data, off)
    off += 2 * nstops
    off += -off % 4
    st_a = struct.unpack_from(f'<{nstops}H', data, off)
    off += 2 * nstops
    off += -off % 4
    st_d = struct.unpack_from(f'<{nstops}H', data, off)
    return offsets, st_s, st_a, st_d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bin', default=os.path.join(BASE, 'trains_v3.bin.gz'))
    ap.add_argument('--meta', default=os.path.join(BASE, 'trains_v3_meta.json'))
    ap.add_argument('--graph', default=os.path.join(BASE, 'graph_v2.json'))
    ap.add_argument('--out', default=os.path.join(BASE, 'trains.json'))
    args = ap.parse_args()

    with open(args.meta) as f:
        meta = json.load(f)
    with open(args.graph) as f:
        stations = json.load(f)['stations']
    offsets, st_s, st_a, st_d = read_bin(args.bin)

    t = meta['trips']
    modes = t.get('m') or [0] * len(t['l'])
    trains = []
    for i in range(len(t['l'])):
        if modes[i] == 1:
            continue                       # バスは GTFS から作り直す
        stops = []
        for j in range(offsets[i], offsets[i + 1]):
            s = stations[st_s[j]]
            stops.append({
                's': s.get('k'),
                'n': s['n'],
                'a': None if st_a[j] == NONE else st_a[j],
                'd': None if st_d[j] == NONE else st_d[j],
            })
        trains.append({
            'line': meta['lines'][t['l'][i]],
            'type': meta['types'][t['t'][i]],
            'dest': t['d'][i],
            'cal': t['c'][i],
            'stops': stops,
        })
    out = {'trains': trains,
           'stats': {'trains': len(trains), 'from': os.path.basename(args.bin)}}
    with open(args.out, 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{args.out}: {len(trains)} trains, '
          f'{sum(len(x["stops"]) for x in trains)} stops, '
          f'{os.path.getsize(args.out)/1e6:.1f}MB')


if __name__ == '__main__':
    main()
