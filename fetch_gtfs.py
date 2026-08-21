#!/usr/bin/env python3
"""
GTFS-JP フィードの取得。

扱うのは「再配布可能なライセンス(CC BY / CC0)で、かつ認証なしで取得できる」
フィードだけ。ODPT の「公共交通オープンデータ基本ライセンス」は再配布制限があるため
オフライン同梱に使えず対象外(神奈中・西鉄・京都市バス・横浜市営などの大手はここ)。

取得元は2つ:

  gtfs-data.jp  GTFSデータリポジトリ(東大生研)。/v2/files がライセンスと都道府県を
                持つのでカタログをそのまま引き、CC BY / CC0 のものを全件取る。
                地方の路線バス事業者とコミュニティバスが厚い。
  odpt          公共交通オープンデータセンター。CC BY 4.0 で出ている静的 GTFS-JP を
                ODPT_FEEDS にホワイトリストで持つ(都営・仙台市営・青森市営など)。
                実ファイルの URL は日付付きなので CKAN のパッケージページから
                「今日以前で最新の版」を解決する。

  python3 fetch_gtfs.py                      # 両カタログ全件
  python3 fetch_gtfs.py --source odpt        # ODPT だけ
  python3 fetch_gtfs.py --only toei          # 指定キーだけ
  python3 fetch_gtfs.py --force              # sha256 が同じでも取り直す
  python3 fetch_gtfs.py --jobs 8             # 並列数(既定 6)

出力:
  data/gtfs/{key}.zip
  data/gtfs/_manifest.json  … 出典表示(CC BY の表示義務)とビルド再現性のための台帳
"""

import argparse
import csv
import gzip
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))

# カタログに載っていないが再配布可(CC BY 4.0)で認証なしに取れるフィード。
#
# gtfs-data.jp / ODPT のどちらのカタログにも現れないため、ここだけURL直指定で持つ。
# 政令市クラスの空白域(北海道・中部)を埋めるものなので、カタログ化されるまでは残す。
# (都営バスは ODPT_FEEDS 側で解決できるのでここには置かない)
FIXED_FEEDS = {
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
        'source': 'fixed',
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
        'source': 'fixed',
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
        'source': 'fixed',
    },
}


UA = 'transit-pwa gtfs fetcher (+https://github.com/shimatoshi/transit-pwa)'

# 再配布可のライセンスだけを通す。カタログ側の表記ゆれをここで正規化する
LICENSE_OK = {
    'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/deed.ja',
    'CC-BY': 'https://creativecommons.org/licenses/by/4.0/deed.ja',
    'CC BY 2.1 JP': 'https://creativecommons.org/licenses/by/2.1/jp/',
    'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja',
}

PREFS = ['', '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県',
         '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県',
         '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県',
         '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県',
         '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
         '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']

GTFS_DATA_JP_API = 'https://api.gtfs-data.jp/v2/files'

# --- gtfs-data.jp 側の除外 ---
# 変換パイプラインに載らないフィード。理由をコメントに残す(再取得時の判断材料)
GTFS_DATA_JP_SKIP = {
    'gd_tsukubacity_tsukubus': 'stop_times.txt が無い',
    'gd_mizuhotown_demandresponsivetransport': 'デマンド交通で arrival_time 列が無い',
}

