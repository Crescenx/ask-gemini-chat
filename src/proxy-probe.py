"""Dependency-free HTTP proxy probe for installations without system curl."""
import json
import sys
import urllib.request
import urllib.error

request = json.load(sys.stdin.buffer)
proxy = request["proxy"]
try:
    if proxy and not proxy.startswith(("http://", "https://")):
        raise ValueError("PROXY_PROBE_UNAVAILABLE")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": proxy} if proxy else {}))
    with opener.open(request["url"], timeout=30) as response:
        print(json.dumps({"status": response.status}))
except Exception as error:
    code = "PROXY_AUTH_REQUIRED" if getattr(error, "code", None) == 407 else "NETWORK_ERROR"
    if isinstance(error, ValueError):
        code = "PROXY_PROBE_UNAVAILABLE"
    print(json.dumps({"error": code}))
