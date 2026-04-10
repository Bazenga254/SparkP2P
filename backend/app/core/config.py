import os
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
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 43200  # 30 days

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

    # I&M Bank Payment Gateway
    IM_BANK_API_URL: str = ""  # e.g., https://api.imbank.com/KEPaymentGatewayService/1.0
    IM_BANK_TOKEN_URL: str = ""  # e.g., https://api.imbank.com/KEOAuthTokenService/1.0/GetToken
    IM_BANK_CHANNEL_ID: str = ""
    IM_BANK_CLIENT_ID: str = ""
    IM_BANK_CLIENT_SECRET: str = ""
    IM_BANK_SENDER_ACCOUNT: str = ""  # SparkP2P's I&M Bank account number
    IM_BANK_SENDER_NAME: str = "SparkP2P"
    IM_BANK_RSA_PUBLIC_KEY: str = ""  # Base64 RSA 2048 public key from I&M

    # Auto-Sweep: M-Pesa Paybill → I&M Bank (triggered on every trader withdrawal)
    # Set IM_SWEEP_PAYBILL to SparkP2P's I&M Bank M-Pesa paybill number (e.g. 400200)
    # Set IM_SWEEP_ACCOUNT to SparkP2P's I&M account number that receives the sweep
    IM_SWEEP_PAYBILL: str = ""   # I&M Bank's M-Pesa paybill for receiving B2B transfers
    IM_SWEEP_ACCOUNT: str = ""   # SparkP2P's I&M Bank account number (credit destination)

    # Binance
    BINANCE_DEFAULT_USER_AGENT: str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    # Claude AI
    ANTHROPIC_API_KEY: str = ""

    # OpenAI
    OPENAI_API_KEY: str = ""

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
    ALLOWED_ADMIN_IPS: str = ""  # Comma-separated IPs, empty = allow all (set in .env)

    # Encryption key for storing sensitive data (Binance cookies, 2FA secrets)
    ENCRYPTION_KEY: str = "change-this-encryption-key"

    @property
    def mpesa_base_url(self) -> str:
        if self.MPESA_ENV == "production":
            return "https://api.safaricom.co.ke"
        return "https://sandbox.safaricom.co.ke"

    class Config:
        env_file = os.environ.get("ENV_FILE", ".env")
        case_sensitive = True


settings = Settings()
