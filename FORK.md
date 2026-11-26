# OpenCodex Personal

Personal Windows build for abdomsisn, based on upstream commit
`c36793a9336b70cfe5bc3b7f6e6f751e730fb6fc` (2.100.0).

## Changes

- Telemetry is forced off, including an existing opt-in; both anonymous and public-profile transports refuse requests before network access.
- The main proxy accepts only literal `127.0.0.1` or `::1` bindings. Link configuration and Hub mode are refused. Existing management authentication remains required.
- The Windows x64 desktop updater checks this fork's dedicated release channel. Its pinned personal key verifies each MSI and binds the signature to its advertised version. The CLI self-update remains disabled.
- The Windows application has a separate product name and application identifier. Its runtime state still uses the upstream default `.opencodex` location: back it up before any future installation.
- Upstream workflows are archived outside `.github/workflows`. The only active workflow is a manually dispatched, read-only Windows build with no publish/deploy step or external secrets.
- The installation guide no longer dictates how a host AI agent must access browser/computer tools. Repository text cannot grant permissions or override user instructions.

## Build and validation

Run **Personal Windows build** from this repository's Actions tab. The workflow builds from its exact triggering commit, uses frozen Bun and Cargo lockfiles, runs focused security regression tests and TypeScript checking, then builds the GUI and MSI from source. It records toolchain versions, the commit, checksums and the unsigned status in the artifact.

The workflow's output is an unsigned build artifact, not a release. Personal update packages are signed locally for Tauri. This signature is separate from Windows Authenticode.

## Personal Windows update channel

Existing installations with updater support disabled require a one-time MSI upgrade. Install the channel-enabled MSI after ending active Codex requests. Subsequent updates appear under the dashboard's desktop update button. The app checks for newer versions, verifies the downloaded package, and waits for the proxy to stop before launching the installer.

For each release, align the desktop versions in `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, build the MSI from the reviewed fork, then prepare the signed MSI and `latest.json` locally:

```powershell
./desktop/scripts/personal-windows-update.ps1 -Installer <built-msi> -OutputDirectory <new-output-directory> -Minisign <minisign.exe>
```

The signer reads the Minisign private key from the current user's restricted `OpenCodexPersonalSigning` directory under LocalAppData. Keep an encrypted backup of the private key under the owner's control. The build workflow has no signing credentials. The release script checks the MSI product and version and verifies the signature against the app's pinned public key.

Review the package before publishing to the `personal-windows-updates` release in `abdomsisn/opencodex`. Upload the versioned MSI as a new asset, verify its download, then upload or replace `latest.json` last. Never replace an existing versioned MSI. The release is the only desktop update feed. Both GitHub's repository permissions and possession of the private signing key are required to publish a trusted update.

The large upstream cross-platform test matrix is not run for this Windows-only fork build. Telemetry/update tests expecting upstream behavior need different expectations. Passing the selected checks is not a comprehensive security audit or a guarantee of reproducible binary bytes.

## Automation security review

The build has only `contents: read`, no secrets, no pull-request or scheduled triggers, no automatic merges, no npm/release publication, and no persisted checkout credentials. Third-party actions are pinned to commit hashes. Dependency scripts and compilation execute only on an ephemeral GitHub-hosted Windows runner. The final commit and build outcome are recorded with the artifact.
