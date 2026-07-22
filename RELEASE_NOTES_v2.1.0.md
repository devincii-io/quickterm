# QuickTerm 2.1.0

## SSH and SFTP terminals, powered by bundled PuTTY

- **New terminal types: SSH and SFTP.** Create a profile in Settings →
  Terminals with a host, optional port, username and PuTTY `.ppk` private
  key. Sessions run through the bundled PuTTY `plink`/`psftp` — no separate
  install needed. Passphrases and passwords are never stored; you are
  prompted inside the terminal.
- **`pscp`, `plink` and `psftp` work in every terminal.** The bundled tools
  folder is appended to each session's `PATH`, so one-off transfers are as
  simple as `pscp file.txt user@host:/tmp/`. A tool you installed yourself
  still takes precedence.
- **SSH remote command.** An SSH profile can run a single remote command
  instead of opening a shell.
- The PuTTY binaries (release 0.84) are pinned and SHA-256-verified against
  the official published checksums at build time. Licences ship in
  `THIRD-PARTY-NOTICES.md`.

## Fixes and details

- Settings: picking Git Bash or Nushell as a profile's type now fills in the
  detected executable path automatically.
- The launcher lists SSH/SFTP under personal profiles only; system entries
  stay limited to shells that work without configuration.
