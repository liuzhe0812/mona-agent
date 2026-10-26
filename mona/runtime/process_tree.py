"""Own and stop a subprocess together with its descendants."""

from __future__ import annotations

import ctypes
import os
import signal
import subprocess
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_DEFAULT_CLOSE_TIMEOUT = 5.0
_WINDOWS_CREATE_SUSPENDED = 0x00000004
_WINDOWS_CREATE_NO_WINDOW = 0x08000000
_WINDOWS_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_WINDOWS_JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3
_WINDOWS_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_WINDOWS_TH32CS_SNAPPROCESS = 0x00000002
_WINDOWS_TH32CS_SNAPTHREAD = 0x00000004
_WINDOWS_THREAD_SUSPEND_RESUME = 0x0002
_WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_WINDOWS_WAIT_OBJECT_0 = 0x00000000
_WINDOWS_WAIT_TIMEOUT = 0x00000102
_WINDOWS_WAIT_FAILED = 0xFFFFFFFF
_WINDOWS_ERROR_NO_MORE_FILES = 18
_WINDOWS_ERROR_INVALID_PARAMETER = 87
_WINDOWS_ERROR_MORE_DATA = 234


@dataclass(frozen=True)
class OwnedProcessInfo:
    parent_pid: int
    executable: Path


def _windows_error(operation: str) -> OSError:
    error = ctypes.get_last_error()
    return OSError(error, f"{operation} failed: {ctypes.FormatError(error).strip()}")


def _handle_value(handle: Any) -> int:
    return int(handle if isinstance(handle, int) else handle.value)


