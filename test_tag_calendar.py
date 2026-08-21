#!/usr/bin/env python3
"""test_tag_calendar.py — 運転日タグ付け(tag_calendar.py)の選抜ロジックの回帰テスト。

trains.json を要求しないよう、選抜の中核 select_for_day() だけを直接叩く。
    python3 test_tag_calendar.py
"""
import sys

import tag_calendar as T


def mk(no, dep, type_=''):
    """列車1本。select_for_day が見るのは _tail / type / stops だけ。"""
    return {'_tail': no, 'type': type_, 'stops': [{'a': None, 'd': dep}]}


def run(trains, sat_tails):
    exact = set(sat_tails)
    cores = {T.core(x) for x in sat_tails}
    stats = {'matched': 0, 'volume': 0, 'low-rho': 0, 'no-evidence': 0}
    sel = T.select_for_day(sorted(trains, key=T.dep_of), exact, cores, stats)
    return sel, stats


fail = 0


def check(name, ok, detail=''):
    global fail
    if not ok:
        fail += 1
    print(f'{"✓" if ok else "✗"} {name}{"  " + detail if detail else ""}')


# --- core(): 日種別サフィクス / 運用記号の差を吸収する ---
check('core: 大阪モノレール 1001 / 1001HB', T.core('1001') == T.core('1001HB'), T.core('1001HB'))
check('core: 東葉高速 B1025S / B1025SR', T.core('B1025S') == T.core('B1025SR'), T.core('B1025SR'))
check('core: ＪＲ川越線 1065F / 1065H', T.core('1065F') == T.core('1065H'), T.core('1065H'))
check('core: 重複マーカー 1003E_2', T.core('1003E_2') == '1003', T.core('1003E_2'))
check('core: 別番号は混ざらない', T.core('M1004Z') != T.core('LD1009D'))

# --- stride_pick(): 順位等間隔。密な時間帯から多く落ちる ---
picked = T.stride_pick(list(range(10)), 5)
check('stride_pick: 要求どおりの本数', len(picked) == 5, str(picked))
check('stride_pick: 全部で足りるときは全部返す', T.stride_pick([1, 2, 3], 9) == [1, 2, 3])
check('stride_pick: 0本要求なら空', T.stride_pick([1, 2, 3], 0) == [])
# ラッシュ(8時台に10本) + 日中(毎時1本) を6割に減らす
rush = [mk(f'R{i}', 480 + i) for i in range(10)]
day = [mk(f'D{i}', 600 + 60 * i) for i in range(10)]
kept = T.stride_pick(sorted(rush + day, key=T.dep_of), 12)
n_rush = sum(1 for t in kept if t['_tail'].startswith('R'))
check('stride_pick: ラッシュ側から多く落ちる', n_rush < 10 and n_rush <= 6,
      f'ラッシュ {n_rush}/10本 残 (日中 {12 - n_rush}/10本)')

# --- 本数ベースの割り当て ---
trains = [mk(str(1000 + i), 300 + 10 * i) for i in range(100)]
# 番号体系が日種別で違う(1本も突合しない)が、土曜は80本走ることが分かっている
sel, st = run(trains, [f'HB{9000 + i}' for i in range(80)])
check('番号が全く噛み合わなくても運転本数で埋める', len(sel) == 80, f'{len(sel)}/100本')
check('  そのとき突合は0本', st['matched'] == 0)
check('  路線群は volume 扱い', st['volume'] == 100)

# 突合できた便は必ず残る
sel, st = run(trains, [t['_tail'] for t in trains[:40]] + [f'HB{9000 + i}' for i in range(40)])
check('突合できた便は必ず選ばれる',
      set(t['_tail'] for t in trains[:40]) <= set(t['_tail'] for t in sel),
      f'選抜 {len(sel)}本 / 突合 {st["matched"]}本')

# 土休の証拠が1件も無い路線は全便を運転扱いに戻す(路線ごと土日に消さない)
sel, st = run(trains, [])
check('証拠なしの路線は全便を運転扱い', len(sel) == 100 and st['no-evidence'] == 100,
      f'{len(sel)}/100本')

# ρ が低すぎる(スクレイプが途中で切れた)群も証拠なし扱い
sel, st = run(trains, [t['_tail'] for t in trains[:5]])
check(f'ρ<{T.MIN_RHO} の群は証拠なし扱いに倒す', len(sel) == 100 and st['low-rho'] == 100,
      f'{len(sel)}/100本')

# --- 通勤ライナー等の平日限定種別 ---
liners = [mk(f'L{i}', 420 + i, '通勤快速') for i in range(10)]
sel, st = run(trains + liners, [])
check('証拠なしでも通勤快速は土休に出さない',
      len(sel) == 100 and all(not t['_tail'].startswith('L') for t in sel),
      f'{len(sel)}/110本')

sel, st = run(trains + liners, [f'HB{9000 + i}' for i in range(100)])
check('本数が足りているうちは通勤快速を補充候補にしない',
      all(not t['_tail'].startswith('L') for t in sel), f'{len(sel)}本')

sel, st = run(trains + liners, [f'HB{9000 + i}' for i in range(110)])
check('本数が足りないときだけ最後に通勤快速も使う', len(sel) == 110, f'{len(sel)}/110本')

for name, pat in [('通勤特急', '通勤特急'), ('ホームライナー瑞浪', 'ホームライナー'),
                  ('モーニング・ウィング', 'ウィング'), ('らくラクはりま', 'らくラク')]:
    check(f'平日限定種別と判定: {name}', bool(T.WEEKDAY_ONLY_TYPE.search(name)))
for name in ['京王ライナー', '拝島ライナー', 'スカイライナー', 'マリンライナー', '快速', '普通']:
    check(f'土休も走るので平日限定にしない: {name}', not T.WEEKDAY_ONLY_TYPE.search(name))

print('\n' + ('ALL OK' if not fail else f'{fail} FAILED'))
sys.exit(1 if fail else 0)
