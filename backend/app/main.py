import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.database import init_db
from app.api.routes import mpesa, traders, orders, admin, auth, subscriptions, chat, extension, browser, im_bank, support
from app.services.binance.poller import order_poller
from app.services.message_templates import seed_default_templates


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await init_db()
    await seed_default_templates()
    # Start housekeeping poller (no longer polls Binance directly;
    # the Chrome extension handles all Binance API calls)
    poller_task = asyncio.create_task(order_poller.start())
    yield
    # Shutdown
    order_poller.stop()
    poller_task.cancel()


app = FastAPI(
    title=settings.APP_NAME,
    description="Automated Binance P2P Trading Platform",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API Routes
app.include_router(auth.router, prefix="/api/auth", tags=["Auth"])
app.include_router(traders.router, prefix="/api/traders", tags=["Traders"])
app.include_router(orders.router, prefix="/api/orders", tags=["Orders"])
app.include_router(mpesa.router, prefix="/api/payment", tags=["M-Pesa"])
app.include_router(admin.router, prefix="/api/admin", tags=["Admin"])
app.include_router(subscriptions.router, prefix="/api/subscriptions", tags=["Subscriptions"])
app.include_router(chat.router, prefix="/api/chat", tags=["Chat"])
app.include_router(extension.router, prefix="/api/ext", tags=["Extension"])
app.include_router(browser.router, prefix="/api/browser", tags=["Browser Automation"])
app.include_router(im_bank.router, prefix="/api/im", tags=["I&M Bank"])
app.include_router(support.router, prefix="/api", tags=["Support"])


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": settings.APP_NAME}
