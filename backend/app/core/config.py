from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # App
    APP_NAME: str = "SparkP2P"
    DEBUG: bool = False

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://postgres:password@localhost:5432/autop2p"

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # JWT Auth
    SECRET_KEY: str = "change-this-secret-key"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24 hours

    # M-Pesa Daraja
    MPESA_CONSUMER_KEY: str = ""
    MPESA_CONSUMER_SECRET: str = ""
    MPESA_SHORTCODE: str = ""
    MPESA_PASSKEY: str = ""
    MPESA_INITIATOR_NAME: str = ""
    MPESA_INITIATOR_PASSWORD: str = ""
    MPESA_SECURITY_CREDENTIAL: str = ""
    MPESA_ENV: str = "sandbox"  # sandbox or production
    MPESA_CALLBACK_BASE_URL: str = "https://yourdomain.com"

    # Binance
    BINANCE_DEFAULT_USER_AGENT: str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    # Claude AI
    ANTHROPIC_API_KEY: str = ""

    # Platform
    PLATFORM_NAME: str = "SparkP2P"
    PLATFORM_FEE_PER_TRADE: int = 15  # KES per trade
    MAX_AUTO_RELEASE_AMOUNT: int = 500000  # KES - flag above this

    # Brevo Email
    BREVO_API_KEY: str = ""
    BREVO_FROM_EMAIL: str = "noreply@sparkp2p.com"
    BREVO_FROM_NAME: str = "SparkP2P"

    # Advanta SMS
    ADVANTA_API_KEY: str = ""
    ADVANTA_PARTNER_ID: str = ""
    ADVANTA_SHORTCODE: str = "SparkAI"

    # Admin
    ADMIN_PASSWORD: str = "SparkAdmin2026"

    # Encryption key for storing sensitive data (Binance cookies, 2FA secrets)
    ENCRYPTION_KEY: str = "change-this-encryption-key"

    @property
    def mpesa_base_url(self) -> str:
        if self.MPESA_ENV == "production":
            return "https://api.safaricom.co.ke"
        return "https://sandbox.safaricom.co.ke"

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
