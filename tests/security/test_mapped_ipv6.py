from __future__ import annotations

import socket
from unittest.mock import patch

import pytest

from mona.security.network import (
    configure_ssrf_whitelist,
    validate_host,
    validate_resolved_url,
    validate_url_target,
)


def _fake_resolve(host: str, address: str):
    def resolver(hostname, port, family=0, type_=0):
        if hostname == host:
            return [(socket.AF_INET6, socket.SOCK_STREAM, 0, "", (address, 0))]
        raise socket.gaierror(f"cannot resolve {hostname}")
    return resolver


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.1", "169.254.169.254"])
def test_blocks_mapped_private_ipv4_for_all_entry_points(ip: str):
    mapped = f"::ffff:{ip}"
    with patch("mona.security.network.socket.getaddrinfo", _fake_resolve(mapped, mapped)):
        assert not validate_url_target(f"http://[{mapped}]/")[0]
        assert not validate_host(mapped)[0]
    assert not validate_resolved_url(f"http://[{mapped}]/")[0]


def test_mapped_ipv4_honors_only_explicit_local_service_permissions():
    with patch("mona.security.network.socket.getaddrinfo", _fake_resolve("service.local", "::ffff:10.0.0.1")):
        assert not validate_url_target("http://service.local/")[0]
        assert validate_url_target("http://service.local/", allow_private=True)[0]
    with patch("mona.security.network.socket.getaddrinfo", _fake_resolve("metadata.local", "::ffff:169.254.169.254")):
        assert not validate_url_target("http://metadata.local/", allow_private=True)[0]
    with patch("mona.security.network.socket.getaddrinfo", _fake_resolve("localhost", "::ffff:127.0.0.1")):
        assert validate_host("localhost", allow_loopback=True)[0]


@pytest.mark.parametrize("cidr", ["10.0.0.0/8", "::ffff:10.0.0.0/104"])
def test_whitelist_treats_mapped_and_native_ipv4_identically(cidr: str):
    configure_ssrf_whitelist([cidr])
    try:
        for address in ("10.0.0.1", "::ffff:10.0.0.1"):
            with patch("mona.security.network.socket.getaddrinfo", _fake_resolve("service.local", address)):
                assert validate_url_target("http://service.local/")[0]
        with patch("mona.security.network.socket.getaddrinfo", _fake_resolve("metadata.local", "::ffff:169.254.169.254")):
            assert not validate_url_target("http://metadata.local/")[0]
    finally:
        configure_ssrf_whitelist([])


def test_allows_public_ipv4_mapped_address():
    with patch("mona.security.network.socket.getaddrinfo", _fake_resolve("example.com", "::ffff:93.184.216.34")):
        assert validate_url_target("https://example.com/")[0]
