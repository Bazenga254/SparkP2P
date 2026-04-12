import ast

target = "/root/SparkP2P/backend/app/api/routes/admin.py"

# Build each line separately to avoid escape sequence issues
lines = []
lines.append("\n\n")
lines.append("@router.get(\"/ip-whitelist\")\n")
lines.append("async def get_ip_whitelist(admin: Trader = Depends(get_admin_trader)):\n")
lines.append("    from app.core.config import settings\n")
lines.append("    raw = settings.ALLOWED_ADMIN_IPS.strip()\n")
lines.append("    ips = [ip.strip() for ip in raw.split(\",\") if ip.strip()] if raw else []\n")
lines.append("    return {\"ips\": ips, \"enabled\": bool(raw)}\n")
lines.append("\n\n")
lines.append("@router.post(\"/ip-whitelist\")\n")
lines.append("async def update_ip_whitelist(request: Request, admin: Trader = Depends(get_admin_trader), db: AsyncSession = Depends(get_db)):\n")
lines.append("    import re as _re, os\n")
lines.append("    body = await request.json()\n")
lines.append("    ips = body.get(\"ips\", [])\n")
lines.append("    ip_re = _re.compile(r\"^(\\d{1,3}\\.){3}\\d{1,3}$\")\n")
lines.append("    for ip in ips:\n")
lines.append("        if not ip_re.match(ip.strip()):\n")
lines.append("            raise HTTPException(status_code=400, detail=\"Invalid IP: \" + ip)\n")
lines.append("    new_value = \",\".join(ip.strip() for ip in ips)\n")
lines.append("    env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), \"../../../../.env\"))\n")
lines.append("    if os.path.exists(env_path):\n")
lines.append("        with open(env_path) as f:\n")
lines.append("            content = f.read()\n")
lines.append("        if \"ALLOWED_ADMIN_IPS=\" in content:\n")
lines.append("            content = _re.sub(r\"ALLOWED_ADMIN_IPS=.*\", \"ALLOWED_ADMIN_IPS=\" + new_value, content)\n")
lines.append("        else:\n")
lines.append("            content = content.rstrip() + chr(10) + \"ALLOWED_ADMIN_IPS=\" + new_value + chr(10)\n")
lines.append("        with open(env_path, \"w\") as f:\n")
lines.append("            f.write(content)\n")
lines.append("    from app.core.config import settings\n")
lines.append("    settings.ALLOWED_ADMIN_IPS = new_value\n")
lines.append("    await write_audit_log(db, admin, \"update_ip_whitelist\", ip_address=get_client_ip(request), detail=\"IP whitelist: \" + (new_value or \"allow all\"))\n")
lines.append("    return {\"status\": \"ok\", \"ips\": ips, \"enabled\": bool(new_value)}\n")

with open(target, "a") as f:
    f.writelines(lines)

with open(target) as f:
    src = f.read()
ast.parse(src)
print("SUCCESS - syntax ok")
