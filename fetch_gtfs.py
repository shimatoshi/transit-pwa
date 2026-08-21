#!/usr/bin/env python3
"""
GTFS-JP フィードの取得。

PR1 では「再配布可能なライセンス(CC BY / CC0)で、かつ認証なしで取得できる」
フィードだけをホワイトリストで持つ。ODPT の「公共交通オープンデータ基本ライセンス」は
再配布制限があるためオフライン同梱に使えず、ここには載せない。

  python3 fetch_gtfs.py                 # ホワイトリスト全件
  python3 fetch_gtfs.py --only toei     # 都営バスのみ
  python3 fetch_gtfs.py --force         # sha256 が同じでも取り直す

出力:
  data/gtfs/{key}.zip
  data/gtfs/_manifest.json  … 出典表示(CC BY の表示義務)とビルド再現性のための台帳
"""

import argparse
import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))

# 再配布可(オフライン同梱可)なフィードのみ。追加時は license を必ず確認すること。
#
# 関西・中部・九州の大手事業者(大阪シティバス・西鉄バス・神戸市バス・京都市バス等)は
# 「公共交通データHUBシステム」や ODPT の基本ライセンス(再配布制限あり)、または
# 利用登録必須で配信されており、ここには載せられない。CC BY/CC0 で認証なし配信の
# フィードに絞ると、政令市クラスでは北海道中央バス・じょうてつ・名古屋市バスのみが該当する。
#
# 関西・九州の地域コミュニティバス(gtfs-data.jp経由)は、別ブランチ
# feat/bus-gtfs-expand が全国規模で網羅的に収録する方針のため、本ブランチでは
# 重複を避けてここには含めない(北海道中央バス・じょうてつ・名古屋市バスの3社は
# 同ブランチの収録対象に含まれていなかったため、政令市クラスの空白域を埋める
# ものとしてこちらに残す)。
#
# 'url' 固定URL方式(都営バス/HODA/BODIK)に加え、'gtfs_data_jp' 方式
# (organization_id, feed_id) にも対応しているが、現状このホワイトリストには
# 'url' 方式のフィードしかない(gtfs-data.jp 経由の追加は上記理由で見送り)。
# GTFSデータリポジトリ(gtfs-data.jp)は改正のたびに配布URLの uid が変わる
# (署名付きS3 URL)ため、'gtfs_data_jp' 方式では fetch 時に API から現行版
# (rid=current)の URL を都度解決する。
FEEDS = {
    'toei': {
        'name': '都営バス',
        'operator': '東京都交通局',
        'url': 'https://api-public.odpt.org/api/v4/files/Toei/data/ToeiBus-GTFS.zip',
        'catalog': 'https://ckan.odpt.org/ja/dataset/b_bus_gtfs_jp-toei',
        'license': 'CC BY 4.0',
        'license_url': 'https://creativecommons.org/licenses/by/4.0/deed.ja',
        # CC BY 4.0 の表示義務。index.html のクレジットはこの文字列を出典とする
        'attribution': '東京都交通局・公共交通オープンデータ協議会',
        'pref': '東京都',
    },
    # ---- 北海道 ----
    'hokkaido_chuo': {
        'name': '北海道中央バス',
        'operator': '北海道中央バス株式会社',
        'url': 'https://ckan.hoda.jp/dataset/24d1dd70-5395-4d6b-b41f-0d83e8eabdb9/resource/dbadfccc-670e-49b9-be77-c3f346ee3160/download/hokkaido_chuo.zip',
        'catalog': 'https://ckan.hoda.jp/dataset/gtfs-data/resource/dbadfccc-670e-49b9-be77-c3f346ee3160',
        'license': 'CC BY 4.0',
        'license_url': 'https://creativecommons.org/licenses/by/4.0/deed.ja',
        'attribution': '北海道中央バス株式会社・北海道オープンデータポータル(HODA)',
        'pref': '北海道',
    },
    'jotetsu': {
        'name': 'じょうてつバス',
        'operator': 'じょうてつ株式会社',
        'url': 'https://ckan.hoda.jp/dataset/24d1dd70-5395-4d6b-b41f-0d83e8eabdb9/resource/fef98fef-6fe2-472f-bde3-9d4f0a509a4a/download/joutetsu.zip',
        'catalog': 'https://ckan.hoda.jp/dataset/gtfs-data/resource/fef98fef-6fe2-472f-bde3-9d4f0a509a4a',
        'license': 'CC BY 4.0',
        'license_url': 'https://creativecommons.org/licenses/by/4.0/deed.ja',
        'attribution': 'じょうてつ株式会社・北海道オープンデータポータル(HODA)',
        'pref': '北海道',
    },
    # ---- 中部 ----
    'nagoya': {
        'name': '名古屋市バス',
        'operator': '名古屋市交通局',
        'url': 'https://data.bodik.jp/dataset/c5794008-8053-42ab-99b9-ee7f6fdf9a9e/resource/125a1d12-7df6-489c-abde-911856e05d1b/download/20260328_bus-gtfs-jp.zip',
        'catalog': 'https://data.bodik.jp/dataset/231002_7109030000_bus-gtfs-jp',
        'license': 'CC BY 4.0',
        'license_url': 'https://creativecommons.org/licenses/by/4.0/deed.ja',
        'attribution': '名古屋市交通局',
        'pref': '愛知県',
    },
}

