"""Generate a payment-confirmation receipt image for BUY-order proof uploads.

Choice Bank is API-only (no browser page to screenshot like I&M was), so for the Binance "upload
payment proof" step we render a clean confirmation image from the transaction data and upload that.
Returns a base64-encoded PNG.
"""
import base64
import io
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

_FONT_PATHS = {
    True:  ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    False: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
}


def _font(size: int, bold: bool = False):
    for p in _FONT_PATHS[bold]:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


def generate_receipt(amount: float, payee_name: str, payee_account: str, ref: str,
                     when: datetime = None, method: str = "M-Pesa") -> str:
    """Render a payment-confirmation receipt → base64 PNG string."""
    when = when or datetime.now()
    W, H = 760, 580
    img = Image.new("RGB", (W, H), "#ffffff")
    d = ImageDraw.Draw(img)

    # ── Green success header (M-Pesa-style) ──
    d.rectangle([0, 0, W, 120], fill="#1ba94c")
    # check circle
    d.ellipse([40, 34, 92, 86], outline="#ffffff", width=4)
    d.line([54, 60, 64, 72], fill="#ffffff", width=5)
    d.line([64, 72, 80, 48], fill="#ffffff", width=5)
    d.text((112, 44), "Payment Successful", font=_font(34, True), fill="#ffffff")

    # ── Amount ──
    d.text((40, 150), f"KES {float(amount):,.0f}", font=_font(54, True), fill="#111827")
    d.line([40, 232, W - 40, 232], fill="#e5e7eb", width=2)

    # ── Detail rows ──
    rows = [
        ("To",        payee_name or "—"),
        ("Account",   payee_account or "—"),
        ("Reference", ref or "—"),
        ("Date",      when.strftime("%d %b %Y, %H:%M")),
        ("Method",    method),
        ("Status",    "Completed"),
    ]
    y = 256
    for label, val in rows:
        d.text((40, y), label, font=_font(20), fill="#6b7280")
        d.text((290, y), str(val), font=_font(20, True), fill="#111827")
        y += 44

    d.text((40, H - 50), "Sent via Choice Microfinance Bank · SparkP2P",
           font=_font(15), fill="#9ca3af")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()
