# Security and company deployment

QuickTerm is a local terminal workspace, not a security boundary. It can be
used on a company workstation when the organization accepts the behavior and
limitations below. This document describes the implementation; it does not
claim a certification or guarantee suitability for every regulated setting.

## Implemented controls

- The server binds to loopback (`127.0.0.1`) and rejects unexpected `Host` and
  browser `Origin` values.
- Sensitive HTTP and WebSocket routes require a random per-install token. The
  token is stored under the signed-in user's `%APPDATA%\quickterm` directory.
- There are no accounts, analytics, advertising, or usage telemetry. Terminal
  I/O and resource measurements are not sent to Fichtel Systems or another
  service.
- Terminal scrollback is held in backend memory while a session lives. Saved
  workspace files retain layout, profile, folder, and live-session IDs, not a
  persistent transcript of terminal output.
- Update checks are optional. They contact the pinned QuickTerm GitHub
  repository; installer downloads are accepted only from that release payload
  and checked against its published `SHA256SUMS.txt` entry.
- New terminal creation can be capped. The cap never terminates existing work;
  it rejects later spawns until the live count falls below the configured value.

## Boundaries and limitations

- Every shell and program runs with the QuickTerm user's OS permissions.
  QuickTerm does not sandbox commands, inspect scripts, filter terminal output,
  or prevent a user from exfiltrating data through tools they launch.
- The local token protects against web pages and accidental API access. It is
  not protection against malware, administrators, or another program already
  running as the same Windows user and able to read that user's files or memory.
- Administrator terminals require a separate Windows UAC-approved launch.
  QuickTerm cannot make an elevated command safe; Windows policy remains the
  authority.
- Unsigned releases can trigger SmartScreen, and a new trusted signing identity
  can still warn while reputation builds. A hash
  published beside a release detects corruption relative to that release, but
  does not replace enterprise publisher trust or an internal software review.
- There is no built-in RBAC, central policy, audit log, transcript retention,
  DLP, SIEM export, or remote administration. Use OS and company tooling where
  those controls are required.

## Resource tracker accuracy and privacy

Measurements are collected only when the local sessions API is queried. They
are neither persisted nor transmitted. RAM means the sum of each host process'
current working set, so shared pages can be counted in more than one terminal.
CPU is the change in process-tree CPU time between samples; `100%` is one
logical CPU and parallel workloads may exceed it. Short-lived processes can
start or exit between snapshots.

For native Windows and POSIX terminals, the tracker includes the shell root and
visible descendants. For WSL it reports only the Windows host-side process tree;
Linux processes and their memory inside the shared WSL VM are not reliably
attributable to an individual terminal. The UI labels this limitation instead
of presenting a misleading full figure. Measurements may also be unavailable
when the OS denies process-query access.

## Suggested IT review

Before broad deployment, an administrator should:

1. Verify the release source and artifact hashes; require code signing if policy
   demands it.
2. Package QuickTerm through the organization's software distribution system
   and define an update policy (in-app checks can be disabled).
3. Apply least privilege, application control, endpoint protection, logging,
   and data-loss controls at the OS level.
4. Review allowed terminal profiles, environment variables, starting folders,
   global hotkeys, and the live-terminal cap.
5. Confirm that in-memory scrollback and local workspace metadata meet the
   organization's retention and incident-response requirements.

## SmartScreen and release signing

The current GitHub release artifacts are not Authenticode-signed, so Windows
can show an unknown-publisher SmartScreen warning. A self-signed certificate is
not a public-distribution fix: recipient machines do not trust it by default,
and Microsoft treats it like an unsigned file for SmartScreen reputation.

For public GitHub distribution, the practical options are:

1. **Microsoft Artifact Signing, Public Trust.** This is Microsoft's preferred
   managed signing service for non-Store distribution. It requires a paid Azure
   subscription and identity validation. Public Trust organization validation
   is currently offered in the European Union; individual Public Trust
   validation is currently limited to the USA and Canada. Fichtel Systems must
   therefore qualify and validate as its legal organization identity to use
   this route from Germany.
2. **A public Authenticode certificate from a trusted commercial CA.** Keep its
   private key in approved protected storage and use the same publisher identity
   consistently across releases.
3. **Microsoft Store distribution.** Microsoft re-signs Store apps; Microsoft
   describes this as the simplest and most reliable way to avoid SmartScreen
   download warnings.

OV and EV certificates both establish a verified publisher, but Microsoft no
longer gives EV certificates an automatic SmartScreen reputation bypass. A new
valid signing identity or new binary may still warn until publisher or file-hash
reputation accumulates. Signing every release consistently is what allows
publisher reputation to carry between versions.

The release pipeline should sign and RFC 3161 timestamp, in this order:

1. Build the PyInstaller application folder.
2. Sign `dist\QuickTerm\QuickTerm.exe` (and any first-party executable or DLL).
3. Build the Inno Setup installer so it contains the signed application.
4. Sign `dist\QuickTerm-v<version>-Setup.exe`.
5. Verify both signatures with the Windows Authenticode policy, then create the
   portable zip and `SHA256SUMS.txt` from the final signed bytes.

With a conventional certificate and Windows SDK SignTool, use SHA-256 for the
file and timestamp digests and an RFC 3161 timestamp URL supplied by the CA.
Verification should use `signtool verify /pa /all /v <file>`. Do not put a PFX
password or cloud signing credential in this repository; inject signing access
from protected CI or release-machine secret storage.
