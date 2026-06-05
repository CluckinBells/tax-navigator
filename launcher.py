# Локальный запуск «Налогового навигатора».
# Сам находит свободный порт и открывает браузер. Нужен, потому что приложение
# использует ES-модули, а их нельзя грузить с file:// — только через http://.
#
# Защита от «зависания»: если сервер на нужном порту уже запущен (прошлый клик),
# мы НЕ поднимаем второй, а просто открываем браузер на уже работающем.

import http.server
import socketserver
import webbrowser
import threading
import socket
import os
import sys
import time
import urllib.request

os.chdir(os.path.dirname(os.path.abspath(__file__)))

FIXED_PORT = 8124  # один фиксированный порт — чтобы повторные клики не плодили серверы

def is_already_running(port):
    """Уже поднят наш сервер на этом порту? Тогда второй не нужен."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/index.html", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False

URL = f"http://localhost:{FIXED_PORT}/index.html"

# Если сервер уже работает (от прошлого запуска) — просто открываем браузер и выходим.
if is_already_running(FIXED_PORT):
    print("Сервер уже запущен — открываю браузер...")
    webbrowser.open(URL)
    time.sleep(1)
    sys.exit(0)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # тихо, без спама

def open_browser():
    time.sleep(1.0)
    webbrowser.open(URL)

print("=" * 60)
print("  Налоговый навигатор ИП 2026 — локальный запуск")
print("=" * 60)
print()
print(f"  Открываю в браузере: {URL}")
print(f"  Mini App:            http://localhost:{FIXED_PORT}/webapp/index.html")
print()
print("  Не закрывайте это окно, пока пользуетесь сервисом.")
print("  Для остановки — закройте окно или нажмите Ctrl+C.")
print("=" * 60)

threading.Thread(target=open_browser, daemon=True).start()

try:
    # allow_reuse_address — чтобы не падать, если порт только что освободился
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", FIXED_PORT), Handler) as httpd:
        httpd.serve_forever()
except KeyboardInterrupt:
    print("\nОстановлено.")
except OSError as e:
    # Порт занят (сервер уже есть) — просто открываем браузер, не падаем
    print(f"\nПохоже, сервер уже работает. Открываю браузер: {URL}")
    webbrowser.open(URL)
    time.sleep(2)
