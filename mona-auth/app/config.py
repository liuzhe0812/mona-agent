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
    alipay_notify_url: str = "https://mona.lzfun.vip/payment/alipay/notify"
    alipay_return_url: str = "https://mona.lzfun.vip/payment/return"
    alipay_sandbox: bool = False
    # 周期扣款签约时使用的签约协议号前缀（用于在支付宝后台对账）
    alipay_sign_scene: str = "INDUSTRY|MEMBERSHIP"

    cors_origins: list[str] = []

    upload_dir: str = "/var/www/mona/uploads"
    upload_url_base: str = "https://mona.lzfun.vip/uploads"

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
