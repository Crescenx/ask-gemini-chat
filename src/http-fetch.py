import base64
import json
import sys
import time

started_at = time.monotonic()
stage = "bootstrap"


def failure(error, code="HTTP_TRANSPORT_ERROR"):
    # Exception messages and tracebacks may contain URLs, paths or credentials.
    cause = {"error": code, "python_exception": type(error).__name__,
             "elapsed_ms": round((time.monotonic() - started_at) * 1000, 3), "stage": stage}
    curl_code = getattr(error, "code", 0)
    if isinstance(curl_code, int) and curl_code > 0:
        cause["curl_code"] = curl_code
    response = getattr(error, "response", None)
    if response is not None and "CurlInfo" in globals():
        status = response.infos.get(CurlInfo.HTTP_CONNECTCODE, 0)
        if isinstance(status, int) and status > 0:
            cause["proxy_status"] = status
    return cause

try:
    from curl_cffi import requests, CurlMime, CurlOpt, CurlInfo
except Exception as error:
    print(json.dumps(failure(error, "HTTP_TRANSPORT_UNAVAILABLE")), flush=True)
    sys.exit(1)

opened = False
try:
    # Node writes UTF-8 bytes regardless of the Windows console code page.
    stage = "input"
    request = json.load(sys.stdin.buffer)
    multipart = None
    if request.get("uploadFile"):
        file = request["uploadFile"]
        multipart = CurlMime()
        multipart.addpart(name="file", content_type=file["type"], filename=file["name"], local_path=file["path"])
    options = {CurlOpt.CONNECTTIMEOUT_MS: 20000}
    if "proxy" in request:
        options[CurlOpt.PROXY] = request["proxy"] or ""
        options[CurlOpt.NOPROXY] = ""
    # Explicit routes override stale environment proxies and bypass rules.
    client = requests.Session(curl_options=options, curl_infos=[CurlInfo.HTTP_CONNECTCODE])
    stage = "request"
    response = client.request(
        request["method"], request["url"], headers=dict(request["headers"]),
        data=base64.b64decode(request["body"]) or None,
        multipart=multipart,
        impersonate="chrome150", stream=True, timeout=None, allow_redirects=False,
    )
    headers = [(k, v) for k, v in response.headers.multi_items()
               if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")]
    print(json.dumps({"status": response.status_code, "headers": headers}), flush=True)
    opened = True
    stage = "body"
    for chunk in response.iter_content():
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
except Exception as error:
    cause = failure(error)
    print(json.dumps(cause), file=sys.stderr, flush=True)
    if not opened:
        print(json.dumps(cause), flush=True)
    sys.exit(1)
finally:
    if "client" in locals():
        client.close()
    if "multipart" in locals() and multipart is not None:
        multipart.close()
