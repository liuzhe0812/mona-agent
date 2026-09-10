from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    environment: str = "development"
    database_url: str = "mysql+pymysql://mona:change-me@127.0.0.1:3306/mona_auth"
    database_pool_size: int = 5
    database_pool_max_overflow: int = 5

    jwt_access_secret: str = "change-me"
    jwt_access_expire_minutes: int = 60 * 24 * 7  # 7 days
    model_access_token_expire_minutes: int = 15
    model_access_enabled: bool = False
    credits_payment_enabled: bool = False
    model_access_max_output_tokens: int = 16_384
    model_access_max_request_bytes: int = 1_000_000
    model_access_max_user_concurrency: int = 1
    model_access_max_global_concurrency: int = 20
    model_access_reserved_stale_seconds: int = 120
    model_access_running_stale_seconds: int = 900
    one_api_base_url: str = "http://127.0.0.1:13000"
    one_api_health_path: str = "/api/status"
    one_api_token: str = ""
    one_api_admin_token: str = ""
    one_api_database_path: str = "/opt/one-api/one-api.db"

    worker_shared_key: str = ""
    worker_attachment_dir: str = "/var/lib/mona/worker-attachments"
    worker_attachment_max_bytes: int = 100 * 1024 * 1024
    worker_job_lease_seconds: int = 120
    worker_job_max_payload_bytes: int = 64 * 1024
    worker_job_max_result_bytes: int = 512 * 1024

    license_private_key_path: str = "keys/private.pem"
    license_public_key_path: str = "keys/public.pem"
    license_expire_days: int = 7
    trial_days: int = 30
    max_devices_per_user: int = 3

    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""

    password_reset_code_expire_minutes: int = 10

    xhp_app_id: str = ""
    xhp_app_secret: str = ""
    xhp_notify_url: str = ""
    xhp_base_url: str = "https://api.xunhupay.com/payment/do.html"

    # 支付宝官方支付配置
    alipay_app_id: str = ""
    alipay_app_private_key: str = ""  # PEM 格式（可从文件加载或直接配置）
    alipay_app_private_key_path: str = ""  # 若上面为空，从此文件加载
    alipay_public_key: str = ""  # PEM 格式
    alipay_public_key_path: str = ""
    alipay_seller_id: str = ""
    alipay_notify_url: str = "https://mona-ai.cn/payment/alipay/notify"
    alipay_return_url: str = "https://mona-ai.cn/payment/return"
    alipay_sandbox: bool = False
    # 周期扣款签约时使用的签约协议号前缀（用于在支付宝后台对账）
    alipay_sign_scene: str = "INDUSTRY|MEMBERSHIP"

    cors_origins: list[str] = []

    upload_dir: str = "/var/www/mona/uploads"
    upload_url_base: str = "https://mona-ai.cn/uploads"
    expert_catalog_path: str = "/var/www/mona/catalogs/experts/catalog-v1.json"
    runtime_catalog_path: str = "/var/www/mona/catalogs/runtimes/catalog-v1.json"

    @property
    def license_private_key(self) -> str:
        return Path(self.license_private_key_path).read_text()

    @property
    def license_public_key(self) -> str:
        return Path(self.license_public_key_path).read_text()

    @property
    def alipay_app_private_key_pem(self) -> str:
        if self.alipay_app_private_key:
            return self.alipay_app_private_key
        if self.alipay_app_private_key_path:
            return Path(self.alipay_app_private_key_path).read_text()
        return ""

    @property
    def alipay_public_key_pem(self) -> str:
        if self.alipay_public_key:
            return self.alipay_public_key
        if self.alipay_public_key_path:
            return Path(self.alipay_public_key_path).read_text()
        return ""

    model_config = {"env_file": ".env", "env_prefix": "MONA_AUTH_"}


settings = Settings()


def validate_runtime_settings() -> None:
    if settings.model_access_max_output_tokens <= 0:
        raise RuntimeError("model_access_max_output_tokens must be positive")
    if settings.model_access_max_request_bytes <= 0:
        raise RuntimeError("model_access_max_request_bytes must be positive")
    if settings.model_access_max_user_concurrency <= 0:
        raise RuntimeError("model_access_max_user_concurrency must be positive")
    if settings.model_access_max_global_concurrency <= 0:
        raise RuntimeError("model_access_max_global_concurrency must be positive")
    if settings.worker_attachment_max_bytes <= 0:
        raise RuntimeError("worker_attachment_max_bytes must be positive")
    if settings.worker_job_lease_seconds <= 0:
        raise RuntimeError("worker_job_lease_seconds must be positive")
    if settings.worker_job_max_payload_bytes <= 0:
        raise RuntimeError("worker_job_max_payload_bytes must be positive")
    if settings.worker_job_max_result_bytes <= 0:
        raise RuntimeError("worker_job_max_result_bytes must be positive")
    if not settings.one_api_health_path.startswith("/"):
        raise RuntimeError("one_api_health_path must start with /")
    if settings.environment.lower() != "production":
        return
    if len(settings.jwt_access_secret) < 32 or settings.jwt_access_secret == "change-me":
        raise RuntimeError("production JWT secret must contain at least 32 characters")
    if "your_password" in settings.database_url or "change-me@" in settings.database_url:
        raise RuntimeError("production database credentials must be replaced")
    if settings.worker_shared_key and len(settings.worker_shared_key) < 32:
        raise RuntimeError("production worker shared key must contain at least 32 characters")
    if settings.model_access_enabled and len(settings.one_api_token) < 16:
        raise RuntimeError("production managed models require an internal One API token")
    alipay_configured = bool(
        settings.alipay_app_id
        or settings.alipay_app_private_key
        or settings.alipay_app_private_key_path
        or settings.alipay_public_key
        or settings.alipay_public_key_path
    )
    if (settings.credits_payment_enabled or alipay_configured) and not settings.alipay_seller_id:
        raise RuntimeError("production Alipay payments require a seller ID")
    if settings.credits_payment_enabled and not settings.alipay_app_id:
        raise RuntimeError("production credit payments require an Alipay app ID")
    if settings.credits_payment_enabled and not (
        settings.alipay_app_private_key or settings.alipay_app_private_key_path
    ):
        raise RuntimeError("production credit payments require an Alipay private key")
    if settings.credits_payment_enabled and not (
        settings.alipay_public_key or settings.alipay_public_key_path
    ):
        raise RuntimeError("production credit payments require an Alipay public key")
    if settings.credits_payment_enabled and not settings.alipay_notify_url.startswith("https://"):
        raise RuntimeError("production Alipay notifications require HTTPS")


