#!/usr/bin/env python3
"""Proxy transparent localhost:1234 -> 192.168.1.10:1234 avec log de chaque requete.
Preuve : si Hermes subagent tape localhost:1234 (provider lmstudio natif), on voit les logs.
"""
import socket, threading, datetime, sys, time

LISTEN, FWD_HOST, FWD_PORT = "127.0.0.1", "192.168.1.10", 1234
LOG = "/home/piloubruce/lmstudio_proxy.log"

def log(msg):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}\n"
    with open(LOG, "a") as f:
        f.write(line)
    print(line, end="")

def pipe(src, dst, tag):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            if tag == "IN":
                # log premier paquet (requete HTTP) pour voir le body/model
                try:
                    head = data.split(b"\r\n\r\n")[0].decode("utf-8", "replace")
                except Exception:
                    head = data[:200].decode("utf-8", "replace")
                log(f"REQ <- {head[:300]}")
            dst.sendall(data)
    except Exception as e:
        pass
    finally:
        try: src.close()
        except: pass
        try: dst.close()
        except: pass

def handle(conn):
    try:
        upstream = socket.create_connection((FWD_HOST, FWD_PORT), timeout=30)
        t1 = threading.Thread(target=pipe, args=(conn, upstream, "IN"), daemon=True)
        t2 = threading.Thread(target=pipe, args=(upstream, conn, "OUT"), daemon=True)
        t1.start(); t2.start()
        t1.join(); t2.join()
    except Exception as e:
        log(f"ERR upstream {e}")
        try: conn.close()
        except: pass

def main():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((LISTEN, 1234))
    s.listen(64)
    log(f"PROXY START listen={LISTEN}:1234 -> {FWD_HOST}:{FWD_PORT}")
    while True:
        conn, addr = s.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()

if __name__ == "__main__":
    main()
