"""Step-by-step check of the Copernicus connection, for finding out why a fetch fails.

Run from the repository root:

    python scripts/check_copernicus.py

It reads COPERNICUS_CLIENT_ID and COPERNICUS_CLIENT_SECRET from api/.env (or the
environment) and never prints them or the access token. It uses only the Python
standard library and `requests`, which the API already needs.

Steps, in order:
  (a) DNS lookup, IPv4 and IPv6 results shown separately
  (b) raw TCP connect on port 443, once per address family
  (c) TLS handshake, checked against the certifi bundle that requests uses and
      against the operating system's certificate store
  (d) OAuth token request, exactly as the API sends it
  (e) a tiny Process API request (64 x 64 px, about 500 m square) whose image is discarded

Every step runs, so you see the whole picture. The summary names the first
failing step and its likely cause. Exit code 0 when every step passes, 1 otherwise.
"""

from __future__ import annotations

import math
import os
import socket
import ssl
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

try:
    import certifi
    import requests
except ImportError as exc:  # pragma: no cover - a dependency is missing
    sys.exit(f"Missing package ({exc.name}). Run: pip install -r api/requirements.txt")

IDENTITY_HOST = "identity.dataspace.copernicus.eu"
PROCESS_HOST = "sh.dataspace.copernicus.eu"
TOKEN_URL = f"https://{IDENTITY_HOST}/auth/realms/CDSE/protocol/openid-connect/token"
PROCESS_URL = f"https://{PROCESS_HOST}/api/v1/process"
WGS84 = "http://www.opengis.net/def/crs/EPSG/0/4326"
EVALSCRIPT = """//VERSION=3
function setup() {
  return { input: ["B02", "B04", "B03"], output: { bands: 3 } };
}
function evaluatePixel(sample) {
  return [sample.B04 * 2.5, sample.B03 * 2.5, sample.B02 * 2.5];
}
"""
PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]

results: list[dict] = []  # {"step", "ok", "text", "cause"}
secrets: list[str] = []   # values to scrub from any printed text


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def report(step: str, ok: bool, text: str, cause: str = "") -> None:
    for secret in secrets:
        text = text.replace(secret, "<hidden>")
    print(f"{'PASS' if ok else 'FAIL'}  {step}: {text}")
    results.append({"step": step, "ok": ok, "text": text, "cause": cause})


def ms_since(start: float) -> str:
    return f"{(time.perf_counter() - start) * 1000:.0f} ms"


def resolve(host: str) -> tuple[list[str], list[str]]:
    ipv4, ipv6 = [], []
    for family, _, _, _, sockaddr in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM):
        address = sockaddr[0]
        bucket = ipv6 if family == socket.AF_INET6 else ipv4
        if address not in bucket:
            bucket.append(address)
    return ipv4, ipv6


def step_dns(hosts: list[str]) -> dict[str, tuple[list[str], list[str]]]:
    found: dict[str, tuple[list[str], list[str]]] = {}
    for host in hosts:
        start = time.perf_counter()
        try:
            ipv4, ipv6 = resolve(host)
        except OSError as exc:
            report(f"(a) DNS {host}", False, f"{exc.__class__.__name__} after {ms_since(start)}",
                   "DNS: the name does not resolve. Check the network, the DNS server, or a filter that blocks the name.")
            continue
        found[host] = (ipv4, ipv6)
        text = (f"IPv4 {', '.join(ipv4) or 'none'} | IPv6 {', '.join(ipv6) or 'none'} "
                f"({ms_since(start)})")
        report(f"(a) DNS {host}", bool(ipv4 or ipv6), text,
               "DNS: no addresses were returned.")
    return found


def tcp_connect(address: str, family: int, timeout: float = 10.0) -> None:
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect((address, 443) if family == socket.AF_INET else (address, 443, 0, 0))


def step_tcp(host: str, addresses: tuple[list[str], list[str]]) -> None:
    for label, family, group in (("IPv4", socket.AF_INET, addresses[0]), ("IPv6", socket.AF_INET6, addresses[1])):
        if not group:
            continue
        start = time.perf_counter()
        try:
            tcp_connect(group[0], family)
        except OSError as exc:
            cause = (f"TCP: port 443 over {label} failed. This is the network path (firewall, filter, Wi-Fi). "
                     "If IPv6 fails and IPv4 works, set COPERNICUS_FORCE_IPV4=true.")
            report(f"(b) TCP {label} {host}:443", False,
                   f"{exc.__class__.__name__} after {ms_since(start)}", cause)
        else:
            report(f"(b) TCP {label} {host}:443", True, f"connected ({ms_since(start)})")


