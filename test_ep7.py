"""
EP-7 Counterparty Filter Live Test
Usage: python test_ep7.py <api_key> <api_secret>
Flow: EP-4 list ads -> EP-7 push filters -> EP-2 read ad back -> compare
"""
import sys, asyncio, hmac, hashlib, time, json
import httpx

SAPI = "https://api.binance.com"

def _sign(secret, params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return hmac.new(secret.encode(), q.encode(), hashlib.sha256).hexdigest()

def _base():
    return {"timestamp": int(time.time() * 1000), "recvWindow": 60000}

def _headers(api_key):
    return {"X-MBX-APIKEY": api_key, "clientType": "web", "Content-Type": "application/json"}

async def list_ads(key, secret):
    p = _base(); p["signature"] = _sign(secret, p)
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{SAPI}/sapi/v1/c2c/ads/listWithPagination",
                         params=p, json={"page": 1, "rows": 50}, headers=_headers(key))
    print(f"  EP-4 HTTP {r.status_code}")
    data = r.json()
    print(f"  EP-4 raw: {json.dumps(data, indent=2)}")
    raw = data.get("data", [])
    return raw.get("content", []) if isinstance(raw, dict) else raw

async def get_ad_detail(key, secret, adv_no):
    p = _base(); p["signature"] = _sign(secret, p)
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{SAPI}/sapi/v1/c2c/ads/getDetailByNo",
                         params={**p, "adsNo": adv_no}, headers=_headers(key))
    resp = r.json()
    if not resp.get("success"):
        async with httpx.AsyncClient(timeout=15) as c:
            r2 = await c.post(f"{SAPI}/sapi/v1/c2c/ads/getDetailByNo",
                              params=p, json={"adsNo": adv_no}, headers=_headers(key))
        resp = r2.json()
    return resp

async def push_filters(key, secret, adv_no, **kwargs):
    p = _base(); p["signature"] = _sign(secret, p)
    body = {"advNo": adv_no, **kwargs}
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(f"{SAPI}/sapi/v1/c2c/ads/update",
                         params=p, json=body, headers=_headers(key))
    return r.status_code, r.json()

async def main():
    if len(sys.argv) < 3:
        print("Usage: python test_ep7.py <api_key> <api_secret>")
        return

    api_key    = sys.argv[1].strip()
    api_secret = sys.argv[2].strip()

    print("=" * 60)
    print("  EP-7 Counterparty Filter Live Test")
    print("=" * 60)
    print(f"\nAPI Key: {api_key[:8]}...{api_key[-4:]}")

    # Step 1: List ads
    print("\n[1] EP-4 — Listing your ads...")
    ads = await list_ads(api_key, api_secret)
    if not ads:
        print("  No ads returned — check permissions or no active ads.")
        return
    print(f"\n  Found {len(ads)} ad(s):")
    for a in ads:
        print(f"    advNo={a.get('advNo')}  {a.get('asset')}  {a.get('tradeType')}  price={a.get('price')}")

    adv_no = ads[0]["advNo"]
    print(f"\n  Testing with advNo: {adv_no}")

    # Step 2: Read BEFORE
    print("\n[2] EP-2 — Reading ad BEFORE push...")
    before = await get_ad_detail(api_key, api_secret, adv_no)
    ad_b = before.get("data", before)
    print(f"  success={before.get('success')}  code={before.get('code')}")
    print(f"  Full response:\n{json.dumps(before, indent=2)}")

    # Step 3: Push filters
    TEST = {
        "userTradeCompleteRateMin":        0.95,
        "userTradeCompleteRateFilterTime": 2,
        "userAllTradeCountMin":            5,
        "userTradeCountFilterTime":        2,
        "userTradeCompleteCountMin":       3,
        "userBuyTradeCountMin":            0,
        "userSellTradeCountMin":           0,
        "userTradeVolumeMin":              0.0,
        "userTradeVolumeAsset":            "USDT",
        "userTradeVolumeFilterTime":       2,
    }
    print(f"\n[3] EP-7 — Pushing counterparty filters...")
    print(f"  Body: {json.dumps({'advNo': adv_no, **TEST}, indent=4)}")
    status, push_resp = await push_filters(api_key, api_secret, adv_no, **TEST)
    print(f"  HTTP {status}")
    print(f"  Response: {json.dumps(push_resp, indent=2)}")

    # Step 4: Read AFTER
    print("\n[4] EP-2 — Reading ad AFTER push (2s delay)...")
    await asyncio.sleep(2)
    after = await get_ad_detail(api_key, api_secret, adv_no)
    ad_a = after.get("data", after)
    print(f"  success={after.get('success')}  code={after.get('code')}")
    print(f"  Full response:\n{json.dumps(after, indent=2)}")

    # Step 5: Compare
    print("\n[5] Filter field comparison (before -> after):")
    FILTER_KEYS = [
        "userTradeCompleteRateMin", "userTradeCompleteRateFilterTime",
        "userAllTradeCountMin", "userTradeCountFilterTime",
        "userTradeCompleteCountMin", "userBuyTradeCountMin",
        "userSellTradeCountMin", "userTradeVolumeMin",
        "userTradeVolumeAsset", "userTradeVolumeFilterTime",
    ]
    found = False
    for k in FILTER_KEYS:
        bv = ad_b.get(k, "-- missing --")
        av = ad_a.get(k, "-- missing --")
        tag = "CHANGED" if bv != av and bv != "-- missing --" else ("same" if bv != "-- missing --" else "NOT IN EP-2 RESPONSE")
        print(f"  {k:<44} {str(bv):<14} -> {str(av):<14}  {tag}")
        if bv != "-- missing --":
            found = True

    print()
    if found:
        print("Filter fields ARE visible in EP-2 response.")
    else:
        print("Filter fields NOT in EP-2 response.")
        print("If EP-7 returned success above, filters are applied by Binance")
        print("but not exposed back through the ad detail endpoint.")

    new_keys = set(ad_a.keys()) - set(ad_b.keys())
    if new_keys:
        print(f"\nNew keys that appeared after push: {new_keys}")
        for k in new_keys:
            print(f"  {k} = {ad_a[k]!r}")

    print("\n" + "=" * 60)

asyncio.run(main())
