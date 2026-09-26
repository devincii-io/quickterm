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


def reachable_pids(
    identities: "list[tuple[int, int]]", root_pids: set[int]
) -> set[int]:
    """PIDs reachable from any root, given cheap (pid, parent) pairs.

    Opening a handle and reading counters for every process on the machine is
    the expensive part of a snapshot, and everything outside the session trees
    is discarded again by summarize_trees. Walking the parent map first lets
    the caller sample only what it will actually use.
    """
    children: dict[int, list[int]] = {}
    for pid, parent in identities:
        children.setdefault(parent, []).append(pid)
    seen: set[int] = set()
    pending = list(root_pids)
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        pending.extend(children.get(pid, ()))
    return seen


def pids_with_children(identities: "list[tuple[int, int]] | None" = None) -> set[int]:
    """PIDs that have at least one direct child, from one process-table snapshot.

    A session is "busy" exactly when its root PID is in this set.
    """
    if identities is None:
        identities = process_identities()
    return {parent for _pid, parent in identities if parent}


def descendants(identities: "list[tuple[int, int]]", root: int) -> set[int]:
    """Every process below ``root`` (the root itself excluded)."""
    return reachable_pids(identities, {root}) - {root}


def drop_reused_links(
    identities: "list[tuple[int, int]]", created: "dict[int, int | None]"
) -> list[tuple[int, int]]:
    """Cut every parent link whose parent was created after the child.

    Windows reuses PIDs quickly and an orphan keeps naming its dead parent's
    PID. Without this check a new session root that inherits that PID adopts
    the orphan: the session reads as busy forever and its metrics include an
    unrelated process. A real parent always exists before its child. When a
    creation time is unknown (protected processes, a process that exited
    mid-snapshot) the link is kept, which is what the code did before.
    """
    guarded: list[tuple[int, int]] = []
    for pid, parent in identities:
        if parent:
            parent_created = created.get(parent)
            child_created = created.get(pid)
            if (
                parent_created is not None
                and child_created is not None
                and parent_created > child_created
            ):
                parent = 0
        guarded.append((pid, parent))
    return guarded


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
        # PROCESS_VM_READ is not required by GetProcessMemoryInfo on any
        # supported Windows version, and asking for it makes OpenProcess fail
        # on processes we could otherwise measure.
        handle = _k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
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

    def _creation_ticks(pid: int) -> int | None:
        handle = _k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return None
        try:
            created = wintypes.FILETIME()
            exited = wintypes.FILETIME()
            kernel = wintypes.FILETIME()
            user = wintypes.FILETIME()
            if not _k32.GetProcessTimes(
                ctypes.c_void_p(handle),
                ctypes.byref(created),
                ctypes.byref(exited),
                ctypes.byref(kernel),
                ctypes.byref(user),
            ):
                return None
            return (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)
        finally:
            _k32.CloseHandle(ctypes.c_void_p(handle))

    def process_identities() -> list[tuple[int, int]]:
        """(pid, parent_pid) for every process, from one Toolhelp snapshot.

        A parent link survives only when the parent is not younger than the
        child (drop_reused_links); a cut link reports parent 0. That costs one
        OpenProcess and GetProcessTimes per process, about 12 ms for 400
        processes.
        """
        snap = _k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
        if not snap or snap == _INVALID_HANDLE:
            return []
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
        created = {pid: _creation_ticks(pid) for pid, _parent in identities}
        return drop_reused_links(identities, created)

    def snapshot_processes(
        roots: set[int] | None = None,
        identities: list[tuple[int, int]] | None = None,
    ) -> dict[int, ProcessSample]:
        """Sample process counters. With ``roots``, only their trees."""
        if identities is None:
            identities = process_identities()
        wanted = reachable_pids(identities, roots) if roots is not None else None
        result: dict[int, ProcessSample] = {}
        for pid, parent in identities:
            if wanted is not None and pid not in wanted:
                continue
            counters = _windows_counters(pid)
            if counters is not None:
                result[pid] = ProcessSample(parent, counters[0], counters[1])
        return result

else:
    def _proc_stat_tail(name: str) -> list[bytes] | None:
        try:
            with open(f"/proc/{name}/stat", "rb") as handle:
                raw = handle.read()
        except OSError:
            return None  # process vanished or access was denied
        # pid (comm) state ppid ...; comm may contain spaces and parentheses,
        # so split after the LAST ')'.
        return raw[raw.rfind(b")") + 2 :].split()

    def process_identities() -> list[tuple[int, int]]:
        """(pid, parent_pid) for every process in /proc; empty without /proc."""
        try:
            entries = os.listdir("/proc")
        except OSError:
            return []
        identities: list[tuple[int, int]] = []
        for name in entries:
            if not name.isdigit():
                continue
            tail = _proc_stat_tail(name)
            try:
                identities.append((int(name), int(tail[1])))  # type: ignore[index]
            except (TypeError, ValueError, IndexError):
                continue
        return identities

    def session_process_groups(session_id: int) -> dict[int, int] | None:
        """{pid: process group} of every live process in POSIX session ``session_id``.

        Zombies are left out: they hold no terminal and cannot be killed
        again, only reaped by their parent. ``None`` when /proc cannot be
        listed (macOS, BSD), so the caller knows it has no answer.
        """
        try:
            entries = os.listdir("/proc")
        except OSError:
            return None
        members: dict[int, int] = {}
        for name in entries:
            if not name.isdigit():
                continue
            # state ppid pgrp session ...: field 6 of the full line is the
            # session id.
            tail = _proc_stat_tail(name)
            try:
                if int(tail[3]) != session_id or tail[0] in (b"Z", b"X"):  # type: ignore[index]
                    continue
                members[int(name)] = int(tail[2])  # type: ignore[index]
            except (TypeError, ValueError, IndexError):
                continue
        return members

    def snapshot_processes(
        roots: set[int] | None = None,
        identities: list[tuple[int, int]] | None = None,
    ) -> dict[int, ProcessSample]:
        """Read Linux /proc counters; return unavailable on other POSIX systems.

        With ``roots``, only the processes in those trees are read.
        """
        try:
            clock_ticks = os.sysconf("SC_CLK_TCK")
            page_size = os.sysconf("SC_PAGE_SIZE")
        except (OSError, ValueError):
            return {}
        if identities is None:
            identities = process_identities()
        wanted = reachable_pids(identities, roots) if roots is not None else None
        samples: dict[int, ProcessSample] = {}
        for pid, _parent in identities:
            if wanted is not None and pid not in wanted:
                continue
            tail = _proc_stat_tail(str(pid))
            try:
                parent = int(tail[1])  # type: ignore[index]
                cpu = (int(tail[11]) + int(tail[12])) / clock_ticks  # type: ignore[index]
                memory = int(tail[21]) * page_size  # type: ignore[index]
            except (TypeError, ValueError, IndexError):
                continue  # vanished between the two reads, or a malformed row
            samples[pid] = ProcessSample(parent, memory, cpu)
        return samples