UA = 'transit-pwa gtfs fetcher (+https://github.com/shimatoshi/transit-pwa)'


def fetch(url, timeout=300):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def resolve_gtfs_data_jp_url(org, feed_id):
    """GTFSデータリポジトリ(gtfs-data.jp)の現行版(rid=current)ダウンロードURLを解決する。
    配布URLは署名付きS3 URLで改正のたびに uid が変わるため、API から都度引く。"""
    api = f'https://api.gtfs-data.jp/v2/organizations/{org}/feeds/{feed_id}'
    body = json.loads(fetch(api))['body']
    for gf in body['gtfs_files']:
        if gf['rid'] == 'current':
            return gf['gtfs_url']
    sys.exit(f'{org}/{feed_id}: rid=current が見つからない')


def feed_info(zip_bytes):
    """feed_info.txt / agency.txt からデータ基準日と事業者名を拾う(台帳・UI表示用)"""
    out = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        names = set(z.namelist())
        if 'feed_info.txt' in names:
            import csv
            with z.open('feed_info.txt') as f:
                rows = list(csv.DictReader(io.TextIOWrapper(f, 'utf-8-sig')))
            if rows:
                r = rows[0]
                out['feed_version'] = r.get('feed_version', '')
                out['feed_start_date'] = r.get('feed_start_date', '')
                out['feed_end_date'] = r.get('feed_end_date', '')
                out['feed_publisher_name'] = r.get('feed_publisher_name', '')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(BASE, 'data', 'gtfs'))
    ap.add_argument('--only', action='append', help='フィードキー(複数可)')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    keys = args.only or list(FEEDS)
    unknown = [k for k in keys if k not in FEEDS]
    if unknown:
        sys.exit(f'unknown feed key(s): {unknown}. known: {list(FEEDS)}')

    os.makedirs(args.out, exist_ok=True)
    mpath = os.path.join(args.out, '_manifest.json')
    manifest = {}
    if os.path.exists(mpath):
        with open(mpath) as f:
            manifest = json.load(f)

    for key in keys:
        spec = FEEDS[key]
        zpath = os.path.join(args.out, f'{key}.zip')
        prev = manifest.get(key, {})
        if 'gtfs_data_jp' in spec:
            gd = spec['gtfs_data_jp']
            url = resolve_gtfs_data_jp_url(gd['org'], gd['feed'])
        else:
            url = spec['url']
        print(f'[{key}] {url}')
        data = fetch(url)
        sha = hashlib.sha256(data).hexdigest()
        if not args.force and prev.get('sha256') == sha and os.path.exists(zpath):
            print(f'  unchanged (sha256 {sha[:12]}…, {len(data)/1e6:.2f}MB)')
            continue
        with open(zpath, 'wb') as f:
            f.write(data)
        entry = {k: spec[k] for k in
                 ('name', 'operator', 'catalog', 'license', 'license_url',
                  'attribution', 'pref')}
        entry['url'] = url
        entry.update({
            'file': f'{key}.zip',
            'sha256': sha,
            'bytes': len(data),
            'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        })
        entry.update(feed_info(data))
        manifest[key] = entry
        print(f'  saved {zpath} ({len(data)/1e6:.2f}MB, sha256 {sha[:12]}…, '
              f'feed {entry.get("feed_version", "?")})')

    with open(mpath, 'w') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')
    print(f'manifest: {mpath} ({len(manifest)} feeds)')


if __name__ == '__main__':
    main()
