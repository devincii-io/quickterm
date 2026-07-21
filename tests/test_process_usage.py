from quickterm.process_usage import ProcessSample, summarize_trees


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
