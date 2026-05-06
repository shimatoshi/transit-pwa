#!/usr/bin/env python3
"""Fetch P81 (connecting line) data from Wikidata and merge into wikidata_stations.json"""

import json
import urllib.request
import urllib.parse
import time
import sys

ENDPOINT = 'https://query.wikidata.org/sparql'
STATIONS_FILE = '/home/transit-pwa/wikidata_stations.json'

def sparql_query(query, retries=3):
    params = urllib.parse.urlencode({'query': query, 'format': 'json'})
    url = f"{ENDPOINT}?{params}"
    headers = {'User-Agent': 'TransitPWA/1.0', 'Accept': 'application/json'}
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            print(f"  Attempt {attempt+1} failed: {e}", file=sys.stderr)
            if attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
    return None

def main():
    print("Fetching P81 (connecting line) data...")
    all_results = []
    limit = 10000
    offset = 0
    while True:
        query = f"""
SELECT ?station ?line ?lineLabel WHERE {{
  ?station wdt:P81 ?line .
  ?station wdt:P17 wd:Q17 .
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "ja,en" }}
}}
LIMIT {limit} OFFSET {offset}"""
        print(f"  Fetching offset={offset}...")
        data = sparql_query(query)
        if not data:
            break
        bindings = data['results']['bindings']
        all_results.extend(bindings)
        print(f"  Got {len(bindings)} (total: {len(all_results)})")
        if len(bindings) < limit:
            break
        offset += limit
        time.sleep(2)

    print(f"Total P81 pairs: {len(all_results)}")

    # Parse
    station_lines = {}  # qid -> [line_name, ...]
    for r in all_results:
        qid = r['station']['value'].split('/')[-1]
        line_name = r['lineLabel']['value']
        if qid not in station_lines:
            station_lines[qid] = []
        if line_name not in station_lines[qid]:
            station_lines[qid].append(line_name)

    print(f"Stations with P81 data: {len(station_lines)}")

    # Merge into existing stations file
    with open(STATIONS_FILE) as f:
        wd = json.load(f)

    merged_count = 0
    for qid, lines in station_lines.items():
        if qid in wd['stations']:
            existing = wd['stations'][qid].get('lines', [])
            for l in lines:
                if l not in existing:
                    existing.append(l)
            wd['stations'][qid]['lines'] = existing
            merged_count += 1

    # Also save the P81 data separately for the build script
    wd['p81_lines'] = station_lines

    with open(STATIONS_FILE, 'w') as f:
        json.dump(wd, f, ensure_ascii=False, indent=1)

    print(f"Merged P81 into {merged_count} existing stations")

    # Stats
    has_lines = sum(1 for s in wd['stations'].values() if s.get('lines'))
    print(f"Stations with any line data now: {has_lines}")

if __name__ == '__main__':
    main()
