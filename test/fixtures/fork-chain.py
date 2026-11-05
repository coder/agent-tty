# Each process forks its successor and ends after DELAY seconds, so a scan of
# /proc almost never shows a live one. Every 50th process writes the time to
# BEAT, so the chain shows that it still runs. It ignores SIGHUP and ends by
# itself after LIMIT seconds.
import os
import signal
import sys
import time

signal.signal(signal.SIGHUP, signal.SIG_IGN)
limit, delay, beat = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
start = time.monotonic()
count = 0
while time.monotonic() - start < limit:
    time.sleep(delay)
    count += 1
    if count % 50 == 0:
        with open(beat, 'w') as file:
            file.write(str(time.time()))
    if os.fork() > 0:
        os._exit(0)
