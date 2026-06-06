#!/usr/bin/env python3
"""gapfill第2弾 runner (Pixel5用): Stage A+B のみ実行。

- dnsshim: Tailscaleで壊れたDNSをDoHで回避
- known_txs2.json (ローカルtrains.jsonの全tx) を train_data のerror印として
  注入し、収集済み列車の再取得を防ぐ
- Stage C (trains.jsonマージ) は母艦側で実行するためここではやらない
"""
import json
import os

import dnsshim  # noqa: F401  (must be first: patches socket.getaddrinfo)
import gapfill_trains as g

BASE = os.path.dirname(os.path.abspath(__file__))


def main():
    state = g.load_state()
    with open(os.path.join(BASE, 'known_txs2.json')) as f:
        known = json.load(f)
    injected = 0
    for tx in known:
        if tx not in state['train_data']:
            state['train_data'][tx] = {'error': True, 'known': True}
            injected += 1
    print(f"known tx injected: {injected}")
    g.stage_a(state)
    g.stage_b(state)
    print("=== A+B complete. fetch gapfill_state.json back to mothership for stage C ===")


if __name__ == '__main__':
    main()
