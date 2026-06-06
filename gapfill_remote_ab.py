#!/usr/bin/env python3
"""Pixel 5用ランチャー: getaddrinfo(netd)死亡環境向けDNS回避 + Stage A/Bのみ実行。

Pixel 5のTermuxはlibc getaddrinfoが失敗する(直IP・UDP DNSは生きている)ので、
起動時にdigでekitan.comを解決してgetaddrinfoをmonkeypatchする。
SNI/HostヘッダはURLのホスト名のまま維持されるのでHTTPSも問題なし。
"""
import socket
import subprocess
import sys

HOST = 'ekitan.com'
FALLBACK_IP = '106.184.68.70'


def resolve_via_dig(host):
    try:
        out = subprocess.run(['dig', '+short', host, '@8.8.8.8'],
                             capture_output=True, text=True, timeout=10).stdout
        for line in out.split('\n'):
            line = line.strip()
            if line and all(p.isdigit() for p in line.split('.')) and line.count('.') == 3:
                return line
    except Exception:
        pass
    return None


ip = resolve_via_dig(HOST) or FALLBACK_IP
print(f"DNS patch: {HOST} -> {ip}")

_orig_gai = socket.getaddrinfo


def _patched_gai(host, *args, **kwargs):
    if host == HOST:
        host = ip
    return _orig_gai(host, *args, **kwargs)


socket.getaddrinfo = _patched_gai

import gapfill_trains as g  # noqa: E402

state = g.load_state()
g.stage_a(state)
g.stage_b(state)
print("AB_COMPLETE")
