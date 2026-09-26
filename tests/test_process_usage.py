import os
import subprocess
import sys
import time

import pytest

from quickterm import process_usage
from quickterm.process_usage import (
    ProcessSample,
    descendants,
    drop_reused_links,
    pids_with_children,
    process_identities,
    reachable_pids,
    snapshot_processes,
    summarize_trees,
)


def test_summarize_trees_includes_root_and_all_descendants():
    processes = {
        10: ProcessSample(parent_pid=1, working_set_bytes=100, cpu_time_s=1.0),
        11: ProcessSample(parent_pid=10, working_set_bytes=200, cpu_time_s=2.0),
        12: ProcessSample(parent_pid=11, working_set_bytes=300, cpu_time_s=3.0),
        20: ProcessSample(parent_pid=1, working_set_bytes=400, cpu_time_s=4.0),
    }

    totals = summarize_trees(processes, {10, 20, 99})

    assert totals[10].working_set_bytes == 600
    assert totals[10].cpu_time_s == 6.0
    assert totals[10].process_count == 3
    assert totals[20].working_set_bytes == 400
    assert totals[99].process_count == 0


def test_reachable_pids_survives_a_cycle_and_a_missing_root():
    # 3 -> 4 -> 3 is a cycle (possible with PID reuse); 99 is not in the table.
    identities = [(2, 1), (3, 2), (4, 3), (3, 4), (5, 4), (7, 6)]
    assert reachable_pids(identities, {2}) == {2, 3, 4, 5}
    assert reachable_pids(identities, {99}) == {99}
    assert reachable_pids(identities, set()) == set()
    assert descendants(identities, 2) == {3, 4, 5}
    assert descendants(identities, 99) == set()


def test_pids_with_children_uses_the_given_snapshot():
    assert pids_with_children([(2, 1), (3, 2), (4, 0)]) == {1, 2}


def test_a_parent_younger_than_its_child_is_not_its_parent():
    # PID 10 died; its orphan 11 still names it. A new process got PID 10.
    created = {10: 500, 11: 300, 12: 600, 13: None}
    identities = [(10, 1), (11, 10), (12, 10), (13, 10), (14, 10)]
    assert drop_reused_links(identities, created) == [
        (10, 1),
        (11, 0),  # the orphan is cut loose
        (12, 10),  # a real child, created after its parent
        (13, 10),  # unknown creation time: keep the link
        (14, 10),
    ]


@pytest.fixture
def sleeping_child():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        yield child
    finally:
        child.kill()
        child.wait(5)


def test_process_table_sees_a_real_child(sleeping_child):
    me = os.getpid()
    identities = process_identities()
    assert (sleeping_child.pid, me) in identities
    assert me in pids_with_children(identities)
    assert sleeping_child.pid in descendants(identities, me)

    samples = snapshot_processes({me}, identities)
    sample = samples[sleeping_child.pid]
    assert sample.parent_pid == me
    assert sample.cpu_time_s >= 0
    assert sample.working_set_bytes > 0
    assert set(samples) <= reachable_pids(identities, {me})


@pytest.mark.skipif(os.name == "nt", reason="/proc parser")
def test_linux_counters_come_from_the_right_stat_fields():
    """utime/stime are fields 14/15 and rss field 24; an off-by-one reads garbage."""
    child = subprocess.Popen(
        [sys.executable, "-c", "import time\nt=time.process_time()\n"
         "while time.process_time()-t<0.3: pass\ntime.sleep(30)"],
    )
    try:
        time.sleep(0.8)
        sample = snapshot_processes({child.pid})[child.pid]
        assert 0.2 <= sample.cpu_time_s < 5  # it burned ~0.3 s of CPU
        # A running interpreter has a few MB resident, never a page count.
        assert 2 * 1024 * 1024 < sample.working_set_bytes < 1024 * 1024 * 1024
    finally:
        child.kill()
        child.wait(5)


@pytest.mark.skipif(os.name == "nt", reason="POSIX sessions")
def test_session_process_groups_lists_live_members_only():
    child = subprocess.Popen(["sleep", "30"], start_new_session=True)
    try:
        assert process_usage.session_process_groups(child.pid) == {child.pid: child.pid}
    finally:
        child.kill()
    # Killed but not yet reaped: a zombie is not a member any more.
    deadline = time.monotonic() + 5
    while process_usage.session_process_groups(child.pid):
        assert time.monotonic() < deadline
        time.sleep(0.02)
    child.wait(5)
    assert process_usage.session_process_groups(child.pid) == {}