# --- ODPT ホワイトリスト ---
# CC BY 4.0 / CC0 で公開されている静的 GTFS-JP のみ。gtfs-data.jp にも同じ事業者が
# 出ているものは重複するのでここには載せない(京成バス千葉ウエスト・永井バス・
# 大利根交通・立川くるりん・国立市・瑞穂町・大新東・三豊市・土佐市)。
# package は CKAN のパッケージ名。実ファイル URL は resolve_odpt_url() が解決する。
ODPT_FEEDS = {
    'toei': ('都営バス', '東京都交通局', '東京都', 'b_bus_gtfs_jp-toei', 'CC BY 4.0'),
    'sendai': ('仙台市営バス', '仙台市交通局', '宮城県',
               'sendai_municipal_bus_realtime_information', 'CC BY 4.0'),
    'aomori_city': ('青森市営バス', '青森市企業局交通部', '青森県',
                    'aomori_city_all_lines', 'CC BY 4.0'),
    'aomori_community': ('青森市コミュニティバス', '青森市', '青森県',
                         'urban_development_aomori_city_all_lines', 'CC BY 4.0'),
    'keifuku': ('京福バス', '京福バス株式会社', '福井県',
                'keifuku_bus_keifuku_rosen', 'CC BY 4.0'),
    'kanetsu': ('関越交通バス', '関越交通株式会社', '群馬県',
                'kan_etsu_transportation_all_lines', 'CC BY 4.0'),
    'gunma_bus': ('群馬バス', '株式会社群馬バス', '群馬県',
                  'gunma_bus_all_lines', 'CC BY 4.0'),
    'gunmachuo': ('群馬中央バス', '群馬中央バス株式会社', '群馬県',
                  'gunmachuo_bus_all_lines', 'CC BY 4.0'),
    'nipponchuo_okutano': ('日本中央バス 奥多野線', '日本中央バス株式会社', '群馬県',
                           'nippon_chuo_bus_okutano_area', 'CC BY 4.0'),
    'joshin_kanko': ('上信観光バス', '株式会社上信観光バス', '群馬県',
                     'joshin_kanko_bus_all_lines', 'CC BY 4.0'),
    'joshin_hire': ('上信ハイヤー', '上信ハイヤー株式会社', '群馬県',
                    'joshin_hire_all_lines', 'CC BY 4.0'),
    'midori_city': ('みどり市路線バス', 'みどり市', '群馬県',
                    'midori_city_all_lines', 'CC BY 4.0'),
    'yoshii': ('よしいバス', '高崎市', '群馬県', 'takasaki_city_yosiibus', 'CC BY 4.0'),
    'nagoya_srt': ('名古屋市 SRT', '名古屋市住宅都市局', '愛知県',
                   'nagoya_housing_city_planning_bureau_nagoya_srt_all_lines', 'CC BY 4.0'),
    'akaiwa': ('赤磐市広域路線バス・市民バス', '赤磐市', '岡山県',
               'akaiwa_city_all_lines', 'CC0 1.0'),
    'olive_bus': ('小豆島オリーブバス', '小豆島オリーブバス株式会社', '香川県',
                  'shodoshima_olive_bus_all_lines', 'CC BY 4.0'),
    'bunkyo_bguru': ('文京区 B-ぐる', '日立自動車交通株式会社', '東京都',
                     'hitachi_automobile_transportation_all_lines', 'CC BY 4.0'),
    'chiyoda_kazaguruma': ('千代田区 風ぐるま', '日立自動車交通株式会社', '東京都',
                           'hitachi_automobile_transportation_chiyoda_alllines', 'CC BY 4.0'),
    'kita_kbus': ('北区 Kバス', '日立自動車交通株式会社', '東京都',
                  'hitachi_automobile_transportation_kita_all_lines', 'CC BY 4.0'),
    'taito_megurin': ('台東区めぐりん', '台東区', '東京都',
                      'tokyo_taito_city_megurin_ccby40', 'CC BY 4.0'),
    'suginami_gsm': ('杉並区グリーンスローモビリティ', '杉並区', '東京都',
                     'tokyo_suginami_city_green_slow_mobility', 'CC BY 4.0'),
    'machida': ('町田市コミュニティバス・市民バス', '町田市', '東京都',
                'machida_city_all_lines', 'CC0 1.0'),
    'inagi_ibus': ('稲城市 iバス', '稲城市', '東京都', 'inagi_city_ibas_a_course', 'CC BY 4.0'),
    'kiyose': ('きよバス', '清瀬市', '東京都', 'kiyose_city_kiyo_bus', 'CC BY 4.0'),
    'kokubunji_bunbus': ('国分寺市ぶんバス', '国分寺市', '東京都',
                         'kokubunji_city_kokubunji_city_bunbus', 'CC BY 4.0'),
    'nishitokyo_hanabus': ('西東京市はなバス', '西東京市', '東京都',
                           'nishitokyo_city_all_lines', 'CC BY 4.0'),
    'higashimurayama_green': ('東村山市グリーンバス', '東村山市', '東京都',
                              'higashi_murayama_city_alllines', 'CC BY 4.0'),
    'higashiyamato_choko': ('東大和市ちょこバス', '東大和市', '東京都',
                            'higashiyamato_city_all_lines_cc0', 'CC0 1.0'),
    'miyake': ('三宅村営バス', '三宅村', '東京都', 'miyake_vill_all_line', 'CC BY 4.0'),
}

