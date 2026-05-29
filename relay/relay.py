"""
SparkP2P Binance Relay Service
Runs locally on a residential IP and forwards Binance SAPI calls from the VPS.
The VPS is geo-blocked by Binance; this machine is not.

Usage:
    python relay.py

Environment:
    RELAY_SECRET   - shared secret that the VPS must include in X-Relay-Secret header
    PORT           - port to listen on (default: 7842)
"""

import os
import logging
import uvicorn
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("relay")

RELAY_SECRET = os.environ.get("RELAY_SECRET", "")
if not RELAY_SECRET:
    raise RuntimeError("RELAY_SECRET environment variable is not set. See relay.env.")

BINANCE_BASE = "https://api.binance.com"

# Only forward to these paths — deny everything else
ALLOWED_PATHS = {
    "/sapi/v1/c2c/ads/listWithPagination",
    "/sapi/v1/c2c/ads/update",
    "/sapi/v1/c2c/ads/updateStatus",
    "/sapi/v1/c2c/ads/getDetailByNo",
}

app = FastAPI(docs_url=None, redoc_url=None)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "sparkp2p-binance-relay"}


@app.api_route("/{path:path}", methods=["POST", "GET"])
async def relay(path: str, request: Request):
    # Auth check
    auth = request.headers.get("X-Relay-Secret", "")
    if auth != RELAY_SECRET:
        logger.warning("Rejected request — bad relay secret (path=/%s)", path)
        raise HTTPException(status_code=403, detail="Invalid relay secret")

    full_path = "/" + path
    if full_path not in ALLOWED_PATHS:
        logger.warning("Rejected request — path not in allowlist: %s", full_path)
        raise HTTPException(status_code=403, detail=f"Path not allowed: {full_path}")

    # Parse incoming request
    query_params = dict(request.query_params)
    try:
        body = await request.json()
    except Exception:
        body = None

    # Forward headers to Binance — strip relay-specific and hop-by-hop headers
    skip = {"host", "x-relay-secret", "content-length", "transfer-encoding", "connection"}
    forward_headers = {k: v for k, v in request.headers.items() if k.lower() not in skip}

    logger.info("Forwarding %s %s  params=%s  body=%s", request.method, full_path, list(query_params.keys()), list((body or {}).keys()))

    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.request(
                method=request.method,
                url=f"{BINANCE_BASE}{full_path}",
                params=query_params,
                json=body,
                headers=forward_headers,
            )
        logger.info("Binance responded HTTP %d for %s", r.status_code, full_path)
        return JSONResponse(content=r.json(), status_code=r.status_code)
    except httpx.TimeoutException:
        logger.error("Timeout calling Binance for %s", full_path)
        raise HTTPException(status_code=504, detail="Binance request timed out")
    except Exception as e:
        logger.error("Error forwarding to Binance: %s", e)
        raise HTTPException(status_code=502, detail=f"Relay error: {e}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7842))
    logger.info("Starting SparkP2P Binance relay on port %d", port)
    uvicorn.run(app, host="127.0.0.1", port=port)
