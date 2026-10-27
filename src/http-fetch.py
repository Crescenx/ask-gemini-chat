import base64
import json
import sys

try:
    from curl_cffi import requests, CurlMime, CurlOpt
except ImportError:
    print(json.dumps({"error": "HTTP_TRANSPORT_UNAVAILABLE"}), flush=True)
    sys.exit(1)

opened = False
try:
    # Node writes UTF-8 bytes regardless of the Windows console code page.
    request = json.load(sys.stdin.buffer)
    multipart = None
    if request.get("uploadFile"):
        file = request["uploadFile"]
        multipart = CurlMime()
        multipart.addpart(name="file", content_type=file["type"], filename=file["name"], local_path=file["path"])
    # libcurl honors the existing proxy environment; certificate checks stay enabled.
    response = requests.request(
        request["method"], request["url"], headers=dict(request["headers"]),
        data=base64.b64decode(request["body"]) or None,
        multipart=multipart,
        impersonate="chrome150", stream=True, timeout=None, allow_redirects=False,
        curl_options={CurlOpt.CONNECTTIMEOUT_MS: 20000},
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
finally:
    if "multipart" in locals() and multipart is not None:
        multipart.close()
