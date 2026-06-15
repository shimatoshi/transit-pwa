#!/usr/bin/env python3
"""
Build CSA (Connection Scan) data for router_v3 from trains.json.

Outputs:
  trains_v3.bin      binary trip-stop arrays (see layout below)
  trains_v3.bin.gz   pre-gzipped for serving (binary types aren't compressed
                     by Vercel; the PWA fetches .gz and DecompressionStream)
  trains_v3_meta.json {lines, types, trips:{l,t,d}, footpaths}

Binary layout (little-endian):
  0   4B  magic 'TV3\\0'
  4   4B  uint32 ntrips
  8   4B  uint32 nstops
  12      uint32[ntrips+1]  tripOffsets (into stop arrays)
  ...     uint16[nstops]    stopStation (graph_v2 station index)
  ...     uint16[nstops]    stopArr  (minutes, 65535 = none)
  ...     uint16[nstops]    stopDep  (minutes, 65535 = none)
  (each section 4-byte aligned, zero-padded)

Times are raw minutes (0..1439) as scraped; the JS loader normalizes
midnight wrap within a trip (monotonic +1440) and duplicates early-morning
connections at +1440 for searches across midnight.

Footpaths: station pairs within 400m straight-line, plus same-base-name
pairs (船橋/京成船橋, 上野/京成上野) within 1.2km.
walk minutes = round(km * 15) + 3 (15min/km + 乗換バッファ).
"""

import gzip
import json
import math
import os
import re
import struct
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))


def haversine_km(la1, lo1, la2, lo2):
    R, rad = 6371.0, math.pi / 180
    dla, dlo = (la2 - la1) * rad, (lo2 - lo1) * rad
    a = math.sin(dla / 2) ** 2 + math.cos(la1 * rad) * math.cos(la2 * rad) * math.sin(dlo / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def base_name(name):
    n = re.sub(r'[（(].*?[)）]', '', name)
    n = re.sub(r'駅$', '', n)
    # 事業者プレフィクスを剥がす: 京成上野→上野, ＪＲ難波→難波
    n = re.sub(r'^(ＪＲ|京成|京王|京急|京阪|阪急|阪神|近鉄|南海|西鉄|東武|西武|名鉄|新)', '', n)
    return n


def build_footpaths(stations):
    cell = 0.005
    grid = defaultdict(list)
    for i, s in enumerate(stations):
        if s.get('la') is None:
            continue
        grid[(int(s['la'] / cell), int(s['lo'] / cell))].append(i)

    pairs = {}

    def consider(i, j, max_km):
        if i >= j:
            i, j = j, i
            if i == j:
                return
        a, b = stations[i], stations[j]
        if a.get('la') is None or b.get('la') is None:
            return
        km = haversine_km(a['la'], a['lo'], b['la'], b['lo'])
        if km <= max_km:
            walk = round(km * 15) + 3
            key = (i, j)
            if key not in pairs or pairs[key] > walk:
                pairs[key] = walk

    # 1) proximity pairs (≤400m)
    for (gy, gx), ids in grid.items():
        neigh = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                neigh.extend(grid.get((gy + dy, gx + dx), []))
        for i in ids:
            for j in neigh:
                if i < j:
                    consider(i, j, 0.4)

    # 2) same-base-name pairs (≤1.2km)
    byname = defaultdict(list)
    for i, s in enumerate(stations):
        bn = base_name(s['n'])
        if bn:
            byname[bn].append(i)
    for ids in byname.values():
        if len(ids) < 2 or len(ids) > 8:
            continue
        for x in range(len(ids)):
            for y in range(x + 1, len(ids)):
                consider(ids[x], ids[y], 1.2)

    return [[i, j, w] for (i, j), w in sorted(pairs.items())]


def pad4(buf):
    while len(buf) % 4:
        buf.append(0)


def main():
    with open(os.path.join(BASE, 'graph_v2.json')) as f:
        g = json.load(f)
    stations = g['stations']
    k2idx = {s['k']: i for i, s in enumerate(stations) if s.get('k')}

    with open(os.path.join(BASE, 'trains.json')) as f:
        trains = json.load(f)['trains']

    lines, line_idx = [], {}
    types, type_idx = [], {}
    trips_l, trips_t, trips_d, trips_c = [], [], [], []
    offsets = [0]
    st_s, st_a, st_d = [], [], []
    skipped_stops = skipped_trips = 0

    for t in trains:
        stops = [s for s in t['stops'] if s['s'] in k2idx]
        skipped_stops += len(t['stops']) - len(stops)
        if len(stops) < 2:
            skipped_trips += 1
            continue
        ln = t['line'] or ''
        if ln not in line_idx:
            line_idx[ln] = len(lines)
            lines.append(ln)
        ty = t.get('type') or ''
        if ty not in type_idx:
            type_idx[ty] = len(types)
            types.append(ty)
        trips_l.append(line_idx[ln])
        trips_t.append(type_idx[ty])
        trips_d.append(t.get('dest') or '')
        trips_c.append(t.get('cal', 7))   # 運転日bit(1平日2土4休)。未タグは7=毎日(安全側)
        for s in stops:
            st_s.append(k2idx[s['s']])
            st_a.append(65535 if s['a'] is None else s['a'] % 1440)
            st_d.append(65535 if s['d'] is None else s['d'] % 1440)
        offsets.append(len(st_s))

    ntrips, nstops = len(trips_l), len(st_s)
    print(f"trips: {ntrips} (skipped {skipped_trips}), stops: {nstops} (skipped {skipped_stops})")
    print(f"lines: {len(lines)}, types: {len(types)}")

    buf = bytearray()
    buf += b'TV3\x00'
    buf += struct.pack('<II', ntrips, nstops)
    buf += struct.pack(f'<{ntrips + 1}I', *offsets)
    pad4(buf)
    buf += struct.pack(f'<{nstops}H', *st_s)
    pad4(buf)
    buf += struct.pack(f'<{nstops}H', *st_a)
    pad4(buf)
    buf += struct.pack(f'<{nstops}H', *st_d)
    pad4(buf)

    bin_path = os.path.join(BASE, 'trains_v3.bin')
    with open(bin_path, 'wb') as f:
        f.write(buf)
    with gzip.open(bin_path + '.gz', 'wb', compresslevel=9) as f:
        f.write(buf)

    footpaths = build_footpaths(stations)
    print(f"footpaths: {len(footpaths)}")

    meta = {
        'lines': lines,
        'types': types,
        'trips': {'l': trips_l, 't': trips_t, 'd': trips_d, 'c': trips_c},
        'footpaths': footpaths,
    }
    meta_path = os.path.join(BASE, 'trains_v3_meta.json')
    with open(meta_path, 'w') as f:
        json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))

    print(f"{bin_path}: {os.path.getsize(bin_path)/1e6:.1f}MB "
          f"(gz {os.path.getsize(bin_path+'.gz')/1e6:.1f}MB), "
          f"meta: {os.path.getsize(meta_path)/1e6:.1f}MB")


if __name__ == '__main__':
    main()
