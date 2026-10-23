import base64
import json
import sys

try:
    from curl_cffi import requests
except ImportError:
    print(json.dumps({"error": "HTTP_TRANSPORT_UNAVAILABLE"}), flush=True)
    sys.exit(1)

opened = False
try:
    request = json.load(sys.stdin)
    # libcurl honors the existing proxy environment; certificate checks stay enabled.
    response = requests.request(
        request["method"], request["url"], headers=dict(request["headers"]),
        data=base64.b64decode(request["body"]) or None,
        impersonate="chrome150", stream=True, timeout=(20, 1800), allow_redirects=False,
    )
    headers = [(k, v) for k, v in response.headers.multi_items()
               if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")]
    print(json.dumps({"status": response.status_code, "headers": headers}), flush=True)
    opened = True
    for chunk in response.iter_content():
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
except Exception:
    if not opened:
        print(json.dumps({"error": "HTTP_TRANSPORT_ERROR"}), flush=True)
    sys.exit(1)
