#!/usr/bin/env python3
"""tag_calendar.py — daytype_keys.json(土/休に運転する列車のキー)で trains.json に
運転日 cal を付与する。bit0=平日(1) bit1=土曜(2) bit2=休日(4)。

【なぜ素朴な突合では駄目なのか】

daytype_keys.json は ekitan の駅ページを ?dw=1(土)/?dw=2(休) で引き直し、
そこに現れた列車の「安定キー」= tx先頭(路線群ID+方向) + tx末尾(列車番号) を
集めたもの。旧実装はこのキーが平日ダイヤの列車と一致するかだけを見て、
一致しなければ cal=1(平日のみ) を振っていた。

しかしこの前提 —「列車番号は日種別をまたいで安定」— は武蔵野線で確認しただけで、
全国では成り立たない。実測の一致率は 66% しかなく、外れ方は3種類ある:

  (A) 路線群ごとスクレイプが届いていない (S=∅)         … 53群 3,506本
  (B) 番号体系が日種別で振り直される
      大阪モノレール   平日 1001    / 土休 1001HB   (末尾に日種別サフィクス)
      東葉高速鉄道     平日 B1025S  / 土休 B1025SR
      ＪＲ川越線       平日 1065F   / 土休 1065H    (運用記号が変わる)
      名古屋市営名城線 平日 M1004Z  / 土休 LD1009D  (完全に別体系)
  (C) 番号空間は共通だが割り当てが日種別で違う (武蔵野線: 134本中51本しか共有しない)

(B)(C) では「土休の番号表に無い」ことは「土休に運転しない」の証拠にならない。
それを cal=1 に倒していたので、千代田線10% / 大阪モノレール12% のように
路線の休日便がごっそり消え、土日だけ何時間も待つ経路が最速として出ていた。

【この実装の考え方】

列車番号の一対一突合は諦め、**路線群(=方向)ごとの運転本数**を土休ダイヤの
情報として使う。個々の番号は当てにならなくても「その路線群に土曜は何本走るか」
= |S| は信用できる(全体で ρ=|S|/|平日番号数| の中央値がほぼ 1.0、分布も
0.7〜1.3 に集中しており、実ダイヤの減便率と整合する)。

  1. 群ごとに運転本数比 ρ = |S| / |平日の番号数| を出す
  2. その群の土曜運転本数を n = min(|平日便数|, round(ρ × |平日便数|)) と見積る
  3. 突合できた便は必ず n に含める(通勤ライナー等を弾く手掛かりとして残す)
  4. 足りない分を、発車時刻順に**順位等間隔**で間引いて補う
     — 密な時間帯(ラッシュ)から多く落ちるので、土休ダイヤ＝平日ダイヤの
       ラッシュ増発を削ったもの、という実態に近い形になる
  5. 補充候補では通勤ライナー等の平日限定種別を後回しにする

ρ が信用できない群 — S が空(A)、または ρ が実ダイヤとして低すぎる(< MIN_RHO) —
は「証拠なし」として全便を土休運転に倒す。証拠が無いことを「運転しない」と
読むのは安全側ではない: 銀座線・日比谷線が土日に丸ごと消えて
渋谷→浅草 が 33分/¥359 から 41分/¥521 の迂回に化けていた。
ただしこの場合も通勤ライナー等の平日限定種別だけは cal=1 のまま残す。

MIN_RHO 未満を切り捨てる副作用として、名鉄築港線のように本当に土休が激減する
工場通勤路線は運転本数を過大評価する。ＪＲ東海道本線(京都・神戸線)のような
大動脈が ρ=0.09 と出る(=駅ページのスクレイプが途中で切れている)方の実害が
桁違いに大きいため、この向きに倒している。

根本的には土休ダイヤを「平日ダイヤへのフラグ」ではなく独立した時刻表として
取り込むべきで、それは scrape_daytype_full.py が時刻表本体を保存するように
変える作業になる(issue #10 参照)。

バスは gtfs_to_trains.py が GTFS の calendar から正しい運転日を作るので触らない。
"""
import json
import os
import re
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))

# ρ がこれ未満の群は「スクレイプが途中で切れた」と見なし、証拠なし扱いに倒す。
# 実測の ρ 分布は 0〜0.1 に53群(=S空)、0.65以上に大半が乗る二峰性で、
# 谷にあたる 0.1〜0.65 は33群/約4,400本しかない。
MIN_RHO = 0.5

# 平日限定で運転される種別。土休の運転本数を補充するときに後回しにする。
# 「京王ライナー」「拝島ライナー」「スカイライナー」等は土休も走るので入れない。
WEEKDAY_ONLY_TYPE = re.compile(r'^通勤|^Ｒ通勤|^ホームライナー|ウィング|^らくラク|^臨時|^ライナー$')

DUP_SUFFIX = re.compile(r'_\d+$')
FIRST_NUM = re.compile(r'\d+')


def split_key(tx):
    """tx を (路線群ID+方向, 列車番号) に割る。中間IDは日次で変わるので捨てる。"""
    p = tx.split('-')
    return (p[0], p[-1]) if len(p) >= 2 else (tx, tx)


