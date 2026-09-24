"""Linux PTY transport. Only the gateway's authenticated terminal manager invokes this."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(**event):
    print(json.dumps(event), flush=True)


child, master = pty.fork()
if child == 0:
    os.execve('/bin/bash', ['bash', '--noprofile', '--norc', '-i'], os.environ)


def cleanup(*_):
    # Capture descendants before killing their parents (including background jobs).
    pending, descendants = [child], []
    while pending:
        pid = pending.pop()
        descendants.append(pid)
        try:
            with open(f'/proc/{pid}/task/{pid}/children') as source:
                pending.extend(int(value) for value in source.read().split())
        except (OSError, ValueError):
            pass
    for pid in reversed(descendants):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
incoming = b''
os.set_blocking(master, False)
outgoing = b''
emit(type='ready')
try:
    while True:
        readers, writers, _ = select.select([master, sys.stdin.buffer], [master] if outgoing else [], [], 1)
        if master in writers:
            try:
                count = os.write(master, outgoing)
                outgoing = outgoing[count:]
            except BlockingIOError:
                pass
        if master in readers:
            try:
                chunk = os.read(master, 16384)
            except OSError:
                break
            if not chunk:
                break
            emit(type='output', data=base64.b64encode(chunk).decode('ascii'))
        if sys.stdin.buffer in readers:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            incoming += chunk
            if len(incoming) > 262144:
                raise ValueError('input transport limit exceeded')
            while b'\n' in incoming:
                line, incoming = incoming.split(b'\n', 1)
                event = json.loads(line)
                if event['type'] == 'input':
                    outgoing += base64.b64decode(event['data'], validate=True)
                    if len(outgoing) > 262144:
                        raise ValueError('terminal input backlog exceeded')
                elif event['type'] == 'resize':
                    size = struct.pack('HHHH', event['rows'], event['cols'], 0, 0)
                    fcntl.ioctl(master, termios.TIOCSWINSZ, size)
finally:
    cleanup()
    os.close(master)
    try:
        _, status = os.waitpid(child, 0)
        emit(type='exit', code=os.waitstatus_to_exitcode(status))
    except ChildProcessError:
        emit(type='exit', code=None)