class _WindowsApi:
    """Lazy ctypes declarations for the documented Win32 process APIs."""

    def __init__(self) -> None:
        from ctypes import wintypes

        class BasicLimitInformation(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class ExtendedLimitInformation(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimitInformation),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        class ThreadEntry32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ThreadID", wintypes.DWORD),
                ("th32OwnerProcessID", wintypes.DWORD),
                ("tpBasePri", wintypes.LONG),
                ("tpDeltaPri", wintypes.LONG),
                ("dwFlags", wintypes.DWORD),
            ]

        class ProcessEntry32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", wintypes.LONG),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", wintypes.WCHAR * 260),
            ]

        class AccountingInformation(ctypes.Structure):
            _fields_ = [(name, ctypes.c_longlong) for name in (
                "TotalUserTime", "TotalKernelTime", "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime",
            )] + [(name, wintypes.DWORD) for name in (
                "TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses",
            )]

        self.handle_type = wintypes.HANDLE
        self.bool_type = wintypes.BOOL
        self.dword_type = wintypes.DWORD
        self.extended_limit_information_type = ExtendedLimitInformation
        self.thread_entry_type = ThreadEntry32
        self.process_entry_type = ProcessEntry32
        self.accounting_information_type = AccountingInformation
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        self.create_job = self.kernel32.CreateJobObjectW
        self.create_job.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        self.create_job.restype = wintypes.HANDLE

        self.set_job_information = self.kernel32.SetInformationJobObject
        self.set_job_information.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        )
        self.set_job_information.restype = wintypes.BOOL

        self.query_job_information = self.kernel32.QueryInformationJobObject
        self.query_job_information.argtypes = (
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
        )
        self.query_job_information.restype = wintypes.BOOL

        self.assign_process = self.kernel32.AssignProcessToJobObject
        self.assign_process.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        self.assign_process.restype = wintypes.BOOL

        self.terminate_job = self.kernel32.TerminateJobObject
        self.terminate_job.argtypes = (wintypes.HANDLE, wintypes.UINT)
        self.terminate_job.restype = wintypes.BOOL

        self.wait_for_single_object = self.kernel32.WaitForSingleObject
        self.wait_for_single_object.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        self.wait_for_single_object.restype = wintypes.DWORD

        self.close_handle = self.kernel32.CloseHandle
        self.close_handle.argtypes = (wintypes.HANDLE,)
        self.close_handle.restype = wintypes.BOOL

        self.is_process_in_job = self.kernel32.IsProcessInJob
        self.is_process_in_job.argtypes = (
            wintypes.HANDLE,
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.BOOL),
        )
        self.is_process_in_job.restype = wintypes.BOOL

        self.open_process = self.kernel32.OpenProcess
        self.open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        self.open_process.restype = wintypes.HANDLE

        self.create_thread_snapshot = self.kernel32.CreateToolhelp32Snapshot
        self.create_thread_snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
        self.create_thread_snapshot.restype = wintypes.HANDLE

        self.create_process_snapshot = self.kernel32.CreateToolhelp32Snapshot
        self.create_process_snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
        self.create_process_snapshot.restype = wintypes.HANDLE

        self.process32_first = self.kernel32.Process32FirstW
        self.process32_first.argtypes = (wintypes.HANDLE, ctypes.POINTER(ProcessEntry32))
        self.process32_first.restype = wintypes.BOOL

        self.process32_next = self.kernel32.Process32NextW
        self.process32_next.argtypes = (wintypes.HANDLE, ctypes.POINTER(ProcessEntry32))
        self.process32_next.restype = wintypes.BOOL

        self.query_full_process_image_name = self.kernel32.QueryFullProcessImageNameW
        self.query_full_process_image_name.argtypes = (
            wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
        )
        self.query_full_process_image_name.restype = wintypes.BOOL

        self.thread32_first = self.kernel32.Thread32First
        self.thread32_first.argtypes = (wintypes.HANDLE, ctypes.POINTER(ThreadEntry32))
        self.thread32_first.restype = wintypes.BOOL

        self.thread32_next = self.kernel32.Thread32Next
        self.thread32_next.argtypes = (wintypes.HANDLE, ctypes.POINTER(ThreadEntry32))
        self.thread32_next.restype = wintypes.BOOL

        self.open_thread = self.kernel32.OpenThread
        self.open_thread.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        self.open_thread.restype = wintypes.HANDLE

        self.resume_thread = self.kernel32.ResumeThread
        self.resume_thread.argtypes = (wintypes.HANDLE,)
        self.resume_thread.restype = wintypes.DWORD

    def process_parent_pids(self) -> dict[int, int]:
        snapshot = self.create_process_snapshot(_WINDOWS_TH32CS_SNAPPROCESS, 0)
        invalid_handle = ctypes.c_void_p(-1).value
        if not snapshot or _handle_value(snapshot) == invalid_handle:
            raise _windows_error("CreateToolhelp32Snapshot(processes)")
        parents: dict[int, int] = {}
        try:
            entry = self.process_entry_type()
            entry.dwSize = ctypes.sizeof(entry)
            ctypes.set_last_error(0)
            if not self.process32_first(snapshot, ctypes.byref(entry)):
                raise _windows_error("Process32FirstW")
            while True:
                parents[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
                ctypes.set_last_error(0)
                if not self.process32_next(snapshot, ctypes.byref(entry)):
                    error = ctypes.get_last_error()
                    if error not in (0, _WINDOWS_ERROR_NO_MORE_FILES):
                        raise OSError(error, "Process32NextW failed")
                    break
        finally:
            self.close_handle(self.handle_type(_handle_value(snapshot)))
        return parents

    def process_image_path(self, pid: int) -> Path:
        process_handle = self.open_process(_WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not process_handle:
            error = ctypes.get_last_error()
            if error == _WINDOWS_ERROR_INVALID_PARAMETER:
                raise ProcessLookupError(pid)
            raise OSError(error, f"OpenProcess({pid}) failed")
        try:
            image = ctypes.create_unicode_buffer(32768)
            size = self.dword_type(len(image))
            if not self.query_full_process_image_name(
                self.handle_type(_handle_value(process_handle)), 0, image, ctypes.byref(size),
            ):
                raise _windows_error(f"QueryFullProcessImageNameW({pid})")
            return Path("".join(image[: int(size.value)]))
        finally:
            self.close_handle(self.handle_type(_handle_value(process_handle)))


_windows_api: _WindowsApi | None = None


def _get_windows_api() -> _WindowsApi:
    global _windows_api
    if _windows_api is None:
        _windows_api = _WindowsApi()
    return _windows_api


class OwnedProcess:
    """A Popen-compatible handle for one process tree owned by Mona.

    On Windows, the process is created suspended, assigned to a private Job
    Object, then resumed. The non-inheritable job handle kills the entire tree
    when closed. On POSIX, the process starts a new session and its process
    group is the ownership boundary.
    """

    def __init__(
        self,
        args: str | Sequence[str | os.PathLike[str]],
        *,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
        stdin: Any = None,
        stdout: Any = None,
        stderr: Any = None,
        text: bool = False,
        encoding: str | None = None,
        errors: str | None = None,
        bufsize: int = -1,
        close_timeout: float = _DEFAULT_CLOSE_TIMEOUT,
    ) -> None:
        if close_timeout <= 0:
            raise ValueError("close_timeout must be positive")
        self.close_timeout = close_timeout
        self.process: subprocess.Popen[str] = None  # type: ignore[assignment]
        self._closed = False
        self._close_error: BaseException | None = None
        self._job_handle: int | None = None
        self._process_group: int | None = None
        self._verified_pids: set[int] = set()
        self._api: _WindowsApi | None = None

        try:
            if os.name == "nt":
                self._start_windows(
                    args,
                    cwd=cwd,
                    env=env,
                    stdin=stdin,
                    stdout=stdout,
                    stderr=stderr,
                    text=text,
                    encoding=encoding,
                    errors=errors,
                    bufsize=bufsize,
                )
            else:
                self.process = subprocess.Popen(
                    args,
                    cwd=cwd,
                    env=env,
                    stdin=stdin,
                    stdout=stdout,
                    stderr=stderr,
                    text=text,
                    encoding=encoding,
                    errors=errors,
                    bufsize=bufsize,
                    start_new_session=True,
                )
                self._process_group = self.process.pid
                if os.getpgid(self.process.pid) != self._process_group:
                    self._process_group = None
                    raise RuntimeError("new process did not become its own process group")
                self._verified_pids.add(self.process.pid)
        except BaseException as start_error:
            try:
                self._abort_start()
            except BaseException as cleanup_error:
                raise cleanup_error from start_error
            raise

    def _start_windows(
        self,
        args: str | Sequence[str | os.PathLike[str]],
        *,
        cwd: str | os.PathLike[str] | None,
        env: Mapping[str, str] | None,
        stdin: Any,
        stdout: Any,
        stderr: Any,
        text: bool,
        encoding: str | None,
        errors: str | None,
        bufsize: int,
    ) -> None:
        api = _get_windows_api()
        self._api = api
        job = api.create_job(None, None)
        if not job:
            raise _windows_error("CreateJobObjectW")
        self._job_handle = _handle_value(job)

        limits = api.extended_limit_information_type()
        limits.BasicLimitInformation.LimitFlags = _WINDOWS_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not api.set_job_information(
            api.handle_type(self._job_handle),
            _WINDOWS_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        ):
            raise _windows_error("SetInformationJobObject")

        self.process = subprocess.Popen(
            args,
            cwd=cwd,
            env=env,
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
            text=text,
            encoding=encoding,
            errors=errors,
            bufsize=bufsize,
            close_fds=True,
            creationflags=_WINDOWS_CREATE_SUSPENDED | _WINDOWS_CREATE_NO_WINDOW,
        )
        process_handle = api.handle_type(int(self.process._handle))
        if not api.assign_process(api.handle_type(self._job_handle), process_handle):
            raise _windows_error("AssignProcessToJobObject")
        self._resume_initial_thread(self.process.pid)

    def _resume_initial_thread(self, pid: int) -> None:
        api = self._api
        assert api is not None
        snapshot = api.create_thread_snapshot(_WINDOWS_TH32CS_SNAPTHREAD, 0)
        invalid_handle = ctypes.c_void_p(-1).value
        if not snapshot or _handle_value(snapshot) == invalid_handle:
            raise _windows_error("CreateToolhelp32Snapshot")

        thread_ids: list[int] = []
        try:
            entry = api.thread_entry_type()
            entry.dwSize = ctypes.sizeof(entry)
            ctypes.set_last_error(0)
            if not api.thread32_first(snapshot, ctypes.byref(entry)):
                raise _windows_error("Thread32First")
            while True:
                if entry.th32OwnerProcessID == pid:
                    thread_ids.append(int(entry.th32ThreadID))
                ctypes.set_last_error(0)
                if not api.thread32_next(snapshot, ctypes.byref(entry)):
                    error = ctypes.get_last_error()
                    if error not in (0, _WINDOWS_ERROR_NO_MORE_FILES):
                        raise OSError(error, "Thread32Next failed")
                    break
        finally:
            api.close_handle(api.handle_type(_handle_value(snapshot)))

        if len(thread_ids) != 1:
            raise RuntimeError(
                f"expected one suspended primary thread for process {pid}, found {len(thread_ids)}"
            )
        thread = api.open_thread(_WINDOWS_THREAD_SUSPEND_RESUME, False, thread_ids[0])
        if not thread:
            raise _windows_error("OpenThread")
        try:
            previous_suspend_count = api.resume_thread(thread)
            if previous_suspend_count == _WINDOWS_WAIT_FAILED:
                raise _windows_error("ResumeThread")
            if previous_suspend_count != 1:
                raise RuntimeError(
                    "expected the primary thread to have one suspended count, "
                    f"got {previous_suspend_count}"
                )
        finally:
            api.close_handle(api.handle_type(_handle_value(thread)))

    @property
    def pid(self) -> int:
        return self.process.pid

    def poll(self) -> int | None:
        return self.process.poll()

    def process_count(self) -> int | None:
        """Count owned Windows processes; unknown platforms retain the running tree."""
        if self._closed:
            return 0
        if os.name != "nt":
            return None
        api = self._api
        if api is None or self._job_handle is None:
            return 0
        accounting = api.accounting_information_type()
        if not api.query_job_information(
            api.handle_type(self._job_handle), 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None,
        ):
            raise _windows_error("QueryInformationJobObject")
        return int(accounting.ActiveProcesses)

    def process_ids(self) -> set[int] | None:
        """Return active PIDs in the owned Windows Job; unknown platforms stay unknown."""
        if self._closed:
            return set()
        if os.name != "nt":
            return None
        api = self._api
        job = self._job_handle
        if api is None or job is None:
            return None

        capacity = max(8, self.process_count() or 0)
        for _ in range(8):
            class BasicProcessIdList(ctypes.Structure):
                _fields_ = [
                    ("NumberOfAssignedProcesses", api.dword_type),
                    ("NumberOfProcessIdsInList", api.dword_type),
                    ("ProcessIdList", ctypes.c_size_t * capacity),
                ]

            info = BasicProcessIdList()
            ctypes.set_last_error(0)
            succeeded = api.query_job_information(
                api.handle_type(job),
                _WINDOWS_JOB_OBJECT_BASIC_PROCESS_ID_LIST,
                ctypes.byref(info),
                ctypes.sizeof(info),
                None,
            )
            assigned = int(info.NumberOfAssignedProcesses)
            listed = int(info.NumberOfProcessIdsInList)
            if succeeded and listed >= assigned:
                pids = {int(pid) for pid in info.ProcessIdList[:listed]}
                self._verified_pids.update(pids)
                return pids
            error = ctypes.get_last_error()
            if succeeded or error == _WINDOWS_ERROR_MORE_DATA:
                capacity = max(capacity * 2, assigned)
                continue
            raise OSError(error, "QueryInformationJobObject(process IDs) failed")
        raise RuntimeError("could not obtain a complete owned Job process list")

    def process_snapshot(self) -> dict[int, OwnedProcessInfo] | None:
        """Return verified Job PIDs with their parent PID and executable path."""
        if os.name != "nt":
            return None
        api = self._api
        if api is None or self._job_handle is None:
            return None
        pids = self.process_ids()
        if pids is None:
            return None
        parents = api.process_parent_pids()
        missing = pids - parents.keys()
        if missing:
            raise ProcessLookupError(f"owned process exited during snapshot: {sorted(missing)}")
        return {
            pid: OwnedProcessInfo(
                parent_pid=parents[pid],
                executable=api.process_image_path(pid),
            )
            for pid in pids
        }

    def owns_pid(self, pid: int) -> bool:
        """Return true only when ``pid`` is verifiably inside this owned tree."""
        if pid <= 0:
            raise ValueError("pid must be positive")
        if self._closed:
            return False
        if os.name == "nt":
            return self._windows_owns_pid(pid)
        return self._posix_owns_pid(pid)

    def _windows_owns_pid(self, pid: int) -> bool:
        api = self._api
        job = self._job_handle
        if api is None or job is None:
            return False
        process_handle = api.open_process(
            _WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION,
            False,
            pid,
        )
        if not process_handle:
            error = ctypes.get_last_error()
            if error == _WINDOWS_ERROR_INVALID_PARAMETER:
                return False
            raise OSError(error, f"OpenProcess({pid}) failed")
        try:
            belongs = api.bool_type(0)
            if not api.is_process_in_job(
                api.handle_type(int(process_handle)),
                api.handle_type(job),
                ctypes.byref(belongs),
            ):
                raise _windows_error("IsProcessInJob")
            owned = bool(belongs.value)
            if owned:
                self._verified_pids.add(pid)
            return owned
        finally:
            api.close_handle(api.handle_type(_handle_value(process_handle)))

    def _posix_owns_pid(self, pid: int) -> bool:
        group = self._process_group
        if group is None:
            return False
        try:
            owned = os.getpgid(pid) == group
        except ProcessLookupError:
            return False
        if owned:
            self._verified_pids.add(pid)
        return owned

    def close(self, timeout: float | None = None) -> None:
        """Terminate the owned process tree and wait up to ``timeout`` seconds."""
        if self._closed:
            return
        if self._close_error is not None:
            raise RuntimeError("a previous process-tree shutdown did not complete") from self._close_error
        wait_timeout = self.close_timeout if timeout is None else timeout
        if wait_timeout <= 0:
            raise ValueError("timeout must be positive")
        deadline = time.monotonic() + wait_timeout
        try:
            if os.name == "nt":
                self._close_windows(deadline)
            else:
                self._close_posix(deadline)
        except BaseException as exc:
            self._close_error = exc
            raise
        self._closed = True

    def _close_windows(self, deadline: float) -> None:
        api = self._api
        job = self._job_handle
        wait_error: BaseException | None = None
        if api is not None and job is not None:
            try:
                job_handle = api.handle_type(job)
                state = api.wait_for_single_object(job_handle, 0)
                if state == _WINDOWS_WAIT_FAILED:
                    raise _windows_error("WaitForSingleObject(job)")
                if state != _WINDOWS_WAIT_OBJECT_0 and not api.terminate_job(job_handle, 1):
                    terminate_error = ctypes.get_last_error()
                    state = api.wait_for_single_object(job_handle, 0)
                    if state != _WINDOWS_WAIT_OBJECT_0:
                        raise OSError(terminate_error, "TerminateJobObject failed")
                remaining = max(deadline - time.monotonic(), 0.0)
                result = api.wait_for_single_object(
                    job_handle,
                    min(int(remaining * 1000), 0xFFFFFFFE),
                )
                if result == _WINDOWS_WAIT_TIMEOUT:
                    wait_error = TimeoutError("owned Windows process tree did not exit in time")
                elif result == _WINDOWS_WAIT_FAILED:
                    wait_error = _windows_error("WaitForSingleObject(job)")
                elif result != _WINDOWS_WAIT_OBJECT_0:
                    wait_error = OSError(f"unexpected job wait result {result:#x}")
            except BaseException as exc:
                wait_error = exc
            finally:
                # KILL_ON_JOB_CLOSE is the final safety net even if explicit
                # termination or bounded waiting reports an error.
                if not api.close_handle(api.handle_type(job)) and wait_error is None:
                    wait_error = _windows_error("CloseHandle(job)")
                self._job_handle = None

        try:
            self.process.wait(timeout=max(deadline - time.monotonic(), 0.0))
        except subprocess.TimeoutExpired:
            if wait_error is None:
                wait_error = TimeoutError("owned Popen process did not exit in time")
        if wait_error is not None:
            raise wait_error

    def _posix_group_has_member(self) -> bool:
        group = self._process_group
        if group is None:
            return False
        for pid in self._verified_pids:
            try:
                if os.getpgid(pid) == group:
                    return True
            except ProcessLookupError:
                continue
        return False

    @staticmethod
    def _posix_group_exists(group: int) -> bool:
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def _close_posix(self, deadline: float) -> None:
        group = self._process_group
        if group is None:
            self.process.wait(timeout=max(deadline - time.monotonic(), 0.0))
            return
        if not self._posix_group_has_member():
            if self._posix_group_exists(group):
                raise RuntimeError("cannot verify ownership of the surviving POSIX process group")
            self.process.wait(timeout=max(deadline - time.monotonic(), 0.0))
            return

        try:
            os.killpg(group, signal.SIGTERM)
        except ProcessLookupError:
            pass

        grace_deadline = min(deadline, time.monotonic() + min(0.25, self.close_timeout / 4))
        while self._posix_group_exists(group) and time.monotonic() < grace_deadline:
            time.sleep(min(0.02, max(grace_deadline - time.monotonic(), 0.0)))
        if self._posix_group_exists(group):
            # The group ID was created by start_new_session and remains reserved
            # while any member is alive, so this signal cannot target a reused
            # process group while the owned group still exists.
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass

        try:
            self.process.wait(timeout=max(deadline - time.monotonic(), 0.0))
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError("owned POSIX process leader did not exit in time") from exc

        while self._posix_group_exists(group):
            if time.monotonic() >= deadline:
                raise TimeoutError("owned POSIX process group did not exit in time")
            time.sleep(min(0.02, max(deadline - time.monotonic(), 0.0)))

    def _abort_start(self) -> None:
        api = self._api
        job = self._job_handle
        cleanup_error: BaseException | None = None
        if os.name == "nt" and api is not None and job is not None:
            try:
                handle = api.handle_type(job)
                state = api.wait_for_single_object(handle, 0)
                if state != _WINDOWS_WAIT_OBJECT_0 and not api.terminate_job(handle, 1):
                    terminate_error = ctypes.get_last_error()
                    state = api.wait_for_single_object(handle, 0)
                    if state != _WINDOWS_WAIT_OBJECT_0:
                        cleanup_error = OSError(
                            terminate_error,
                            "TerminateJobObject failed during startup cleanup",
                        )
                state = api.wait_for_single_object(handle, 1000)
                if state == _WINDOWS_WAIT_TIMEOUT:
                    cleanup_error = TimeoutError("startup process tree did not exit in time")
                elif state == _WINDOWS_WAIT_FAILED and cleanup_error is None:
                    cleanup_error = _windows_error("WaitForSingleObject during startup cleanup")
                elif state != _WINDOWS_WAIT_OBJECT_0 and cleanup_error is None:
                    cleanup_error = OSError(f"unexpected startup job wait result {state:#x}")
            except OSError as exc:
                cleanup_error = exc
            finally:
                if not api.close_handle(api.handle_type(job)) and cleanup_error is None:
                    cleanup_error = _windows_error("CloseHandle during startup cleanup")
            self._job_handle = None
        elif os.name != "nt" and self._process_group is not None:
            try:
                os.killpg(self._process_group, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError as exc:
                cleanup_error = exc

        process = getattr(self, "process", None)
        if process is not None:
            if process.poll() is None:
                try:
                    process.kill()
                except OSError as exc:
                    cleanup_error = cleanup_error or exc
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired as exc:
                if cleanup_error is None:
                    cleanup_error = TimeoutError(
                        "startup process did not exit after termination"
                    )
                    cleanup_error.__cause__ = exc
            except OSError as exc:
                cleanup_error = cleanup_error or exc
        if cleanup_error is not None:
            raise RuntimeError("failed to clean up an incompletely started process") from cleanup_error

    def __enter__(self) -> OwnedProcess:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
