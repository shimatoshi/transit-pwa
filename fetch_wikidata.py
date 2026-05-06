#!/usr/bin/env python3
"""
Fetch Japanese railway station data from Wikidata SPARQL.
Collects: stations, coordinates, lines (P361), adjacency (P197).
"""

import json
import urllib.request
import urllib.parse
import time
import sys

ENDPOINT = 'https://query.wikidata.org/sparql'
OUTPUT = '/home/transit-pwa/wikidata_stations.json'

def sparql_query(query, retries=3):
    params = urllib.parse.urlencode({'query': query, 'format': 'json'})
    url = f"{ENDPOINT}?{params}"
    headers = {'User-Agent': 'TransitPWA/1.0 (offline route planner)', 'Accept': 'application/json'}
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

def fetch_all(query, desc):
    """Fetch with pagination using OFFSET/LIMIT."""
    all_results = []
    limit = 10000
    offset = 0
    while True:
        paged = query + f"\nLIMIT {limit} OFFSET {offset}"
        print(f"  Fetching {desc} offset={offset}...")
        data = sparql_query(paged)
        if not data:
            print(f"  Failed at offset {offset}")
            break
        bindings = data['results']['bindings']
        all_results.extend(bindings)
        print(f"  Got {len(bindings)} results (total: {len(all_results)})")
        if len(bindings) < limit:
            break
        offset += limit
        time.sleep(2)  # Rate limit
    return all_results

def main():
    print("=== Step 1: Fetch stations with coordinates ===")
    # Get all Japanese railway stations with coordinates
    # Q548662 = railway station in Japan, but also use broader approach
    station_query = """
SELECT ?station ?stationLabel ?coord ?line ?lineLabel WHERE {
  ?station wdt:P361 ?line .
  ?station wdt:P625 ?coord .
  ?station wdt:P17 wd:Q17 .
  ?station wdt:P31/wdt:P279* wd:Q548662 .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en" }
}
ORDER BY ?line ?station"""

    station_results = fetch_all(station_query, "stations+lines")
    print(f"Total station-line pairs: {len(station_results)}")

    print("\n=== Step 2: Fetch adjacency data ===")
    adj_query = """
SELECT ?station ?stationLabel ?adj ?adjLabel WHERE {
  ?station wdt:P197 ?adj .
  ?station wdt:P17 wd:Q17 .
  ?adj wdt:P17 wd:Q17 .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en" }
}
ORDER BY ?station"""

    adj_results = fetch_all(adj_query, "adjacency")
    print(f"Total adjacency pairs: {len(adj_results)}")

    print("\n=== Step 3: Fetch stations without line data (by type) ===")
    # Some stations have coords and P197 but no P361
    extra_query = """
SELECT ?station ?stationLabel ?coord WHERE {
  ?station wdt:P31/wdt:P279* wd:Q548662 .
  ?station wdt:P17 wd:Q17 .
  ?station wdt:P625 ?coord .
  FILTER NOT EXISTS { ?station wdt:P361 ?anyLine }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ja,en" }
}
ORDER BY ?station"""

    extra_results = fetch_all(extra_query, "extra stations")
    print(f"Extra stations (no line): {len(extra_results)}")

    # Parse and save
    print("\n=== Parsing ===")

    def parse_coord(coord_str):
        # "Point(139.123 35.456)" or "Point(139.123,35.456)"
        s = coord_str.replace('Point(', '').replace(')', '').strip()
        parts = s.replace(',', ' ').split()
        if len(parts) < 2:
            return None, None
        return float(parts[1]), float(parts[0])  # lat, lon

    def entity_id(uri):
        return uri.split('/')[-1]

    # Build station dict
    stations = {}  # qid -> {name, lat, lon, lines: [line_name], line_qids: [qid]}

    for r in station_results:
        qid = entity_id(r['station']['value'])
        name = r['stationLabel']['value']
        lat, lon = parse_coord(r['coord']['value'])
        line_qid = entity_id(r['line']['value'])
        line_name = r['lineLabel']['value']

        if lat is None:
            continue
        if qid not in stations:
            stations[qid] = {
                'qid': qid, 'name': name,
                'lat': lat, 'lon': lon,
                'lines': [], 'line_qids': []
            }
        if line_name not in stations[qid]['lines']:
            stations[qid]['lines'].append(line_name)
            stations[qid]['line_qids'].append(line_qid)

    for r in extra_results:
        qid = entity_id(r['station']['value'])
        if qid in stations:
            continue
        name = r['stationLabel']['value']
        lat, lon = parse_coord(r['coord']['value'])
        if lat is None:
            continue
        stations[qid] = {
            'qid': qid, 'name': name,
            'lat': lat, 'lon': lon,
            'lines': [], 'line_qids': []
        }

    # Build adjacency
    adjacency = []  # [(station_qid, adj_qid)]
    for r in adj_results:
        s_qid = entity_id(r['station']['value'])
        a_qid = entity_id(r['adj']['value'])
        adjacency.append((s_qid, a_qid))

    print(f"Stations: {len(stations)}")
    print(f"Adjacency pairs: {len(adjacency)}")
    print(f"Stations with lines: {sum(1 for s in stations.values() if s['lines'])}")

    # Save
    output = {
        'stations': stations,
        'adjacency': adjacency,
    }

    with open(OUTPUT, 'w') as f:
        json.dump(output, f, ensure_ascii=False, indent=1)

    size = len(json.dumps(output, ensure_ascii=False))
    print(f"\nSaved to {OUTPUT} ({size/1024/1024:.1f} MB)")

    # Quick stats
    adj_stations = set()
    for s, a in adjacency:
        adj_stations.add(s)
        adj_stations.add(a)
    in_both = adj_stations & set(stations.keys())
    print(f"Stations with adjacency data: {len(adj_stations)}")
    print(f"Stations in both (coords + adj): {len(in_both)}")

if __name__ == '__main__':
    main()
