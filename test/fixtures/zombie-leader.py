# The main thread exits while a second thread sleeps, so /proc shows the
# process as a zombie (ps shows Zl) while it still runs.
import ctypes
import signal
import threading
import time

signal.signal(signal.SIGHUP, signal.SIG_IGN)
threading.Thread(target=time.sleep, args=(300,)).start()
ctypes.CDLL(None).pthread_exit(None)
