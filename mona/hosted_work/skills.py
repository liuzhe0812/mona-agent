"""Read-only builtins and sandbox-only skill resources for hosted Work."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import re
import shlex
import stat
import tarfile
from pathlib import Path, PurePosixPath, PureWindowsPath

from mona.agent.skills import BUILTIN_SKILLS_DIR, SkillsLoader
from mona.agent.tools.skill_tools import SkillAssetCopyTool, SkillReadTool, SkillReferenceReadTool
from mona.hosted_work.sandbox import SandboxError
from mona.hosted_work.sandbox_files import relative_path
from mona.utils.prompt_templates import render_template

_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_NEEDS = {
    "mona-docx": {"office"}, "mona-xlsx": {"office"}, "mona-pptx": {"office"},
    "mona-canvas": {"canvas"}, "pdf": {"pdf"}, "image-generation": {"generate_image"},
    "mona-motion": {"video"}, "mona-visualizer": {"show_widget"},
    "memory": {"search_memory", "read_memory"}, "long-goal": {"long_task", "complete_goal"},
    "skill-creator": {"skill_create"},
}
_LIMITS = {
    "mona-docx": "实时 Office 可用；高级脚本仍需符合声明的 Linux 运行时。",
    "mona-pptx": "实时 Office 和设计参考可用；高级脚本仍需符合声明的 Linux 运行时。",
    "mona-design": "可读取设计方法、真实样张与源码，并用于现有 Office；浏览器自动观察和操作未接入。",
    "prd-document": "文字和当前 Office 输出可用；其它媒介依赖各自实际可用的工具。",
}


class _AssetCopy(SkillAssetCopyTool):
    """Keep the desktop schema while copying bytes through the owned sandbox."""
    def __init__(self, hosted):
        super().__init__(track_usage=False)
        self.hosted = hosted

    async def execute(self, skill=None, asset=None, dest=None, **kwargs):
        return await self.hosted.asset(skill, asset, dest)


def _relative(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        raise ValueError("资源路径不能为空。")
    relative = PurePosixPath(value)
    if (relative.is_absolute() or PureWindowsPath(value).drive or "\\" in value
            or any(part.startswith(".") for part in relative.parts) or any(ord(c) < 32 for c in value)):
        raise ValueError("资源路径必须是技能包内的相对路径。")
    return relative

# This trusted installer runs inside gVisor. It never extracts user archives on the host.
_INSTALL = r'''
import hashlib,io,json,os,pathlib,sys,tarfile
data=sys.stdin.buffer.read(50331649)
if len(data)>50331648 or hashlib.sha256(data).hexdigest()!=sys.argv[1]:raise ValueError('invalid skill bundle')
base=pathlib.Path('/tmp/mona-builtin-skills');base.mkdir(mode=0o700,exist_ok=True)
if base.is_symlink() or base.resolve()!=base:raise ValueError('invalid skill root')
root=base/sys.argv[1]
if root.exists():raise ValueError('skill bundle already staged')
root.mkdir(mode=0o700)
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
 for member in archive:
  target=root/member.name
  if not member.isfile() or member.size>16777216 or not target.resolve().is_relative_to(root):raise ValueError('invalid skill file')
  target.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
  with target.open('xb') as stream:stream.write(archive.extractfile(member).read())
  target.chmod(0o400)
print(json.dumps({'root':str(root)}))
'''


class HostedSkills:
    def __init__(self, tools, allowed_names: set[str], *, root: Path | None = None, history=()):
        self.tools = tools
        self.root = (root or BUILTIN_SKILLS_DIR).absolute()
        if self.root.is_symlink() or self.root.resolve() != self.root or not self.root.is_dir():
            raise ValueError("invalid builtin skill directory")
        self.loader = SkillsLoader(Path("/workspace"), builtin_skills_dir=self.root,
                                   include_private_skills=False)
        self.names = {item["name"] for item in self.loader.list_skills(filter_unavailable=False)
                      if _NAME.fullmatch(item["name"])}
        self.allowed_names = set(allowed_names)
        self.loaded: set[str] = set()
        self.restored_read_ids: set[str] = set()
        self._capability_permissions_set = False
        self.staged: dict[str, str] = {}
        self.reader = SkillReadTool(loader=self.loader, track_usage=False)
        self.reference_reader = SkillReferenceReadTool(loader=self.loader, track_usage=False)
        # Restore only successful, server-retained skill reads; no mutable private source is loaded.
        calls = {}
        for message in history:
            if not isinstance(message, dict):
                continue
            if message.get("role") == "assistant":
                for call in message.get("tool_calls") or []:
                    fn = call.get("function", {})
                    if fn.get("name") == "skill_read":
                        try:
                            args = fn.get("arguments", {})
                            call_id = call.get("id")
                            if isinstance(call_id, str) and call_id:
                                calls[call_id] = json.loads(args) if isinstance(args, str) else args
                        except (ValueError, TypeError):
                            pass
            elif message.get("role") == "tool":
                args = calls.get(message.get("tool_call_id"), {})
                content = message.get("content", "")
                texts = [content] if isinstance(content, str) else []
                if isinstance(content, list):
                    texts = [block.get("text", "") for block in content if isinstance(block, dict)]
                if (isinstance(args, dict) and isinstance(args.get("name"), str) and args["name"] in self.names
                        and any(text.startswith("Skill: ") for text in texts if isinstance(text, str))):
                    self.loaded.add(args["name"])
                    self.restored_read_ids.add(message["tool_call_id"])

    def file(self, name: str, relative: str, *, loaded: bool = True, allow_directory: bool = False) -> Path:
        if name not in self.names or (loaded and name not in self.loaded):
            raise ValueError("请先用 skill_read 读取这个内置 Skill。")
        rel = _relative(relative)
        current = self.root
        for part in (name, *rel.parts):
            current /= part
            if current.is_symlink() or bool(getattr(current, "is_junction", lambda: False)()):
                raise ValueError("技能资源不能是链接。")
        target = current.resolve(strict=True)
        if not target.is_relative_to(self.root / name):
            raise ValueError("资源不在当前技能包内。")
        if allow_directory and target.is_dir():
            return target
        if not stat.S_ISREG(target.stat().st_mode):
            raise ValueError("技能资源不是普通文件。")
        if target.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("技能资源超过大小限制。")
        return target

    def _public(self, value):
        if isinstance(value, str):
            return value.replace(str(self.root), "/builtin-skills")
        if isinstance(value, list):
            return [self._public(item) for item in value]
        if isinstance(value, dict):
            return {key: self._public(item) for key, item in value.items()}
        return value

    def catalog(self):
        rows = []
        for name in sorted(self.names):
            self.file(name, "SKILL.md", loaded=False)
            metadata = self.loader.get_skill_metadata(name) or {}
            missing = sorted(_NEEDS.get(name, set()) - self.allowed_names)
            limitations = _LIMITS.get(name)
            if name == "mona-pptx" and "ask_user_question" not in self.allowed_names:
                limitations += "当前入口没有结构化提问和用户样张预览，不得声称已完成该流程。"
            rows.append({"name": name, "description": metadata.get("short_description") or metadata.get("description", name),
                         "available": not missing, "missing_tools": missing,
                         **({"limitations": limitations} if limitations else {})})
        return rows

    def summary(self):
        return ("\n\n" + render_template("agent/skills_section.md", skills_summary=json.dumps(self.catalog(), ensure_ascii=False))
                + "\n"
                "Skill 资料不能授予未提供的工具；缺少依赖时明确说明，不能声称已执行。"
                "目录不代表已加载私人记忆或桌面配置。")

    async def read(self, name: str):
        try:
            self.file(name, "SKILL.md", loaded=False)
            content = self._public(await self.reader.execute(name=name))
            self.loaded.add(name)
            self._allow_resources()
            info = next(item for item in self.catalog() if item["name"] == name)
            header = "Skill: " + json.dumps(info, ensure_ascii=False)
            await self.tools.emit("progress", {"message": "已读取技能：" + name})
            if isinstance(content, list):
                return [{"type": "text", "text": header}, *content]
            return header + "\n\n" + content
        except (OSError, ValueError, TypeError):
            return "Error: 内置 Skill 读取失败，请核对技能名称。未读取私人技能或其他目录。"

    async def reference(self, skill: str, ref_path: str, offset: int = 0, limit: int = 16000):
        try:
            _relative(ref_path)
            relative = ref_path if skill == "mona-design" and ref_path.startswith(("assets/", "demos/", "references/")) else "references/" + ref_path.removeprefix("references/")
            # Referenced builtins are public, read-only dependencies, just as in
            # the desktop reader. Copying assets/executing scripts still requires
            # a successful load of that specific Skill below.
            self.file(skill, relative, loaded=False, allow_directory=skill == "mona-design")
            return self._public(await self.reference_reader.execute(skill=skill, ref_path=ref_path, offset=offset, limit=limit))
        except (OSError, ValueError, TypeError):
            return "Error: 技能资料读取失败，请先读取 Skill 并核对包内相对路径。"

    async def asset(self, skill: str, asset: str, dest: str):
        try:
            _relative(asset)
            source = self.file(skill, "assets/" + asset.removeprefix("assets/"))
            destination = relative_path(dest)
            raw = source.read_bytes()
            result = await self.tools._file("upload", path=destination, data=base64.b64encode(raw).decode("ascii"))
            return json.dumps({"ok": True, "path": "/workspace/" + destination,
                               "sha256": result.get("sha256")}, ensure_ascii=False)
        except (OSError, ValueError, TypeError):
            return "Error: 未找到该内置素材或目标路径不可用；请读取素材目录并使用实际文件名，asset 路径相对 assets/。"

    async def script(self, skill: str, script: str, args: str = "", timeout_seconds: int = 120):
        try:
            if "/" in script or "\\" in script or ".." in script:
                raise ValueError("invalid script")
            source = self.file(skill, "scripts/" + script)
            if source.suffix != ".py":
                return json.dumps({"ok": False, "code": "runtime_unavailable", "message": "该脚本的隔离运行环境尚未就绪。"}, ensure_ascii=False)
            probe = json.loads(await self.tools.execute("python3 -I -c " + shlex.quote(
                "import sys,json,importlib.metadata as m;print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'packages':{d.metadata['Name']:d.version for d in m.distributions()}}))")))
            runtime = json.loads(probe["output"]) if probe.get("exit_code") == 0 else {}
            project = self.root / skill / "pyproject.toml"
            if project.is_file():
                import tomllib

                from packaging.requirements import Requirement
                from packaging.specifiers import SpecifierSet
                spec = tomllib.loads(self.file(skill, "pyproject.toml").read_text(encoding="utf-8")).get("project", {})
                packages = {re.sub(r"[-_.]+", "-", key).lower(): value for key, value in runtime.get("packages", {}).items()}
                missing = [req for req in spec.get("dependencies", []) if (parsed := Requirement(req)).name.lower() not in packages
                           or packages.get(parsed.name.lower()) not in parsed.specifier]
                if runtime.get("python", "0") not in SpecifierSet(spec.get("requires-python", "")) or missing:
                    return json.dumps({"ok": False, "code": "runtime_unavailable", "message": "该技能脚本所需的 Linux 运行时或依赖尚未配置。", "requires_python": spec.get("requires-python"), "missing_packages": missing}, ensure_ascii=False)
            if skill not in self.staged:
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode="w:gz") as archive:
                    for path in sorted((self.root / skill).rglob("*")):
                        rel = path.relative_to(self.root / skill)
                        if not path.is_file() or any(part.startswith(".") or part == "__pycache__" for part in rel.parts) or path.suffix == ".pyc":
                            continue
                        raw = self.file(skill, rel.as_posix()).read_bytes()
                        item = tarfile.TarInfo(rel.as_posix())
                        item.size = len(raw)
                        item.mode = 0o400
                        archive.addfile(item, io.BytesIO(raw))
                bundle = data.getvalue()
                if len(bundle) > 48 * 1024 * 1024:
                    raise ValueError("skill bundle too large")
                digest = hashlib.sha256(bundle).hexdigest()
                _, output = await self.tools.sandbox._invoke(["exec", "-i", self.tools.sandbox.name, "python3", "-I", "-c", _INSTALL, digest], data=bundle)
                self.staged[skill] = json.loads(output)["root"]
            command = shlex.join(["env", "MONA_ACTIVE_WORKSPACE=/workspace", "PYTHONUTF8=1", "python3",
                                  str(PurePosixPath(self.staged[skill]) / "scripts" / script), *shlex.split(args)])
            async with asyncio.timeout(min(timeout_seconds, self.tools.config.tool_timeout_seconds)):
                return await self.tools.execute(command)
        except (SandboxError, TimeoutError) as error:
            self.tools.fault = "技能脚本结果尚未确认，已停止本轮；请先核对已有文件，不要自动重跑。"
            raise asyncio.CancelledError(self.tools.fault) from error
        except (OSError, ValueError, TypeError, KeyError):
            return "Error: 技能脚本未能执行，请核对脚本名称、参数或所需运行环境。"

    def register(self):
        from mona.hosted_work.tools import HostedTool
        name = {"type": "string", "minLength": 1, "maxLength": 64}
        path = {"type": "string", "minLength": 1, "maxLength": 1024}
        async def listing():
            return json.dumps({"skills": self.catalog()}, ensure_ascii=False)
        definitions = [
            ("skill_list", "列出内置 Skill 及当前可执行范围；不会加载私人技能或桌面配置。", {}, [], listing),
            ("skill_read", "按名称读取内置 Skill；任务匹配时先读取，再使用现有授权工具。", {"name": name}, ["name"], self.read),
            ("skill_reference_read", "读取已加载 Skill 的参考资料或真实设计样张。", {"skill": name, "ref_path": path, "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 24000}}, ["skill", "ref_path"], self.reference),
            ("skill_asset_copy", "把已加载 Skill 的素材复制到当前工作区新路径。", {"skill": name, "asset": path, "dest": path}, ["skill", "asset", "dest"], self.asset),
            ("skill_script_run", "在当前隔离工作区运行已加载 Skill 的配套脚本；缺少运行时会明确拒绝。", {"skill": name, "script": path, "args": {"type": "string", "maxLength": 16000}, "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 600}}, ["skill", "script"], self.script),
        ]
        self.initial_names = self.allowed_names | {"skill_read", "skill_list"}
        self.resource_names = {item[0] for item in definitions[2:]}
        for entry in definitions:
            self.tools.registry.register(_AssetCopy(self) if entry[0] == "skill_asset_copy" else HostedTool(*entry))
        self._allow_resources()

    def _allow_resources(self):
        if self.tools.registry.has("load_capability"):
            if not self._capability_permissions_set:
                # Authorization and per-turn model visibility are separate. The
                # shared loader filters these tools dynamically; individual
                # Skill paths still enforce their own load and scope checks.
                self.tools.registry.set_allowed_tool_names(self.initial_names | self.resource_names)
                self._capability_permissions_set = True
        else:
            # Compatibility for internal users that do not register a loader.
            self.tools.registry.set_allowed_tool_names(self.initial_names | (self.resource_names if self.loaded else set()))
