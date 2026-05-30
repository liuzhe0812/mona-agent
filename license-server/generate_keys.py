from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pathlib import Path

KEYS_DIR = Path(__file__).parent / "keys"


def generate_keys():
    KEYS_DIR.mkdir(parents=True, exist_ok=True)

    private_path = KEYS_DIR / "private.pem"
    public_path = KEYS_DIR / "public.pem"

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    private_path.write_bytes(private_pem)
    public_path.write_bytes(public_pem)

    print(f"Private key: {private_path}")
    print(f"Public key:  {public_path}")
    print("Copy public.pem to Mona client: mona/auth/pubkey.pem")


if __name__ == "__main__":
    generate_keys()
