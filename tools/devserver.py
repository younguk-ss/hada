# 로컬 개발 서버: 캐시를 끈 정적 서버 (ES 모듈이 옛 버전으로 남는 문제 방지)
# 사용: python3 tools/devserver.py [port]
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
