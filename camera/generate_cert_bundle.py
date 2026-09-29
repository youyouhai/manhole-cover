"""Build the ESP32 compact trust bundle from an installed CA PEM collection.

Usage: python generate_cert_bundle.py SOURCE_PEM OUTPUT_BIN
The binary format follows Arduino-ESP32 esp_crt_bundle.c: a 16-bit count,
then sorted (subject DER length, SPKI DER length, subject DER, SPKI DER) entries.
Requires the cryptography package on the development computer only.
"""

import re
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization


def main() -> None:
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    entries = []
    for pem in re.findall(rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", source.read_bytes(), re.S):
        cert = x509.load_pem_x509_certificate(pem)
        subject = cert.subject.public_bytes()
        key = cert.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        entries.append((subject, key))
    entries.sort(key=lambda entry: entry[0])
    payload = len(entries).to_bytes(2, "big")
    for subject, key in entries:
        payload += len(subject).to_bytes(2, "big") + len(key).to_bytes(2, "big") + subject + key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload)
    print(f"Bundled {len(entries)} trusted roots into {target} ({len(payload)} bytes)")


if __name__ == "__main__":
    main()
