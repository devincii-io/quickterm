# QuickTerm session model

QuickTerm borrows tmux's most important rule: the process that owns a terminal
must outlive the UI looking at it. The FastAPI backend is the local terminal
server; a pane is only a client attachment. Closing a pane therefore does not
implicitly mean killing its process.

## Runtime hierarchy

```text
QuickTerm backend (one ordinary process per configured port)
|-- terminal session (one PTY + bounded in-memory scrollback)
|   `-- attachment (one pane/WebSocket; transient)
`-- workspace (saved layout and ownership metadata)
    `-- split tree
        `-- pane (live session view or unavailable placeholder)
```

- A **session** owns the PTY, process tree, live/dead state, activity markers,
  optional profile, and current workspace label.
- A **workspace** owns a split layout plus the session IDs that belong to it,
  including deliberately detached sessions. Its JSON is the durable ownership
  authority; the live `SessionInfo.workspace` label is synchronized whenever a
  workspace is saved, promoted, moved, or deleted.
- A **pane** owns xterm rendering and a WebSocket attachment, never the process.
  It may display a live session, an empty launch target, an exited frame, or a
  transcript-free unavailable placeholder.
- An **attachment** is disposable. Slow attachments are forced to resync from
  bounded memory instead of corrupting VT state by silently dropping bytes.

Scratch is an intentionally disposable workspace. It is saved only for the
current backend lifetime and removed on startup and clean shutdown. Named
workspaces persist layouts and IDs, but terminal transcripts never go to disk.

## Operation semantics

| Operation | Process | Workspace ownership | Pane |
|---|---|---|---|
| `D` / `Alt+D` detach | kept alive and marked retained | kept | removed |
| `X` / `Alt+W` kill | verified process-tree termination | removed on success | removed on success |
| Switch workspace | kept | unchanged | layout is replaced and live IDs reattach |
| Move here and attach | kept | moved through workspace saves | attached here |
| Restore missing ID | already gone | metadata remains until replaced or cleaned | unavailable; no fake history |
| Quit QuickTerm | all sessions end | named layout metadata remains | viewer closes |

A destructive action always has an in-app confirmation. Kill failures remain
visible. Detach first calls the retain endpoint so an untouched shell cannot be
mistaken for disposable background clutter by the idle reaper.

## Claude Code is an application session on top of a terminal session

A Claude conversation and its PTY are different identities. QuickTerm profiles
bind Claude Code to a project folder and expose Claude's native modes: new,
continue latest, session picker, and background-agent manager. If the PTY dies,
QuickTerm never claims it was resumed and never replays a disk transcript. The
unavailable pane offers explicit `--continue` or `--resume` recovery, which
starts a new PTY and asks Claude to recover its own conversation state.

## Focus and desktop ownership invariants

- One ordinary Windows viewer is canonical. A second launch queues its folder
  request to the authenticated backend, summons the existing window, and exits.
  Elevated UAC terminals remain isolated by design.
- A new, split, or attached pane receives focus immediately, after its terminal
  is created, and after replay finishes. Each delayed callback first verifies
  that the pane is still selected, so it cannot steal focus later.
- Sidebar actions and profile cycling return focus to the selected terminal.
- Native `Ctrl+V` and `Ctrl+Shift+V` reach xterm unchanged. QuickTerm uses a
  small cold Alt layer for workspace actions and leaves documented shell and
  Claude keys alone.

## tmux feature map

Implemented now: server-owned PTYs, attach/detach, named sessions, nested split
trees, directional focus, resize/balance, zoom, renaming, background-output
attention, bounded replay, named saved layouts, workspace/global inventory,
command palette, kill confirmation, and session reattachment while the backend
is alive.

Useful later, in priority order:

1. A **window/tab layer** inside a workspace, matching tmux's
   session -> window -> pane hierarchy without opening another OS viewer.
2. Pane **break/join/swap/rotate** operations and drag targets for moving panes
   between workspace windows.
3. A searchable **copy mode** over bounded memory, plus optional user-controlled
   export. Export must remain explicit so the no-transcript default holds.
4. Target syntax and a command mode for automation (`workspace:window.pane`),
   followed by a small read-only control API and lifecycle hooks.
5. Opt-in synchronized input, pane broadcast, and richer activity/bell markers.

tmux multi-user ACLs and remote server exposure are deliberate non-goals for
the current local, per-Windows-user security model. Implementing them would
require a new authentication and authorization design rather than exposing the
loopback token more broadly.
