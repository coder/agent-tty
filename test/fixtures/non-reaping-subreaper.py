# Runs the command given as arguments as a child subreaper that never reaps
# the orphans it adopts, as a container's PID 1 without an init does. It
# prints the command's stdout, closes its own, and sleeps until it is killed.
import ctypes
import os
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    sys.exit(f"prctl(PR_SET_CHILD_SUBREAPER) failed: errno {ctypes.get_errno()}")

result = subprocess.run(sys.argv[1:], stdout=subprocess.PIPE, check=False)
sys.stdout.buffer.write(result.stdout)
sys.stdout.flush()
os.close(sys.stdout.fileno())

while True:
    time.sleep(3600)
