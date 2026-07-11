"""Rough output-throughput benchmark for QuickTerm.

Spawns a child that dumps a large burst of output and times how long it takes to
stream through the SessionManager fan-out, plus how many coalesced frames the
attachment saw (fewer frames = better coalescing).

Run:  uv run --no-sync python scripts/bench_throughput.py [megabytes]
"""

from __future__ import annotations

import asyncio
import sys
import time

from quickterm.session_manager import SessionManager

LINE = b"0123456789ABCDEF" * 4  # 64 bytes + newline


async def main(mb: float) -> None:
    loop = asyncio.get_running_loop()
    mgr = SessionManager(loop)
    lines = int(mb * 1_000_000 / (len(LINE) + 1))
    # sys.executable guarantees the child interpreter exists regardless of PATH.
    script = (
        "import sys\n"
        f"buf=('{LINE.decode()}\\n')*1000\n"
        f"n={lines}\n"
        "w=sys.stdout.write\n"
        "for _ in range(n//1000): w(buf)\n"
    )
    info = mgr.spawn(cmd=sys.executable, args=["-c", script])
    att = mgr.attach(info.id)

    total = 0
    frames = 0
    t0 = time.monotonic()
    while True:
        item = await att.queue.get()
        if item is None:
            break
        total += len(item)
        frames += 1
    dt = time.monotonic() - t0

    rate = (total / 1e6 / dt) if dt else 0.0
    per_frame = (total / frames) if frames else 0
    print(
        f"{total / 1e6:6.1f} MB seen in {dt:5.2f}s  ->  {rate:6.1f} MB/s  "
        f"over {frames} frames ({per_frame:,.0f} B/frame)\n"
        "(bytes may undercount vs produced: the 256-slot attachment queue drops "
        "oldest under backpressure; wall-clock + frame count are the signal.)"
    )
    mgr.shutdown()


if __name__ == "__main__":
    megabytes = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
    asyncio.run(main(megabytes))
