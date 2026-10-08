#!/usr/bin/env python3
"""Restart abnormal collector exits, bounded to avoid an endless crash loop."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

p = argparse.ArgumentParser()
p.add_argument('--root', type=Path, required=True)
a = p.parse_args()
child = None
stopping = False
def stop(*_):
    global stopping
    stopping = True
    if child is not None:
        child.terminate()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
(a.root / 'supervisor.pid').write_text(str(os.getpid()))
for attempt in range(4):
    child = subprocess.Popen([sys.executable, str(Path(__file__).with_name('collector.py')),
                              'run', '--root', str(a.root)])
    code = child.wait()
    if stopping or code == 0:
        subprocess.run([sys.executable, str(Path(__file__).with_name('collector.py')),
                        'export', '--root', str(a.root)], check=True)
        sys.exit(code)
    print(f'Collector exited {code}; restart {attempt + 1}/3', flush=True)
    if attempt < 3:
        for _ in range(15 * (attempt + 1)):
            if stopping:
                sys.exit(code)
            time.sleep(1)
sys.exit(code)
