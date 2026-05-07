#!/usr/bin/env python3
"""
Scrape timetable data from ekitan.com using sitemap URLs.
Outputs timetable.json for the PWA.

Strategy:
1. Parse sitemap to get all line-station/d1 URLs (weekday timetables)
2. For each URL, extract departure times from HTML
3. Map ekitan station IDs to our graph station names
4. Save compact timetable data

Rate limiting: 2 sec between requests, resume support.
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

BASE = '/home/transit-pwa'
SITEMAP1 = os.path.join(BASE, '/tmp/railway1.xml')
SITEMAP2 = os.path.join(BASE, '/tmp/railway2.xml')
PROGRESS_FILE = os.path.join(BASE, 'scrape_progress.json')
STATION_MAP_FILE = os.path.join(BASE, 'ekitan_stations.json')
TIMETABLE_FILE = os.path.join(BASE, 'timetable_raw.json')
OUTPUT_FILE = os.path.join(BASE, 'timetable.json')
DELAY = 1.5  # seconds between requests
UA = 'Mozilla/5.0 (Linux; Android 10; Pixel 3a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36'

def http_get(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode('utf-8')
        except Exception as e:
            print(f"  Retry {attempt+1}: {e}", file=sys.stderr)
            if attempt < retries - 1:
                time.sleep(3 * (attempt + 1))
    return None

def parse_sitemap():
    """Get all line-station timetable URLs from sitemap."""
    urls = []
    for path in ['/tmp/railway1.xml', '/tmp/railway2.xml']:
        if not os.path.exists(path):
            print(f"Downloading sitemap...")
            url = f"https://ekitan.com/timetable/{os.path.basename(path)}"
            html = http_get(url)
            if html:
                with open(path, 'w') as f:
                    f.write(html)
        with open(path) as f:
            xml = f.read()
        found = re.findall(r'<loc>(https://ekitan\.com/timetable/railway/[^<]+)</loc>', xml)
        urls.extend(found)
    return urls

def phase1_get_station_map():
    """Get ekitan station ID → station name mapping from station pages."""
    print("=== Phase 1: Get station name mapping ===")

    if os.path.exists(STATION_MAP_FILE):
        with open(STATION_MAP_FILE) as f:
            data = json.load(f)
        print(f"Loaded existing station map: {len(data)} stations")
        return data

    urls = parse_sitemap()
    station_urls = [u for u in urls if '/station/' in u and '/line-station/' not in u]
    print(f"Station URLs to fetch: {len(station_urls)}")

    station_map = {}  # ekitan_id -> {name, lines: [{line_station_id, direction, line_name}]}

    for i, url in enumerate(station_urls):
        sid = re.search(r'/station/(\d+)', url).group(1)
        if sid in station_map:
            continue

        html = http_get(url)
        if not html:
            print(f"  SKIP {url}")
            continue

        # Extract station name from title
        title = re.search(r'<title>(.+?)駅の時刻表', html)
        if not title:
            title = re.search(r'<title>(.+?)の時刻表', html)
        if not title:
            continue

        name = title.group(1).strip()

        # Extract line-station links (timetable directions)
        ls_links = re.findall(r'/timetable/railway/line-station/(\d+)-(\d+)/d1', html)

        directions = []
        for ls_id, direction in ls_links:
            directions.append({'ls': ls_id, 'd': direction})

        station_map[sid] = {'name': name, 'dirs': directions}

        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(station_urls)} stations ({len(station_map)} mapped)")
            # Save progress
            with open(STATION_MAP_FILE, 'w') as f:
                json.dump(station_map, f, ensure_ascii=False)

        time.sleep(DELAY)

    with open(STATION_MAP_FILE, 'w') as f:
        json.dump(station_map, f, ensure_ascii=False)
    print(f"Station map saved: {len(station_map)} stations")
    return station_map

def phase2_scrape_timetables(station_map):
    """Scrape timetable data for all station directions."""
    print("\n=== Phase 2: Scrape timetables ===")

    # Load progress
    timetables = {}
    if os.path.exists(TIMETABLE_FILE):
        with open(TIMETABLE_FILE) as f:
            timetables = json.load(f)
        print(f"Resuming: {len(timetables)} already scraped")

    # Build list of URLs to scrape
    to_scrape = []
    for sid, info in station_map.items():
        for d in info['dirs']:
            key = f"{d['ls']}-{d['d']}"
            if key not in timetables:
                to_scrape.append((sid, d['ls'], d['d'], key))

    print(f"Remaining to scrape: {len(to_scrape)}")
    print(f"Estimated time: {len(to_scrape) * DELAY / 60:.0f} minutes")

    for i, (sid, ls_id, direction, key) in enumerate(to_scrape):
        url = f"https://ekitan.com/timetable/railway/line-station/{ls_id}-{direction}/d1"
        html = http_get(url)
        if not html:
            print(f"  SKIP {url}")
            continue

        # Extract departure times from "departure=HHMM" pattern
        departures = re.findall(r'departure=(\d{4})', html)
        # Remove duplicates while preserving order
        seen = set()
        unique_deps = []
        for d in departures:
            if d not in seen:
                seen.add(d)
                unique_deps.append(d)

        # Extract line name and direction from title
        title_match = re.search(r'<title>(.+?)駅\((.+?)\)の時刻表', html)
        line_dir = ''
        if title_match:
            line_dir = title_match.group(2)

        timetables[key] = {
            'sid': sid,
            'deps': unique_deps,  # ["0534", "0540", ...]
            'info': line_dir,
        }

        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(to_scrape)} ({len(timetables)} total)")
            with open(TIMETABLE_FILE, 'w') as f:
                json.dump(timetables, f, ensure_ascii=False)

        if (i + 1) % 500 == 0:
            # Full save
            with open(TIMETABLE_FILE, 'w') as f:
                json.dump(timetables, f, ensure_ascii=False)
            print(f"  Saved checkpoint at {i+1}")

        time.sleep(DELAY)

    with open(TIMETABLE_FILE, 'w') as f:
        json.dump(timetables, f, ensure_ascii=False)
    print(f"Timetables saved: {len(timetables)} entries")
    return timetables

def phase3_build_compact(station_map, timetables):
    """Build compact timetable.json for the PWA."""
    print("\n=== Phase 3: Build compact timetable ===")

    # Map ekitan station names to our graph
    with open(os.path.join(BASE, 'graph.json')) as f:
        graph = json.load(f)

    graph_name_to_ids = defaultdict(list)
    for i, s in enumerate(graph['stations']):
        graph_name_to_ids[s['n']].append(i)

    # Build: graph_station_id -> [{line_dir, departures}]
    result = {}
    matched = 0
    unmatched = 0

    for sid, info in station_map.items():
        name = info['name']
        graph_ids = graph_name_to_ids.get(name, [])

        if not graph_ids:
            unmatched += 1
            continue

        matched += 1

        for d in info['dirs']:
            key = f"{d['ls']}-{d['d']}"
            if key not in timetables:
                continue

            tt = timetables[key]
            deps = tt['deps']
            line_dir = tt['info']

            if not deps:
                continue

            # Store as compact: convert "0534" to minutes since midnight (334)
            mins = []
            for dep in deps:
                h, m = int(dep[:2]), int(dep[2:])
                mins.append(h * 60 + m)

            for gid in graph_ids:
                if str(gid) not in result:
                    result[str(gid)] = []
                result[str(gid)].append({
                    'dir': line_dir,
                    'deps': mins,
                })

    print(f"Matched: {matched}, Unmatched: {unmatched}")
    print(f"Graph stations with timetable: {len(result)}")

    # Save
    output = {
        'data': result,
        'stats': {
            'stations_with_tt': len(result),
            'total_departures': sum(len(d['deps']) for dlist in result.values() for d in dlist),
        }
    }

    with open(OUTPUT_FILE, 'w') as f:
        json.dump(output, f, ensure_ascii=False, separators=(',', ':'))

    size = os.path.getsize(OUTPUT_FILE)
    print(f"Output: {OUTPUT_FILE} ({size/1024/1024:.1f} MB)")
    print(f"Stats: {output['stats']}")

def main():
    print("=== Ekitan Timetable Scraper ===")
    print(f"Rate limit: {DELAY}s between requests")
    print()

    station_map = phase1_get_station_map()
    timetables = phase2_scrape_timetables(station_map)
    phase3_build_compact(station_map, timetables)

if __name__ == '__main__':
    main()
