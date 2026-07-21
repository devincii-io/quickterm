# QuickTerm 2.0.3

This security release hardens terminal profile environment variables from
storage through process launch without changing normal profile behavior.

## Environment security

- Encrypts profile environment values at rest with Windows current-user DPAPI
  and automatically migrates existing plaintext values.
- Protects administrator-terminal launch specifications with DPAPI instead of
  placing recoverable Base64 JSON in the process command line.
- Rejects malformed names, NUL characters, case-insensitive duplicates, and
  oversized environment payloads consistently across config, API, UAC, and PTY
  entry points.
- Caps configuration/session JSON requests before buffering and prevents
  sensitive API responses from being cached.

## Local secret handling

- Creates the local auth token atomically and enforces user-only token/config
  permissions on POSIX fallback systems.
- Enables raw terminal I/O logging only for the exact value
  `QUICKTERM_DEBUG_IO=1`; values such as `0` no longer activate it accidentally.
- Warns in the log whenever raw input tracing is enabled and documents that
  child processes inherit profile variables.

## Compatibility

- Keeps the public in-memory and API environment shape as `dict[str, str]`.
- Continues accepting legacy plaintext config values and rewrites them securely
  after a successful load.

Validated with 184 tests, Ruff, frontend syntax checks, Windows DPAPI
round-trips, and a packaged application smoke test covering encrypted config,
real ConPTY environment delivery, authentication, and dynamic routes.
