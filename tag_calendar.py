#!/usr/bin/env python3
"""tag_calendar.py — daytype_keys.json(土/休の運転列車キー)で trains.json に運転日 cal を付与。
bit0=平日(1) bit1=土曜 bit2=休日。

突合は安定キー(tx先頭=路線群 + tx末尾=列車番号)で行う。ekitanの内部tx中間IDは
日次で変わるためフルtxでは一致しない。

【突合キーの限界と、路線単位のフォールバック】

「列車番号は安定」という前提は武蔵野線266本で確認したものだが、全国では成り立たない。
実際の一致率は 66% しかなく、外れ方には2種類ある:

  (A) 再スクレイプが届かなかった路線 — 路線群IDごと sat/sun 集合に現れない
      (ＪＲ中央本線, 東京メトロ副都心線, 東京メトロ有楽町線 など17路線)
  (B) 路線群は届いているのに列車番号が日種別で振り直される路線 — 一致 0本
      東京メトロ銀座線の列車番号は平日 HGA501 / HGB549 のように日種別が
      番号自体に埋まっているので、平日の番号は土休の時刻表に絶対に現れない
      (銀座線, 日比谷線, 半蔵門線, 南北線, 札幌市営地下鉄東西線 など19路線)

どちらも「その路線について土休の情報が1件も無い」状態なのに、素朴に cal=1 を
振ると **土日はその路線が丸ごと消える**。銀座線・日比谷線が土日に使えず、
渋谷→浅草 が 33分/¥359 から 41分/¥521 の山手線+TX迂回に化けていた。

証拠が無いことを「運転しない」と読むのは安全側ではない。make_trains_v3.py が
未タグを 7(毎日) にしているのと揃えて、**土休の証拠が1件も無い路線は全便を
毎日運転として残す**。証拠がある路線ではこれまで通り cal=1 を信じる
(通勤ライナー等、実際に平日限定の列車を土日に出さないため)。

バスは gtfs_to_trains.py が GTFS の calendar から正しい運転日を作るのでここでは触らない。
"""
import json, os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))


def key(tx):
    p = tx.split('-')
    return p[0] + '|' + p[-1] if len(p) >= 2 else tx


dt = json.load(open(os.path.join(BASE, 'daytype_keys.json')))
sat = set(dt['sat'])
sun = set(dt['sun'])

data = json.load(open(os.path.join(BASE, 'trains.json')))
trains = data['trains']

# 1回目: 素の突合
for t in trains:
    k = key(t['tx'])
    cal = 1                      # 平日(既存データ=平日)
    if k in sat:
        cal |= 2
    if k in sun:
        cal |= 4
    t['cal'] = cal

# 2回目: 路線ごとに土休の証拠があるかを数え、1件も無い路線は毎日運転に戻す
weekend_hits = defaultdict(int)
line_total = defaultdict(int)
for t in trains:
    line_total[t['line']] += 1
    if t['cal'] & 6:
        weekend_hits[t['line']] += 1

no_evidence = {L for L in line_total if weekend_hits[L] == 0}
restored = 0
for t in trains:
    if t['line'] in no_evidence:
        t['cal'] = 7
        restored += 1

hist = {}
for t in trains:
    hist[t['cal']] = hist.get(t['cal'], 0) + 1

data.setdefault('stats', {})['calendar'] = hist
json.dump(data, open(os.path.join(BASE, 'trains.json'), 'w'), ensure_ascii=False, separators=(',', ':'))

names = {1: '平日のみ', 3: '平日+土', 5: '平日+休', 7: '毎日', 2: '土のみ', 4: '休のみ', 6: '土休のみ'}
print('運転日タグ付け完了:')
for kk in sorted(hist):
    print(f'  cal={kk} ({names.get(kk, "?")}): {hist[kk]}本')
print(f'\n土休の証拠が1件も無い路線: {len(no_evidence)}路線 / {restored}本を毎日運転に戻した')
for L in sorted(no_evidence, key=lambda x: -line_total[x])[:20]:
    print(f'  {L} ({line_total[L]}本)')
wd_only = hist.get(1, 0)
print(f'\n平日のみ率: {100*wd_only//len(trains)}% (低いほど良い。高すぎるとカバレッジ不足)')
print('※ 一致率そのものが低い路線(千代田線10% / 東西線13% 等)は上のフォールバックでは救えない。')
print('  土休ダイヤを「フラグ」ではなく別の時刻表として取り込む必要がある。')
