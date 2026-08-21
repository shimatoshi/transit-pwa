#!/usr/bin/env python3
"""graph_v2.json の駅に r(かな読み) を付与し、欠落している e(英字名) を補完する。

Issue #12: e は Wikidata 英語ラベル依存で 2,464/9,901 件欠落、読みがなは皆無。

手順:
  1. wikidata_readings.json (fetch_station_readings.py が生成。P1814かな + 英語
     ラベル + 座標) を正規化名でマッチし、r と e を埋める。同名駅は座標近接
     (約5km) で曖昧性解消。
  2. マッチしなかった駅(バス停含む)は pykakasi で駅名から読みを推定する。
     固有名詞の読み誤りはあり得るが、検索不能よりは良い。
  3. e がまだ無い駅は r からヘボン式ローマ字を生成して埋める。

キーは k が ekitan 駅ID で使用済みのため r (reading) を使う。
"""
import json
import os
import re
import unicodedata
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))

GEO_COMPANY_PREFIXES = (
    '京浜急行電鉄', '東京モノレール', '東京地下鉄', '東京メトロ', '東武鉄道',
    '西武鉄道', '京成電鉄', '京王電鉄', '小田急電鉄', '東急電鉄', '相模鉄道',
)

# --- ヘボン式変換テーブル (ひらがな→ローマ字) ---
_T = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
    'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
    'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
    'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
    'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
    'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
    'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
    'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
    'わ': 'wa', 'ゐ': 'i', 'ゑ': 'e', 'を': 'o',
    'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
    'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
    'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
    'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
    'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
    'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o',
    'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo', 'ゔ': 'vu',
    'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
    'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
    'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
    'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
    'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
    'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
    'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
    'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
    'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
    'ぢゃ': 'ja', 'ぢゅ': 'ju', 'ぢょ': 'jo',
    'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
    'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo',
    'ふぁ': 'fa', 'ふぃ': 'fi', 'ふぇ': 'fe', 'ふぉ': 'fo',
    'てぃ': 'ti', 'でぃ': 'di', 'とぅ': 'tu', 'どぅ': 'du',
    'うぃ': 'wi', 'うぇ': 'we', 'うぉ': 'wo',
    'ゔぁ': 'va', 'ゔぃ': 'vi', 'ゔぇ': 've', 'ゔぉ': 'vo',
    'しぇ': 'she', 'ちぇ': 'che', 'じぇ': 'je',
}


def kata_to_hira(s):
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)


def kana_to_hepburn(kana):
    """ひらがな読み→ヘボン式(長音は英語圏の慣用に合わせ ou/oo/uu を畳む)。"""
    out = []
    i = 0
    n = len(kana)
    while i < n:
        c = kana[i]
        if c == 'っ':
            nxt = None
            for l in (2, 1):
                seg = kana[i + 1:i + 1 + l]
                if seg in _T:
                    nxt = _T[seg]
                    break
            if nxt:
                out.append('t' if nxt.startswith('ch') else nxt[0])
            i += 1
            continue
        if c == 'ん':
            nxt = None
            for l in (2, 1):
                seg = kana[i + 1:i + 1 + l]
                if seg in _T:
                    nxt = _T[seg]
                    break
            out.append('m' if nxt and nxt[0] in 'bmp' else 'n')
            i += 1
            continue
        if c == 'ー':  # 長音記号は直前の母音の伸ばし→畳むので捨てる
            i += 1
            continue
        hit = False
        for l in (2, 1):
            seg = kana[i:i + l]
            if seg in _T:
                out.append(_T[seg])
                i += l
                hit = True
                break
        if not hit:
            out.append(c)  # 数字・記号等はそのまま
            i += 1
    s = ''.join(out)
    s = re.sub(r'ou|oo', 'o', s)
    s = re.sub(r'uu', 'u', s)
    return s[:1].upper() + s[1:] if s else s


def norm(name):
    s = re.sub(r'[（(].*?[)）]$', '', name)
    s = unicodedata.normalize('NFKC', s)
    return s.replace('ヶ', 'ケ').replace('ヵ', 'カ')


def dist2(a, b):
    dla = a[0] - b[0]
    dlo = (a[1] - b[1]) * 0.82
    return dla * dla + dlo * dlo


HAS_KANA = re.compile(r'[ぁ-ゖ]')


def main():
    g2 = json.load(open(os.path.join(BASE, 'graph_v2.json')))
    readings = json.load(open(os.path.join(BASE, 'wikidata_readings.json')))

    # 正規化名 -> [(la, lo, kana, en)]
    cands = defaultdict(list)
    for rec in readings.values():
        ja = rec['ja']
        base = re.sub(r'駅$', '', ja)
        kana = rec.get('kana', '')
        if kana:
            kana = kata_to_hira(unicodedata.normalize('NFKC', kana))
            if ja.endswith('駅') and kana.endswith('えき'):
                kana = kana[:-2]
        en = rec.get('en', '')
        en = re.sub(r'\s+[Ss]tation$', '', en)
        if not re.search(r'[A-Za-z]', en):
            en = ''
        if not kana and not en:
            continue
        row = (rec.get('la'), rec.get('lo'), kana, en)
        names = {norm(base)}
        for pre in GEO_COMPANY_PREFIXES:
            if base.startswith(pre):
                names.add(norm(base[len(pre):]))
        for nm in names:
            cands[nm].append(row)

    st_wd = st_kks = e_wd = e_hep = amb = 0
    kks = None
    for s in g2['stations']:
        cs = cands.get(norm(s['n']))
        best = None
        if cs:
            if len(cs) == 1:
                best = cs[0]
            elif s.get('la') is not None:
                scored = sorted(
                    (dist2((s['la'], s['lo']), (c[0], c[1])), c)
                    for c in cs if c[0] is not None)
                if scored and scored[0][0] < 0.0025:  # ≒5km
                    best = scored[0][1]
            if best is None:
                # 全候補の読みが一致するなら座標が無くても採用できる
                kanas = {c[2] for c in cs if c[2]}
                ens = {c[3] for c in cs if c[3]}
                if len(kanas) <= 1 and len(ens) <= 1:
                    best = (None, None,
                            next(iter(kanas), ''), next(iter(ens), ''))
                else:
                    amb += 1
        if best:
            if best[2] and not s.get('r'):
                s['r'] = best[2]
                st_wd += 1
            if best[3] and not s.get('e'):
                s['e'] = best[3]
                e_wd += 1
        if not s.get('r'):
            # pykakasi フォールバック(読み誤りの可能性あり。無いよりまし)
            if kks is None:
                import pykakasi
                kks = pykakasi.kakasi()
            base_name = re.sub(r'[（(].*?[)）]$', '', s['n'])
            hira = ''.join(w['hira'] for w in kks.convert(base_name))
            hira = kata_to_hira(hira)
            if HAS_KANA.search(hira):
                s['r'] = hira
                st_kks += 1
        if not s.get('e') and s.get('r'):
            s['e'] = kana_to_hepburn(s['r'])
            e_hep += 1

    no_e = sum(1 for s in g2['stations'] if not s.get('e'))
    no_r = sum(1 for s in g2['stations'] if not s.get('r'))
    with open(os.path.join(BASE, 'graph_v2.json'), 'w') as f:
        json.dump(g2, f, ensure_ascii=False, separators=(',', ':'))
    print(f"r: wikidata {st_wd} + pykakasi {st_kks}, "
          f"e: wikidata {e_wd} + hepburn {e_hep}, ambiguous {amb}")
    print(f"残欠落: e={no_e}, r={no_r} / {len(g2['stations'])}")


if __name__ == '__main__':
    main()
