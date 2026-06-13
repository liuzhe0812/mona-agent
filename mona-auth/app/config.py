from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "mysql+pymysql://mona:mona@127.0.0.1:3306/mona_auth"
    database_pool_size: int = 5

    jwt_access_secret: str = "change-me"
    jwt_access_expire_minutes: int = 60 * 24 * 7  # 7 days

    license_private_key_path: str = "keys/private.pem"
    license_public_key_path: str = "keys/public.pem"
    license_expire_days: int = 7
    trial_days: int = 31
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

    cors_origins: list[str] = []

    @property
    def license_private_key(self) -> str:
        return Path(self.license_private_key_path).read_text()

    @property
    def license_public_key(self) -> str:
        return Path(self.license_public_key_path).read_text()

    model_config = {"env_file": ".env", "env_prefix": "MONA_AUTH_"}


settings = Settings()
