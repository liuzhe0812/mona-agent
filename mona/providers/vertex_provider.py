"""Vertex AI's OpenAI-compatible Gemini endpoint, authenticated with Google ADC."""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any
from urllib.parse import urlsplit

from mona.providers.openai_compat_provider import OpenAICompatProvider

_HOST = re.compile(r"(?:(?P<region>[a-z][a-z0-9-]*)-)?aiplatform\.googleapis\.com")
_RESOURCE = re.compile(r"/(?P<version>v1(?:beta1)?)/projects/(?P<project>[A-Za-z0-9][A-Za-z0-9.:-]*)/locations/(?P<region>[a-z0-9-]+)/endpoints/openapi")
_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def validate_vertex_base(value: str) -> str:
    """Allow only Google's public Vertex API origin and a documented endpoint shape."""
    url = urlsplit(value.strip())
    host = url.hostname or ""
    path = url.path.rstrip("/")
    if (url.scheme != "https" or not _HOST.fullmatch(host) or url.port not in {None, 443}
            or url.username is not None or url.password is not None or url.query or url.fragment
            or (path not in {"", "/v1", "/v1beta1"} and not _RESOURCE.fullmatch(path))):
        raise ValueError("Vertex AI 需要 Google 官方区域地址或包含项目与区域的 OpenAI 兼容端点。")
    return f"https://{host}{path}"


class VertexAccess:
    def __init__(self, api_base: str | None):
        location = os.environ.get("GOOGLE_CLOUD_LOCATION") or "global"
        if not api_base or api_base == "https://{location}-aiplatform.googleapis.com":
            api_base = "https://aiplatform.googleapis.com" if location == "global" else f"https://{location}-aiplatform.googleapis.com"
        self.base = validate_vertex_base(api_base)
        url = urlsplit(self.base)
        self.origin = f"https://{url.hostname}"
        self._resource = _RESOURCE.fullmatch(url.path)
        self.version = self._resource["version"] if self._resource else url.path.strip("/") or "v1"
        region = _HOST.fullmatch(url.hostname).group("region")
        self.location = self._resource["region"] if self._resource else region or location
        if (not re.fullmatch(r"[a-z0-9-]+", self.location) or region and region != self.location):
            raise ValueError("Vertex AI 地址中的区域不一致。")
        self.credentials = None
        self._project: str | None = None
        self._lock = asyncio.Lock()

    def _refresh(self) -> tuple[str, dict[str, str]]:
        import google.auth
        from google.auth.exceptions import GoogleAuthError
        from google.auth.transport.requests import Request
        import requests

        if self.credentials is None or not self.credentials.valid:
            # ADC can contain a configurable token URL. Keep the refresh secret
            # on Google OAuth/STS/impersonation services and prevent redirects.
            with requests.Session() as session:
                session.max_redirects = 0
                transport = Request(session=session)

                def refresh_request(url, method="GET", body=None, headers=None, **kwargs):
                    target = urlsplit(url)
                    host = target.hostname or ""
                    metadata = (target.scheme == "http" and host in {"metadata.google.internal", "169.254.169.254"}
                                and (target.path == "/" or target.path.startswith("/computeMetadata/v1/")))
                    google_oauth = target.scheme == "https" and (
                        host in {"oauth2.googleapis.com", "oauth2.mtls.googleapis.com", "sts.googleapis.com",
                                 "iamcredentials.googleapis.com", "cloudresourcemanager.googleapis.com"}
                        or (host in {"accounts.google.com", "www.googleapis.com"} and "oauth2" in target.path)
                        or re.fullmatch(r"(?:sts|iamcredentials)\.[a-z0-9-]+\.rep\.googleapis\.com", host)
                    )
                    if not (metadata or google_oauth) or target.username is not None or target.password is not None or target.port not in {None, 443 if google_oauth else 80}:
                        raise ValueError("Google 凭据配置包含不支持的认证端点。")
                    return transport(url=url, method=method, body=body, headers=headers, **kwargs)

                try:
                    if self.credentials is None:
                        self.credentials, self._project = google.auth.default(scopes=_SCOPES, request=refresh_request)
                    if not self.credentials.valid:
                        self.credentials.refresh(refresh_request)
                except (GoogleAuthError, requests.RequestException):
                    raise RuntimeError("Google ADC 尚未就绪，请配置应用默认凭据并确认项目有 Vertex AI 权限。") from None
        if not isinstance(self.credentials.token, str) or not self.credentials.token:
            raise RuntimeError("Google ADC 未返回有效的 Vertex AI 访问凭据。")
        project = self._resource["project"] if self._resource else os.environ.get("GOOGLE_CLOUD_PROJECT") or self._project
        if not project or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.:-]*", project):
            raise ValueError("请在 Vertex AI 端点、GOOGLE_CLOUD_PROJECT 或应用默认凭据中指定 Google Cloud 项目。")
        endpoint = self.base if self._resource else f"{self.origin}/{self.version}/projects/{project}/locations/{self.location}/endpoints/openapi"
        headers = {"Authorization": f"Bearer {self.credentials.token}"}
        quota_project = getattr(self.credentials, "quota_project_id", None)
        if quota_project:
            headers["x-goog-user-project"] = quota_project
        return endpoint, headers

    async def authorize(self) -> tuple[str, dict[str, str]]:
        async with self._lock:
            return await asyncio.to_thread(self._refresh)

    async def catalog_request(self) -> tuple[str, dict[str, str]]:
        _, headers = await self.authorize()
        return f"{self.origin}/v1beta1/publishers/google/models", headers


class VertexOpenAIProvider(OpenAICompatProvider):
    def __init__(self, *, api_base: str | None, default_model: str, spec, model_metadata=None):
        self._vertex = VertexAccess(api_base)
        super().__init__(default_model=default_model, api_base=self._vertex.base, spec=spec,
                         model_metadata=model_metadata, wire_api="openai-completions")

    async def _ensure_client(self):
        endpoint, headers = await self._vertex.authorize()
        self._effective_base = endpoint
        self._api_key_for_client = headers["Authorization"].removeprefix("Bearer ")
        if "x-goog-user-project" in headers:
            self._default_headers["x-goog-user-project"] = headers["x-goog-user-project"]
        client = await super()._ensure_client()
        client.api_key = self._api_key_for_client
        return client

    def _build_kwargs(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        request = super()._build_kwargs(*args, **kwargs)
        if "/" not in request["model"]:
            request["model"] = "google/" + request["model"]
        return request
