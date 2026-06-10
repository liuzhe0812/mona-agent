import urllib.request
import json

# Check manifest
req = urllib.request.Request('https://mona.lzfun.vip/updates/update.json', headers={'Cache-Control': 'no-cache'})
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())
    print('Manifest:', json.dumps(data, indent=2, ensure_ascii=False))

# Check update package
req2 = urllib.request.Request('https://mona.lzfun.vip/releases/mona-1.0.1.tar.gz', method='HEAD')
try:
    with urllib.request.urlopen(req2) as r:
        cl = r.headers.get('Content-Length', 'unknown')
        print(f'Update package: HTTP {r.status}, Content-Length: {cl}')
except Exception as e:
    print(f'Update package check failed: {e}')

# Check NSIS download
req3 = urllib.request.Request('https://mona.lzfun.vip/releases/Mona-latest.exe', method='HEAD')
try:
    with urllib.request.urlopen(req3) as r:
        cl = r.headers.get('Content-Length', 'unknown')
        print(f'NSIS installer: HTTP {r.status}, Content-Length: {cl}')
except Exception as e:
    print(f'NSIS check failed: {e}')
