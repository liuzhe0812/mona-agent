"""Cindy's chat-provider catalog, reduced to Mona's chat runtime needs.

The catalog intentionally contains only provider presets and OpenAI-compatible
model metadata.  Harness-specific routing/auth data stays in Cindy.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CindyModel:
    id: str
    name: str
    context_window: int | None = None


@dataclass(frozen=True)
class CindyChatProvider:
    id: str
    name: str
    api_base: str
    models: tuple[CindyModel, ...] = ()
    models_url: str | None = None
    region: str | None = None
    api_key_required: bool = True
    api_base_editable: bool = False


def _models(*rows: tuple[str, str, int | None]) -> tuple[CindyModel, ...]:
    return tuple(CindyModel(*row) for row in rows)


# Keep this list in Cindy preset order; Chinese Mainland entries are sorted
# first by the settings UI.
CINDY_CHAT_PROVIDERS: tuple[CindyChatProvider, ...] = (
    CindyChatProvider(
        "openrouter", "OpenRouter", "https://openrouter.ai/api/v1",
        _models(("z-ai/glm-5.2", "GLM-5.2 (OpenRouter)", None), ("moonshotai/kimi-k2.6", "Kimi K2.6 (OpenRouter)", None)),
        region="global",
    ),
    CindyChatProvider(
        "deepseek", "DeepSeek", "https://api.deepseek.com",
        _models(("deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000), ("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000)),
        models_url="https://api.deepseek.com/models",
    ),
    CindyChatProvider(
        "zhipu-glm-cn", "智谱 GLM（中国大陆）", "https://open.bigmodel.cn/api/paas/v4",
        _models(("glm-5.2", "GLM-5.2", None), ("glm-5.1", "GLM-5.1", None)),
        region="cn",
    ),
    CindyChatProvider(
        "zhipu-glm-global", "Z.ai GLM (Global)", "https://api.z.ai/api/paas/v4",
        _models(("glm-5.2", "GLM-5.2", None), ("glm-5.1", "GLM-5.1", None)),
        region="global",
    ),
    CindyChatProvider(
        "moonshot-kimi-cn", "Kimi (Moonshot 中国大陆)", "https://api.moonshot.cn/v1",
        _models(("kimi-k3", "Kimi K3", None), ("kimi-k2.7-code", "Kimi K2.7 Code", None), ("kimi-k2.6", "Kimi K2.6", None)),
        models_url="https://api.moonshot.cn/v1/models", region="cn",
    ),
    CindyChatProvider(
        "moonshot-kimi-global", "Kimi (Moonshot Global)", "https://api.moonshot.ai/v1",
        _models(("kimi-k3", "Kimi K3", None), ("kimi-k2.7-code", "Kimi K2.7 Code", None), ("kimi-k2.6", "Kimi K2.6", None)),
        models_url="https://api.moonshot.ai/v1/models", region="global",
    ),
    CindyChatProvider(
        "moonshot-kimi-code", "Kimi Code（编程计划包月）", "https://api.kimi.com/coding/v1",
        _models(("kimi-for-coding", "Kimi for Coding", 262_144), ("kimi-for-coding-highspeed", "Kimi for Coding 高速版", 262_144), ("k3", "Kimi K3", 262_144)),
    ),
    CindyChatProvider(
        "minimax-cn", "MiniMax（中国大陆）", "https://api.minimaxi.com/v1",
        _models(("MiniMax-M3", "MiniMax M3", 1_000_000), ("MiniMax-M2.5", "MiniMax M2.5", None)), region="cn",
    ),
    CindyChatProvider(
        "minimax-global", "MiniMax (Global)", "https://api.minimax.io/v1",
        _models(("MiniMax-M3", "MiniMax M3", 1_000_000), ("MiniMax-M2.5", "MiniMax M2.5", None)), region="global",
    ),
    CindyChatProvider(
        "aliyun-bailian-coding", "阿里云百炼 Coding Plan（包月）", "https://coding.dashscope.aliyuncs.com/v1",
        _models(("qwen3.7-plus", "Qwen 3.7 Plus", None), ("qwen3-coder-next", "Qwen3 Coder Next", None), ("qwen3-coder-plus", "Qwen3 Coder Plus", None)), region="cn",
    ),
    CindyChatProvider(
        "aliyun-bailian-token-plan-cn", "阿里云百炼 Token Plan（个人版）", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        _models(("qwen3.8-max-preview", "Qwen 3.8 Max Preview", 983_616), ("qwen3.7-max", "Qwen 3.7 Max", 992_000), ("qwen3.7-plus", "Qwen 3.7 Plus", 1_000_000), ("qwen3.6-flash", "Qwen 3.6 Flash", 1_000_000), ("glm-5.2", "GLM-5.2", 1_000_000), ("deepseek-v4-pro", "DeepSeek V4 Pro", 1_048_576)),
        models_url="https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models", region="cn",
    ),
    CindyChatProvider(
        "aliyun-bailian-token-plan-team-cn", "阿里云百炼 Token Plan（团队版）", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        _models(("qwen3.8-max-preview", "Qwen 3.8 Max Preview", 983_616), ("qwen3.7-max", "Qwen 3.7 Max", 992_000), ("qwen3.7-plus", "Qwen 3.7 Plus", 1_000_000), ("qwen3.6-plus", "Qwen 3.6 Plus", 1_000_000), ("qwen3.6-flash", "Qwen 3.6 Flash", 1_000_000), ("deepseek-v4-pro", "DeepSeek V4 Pro", 1_048_576), ("deepseek-v4-flash", "DeepSeek V4 Flash", 1_048_576), ("deepseek-v3.2", "DeepSeek V3.2", 131_072), ("kimi-k2.7-code", "Kimi K2.7 Code", 262_144), ("kimi-k2.6", "Kimi K2.6", 262_144), ("kimi-k2.5", "Kimi K2.5", 262_144), ("glm-5.2", "GLM-5.2", 1_000_000), ("glm-5.1", "GLM-5.1", 202_752), ("glm-5", "GLM-5", 202_752), ("MiniMax-M2.5", "MiniMax M2.5", 196_608)),
        models_url="https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models", region="cn",
    ),
    CindyChatProvider(
        "google-gemini-api", "Google Gemini API", "https://generativelanguage.googleapis.com/v1beta/openai",
        _models(("gemini-3.6-flash", "Gemini 3.6 Flash", 1_000_000), ("gemini-3.5-flash", "Gemini 3.5 Flash", 1_000_000), ("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", 1_000_000)),
        models_url="https://generativelanguage.googleapis.com/v1beta/openai/models", region="global",
    ),
    CindyChatProvider(
        "litellm",
        "LiteLLM Proxy",
        "http://127.0.0.1:4000/v1",
        api_key_required=False,
        api_base_editable=True,
    ),
    CindyChatProvider(
        "longcat", "LongCat", "https://api.longcat.chat/openai/v1",
        _models(("LongCat-2.0", "LongCat 2.0", 1_000_000)),
        models_url="https://api.longcat.chat/openai/v1/models",
    ),
    CindyChatProvider(
        "zhipu-coding-plan-cn", "智谱 GLM Coding Plan（中国大陆）", "https://open.bigmodel.cn/api/coding/paas/v4",
        _models(("glm-5.2", "GLM-5.2", None), ("glm-5.1", "GLM-5.1", None)), region="cn",
    ),
    CindyChatProvider(
        "zai-coding-plan-global", "Z.ai GLM Coding Plan (Global)", "https://api.z.ai/api/coding/paas/v4",
        _models(("glm-5.2", "GLM-5.2", None), ("glm-5.1", "GLM-5.1", None)), region="global",
    ),
    CindyChatProvider(
        "xiaomi-mimo-api-cn", "小米 MiMo API（按量）", "https://api.xiaomimimo.com/v1",
        _models(("mimo-v2.5-pro", "MiMo V2.5 Pro", 1_000_000), ("mimo-v2.5", "MiMo V2.5", 1_000_000)), region="cn",
    ),
    CindyChatProvider(
        "xiaomi-mimo-token-plan-cn", "小米 MiMo Token Plan（包月）", "https://token-plan-cn.xiaomimimo.com/v1",
        _models(("mimo-v2.5-pro", "MiMo V2.5 Pro", 1_000_000), ("mimo-v2.5", "MiMo V2.5", 1_000_000)), region="cn",
    ),
    CindyChatProvider(
        "volcengine-agent-plan", "火山方舟 Agent Plan", "https://ark.cn-beijing.volces.com/api/plan/v3",
        _models(("ark-code-latest", "Ark Code Latest", None)), region="cn",
    ),
    CindyChatProvider(
        "volcengine-coding-plan", "火山方舟 Coding Plan", "https://ark.cn-beijing.volces.com/api/coding/v3",
        _models(("ark-code-latest", "Ark Code Latest", None)), region="cn",
    ),
    CindyChatProvider(
        "tencentcloud-coding-plan", "腾讯云 Coding Plan", "https://api.lkeap.cloud.tencent.com/coding/v3",
        _models(("tc-code-latest", "Tencent Code Latest", None), ("glm-5", "GLM-5", None)), region="cn",
    ),
    CindyChatProvider(
        "opencode-go", "OpenCode Go", "https://opencode.ai/zen/go/v1",
        _models(("grok-4.5", "Grok 4.5", None), ("glm-5.2", "GLM-5.2", None), ("glm-5.1", "GLM-5.1", None), ("kimi-k3", "Kimi K3", None), ("kimi-k2.7-code", "Kimi K2.7 Code", None), ("kimi-k2.6", "Kimi K2.6", None), ("mimo-v2.5", "MiMo V2.5", None), ("mimo-v2.5-pro", "MiMo V2.5 Pro", None), ("deepseek-v4-pro", "DeepSeek V4 Pro", None), ("deepseek-v4-flash", "DeepSeek V4 Flash", None), ("hy3", "Hy3", None)),
        models_url="https://opencode.ai/zen/go/v1/models", region="global",
    ),
    CindyChatProvider(
        "vercel-ai-gateway", "Vercel AI Gateway", "https://ai-gateway.vercel.sh/v1",
        _models(("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6 (Vercel)", None), ("openai/gpt-5.4", "GPT-5.4 (Vercel)", None), ("xai/grok-4.5", "Grok 4.5 (Vercel)", None)),
        models_url="https://ai-gateway.vercel.sh/v1/models", region="global",
    ),
)


CINDY_CHAT_PROVIDER_BY_ID = {provider.id: provider for provider in CINDY_CHAT_PROVIDERS}
