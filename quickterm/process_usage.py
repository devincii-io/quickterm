"""Lightweight host process-tree resource snapshots.

The tracker intentionally uses OS counters directly instead of a resident
sampler or telemetry dependency.  A snapshot is taken only when the local API
is queried, and nothing is persisted or sent off the machine.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class ProcessSample:
    parent_pid: int
    working_set_bytes: int
    cpu_time_s: float


@dataclass(frozen=True)
class TreeUsage:
    working_set_bytes: int
    cpu_time_s: float
    process_count: int


def summarize_trees(
    processes: dict[int, ProcessSample], root_pids: set[int]
) -> dict[int, TreeUsage]:
    """Sum each root and all descendants from one internally consistent snapshot."""
    children: dict[int, list[int]] = {}
    for pid, sample in processes.items():
        children.setdefault(sample.parent_pid, []).append(pid)

    totals: dict[int, TreeUsage] = {}
    for root in root_pids:
        memory = 0
        cpu = 0.0
        count = 0
        pending = [root]
        seen: set[int] = set()
        while pending:
            pid = pending.pop()
            if pid in seen:
                continue
            seen.add(pid)
            sample = processes.get(pid)
            if sample is not None:
                memory += sample.working_set_bytes
                cpu += sample.cpu_time_s
                count += 1
            pending.extend(children.get(pid, ()))
        totals[root] = TreeUsage(memory, cpu, count)
    return totals


if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _TH32CS_SNAPPROCESS = 0x00000002
    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _PROCESS_VM_READ = 0x0010
    _INVALID_HANDLE = ctypes.c_void_p(-1).value

    class _PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    class _PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
            ("PrivateUsage", ctypes.c_size_t),
        ]

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _psapi = ctypes.WinDLL("psapi", use_last_error=True)
    _k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    _k32.OpenProcess.restype = ctypes.c_void_p

    def _filetime_seconds(value: wintypes.FILETIME) -> float:
        ticks = (int(value.dwHighDateTime) << 32) | int(value.dwLowDateTime)
        return ticks / 10_000_000.0

    def _windows_counters(pid: int) -> tuple[int, float] | None:
        handle = _k32.OpenProcess(
            _PROCESS_QUERY_LIMITED_INFORMATION | _PROCESS_VM_READ, False, pid
        )
        if not handle:
            return None
        try:
            counters = _PROCESS_MEMORY_COUNTERS_EX()
            counters.cb = ctypes.sizeof(counters)
            memory = 0
            if _psapi.GetProcessMemoryInfo(
                ctypes.c_void_p(handle), ctypes.byref(counters), counters.cb
            ):
                memory = int(counters.WorkingSetSize)
            created = wintypes.FILETIME()
            exited = wintypes.FILETIME()
            kernel = wintypes.FILETIME()
            user = wintypes.FILETIME()
            cpu = 0.0
            if _k32.GetProcessTimes(
                ctypes.c_void_p(handle),
                ctypes.byref(created),
                ctypes.byref(exited),
                ctypes.byref(kernel),
                ctypes.byref(user),
            ):
                cpu = _filetime_seconds(kernel) + _filetime_seconds(user)
            return memory, cpu
        finally:
            _k32.CloseHandle(ctypes.c_void_p(handle))

    def snapshot_processes() -> dict[int, ProcessSample]:
        snap = _k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
        if not snap or snap == _INVALID_HANDLE:
            return {}
        identities: list[tuple[int, int]] = []
        try:
            entry = _PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(entry)
            ref = ctypes.byref(entry)
            if _k32.Process32FirstW(ctypes.c_void_p(snap), ref):
                while True:
                    identities.append(
                        (int(entry.th32ProcessID), int(entry.th32ParentProcessID))
                    )
                    if not _k32.Process32NextW(ctypes.c_void_p(snap), ref):
                        break
        finally:
            _k32.CloseHandle(ctypes.c_void_p(snap))

        result: dict[int, ProcessSample] = {}
        for pid, parent in identities:
            counters = _windows_counters(pid)
            if counters is not None:
                result[pid] = ProcessSample(parent, counters[0], counters[1])
        return result

else:
    def snapshot_processes() -> dict[int, ProcessSample]:
        """Read Linux /proc counters; return unavailable on other POSIX systems."""
        try:
            entries = os.listdir("/proc")
            clock_ticks = os.sysconf("SC_CLK_TCK")
            page_size = os.sysconf("SC_PAGE_SIZE")
        except (OSError, ValueError):
            return {}
        result: dict[int, ProcessSample] = {}
        for name in entries:
            if not name.isdigit():
                continue
            try:
                with open(f"/proc/{name}/stat", "rb") as handle:
                    raw = handle.read()
                tail = raw[raw.rfind(b")") + 2 :].split()
                parent = int(tail[1])
                cpu = (int(tail[11]) + int(tail[12])) / clock_ticks
                memory = int(tail[21]) * page_size
                result[int(name)] = ProcessSample(parent, memory, cpu)
            except (OSError, ValueError, IndexError):
                continue  # process vanished, access was denied, or row was malformed
        return result
