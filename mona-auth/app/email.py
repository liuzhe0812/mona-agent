import smtplib
from email.mime.text import MIMEText

from app.config import settings


def send_email(to: str, subject: str, body: str) -> None:
    if not settings.smtp_host or not settings.smtp_user:
        raise RuntimeError("SMTP not configured")

    msg = MIMEText(body, "html", "utf-8")
    msg["Subject"] = subject
    msg["From"] = settings.smtp_from or settings.smtp_user
    msg["To"] = to

    if settings.smtp_port == 465:
        server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port)
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port)
        server.starttls()

    try:
        server.login(settings.smtp_user, settings.smtp_password)
        server.sendmail(msg["From"], [to], msg.as_string())
    finally:
        server.quit()


def send_reset_code_email(to: str, code: str) -> None:
    subject = "Mona - 验证码"
    body = f"""
    <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;">
        <h2>Mona 密码重置</h2>
        <p>您的验证码是：</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:4px;color:#333;">{code}</p>
        <p style="color:#999;font-size:13px;">验证码 {settings.password_reset_code_expire_minutes} 分钟内有效，如非本人操作请忽略。</p>
    </div>
    """
    send_email(to, subject, body)


def send_register_code_email(to: str, code: str) -> None:
    subject = "Mona - 注册验证码"
    body = f"""
    <div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;">
        <h2>Mona 注册</h2>
        <p>您的注册验证码是：</p>
        <p style="font-size:32px;font-weight:bold;letter-spacing:4px;color:#333;">{code}</p>
        <p style="color:#999;font-size:13px;">验证码 {settings.password_reset_code_expire_minutes} 分钟内有效，如非本人操作请忽略。</p>
    </div>
    """
    send_email(to, subject, body)