def tls_handshake(host: str, cafile: str | None) -> None:
    context = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
    with socket.create_connection((host, 443), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname=host):
            pass


def step_tls(host: str) -> None:
    start = time.perf_counter()
    try:
        tls_handshake(host, certifi.where())
    except ssl.SSLCertVerificationError as exc:
        error_name = exc.__class__.__name__
    except (ssl.SSLError, OSError) as exc:
        # the connection ended or was reset during the handshake: not a certificate problem
        report(f"(c) TLS {host}", False, f"{exc.__class__.__name__} after {ms_since(start)}",
               "TLS: the connection was closed or reset during the secure handshake. A filter, proxy or "
               "antivirus may be interfering, or the link dropped. Retry; if it persists, try another network.")
        return
    else:
        report(f"(c) TLS {host}", True, f"certificate accepted by the certifi bundle ({ms_since(start)})")
        return

    # the certificate was rejected: would the operating system's store accept it?
    try:
        tls_handshake(host, None)
    except OSError:
        system_ok = False
    else:
        system_ok = True
    if system_ok:
        cause = ("TLS: the Windows certificate store trusts this certificate, but the bundle requests uses does not. "
                 "A proxy or antivirus is re-signing HTTPS. Export its root certificate as PEM and set "
                 "COPERNICUS_CA_BUNDLE to that file.")
    else:
        cause = "TLS: no certificate store accepts this certificate. Check the system clock and the network."
    report(f"(c) TLS {host}", False, f"{error_name} with the certifi bundle", cause)


def proxy_names() -> list[str]:
    names = []
    for name in PROXY_NAMES:
        for variant in (name, name.lower()):
            if os.environ.get(variant):
                names.append(variant)
                break
    return names