ODPT_CKAN = 'https://ckan.odpt.org/ja/dataset/'
RESOURCE_RE = re.compile(
    r'<a class="heading" href="(/ja/dataset/[^"]+/resource/[0-9a-f-]+)"[^>]*title="([^"]*)"')
ODPT_FILE_RE = re.compile(r'href="(https://api-public\.odpt\.org[^"]+)"')


def http(url, timeout=300):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    body = gzip.decompress(body)
                return body
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 + 3 * attempt)


# ---------- カタログ ----------

def catalog_gtfs_data_jp():
    """https://api.gtfs-data.jp/v2/files をそのまま feed spec へ落とす"""
    body = json.loads(http(GTFS_DATA_JP_API))['body']
    out = {}
    today = date.today().isoformat()
    for x in body:
        lic = (x.get('feed_license_id') or '').strip()
        if lic not in LICENSE_OK:
            continue
        if (x.get('file_to_date') or '9999-12-31') < today:
            continue          # 有効期限切れの版は取らない
        key = 'gd_' + re.sub(r'[^a-z0-9]+', '_',
                             f"{x['organization_id']}_{x['feed_id']}".lower()).strip('_')
        if key in GTFS_DATA_JP_SKIP:
            continue
        pref_id = x.get('feed_pref_id') or 0
        out[key] = {
            'name': x['feed_name'],
            'operator': x['organization_name'],
            'url': x['file_url'],
            'catalog': x['feed_page_url'],
            'license': lic,
            'license_url': x.get('feed_license_url') or LICENSE_OK[lic],
            # CC BY の表示義務。gtfs-data.jp は公開主体名がそのまま出典になる
            'attribution': f"{x['organization_name']}・GTFSデータリポジトリ",
            'pref': PREFS[pref_id] if 0 < pref_id < len(PREFS) else '',
            'source': 'gtfs-data.jp',
        }
    return out


def resolve_odpt_url(package):
    """CKAN のパッケージページから「今日以前で最新」のリソースを選び、
    その実ファイル(api-public.odpt.org)の URL を返す。

    ODPT のファイル URL は ?date=YYYYMMDD 付きで、日付なしは 404 になる。
    改正ダイヤが先行公開されるため単純な最新版だと当面走らないデータを掴むので、
    「今日以前で最新」= 現に有効な版 を採る(無ければ最古の将来版)。"""
    page = http(ODPT_CKAN + package).decode('utf-8', 'replace')
    dated = []
    for href, title in RESOURCE_RE.findall(page):
        m = re.search(r'-(\d{8})', title)
        dated.append((m.group(1) if m else '', href))
    if not dated:
        raise ValueError(f'{package}: リソースが見つからない')
    today = date.today().strftime('%Y%m%d')
    past = [d for d in dated if d[0] and d[0] <= today]
    _, href = max(past) if past else min(dated)
    res = http('https://ckan.odpt.org' + href).decode('utf-8', 'replace')
    urls = ODPT_FILE_RE.findall(res)
    if not urls:
        raise ValueError(f'{package}: ダウンロード URL が見つからない')
    return urls[0].replace('&amp;', '&')


def catalog_odpt(prev):
    out = {}
    for key, (name, operator, pref, package, lic) in ODPT_FEEDS.items():
        try:
            url = resolve_odpt_url(package)
        except Exception as e:
            url = (prev.get(key) or {}).get('url')
            if not url:
                print(f'[{key}] URL 解決に失敗: {e}', file=sys.stderr)
                continue
            print(f'[{key}] URL 解決に失敗({e}) — 台帳の URL を使う', file=sys.stderr)
        out[key] = {
            'name': name,
            'operator': operator,
            'url': url,
            'catalog': ODPT_CKAN + package,
            'license': lic,
            'license_url': LICENSE_OK[lic],
            'attribution': f'{operator}・公共交通オープンデータ協議会',
            'pref': pref,
            'source': 'odpt',
        }
        time.sleep(0.2)       # CKAN への礼儀。ここだけレート制限が効く
    return out


