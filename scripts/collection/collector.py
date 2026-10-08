#!/usr/bin/env python3
"""Durable, finite collection queue. Never modifies the production dataset."""
import argparse
import csv
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import time
import unicodedata
from datetime import datetime, timezone
from urllib.parse import parse_qs, quote, urljoin, urlparse
import urllib.request
import zipfile


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    os.replace(temporary, path)


def database(root):
    root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(root / 'queue.sqlite', timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('''CREATE TABLE IF NOT EXISTS tasks (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT NOT NULL,
        payload TEXT NOT NULL, priority INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        retry_at REAL NOT NULL DEFAULT 0, error TEXT, updated TEXT)''')
    db.execute('''CREATE TABLE IF NOT EXISTS results (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL)''')
    db.commit()
    return db


def enqueue(db, key, kind, url, payload, priority):
    db.execute('INSERT OR IGNORE INTO tasks(key,kind,url,payload,priority) VALUES(?,?,?,?,?)',
               (key, kind, url, json.dumps(payload, ensure_ascii=False), priority))


def status(db):
    counts = {}
    for row in db.execute('SELECT kind,status,count(*) n FROM tasks GROUP BY kind,status'):
        counts.setdefault(row['kind'], {})[row['status']] = row['n']
    return {'updated_at': now(), 'tasks': counts,
            'result_count': db.execute('SELECT count(*) FROM results').fetchone()[0]}


def read_csv(z, name):
    matches = [n for n in z.namelist() if Path(n).name == name]
    if not matches:
        return []
    return list(csv.DictReader(io.StringIO(z.read(matches[0]).decode('utf-8-sig'))))


def rail_type(value):
    value = int(value)
    return value in (0, 1, 2, 5, 6, 7, 12) or 100 <= value < 200 or 400 <= value < 500 or 900 <= value < 1000


def gtfs_summary(blob, today=None):
    today = today or datetime.now(timezone.utc).strftime('%Y%m%d')
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        bad = z.testzip()
        if bad:
            raise ValueError('Corrupt ZIP: ' + bad)
        tables = {name: read_csv(z, name + '.txt') for name in
                  ('stops', 'routes', 'trips', 'stop_times', 'calendar', 'calendar_dates', 'feed_info', 'frequencies')}
    for name in ('stops', 'routes', 'trips', 'stop_times'):
        if not tables[name]:
            raise ValueError('Missing/empty GTFS table: ' + name)
    stop_ids = {x['stop_id'] for x in tables['stops']}
    route_ids = {x['route_id'] for x in tables['routes']}
    trip_ids = {x['trip_id'] for x in tables['trips']}
    if any(x['route_id'] not in route_ids for x in tables['trips']):
        raise ValueError('Unknown route reference')
    if any(x['trip_id'] not in trip_ids or x['stop_id'] not in stop_ids for x in tables['stop_times']):
        raise ValueError('Unknown trip/stop reference')
    if not tables['calendar'] and not tables['calendar_dates']:
        raise ValueError('Missing service calendar')
    services = {x['service_id'] for x in tables['calendar'] + tables['calendar_dates']}
    if any(x['service_id'] not in services for x in tables['trips']):
        raise ValueError('Unknown service calendar reference')
    rail_routes = {x['route_id'] for x in tables['routes'] if rail_type(x['route_type'])}
    rail_trips = {x['trip_id'] for x in tables['trips'] if x['route_id'] in rail_routes}
    selected_times = [x for x in tables['stop_times'] if x['trip_id'] in rail_trips]
    rail_stops = {x['stop_id'] for x in selected_times}
    dates = [x.get('end_date', '') for x in tables['calendar']] + [x.get('date', '') for x in tables['calendar_dates']]
    end = max((x for x in dates if x), default='')
    info = tables['feed_info'][0] if tables['feed_info'] else {}
    if info.get('feed_end_date'):
        end = min(end, info['feed_end_date']) if end else info['feed_end_date']
    return {'table_counts': {k: len(v) for k, v in tables.items()},
            'rail_routes': len(rail_routes), 'rail_trips': len(rail_trips),
            'rail_stop_times': len(selected_times), 'rail_stops': len(rail_stops),
            'stops': [x for x in tables['stops'] if x['stop_id'] in rail_stops],
            'rail_route_data': [x for x in tables['routes'] if x['route_id'] in rail_routes],
            'route_data': tables['routes'],
            'mode_review_stops': tables['stops'] if not rail_trips else [],
            'feed_info': info, 'calendar_end_date': end,
            'expired': bool(end and end < today)}


def browser_fetch(url):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            page = browser.new_page(locale='ja-JP', timezone_id='Asia/Tokyo')
            response = page.goto(url, wait_until='domcontentloaded', timeout=45000)
            if response is None or response.status != 200:
                raise ValueError('Browser HTTP ' + str(response.status if response else None))
            control = page.get_by_text('すべての時刻', exact=True)
            if control.count():
                control.first.click()
            return page.content().encode('utf-8')
        finally:
            browser.close()


def fetch(url):
    req = urllib.request.Request(quote(url, safe="/:?=&%+#@;,!$'()*[]"), headers={
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
        'Accept-Encoding': 'gzip', 'Accept-Language': 'ja-JP,ja;q=0.9'})
    with urllib.request.urlopen(req, timeout=45) as response:
        blob = response.read(40 * 1024 * 1024 + 1)
    if len(blob) > 40 * 1024 * 1024:
        raise ValueError('Response exceeds 40MiB')
    return gzip.decompress(blob) if blob[:2] == b'\x1f\x8b' else blob


def html_parse(kind, blob):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(blob, 'html.parser')
    title = soup.title.get_text(' ', strip=True) if soup.title else ''
    if not title or '駅探' not in title:
        raise ValueError('Unexpected HTML or missing title')
    if kind == 'station':
        links = []
        for a in soup.find_all('a', href=True):
            if re.search(r'/line-station/[0-9]+-[0-9]+/d[12]', a['href']):
                links.append({'label': a.get_text(' ', strip=True), 'url': urljoin('https://ekitan.com', a['href'])})
        return {'title': title, 'directions': list({x['url']: x for x in links}.values())}
    if kind == 'timetable':
        entries = []
        for a in soup.find_all('a', href=True):
            if '/timetable/railway/train?' in a['href']:
                url = urljoin('https://ekitan.com', a['href'])
                args = parse_qs(urlparse(url).query)
                if not args.get('tx') or not args.get('departure'):
                    continue
                entries.append({'url': url, 'label': a.get_text(' ', strip=True),
                                'tx': args['tx'][0], 'departure': args['departure'][0]})
        entries = list({x['url']: x for x in entries}.values())
        if not entries:
            raise ValueError('Empty timetable; requires suspension/seasonal check')
        return {'title': title, 'entries': entries,
                'as_of': sorted(set(re.findall(r'[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日現在', soup.get_text())))}
    stops = []
    for tr in soup.find_all('tr'):
        cell = tr.select_one('.td-station-name')
        tc = tr.select_one('.td-dep-and-arr-time')
        if not cell or not tc:
            continue
        a = cell.find('a', href=True)
        text = tc.get_text(' ', strip=True)
        sid = re.search(r'/station/([0-9]+)', a['href']) if a else None
        arrival = re.search(r'([0-9]{1,2}:[0-9]{2})\s*着', text)
        departure = re.search(r'([0-9]{1,2}:[0-9]{2})\s*発', text)
        stops.append({'station': cell.get_text(' ', strip=True), 'station_id': sid[1] if sid else None,
                      'arrival': arrival[1] if arrival else None, 'departure': departure[1] if departure else None})
    if len(stops) < 2 or any(not s['station_id'] or not (s['arrival'] or s['departure']) for s in stops):
        raise ValueError('Invalid or incomplete train stop list')
    return {'title': title, 'stops': stops}


def seed(root, config):
    db = database(root)
    atomic(root / 'config.json', config)
    for feed in config['feeds']:
        enqueue(db, 'gtfs:' + feed['key'], 'gtfs', feed['url'], feed, 0)
    for station in config['stations']:
        enqueue(db, 'station:' + station['station_id'], 'station', station['url'], station, 10)
    for row in config.get('priority_timetables', []):
        enqueue(db, 'timetable:' + row['url'], 'timetable', row['url'], row, 1)
    for source in config.get('official_sources', []):
        enqueue(db, 'source:' + source['url'], 'source', source['url'], source, 3)
    db.commit()
    atomic(root / 'status.json', status(db))
    print(json.dumps(status(db), ensure_ascii=False))


def process(db, root, task):
    payload = json.loads(task['payload'])
    blob = fetch(task['url'])
    if task['kind'] == 'gtfs':
        result = gtfs_summary(blob)
        destination = root / 'gtfs' / (payload['key'] + '.zip')
        destination.parent.mkdir(exist_ok=True)
        temporary = destination.with_suffix('.zip.tmp')
        temporary.write_bytes(blob)
        os.replace(temporary, destination)
        result['zip_file'] = str(destination.relative_to(root))
        result['use_status'] = 'expired' if result['expired'] else 'ready' if result['rail_trips'] else 'no_rail_trips'
    elif task['kind'] in ('source', 'document'):
        media = None
        if blob.startswith(b'%PDF'):
            media = ('pdf', 'application/pdf', 'needs_pdf_parser')
        elif blob.startswith(b'\xff\xd8\xff'):
            media = ('jpg', 'image/jpeg', 'needs_image_parser')
        elif blob.startswith(b'\x89PNG\r\n\x1a\n'):
            media = ('png', 'image/png', 'needs_image_parser')
        elif blob.startswith((b'GIF87a', b'GIF89a')):
            media = ('gif', 'image/gif', 'needs_image_parser')
        elif blob.startswith(b'RIFF') and blob[8:12] == b'WEBP':
            media = ('webp', 'image/webp', 'needs_image_parser')
        if media:
            destination = root / 'documents' / (hashlib.sha256(blob).hexdigest() + '.' + media[0])
            destination.parent.mkdir(exist_ok=True)
            destination.write_bytes(blob)
            result = {'document_file': str(destination.relative_to(root)),
                      'media_type': media[1], 'review_status': media[2]}
        elif task['kind'] == 'document':
            raise ValueError('Expected PDF/image document')
        else:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(blob, 'html.parser')
            if not soup.title:
                raise ValueError('Official source missing HTML title')
            links = []
            for a in soup.find_all('a', href=True):
                url = urljoin(task['url'], a['href']).split('#')[0]
                label = a.get_text(' ', strip=True)
                if urlparse(url).netloc != urlparse(task['url']).netloc:
                    continue
                if 'バス' in label or not (re.search('時刻|電車|路線', label) or url.lower().endswith('.pdf')):
                    continue
                links.append({'url': url, 'label': label})
                depth = payload.get('depth', 0)
                if depth < 2 and len(links) <= 50 and url.startswith(('https://', 'http://')):
                    kind = 'document' if urlparse(url).path.lower().endswith('.pdf') else 'source'
                    enqueue(db, kind + ':' + url, kind, url, {**payload, 'depth': depth + 1}, 4)
            result = {'title': soup.title.get_text(' ', strip=True), 'links': links,
                      'review_status': 'needs_source_adapter'}
    else:
        try:
            result = html_parse(task['kind'], blob)
        except ValueError:
            blob = browser_fetch(task['url'])
            result = html_parse(task['kind'], blob)
        if task['kind'] == 'station':
            if not result['directions']:
                result['review_status'] = 'no_timetable_links'
            for direction in result['directions']:
                for day in range(3):
                    url = direction['url'].split('?')[0] + '?dw=' + str(day)
                    enqueue(db, 'timetable:' + url, 'timetable', url,
                            {**payload, 'day': day, 'direction': direction['label']}, 11)
        elif task['kind'] == 'timetable':
            day = payload['day']
            # Actual query/calendar is part of the key: never collapse weekdays.
            for entry in result['entries']:
                query = parse_qs(urlparse(entry['url']).query)
                if query.get('dw', [str(day)])[0] != str(day):
                    raise ValueError('Requested calendar differs from detail link')
                enqueue(db, 'train:' + str(day) + ':' + entry['tx'], 'train', entry['url'],
                        {**payload, 'tx': entry['tx']}, 2 if task['priority'] == 1 else 20)
    sha = hashlib.sha256(blob).hexdigest()
    raw = root / 'raw'
    raw.mkdir(exist_ok=True)
    if task['kind'] not in ('gtfs', 'document') and not result.get('document_file'):
        with gzip.open(raw / (sha + '.html.gz'), 'wb') as f:
            f.write(blob)
        result['raw_file'] = 'raw/' + sha + '.html.gz'
    result.update({'source_url': task['url'], 'sha256': sha, 'collected_at': now(), 'context': payload})
    db.execute('INSERT OR REPLACE INTO results(key,kind,data) VALUES(?,?,?)',
               (task['key'], task['kind'], json.dumps(result, ensure_ascii=False)))
    db.execute("UPDATE tasks SET status='done',error=NULL,updated=? WHERE key=?", (now(), task['key']))
    db.commit()
    print(json.dumps({'event': 'collected', 'kind': task['kind'], 'key': task['key'],
                      'entries': len(result.get('entries', [])), 'rail_trips': result.get('rail_trips'),
                      'at': now()}, ensure_ascii=False), flush=True)


def run(root, delay):
    root.mkdir(parents=True, exist_ok=True)
    lock = (root / 'run.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    atomic(root / 'pid.json', {'pid': os.getpid(), 'started_at': now()})
    db = database(root)
    db.execute("UPDATE tasks SET status='pending' WHERE status='running'")
    db.commit()
    stop = [False]
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__(0, True))
    signal.signal(signal.SIGINT, lambda *_: stop.__setitem__(0, True))
    while not stop[0]:
        task = db.execute("SELECT * FROM tasks WHERE status='pending' AND retry_at<=? ORDER BY priority,key LIMIT 1", (time.time(),)).fetchone()
        heartbeat = status(db)
        heartbeat.update({'pid': os.getpid(), 'state': 'running' if task else 'waiting'})
        atomic(root / 'status.json', heartbeat)
        if not task:
            if not db.execute("SELECT count(*) FROM tasks WHERE status='pending'").fetchone()[0]:
                break
            time.sleep(5)
            continue
        db.execute("UPDATE tasks SET status='running',attempts=attempts+1,updated=? WHERE key=?", (now(), task['key']))
        db.commit()
        time.sleep(delay)
        try:
            process(db, root, task)
        except Exception as error:
            # Roll back any dependent queue inserts from an invalid response.
            db.rollback()
            attempt = task['attempts'] + 1
            db.execute('UPDATE tasks SET status=?,retry_at=?,error=?,updated=? WHERE key=?',
                       ('failed' if attempt >= 3 else 'pending', time.time() + min(300, 30 * 2 ** attempt),
                        str(error), now(), task['key']))
            db.commit()
            print(json.dumps({'event': 'retry' if attempt < 3 else 'failed', 'key': task['key'],
                              'attempt': attempt, 'error': str(error), 'at': now()}, ensure_ascii=False), flush=True)
    final = status(db)
    final.update({'pid': os.getpid(), 'state': 'stopped' if stop[0] else 'finished'})
    atomic(root / 'status.json', final)
    print(json.dumps(final, ensure_ascii=False), flush=True)


def export(root):
    db = database(root)
    for kind in ('gtfs', 'station', 'timetable', 'train', 'source', 'document'):
        rows = [json.loads(x['data']) for x in db.execute('SELECT data FROM results WHERE kind=?', (kind,))]
        atomic(root / (kind + '-results.json'), rows)
    config = json.loads((root / 'config.json').read_text())
    stops = {}
    def norm(name):
        name = unicodedata.normalize('NFKC', name)
        return re.sub(r'\([^)]*\)|[\s・]', '', name).replace('ヶ', 'ケ').removesuffix('駅')
    for row in db.execute("SELECT data FROM results WHERE kind='gtfs'"):
        data = json.loads(row['data'])
        if data['use_status'] != 'ready':
            continue
        for stop in data['stops']:
            stops.setdefault(norm(stop['stop_name']), []).append({
                'source_key': data['context']['key'], 'stop_id': stop['stop_id'],
                'lat': float(stop['stop_lat']), 'lon': float(stop['stop_lon'])})
    coverage = []
    for candidate in config.get('candidates', []):
        matches = []
        for stop in stops.get(norm(candidate['name']), []):
            # Bounding box is only a candidate match; keep coordinates for review.
            if abs(stop['lat'] - candidate['lat']) < 0.005 and abs(stop['lon'] - candidate['lon']) < 0.007:
                matches.append(stop)
        coverage.append({'candidate': candidate, 'gtfs_matches': matches,
                         'status': 'gtfs_candidate_match' if matches else 'needs_source_or_alias_review'})
    atomic(root / 'candidate-coverage.json', coverage)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['seed', 'run', 'status', 'export', 'retry-failed'])
    p.add_argument('--root', required=True, type=Path)
    p.add_argument('--config', type=Path)
    p.add_argument('--delay', type=float, default=1.5)
    a = p.parse_args()
    if a.action == 'seed':
        seed(a.root, json.loads(a.config.read_text()))
    elif a.action == 'run':
        run(a.root, a.delay)
    elif a.action == 'export':
        export(a.root)
    else:
        db = database(a.root)
        if a.action == 'retry-failed':
            db.execute("UPDATE tasks SET status='pending',attempts=0,retry_at=0 WHERE status='failed'")
            db.commit()
        print(json.dumps(status(db), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
