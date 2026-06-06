"""DNS shim for Pixel5 (system resolver is broken by Tailscale).

Monkeypatches socket.getaddrinfo: on resolution failure, falls back to
DNS-over-HTTPS via 1.1.1.1 (IP-literal URL, so no DNS needed for the
resolver itself; TLS cert is valid for 1.1.1.1). Import before anything
that does network I/O.
"""
import json
import socket
import urllib.request

_orig = socket.getaddrinfo
_cache = {}


def _doh_resolve(host):
    if host in _cache:
        return _cache[host]
    req = urllib.request.Request(
        f'https://1.1.1.1/dns-query?name={host}&type=A',
        headers={'Accept': 'application/dns-json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        ans = json.loads(r.read())
    ips = [a['data'] for a in ans.get('Answer', []) if a.get('type') == 1]
    _cache[host] = ips
    return ips


def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    try:
        return _orig(host, port, family, type, proto, flags)
    except socket.gaierror:
        ips = _doh_resolve(host)
        if not ips:
            raise
        res = []
        for ip in ips:
            res.extend(_orig(ip, port, family, type, proto, flags))
        return res


socket.getaddrinfo = getaddrinfo