# ---------- 取得 ----------

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
    """feed_info.txt からデータ基準日を拾う(台帳・UI表示用)"""
    out = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        if 'feed_info.txt' not in z.namelist():
            return out
        with z.open('feed_info.txt') as f:
            rows = list(csv.DictReader(io.TextIOWrapper(f, 'utf-8-sig')))
        if rows:
            r = rows[0]
            for k in ('feed_version', 'feed_start_date', 'feed_end_date',
                      'feed_publisher_name'):
                out[k] = r.get(k, '')
    return out


def fetch_one(key, spec, out_dir, manifest, force):
    zpath = os.path.join(out_dir, f'{key}.zip')
    prev = manifest.get(key, {})
    try:
        data = http(spec['url'])
    except Exception as e:
        return key, None, f'取得失敗: {e}'
    if len(data) < 200:
        return key, None, f'取得失敗: 応答が {len(data)}B しかない'
    sha = hashlib.sha256(data).hexdigest()
    if not force and prev.get('sha256') == sha and os.path.exists(zpath):
        return key, prev, f'unchanged ({len(data)/1e6:.2f}MB)'
    try:
        info = feed_info(data)
    except Exception as e:
        return key, None, f'zip として読めない: {e}'
    with open(zpath, 'wb') as f:
        f.write(data)
    entry = {k: spec[k] for k in ('name', 'operator', 'url', 'catalog', 'license',
                                  'license_url', 'attribution', 'pref', 'source')}
    entry.update({
        'file': f'{key}.zip',
        'sha256': sha,
        'bytes': len(data),
        'fetched_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    })
    entry.update(info)
    return key, entry, f'saved {len(data)/1e6:.2f}MB feed={entry.get("feed_version", "?")}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(BASE, 'data', 'gtfs'))
    ap.add_argument('--only', action='append', help='フィードキー(複数可)')
    ap.add_argument('--source', action='append',
                    choices=['gtfs-data.jp', 'odpt', 'fixed'],
                    help='カタログを絞る')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--jobs', type=int, default=6)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    mpath = os.path.join(args.out, '_manifest.json')
    manifest = {}
    if os.path.exists(mpath):
        with open(mpath) as f:
            manifest = json.load(f)

    sources = args.source or ['gtfs-data.jp', 'odpt', 'fixed']
    feeds = {}
    if 'fixed' in sources:
        feeds.update({k: dict(v) for k, v in FIXED_FEEDS.items()})
    if 'odpt' in sources:
        print('カタログ: odpt …', flush=True)
        feeds.update(catalog_odpt(manifest))
    if 'gtfs-data.jp' in sources:
        print('カタログ: gtfs-data.jp …', flush=True)
        feeds.update(catalog_gtfs_data_jp())
    print(f'カタログ {len(feeds)} フィード')

    if args.only:
        unknown = [k for k in args.only if k not in feeds]
        if unknown:
            sys.exit(f'unknown feed key(s): {unknown}')
        feeds = {k: feeds[k] for k in args.only}

    failed = {}
    with ThreadPoolExecutor(args.jobs) as ex:
        results = ex.map(lambda kv: fetch_one(kv[0], kv[1], args.out, manifest, args.force),
                         sorted(feeds.items()))
        for i, (key, entry, msg) in enumerate(results):
            if entry is None:
                failed[key] = msg
                print(f'[{key}] !! {msg}', flush=True)
            else:
                manifest[key] = entry
                if i % 25 == 0 or 'saved' in msg:
                    print(f'[{key}] {msg}', flush=True)

    # カタログから消えたフィードは台帳からも落とす(zip は残しても参照されない)
    #
    # ただし今回の実行で引いていないカタログのぶんまで消してはいけない。
    # --source fixed だけを流すと gtfs-data.jp/odpt 由来の576件が「カタログから
    # 消えた」と誤判定されて台帳ごと吹き飛ぶ(実際に踏んだ)。全ソースを引いた
    # ときだけ、台帳の掃除をする。
    if not args.only and not args.source:
        stale = [k for k in manifest if k not in feeds and k not in failed]
        for k in stale:
            del manifest[k]
        if stale:
            print(f'カタログから消えたため台帳から削除: {len(stale)} 件')

    with open(mpath, 'w') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')
    print(f'manifest: {mpath} ({len(manifest)} feeds, 失敗 {len(failed)} 件)')
    if failed:
        for k, v in failed.items():
            print(f'  失敗 {k}: {v}')


if __name__ == '__main__':
    main()