def step_token(client_id: str, client_secret: str, verify) -> str | None:
    start = time.perf_counter()
    try:
        response = requests.post(
            TOKEN_URL,
            data={"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret},
            headers={"Connection": "close"},
            timeout=(15, 45),
            verify=verify,
        )
    except requests.exceptions.SSLError as exc:
        report("(d) token request", False, f"{exc.__class__.__name__} after {ms_since(start)}",
               "TLS: requests could not verify the certificate. See step (c) and COPERNICUS_CA_BUNDLE.")
        return None
    except requests.RequestException as exc:
        if exc.__class__.__name__ == "ProxyError":
            cause = ("Proxy: the app sends HTTPS through the proxy from HTTP(S)_PROXY or the Windows proxy setting, "
                     "and that proxy refused or failed. Steps (b) and (c) connect directly, so they can pass. "
                     "Check the proxy address, or add the Copernicus hosts to NO_PROXY.")
        else:
            cause = ("Network: the sign-in connection failed after DNS, TCP and TLS. The link drops or a filter "
                     "resets connections. Try another network, or a wired connection.")
        report("(d) token request", False, f"{exc.__class__.__name__} after {ms_since(start)}", cause)
        return None
    if response.status_code == 200:
        try:
            token = response.json().get("access_token")
        except ValueError:
            token = None
        if token:
            secrets.append(token)
            report("(d) token request", True, f"HTTP 200, token received ({ms_since(start)}); value not shown")
            return token
        report("(d) token request", False, "HTTP 200 without an access_token",
               "Credentials: the identity service answered without a token. Check the client settings.")
        return None
    error = ""
    try:
        error = str(response.json().get("error", ""))[:60]
    except (ValueError, AttributeError):
        pass
    if response.status_code in (400, 401, 403):
        cause = ("Credentials: Copernicus rejected the client ID or secret. Check COPERNICUS_CLIENT_ID and "
                 "COPERNICUS_CLIENT_SECRET in api/.env (no quotes or spaces) and that the client is active.")
    else:
        cause = "API error: the identity service answered with an unexpected status. Try again later."
    report("(d) token request", False,
           f"HTTP {response.status_code}{' (' + error + ')' if error else ''} ({ms_since(start)})", cause)
    return None


def step_process(token: str, verify) -> None:
    today = date.today()
    # a 500 m square around 33.7 N, 73.0 E (about 0.00225 deg north, 0.0027 deg east)
    half_lat = 0.25 / 111.32
    half_lon = 0.25 / (111.32 * math.cos(math.radians(33.7)))
    bbox = [73.0 - half_lon, 33.7 - half_lat, 73.0 + half_lon, 33.7 + half_lat]
    payload = {
        "input": {
            "bounds": {"bbox": bbox, "properties": {"crs": WGS84}},
            "data": [{
                "type": "sentinel-2-l2a",
                "dataFilter": {
                    "timeRange": {"from": f"{today - timedelta(days=60)}T00:00:00Z",
                                  "to": f"{today}T00:00:00Z"},
                    "mosaickingOrder": "leastCC",
                },
            }],
        },
        "output": {"width": 64, "height": 64,
                   "responses": [{"identifier": "default", "format": {"type": "image/png"}}]},
        "evalscript": EVALSCRIPT,
    }
    start = time.perf_counter()
    try:
        response = requests.post(
            PROCESS_URL,
            json=payload,
            headers={"Authorization": f"Bearer {token}", "Connection": "close"},
            timeout=(15, 45),
            verify=verify,
        )
    except requests.RequestException as exc:
        report("(e) process request", False, f"{exc.__class__.__name__} after {ms_since(start)}",
               "Network: the imagery connection failed after the sign-in succeeded. Try again on another network.")
        return
    if response.status_code == 200 and response.content[:4] == b"\x89PNG":
        report("(e) process request", True,
               f"HTTP 200, {len(response.content)} bytes of PNG ({ms_since(start)}); image discarded")
        return
    reason = ""
    try:
        body = response.json()
        message = body.get("message") or (body.get("error") or {}).get("message") if isinstance(body, dict) else ""
        reason = str(message or "")[:200]
    except (ValueError, AttributeError):
        pass
    if response.status_code in (401, 403):
        cause = ("API error: the token was accepted for sign-in but the imagery request was refused. Check the "
                 "client's Sentinel Hub access and quota in the Copernicus dashboard.")
    else:
        cause = f"API error: the Process API refused the request (HTTP {response.status_code}). Reason: {reason or 'none given'}"
    report("(e) process request", False, f"HTTP {response.status_code} ({ms_since(start)})", cause)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    env_values = load_env_file(root / "api" / ".env")

    def setting(name: str) -> str:
        return (env_values.get(name) or os.environ.get(name) or "").strip()

    client_id = setting("COPERNICUS_CLIENT_ID")
    client_secret = setting("COPERNICUS_CLIENT_SECRET")
    secrets.extend(v for v in (client_id, client_secret) if v)
    ca_bundle = setting("COPERNICUS_CA_BUNDLE")
    verify = ca_bundle if ca_bundle and Path(ca_bundle).is_file() else True

    print(f"Python {sys.version.split()[0]} on {sys.platform}; requests {requests.__version__}")
    print(f"Credentials in api/.env: ID {'set' if client_id else 'MISSING'}, secret {'set' if client_secret else 'MISSING'}")
    print(f"COPERNICUS_CA_BUNDLE: {'set, used' if verify is not True else 'not set (default certificates)'}")
    print(f"COPERNICUS_FORCE_IPV4: {'true' if setting('COPERNICUS_FORCE_IPV4').lower() in ('1', 'true', 'yes', 'on') else 'false'}")
    names = proxy_names()
    print(f"Proxy environment variables set (names only): {', '.join(names) if names else 'none'}")
    system_proxies = sorted(urllib.request.getproxies().keys())
    print(f"System proxy schemes (from the OS settings): {', '.join(system_proxies) if system_proxies else 'none'}")
    print()

    addresses = step_dns([IDENTITY_HOST, PROCESS_HOST])
    if IDENTITY_HOST in addresses:
        step_tcp(IDENTITY_HOST, addresses[IDENTITY_HOST])
        step_tls(IDENTITY_HOST)
    if PROCESS_HOST in addresses:
        step_tcp(PROCESS_HOST, addresses[PROCESS_HOST])

    if not (client_id and client_secret):
        report("(d) token request", False, "not run: credentials are missing from api/.env",
               "Credentials: set COPERNICUS_CLIENT_ID and COPERNICUS_CLIENT_SECRET in api/.env.")
    else:
        token = step_token(client_id, client_secret, verify)
        if token:
            step_process(token, verify)

    failed = [r for r in results if not r["ok"]]
    print()
    if not failed:
        print("SUMMARY: every step passed. If the app still fails, check the API log and that it reads this api/.env.")
        return 0
    first = failed[0]
    print(f"SUMMARY: first failing step is {first['step']}.")
    print(f"Likely cause: {first['cause']}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
