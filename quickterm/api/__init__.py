"""REST and WebSocket routes, one module per route group.

Each module exposes `register(app, ctx)`; `quickterm.server.create_app` builds
the shared `ApiContext`, installs the guard and calls them in turn.
"""
