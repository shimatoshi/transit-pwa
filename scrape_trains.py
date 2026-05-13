#!/usr/bin/env python3
"""
Scrape train-based timetable from ekitan.com train detail pages.

Strategy:
  Phase 1: For each line, fetch the station page with most departures
           to collect all train detail URLs (tx parameters).
  Phase 2: Fetch each unique train detail page to get full stop list
           with arrival/departure times.
  Phase 3: Build trains.json for the PWA.

Resume support: saves progress after every batch.
"""

import json
import os
import re
import sys
import time
import urllib.request
from collections import defaultdict

BASE = '/home/transit-pwa'
TIMETABLE_RAW = os.path.join(BASE, 'timetable_raw.json')
TRAIN_URLS_FILE = os.path.join(BASE, 'train_urls.json')      # Phase1 output
TRAIN_DATA_FILE = os.path.join(BASE, 'train_data.json')       # Phase2 output
OUTPUT_FILE = os.path.join(BASE, 'trains.json')                # Phase3 output

DELAY = 0.8  # seconds between requests
UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36'
REFERER = 'https://ekitan.com/timetable/railway'


def http_get(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Referer': REFERER,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ja,en;q=0.5',
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode('utf-8')
        except Exception as e:
            print(f"  Retry {attempt+1}: {e}", file=sys.stderr)
            if attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
    return None


def save_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    os.rename(tmp, path)


def phase1_collect_train_urls():
    """Collect train detail URLs from station timetable pages."""
    print("=== Phase 1: Collect train URLs ===")

    # Load existing progress
    if os.path.exists(TRAIN_URLS_FILE):
        with open(TRAIN_URLS_FILE) as f:
            state = json.load(f)
        done_lines = set(state.get('done_lines', []))
        all_txs = state.get('txs', {})  # tx -> {line_station, sf, departure, d}
        print(f"Resuming: {len(done_lines)} lines done, {len(all_txs)} txs collected")
    else:
        done_lines = set()
        all_txs = {}

    # Load raw timetable to find best station per line
    with open(TIMETABLE_RAW) as f:
        raw = json.load(f)

    # Group by line ID, pick station with most departures
    line_best = {}  # line_id -> (key, ndeps, data)
    for k, v in raw.items():
        line_id = k.split('-')[0]
        ndeps = len(v['deps'])
        if line_id not in line_best or ndeps > line_best[line_id][1]:
            line_best[line_id] = (k, ndeps, v)

    to_do = [(lid, info) for lid, info in line_best.items() if lid not in done_lines]
    print(f"Lines to process: {len(to_do)} / {len(line_best)}")

    for i, (line_id, (key, ndeps, data)) in enumerate(to_do):
        ls_key = key  # e.g. "292-1"
        ls_id, idx = ls_key.split('-')
        url = f"https://ekitan.com/timetable/railway/line-station/{ls_id}-{idx}/d1"

        html = http_get(url)
        if not html:
            print(f"  SKIP line {line_id} ({url})")
            continue

        # Extract train detail URLs
        train_matches = re.findall(
            r'/timetable/railway/train\?sf=(\d+)&tx=([^&]+)&dw=[^&]*&dt=[^&]*&departure=(\d{4})&SFF=([^&]+)&d=(\d+)',
            html
        )

        new_txs = 0
        for sf, tx, departure, sff, d in train_matches:
            if tx not in all_txs:
                all_txs[tx] = {
                    'sf': sf,
                    'dep': departure,
                    'sff': sff,
                    'd': d,
                    'line': data['info'],
                }
                new_txs += 1

        done_lines.add(line_id)

        if (i + 1) % 20 == 0 or i == len(to_do) - 1:
            save_json(TRAIN_URLS_FILE, {
                'done_lines': list(done_lines),
                'txs': all_txs,
            })

        print(f"  [{i+1}/{len(to_do)}] line={line_id} ({data['info'][:30]}) "
              f"+{new_txs} txs (total: {len(all_txs)})")
        time.sleep(DELAY)

    save_json(TRAIN_URLS_FILE, {
        'done_lines': list(done_lines),
        'txs': all_txs,
    })
    print(f"\nPhase 1 done: {len(all_txs)} unique trains from {len(done_lines)} lines")
    return all_txs


def parse_train_detail(html):
    """Parse a train detail page into structured data."""
    # Extract train info from header
    header = re.search(
        r'ek-onetrain-title-inner\">(.+?)</span>',
        html, re.DOTALL
    )
    info = {}
    if header:
        h = re.sub(r'<[^>]+>', ' ', header.group(1)).strip()
        h = re.sub(r'\s+', ' ', h)
        info['header'] = h
        # Parse: "つくばエクスプレス　始発：つくば 区間快速　秋葉原行き"
        m = re.match(r'(.+?)[\s　]+始発[：:](.+?)\s+(.+?)[\s　]+(.+?)行き', h)
        if m:
            info['line'] = m.group(1).strip()
            info['origin'] = m.group(2).strip()
            info['type'] = m.group(3).strip()
            info['dest'] = m.group(4).strip()

    # Extract stops
    stops = []
    trs = re.findall(r'<tr>(.*?)</tr>', html, re.DOTALL)
    for tr in trs:
        if 'td-station-name' not in tr:
            continue
        station_m = re.search(r'td-station-name\"><a[^>]*>([^<]+)', tr)
        if not station_m:
            continue
        station = station_m.group(1).strip()

        # Time cell: works for both mobile (span class) and PC (plain text) layouts
        time_cell = re.search(r'td-dep-and-arr-time\">(.*?)</td>', tr, re.DOTALL)
        arr = None
        dep = None
        if time_cell:
            cell = time_cell.group(1)
            arr_m = re.search(r'(\d+:\d+)着', cell)
            dep_m = re.search(r'(\d+:\d+)発', cell)
            arr = arr_m.group(1) if arr_m else None
            dep = dep_m.group(1) if dep_m else None

        # Station ID from link
        sid_m = re.search(r'/station/(\d+)', tr)
        sid = sid_m.group(1) if sid_m else None

        stops.append({
            's': sid,       # ekitan station ID
            'n': station,   # station name
            'a': arr,       # arrival time "HH:MM" or None
            'd': dep,       # departure time "HH:MM" or None
        })

    return info, stops


def phase2_fetch_train_details(all_txs):
    """Fetch train detail pages with async parallelism."""
    print("\n=== Phase 2: Fetch train details (async) ===")

    import asyncio
    try:
        import aiohttp
        HAS_AIOHTTP = True
    except ImportError:
        HAS_AIOHTTP = False

    # Load existing
    if os.path.exists(TRAIN_DATA_FILE):
        with open(TRAIN_DATA_FILE) as f:
            train_data = json.load(f)
        print(f"Resuming: {len(train_data)} trains already fetched")
    else:
        train_data = {}

    to_do = [(tx, meta) for tx, meta in all_txs.items() if tx not in train_data]
    print(f"Remaining: {len(to_do)}")

    if not to_do:
        return train_data

    WORKERS = 5
    per_req = DELAY  # delay per worker between requests
    effective_rate = WORKERS / per_req
    print(f"Workers: {WORKERS}, effective rate: {effective_rate:.1f} req/s")
    print(f"Estimated time: {len(to_do) / effective_rate / 3600:.1f} hours")

    if HAS_AIOHTTP:
        asyncio.get_event_loop().run_until_complete(
            _phase2_async(to_do, train_data, WORKERS)
        )
    else:
        print("aiohttp not available, falling back to threaded mode")
        _phase2_threaded(to_do, train_data, WORKERS)

    save_json(TRAIN_DATA_FILE, train_data)
    ok = sum(1 for v in train_data.values() if not v.get('error'))
    print(f"\nPhase 2 done: {ok} trains fetched ({len(train_data)} total)")
    return train_data


async def _phase2_async(to_do, train_data, workers):
    """Async version using aiohttp."""
    import aiohttp, asyncio

    headers = {
        'User-Agent': UA,
        'Referer': REFERER,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.5',
    }

    sem = asyncio.Semaphore(workers)
    done_count = [0]
    total = len(to_do)
    lock = asyncio.Lock()

    async def fetch_one(session, tx, meta):
        sf, dep, sff, d = meta['sf'], meta['dep'], meta['sff'], meta['d']
        url = (f"https://ekitan.com/timetable/railway/train?"
               f"sf={sf}&tx={tx}&dw=&dt=&departure={dep}&SFF={sff}&d={d}")

        async with sem:
            for attempt in range(3):
                try:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                        html = await resp.text()
                    break
                except Exception as e:
                    if attempt == 2:
                        async with lock:
                            train_data[tx] = {'error': True}
                            done_count[0] += 1
                        return
                    await asyncio.sleep(2 * (attempt + 1))

            info, stops = parse_train_detail(html)
            async with lock:
                train_data[tx] = {
                    'info': info,
                    'stops': stops,
                    'line_hint': meta.get('line', ''),
                }
                done_count[0] += 1

                if done_count[0] % 100 == 0:
                    save_json(TRAIN_DATA_FILE, train_data)
                    remaining = (total - done_count[0]) / (workers / DELAY)
                    print(f"  [{done_count[0]}/{total}] saved. ETA: {remaining/3600:.1f}h")
                elif done_count[0] % 25 == 0:
                    line = info.get('line', '?')[:20]
                    typ = info.get('type', '?')
                    print(f"  [{done_count[0]}/{total}] {line} {typ} {len(stops)} stops")

            await asyncio.sleep(DELAY)

    connector = aiohttp.TCPConnector(limit=workers, force_close=True)
    async with aiohttp.ClientSession(headers=headers, connector=connector) as session:
        tasks = [fetch_one(session, tx, meta) for tx, meta in to_do]
        await asyncio.gather(*tasks)


def _phase2_threaded(to_do, train_data, workers):
    """Threaded fallback when aiohttp is not available."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading

    lock = threading.Lock()
    done_count = [0]
    total = len(to_do)

    def fetch_one(tx, meta):
        sf, dep, sff, d = meta['sf'], meta['dep'], meta['sff'], meta['d']
        url = (f"https://ekitan.com/timetable/railway/train?"
               f"sf={sf}&tx={tx}&dw=&dt=&departure={dep}&SFF={sff}&d={d}")

        html = http_get(url)
        if not html:
            with lock:
                train_data[tx] = {'error': True}
                done_count[0] += 1
            return

        info, stops = parse_train_detail(html)
        with lock:
            train_data[tx] = {
                'info': info,
                'stops': stops,
                'line_hint': meta.get('line', ''),
            }
            done_count[0] += 1

            if done_count[0] % 100 == 0:
                save_json(TRAIN_DATA_FILE, train_data)
                remaining = (total - done_count[0]) * DELAY / workers
                print(f"  [{done_count[0]}/{total}] saved. ETA: {remaining/3600:.1f}h")
            elif done_count[0] % 25 == 0:
                line = info.get('line', '?')[:20]
                typ = info.get('type', '?')
                print(f"  [{done_count[0]}/{total}] {line} {typ} {len(stops)} stops")

        time.sleep(DELAY)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(fetch_one, tx, meta) for tx, meta in to_do]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception as e:
                print(f"  Worker error: {e}", file=sys.stderr)


def phase3_build_output(train_data):
    """Build compact trains.json for PWA."""
    print("\n=== Phase 3: Build trains.json ===")

    trains = []
    for tx, data in train_data.items():
        if data.get('error'):
            continue
        info = data.get('info', {})
        stops = data.get('stops', [])
        if len(stops) < 2:
            continue

        # Convert times to minutes
        compact_stops = []
        for stop in stops:
            arr_min = None
            dep_min = None
            if stop['a']:
                h, m = stop['a'].split(':')
                arr_min = int(h) * 60 + int(m)
            if stop['d']:
                h, m = stop['d'].split(':')
                dep_min = int(h) * 60 + int(m)

            compact_stops.append({
                's': stop['s'],    # station ID
                'n': stop['n'],    # name
                'a': arr_min,      # arrival minutes
                'd': dep_min,      # departure minutes
            })

        trains.append({
            'tx': tx,
            'line': info.get('line', data.get('line_hint', '')),
            'type': info.get('type', ''),
            'dest': info.get('dest', ''),
            'stops': compact_stops,
        })

    # Sort by line then first departure
    trains.sort(key=lambda t: (
        t['line'],
        t['stops'][0].get('d') or t['stops'][0].get('a') or 0
    ))

    output = {
        'trains': trains,
        'stats': {
            'total_trains': len(trains),
            'total_stops': sum(len(t['stops']) for t in trains),
            'lines': len(set(t['line'] for t in trains)),
        }
    }

    save_json(OUTPUT_FILE, output)
    size = os.path.getsize(OUTPUT_FILE)
    print(f"Output: {OUTPUT_FILE} ({size/1024/1024:.1f} MB)")
    print(f"Stats: {output['stats']}")


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', type=int, default=0,
                        help='Run specific phase (1/2/3), 0=all')
    args = parser.parse_args()

    print("=== Ekitan Train Detail Scraper ===")
    print(f"Delay: {DELAY}s")
    print()

    if args.phase in (0, 1):
        all_txs = phase1_collect_train_urls()
    else:
        with open(TRAIN_URLS_FILE) as f:
            all_txs = json.load(f)['txs']

    if args.phase in (0, 2):
        train_data = phase2_fetch_train_details(all_txs)
    else:
        with open(TRAIN_DATA_FILE) as f:
            train_data = json.load(f)

    if args.phase in (0, 3):
        phase3_build_output(train_data)


if __name__ == '__main__':
    main()