def core(tail):
    """列車番号の数字部分だけを取る。
    1001HB→1001, B1025SR→1025 のように日種別サフィクス/運用記号の差を吸収する。"""
    t = DUP_SUFFIX.sub('', tail)
    m = FIRST_NUM.search(t)
    return m.group(0) if m else t


def dep_of(t):
    """先発時刻(分)。並べ替え用なので取れなければ末尾に送る。"""
    for s in t['stops']:
        if s.get('d') is not None:
            return s['d']
        if s.get('a') is not None:
            return s['a']
    return 9999


def stride_pick(lst, k):
    """発車時刻順に並んだ lst から k 本を順位等間隔で抜く。
    密な時間帯からより多く落ちるので、時間分布の形を保ったまま減便できる。"""
    if k <= 0:
        return []
    if k >= len(lst):
        return list(lst)
    n = len(lst)
    return [lst[i * n // k] for i in range(k)]


def select_for_day(trains, exact, cores, stats):
    """1路線群ぶんの列車から、その日種別に運転する列車を選んで返す。"""
    matched, rest = [], []
    for t in trains:
        tail = t['_tail']
        (matched if (tail in exact or core(tail) in cores) else rest).append(t)

    n_tails = len({core(t['_tail']) for t in trains})
    rho = (len(cores) / n_tails) if (cores and n_tails) else 0.0

    if not cores:
        kind = 'no-evidence'
    elif rho < MIN_RHO:
        kind = 'low-rho'
    else:
        kind = 'volume'

    if kind == 'volume':
        n = min(len(trains), round(rho * len(trains)))
    else:
        # 証拠なし: 平日限定種別を除く全便を運転扱いにする
        n = max(len(matched),
                sum(1 for t in trains if not WEEKDAY_ONLY_TYPE.search(t.get('type') or '')))

    stats[kind] += len(trains)
    stats['matched'] += len(matched)

    if len(matched) >= n:
        return matched

    need = n - len(matched)
    normal = [t for t in rest if not WEEKDAY_ONLY_TYPE.search(t.get('type') or '')]
    liner = [t for t in rest if WEEKDAY_ONLY_TYPE.search(t.get('type') or '')]
    picked = stride_pick(normal, need)
    if len(picked) < need:
        picked += stride_pick(liner, need - len(picked))
    return matched + picked


def main():
    day_keys = {}
    dt = json.load(open(os.path.join(BASE, 'daytype_keys.json')))
    for day in ('sat', 'sun'):
        exact, cores = defaultdict(set), defaultdict(set)
        for k in dt[day]:
            g, tail = k.split('|', 1)
            exact[g].add(tail)
            cores[g].add(core(tail))
        day_keys[day] = (exact, cores)

    data = json.load(open(os.path.join(BASE, 'trains.json')))
    trains = data['trains']

    groups = defaultdict(list)
    for t in trains:
        g, tail = split_key(t.get('tx') or '')
        t['_tail'] = tail
        t['cal'] = 1                     # 平日(既存データ=平日ダイヤ)
        groups[g].append(t)
    for lst in groups.values():
        lst.sort(key=dep_of)

    stats = {}
    for day, bit in (('sat', 2), ('sun', 4)):
        exact_by, core_by = day_keys[day]
        st = stats[day] = defaultdict(int)
        for g, lst in groups.items():
            for t in select_for_day(lst, exact_by.get(g, set()), core_by.get(g, set()), st):
                t['cal'] |= bit

    hist = defaultdict(int)
    for t in trains:
        del t['_tail']
        hist[t['cal']] += 1
    hist = dict(hist)

    data.setdefault('stats', {})['calendar'] = hist
    json.dump(data, open(os.path.join(BASE, 'trains.json'), 'w'),
              ensure_ascii=False, separators=(',', ':'))

    names = {1: '平日のみ', 3: '平日+土', 5: '平日+休', 7: '毎日'}
    print('運転日タグ付け完了:')
    for k in sorted(hist):
        print(f'  cal={k} ({names.get(k, "?")}): {hist[k]}本')
    n = len(trains)
    for day in ('sat', 'sun'):
        st = stats[day]
        print(f'\n[{day}] 列車番号が直接突合できた便 {st["matched"]}/{n} '
              f'({100*st["matched"]/n:.1f}%)  路線群の内訳:')
        for kind, label in (('volume', '運転本数比を採用'),
                            ('low-rho', f'ρ<{MIN_RHO} で証拠なし扱い'),
                            ('no-evidence', 'スクレイプ未達で証拠なし')):
            print(f'  {label:26s} {st[kind]}本')
    tagged = sum(1 for t in trains if t['cal'] & 4)
    print(f'\n休日タグが付いた列車: {tagged}/{n} ({100*tagged/n:.1f}%)')
    print(f'平日のみ率: {100*hist.get(1, 0)/n:.1f}% '
          '(低いほど良い。高すぎるとカバレッジ不足)')


if __name__ == '__main__':
    main()
