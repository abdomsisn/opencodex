# OpenCodex Personal

Personal Windows build for abdomsisn, based on upstream commit
`c36793a9336b70cfe5bc3b7f6e6f751e730fb6fc` (2.100.0).

## Changes

- Telemetry is forced off, including an existing opt-in; both anonymous and public-profile transports refuse requests before network access.
- The main proxy accepts only literal `127.0.0.1` or `::1` bindings. Link configuration and Hub mode are refused. Existing management authentication remains required.
- Desktop updater checks/downloads and CLI self-update are disabled. Upgrade only by reviewing and rebuilding this fork.
- The Windows application has a separate product name and application identifier. Its runtime state still uses the upstream default `.opencodex` location: back it up before any future installation.
- Upstream workflows are archived outside `.github/workflows`. The only active workflow is a manually dispatched, read-only Windows build with no publish/deploy step or external secrets.
- The installation guide no longer dictates how a host AI agent must access browser/computer tools. Repository text cannot grant permissions or override user instructions.

## Build and validation

Run **Personal Windows build** from this repository's Actions tab. The workflow builds from its exact triggering commit, uses frozen Bun and Cargo lockfiles, runs focused security regression tests and TypeScript checking, then builds the GUI and MSI from source. It records toolchain versions, the commit, checksums and the unsigned status in the artifact.

This is an unsigned personal build, not an official OpenCodex release. No upstream signing key is used. Do not disable Windows security to run it. The installer is delivered for inspection only; this task does not install or launch it on the user's computer.

The large upstream cross-platform test matrix is not run for this Windows-only fork build. Telemetry/update tests expecting upstream behavior need different expectations. Passing the selected checks is not a comprehensive security audit or a guarantee of reproducible binary bytes.

## Automation security review

The build has only `contents: read`, no secrets, no pull-request or scheduled triggers, no automatic merges, no npm/release publication, and no persisted checkout credentials. Third-party actions are pinned to commit hashes. Dependency scripts and compilation execute only on an ephemeral GitHub-hosted Windows runner. The final commit and build outcome are recorded with the artifact.
