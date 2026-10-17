# Azure Nightly fork releases

The fork uses `com.jonathanm10.t3code.azure`, `T3 Code (Azure Nightly)` and the
`t3code-azure` protocol. The existing update controls consume the public
`Jonathanm10/t3code-azure-nightly` Nightly feed. Core and MCP tarballs accompany
the desktop release; neither needs a private registry.

## Enable the release controller

Keep Actions disabled until the controller and protections have been reviewed.
The workflow runs only from `release-control`. Make that the default branch for
scheduled runs, restrict writes to it, and protect its workflows and release
scripts from the integration bot. The bot can update candidate refs and the
maintained `azure-nightly` branch. It must have no bypass for `release-control`.

Create the `azure-nightly-release` environment with a deployment branch rule
allowing only `release-control`. Store signing secrets exclusively in this
environment, never as repository or organization secrets accessible to candidate
workflows. Configure GitHub immutable releases and make the release repository
public before enabling publication. Private preparation repositories fail the
publisher gate. Disable the inherited upstream release, npm, AUR and deployment
workflows in the fork; this workflow publishes only macOS arm64 and two tarballs.

Set these repository variables from the intended public build configuration.
Their absence fails the candidate before building.

| Repository variable                | Purpose                     |
| ---------------------------------- | --------------------------- |
| `T3CODE_CLERK_PUBLISHABLE_KEY`     | Public Clerk frontend key   |
| `T3CODE_CLERK_JWT_TEMPLATE`        | Connect token template      |
| `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` | CLI OAuth client identifier |
| `T3CODE_RELAY_URL`                 | HTTPS Connect relay URL     |

Set these environment references after the intended publisher's Developer ID
identity and notarization access are explicitly approved. Select the exact
certificate by its SHA-1 fingerprint.

| Environment setting                                    | Kind                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `FORK_SIGNING_P12_BASE64`, `FORK_SIGNING_P12_PASSWORD` | Secrets                                                              |
| `FORK_NOTARY_KEY_BASE64`                               | Secret containing the base64 App Store Connect API private key       |
| `FORK_SIGNING_IDENTITY_SHA1`, `FORK_APPLE_TEAM_ID`     | Variables identifying the approved Developer ID certificate and team |
| `FORK_NOTARY_KEY_ID`, `FORK_NOTARY_ISSUER`             | Variables identifying the notarization API key                       |

The hourly controller skips unchanged upstream and maintained-fork commits using
the last successful release provenance. Manual dispatch forces a build for
acceptance or an explicit rebuild. It resolves a published upstream Nightly tag to its concrete commit
and merges it into a candidate based on `azure-nightly`. Conflicts stop the run.
The fork version advances past every existing fork version, including reserved
drafts, and retains the supported `X.Y.Z-nightly.YYYYMMDD.N` format. Candidate
installation, checks and packaging run in a separate job without signing secrets.
Standalone tarballs are packed from the clean source before the four desktop release
manifests are stamped or the production build generates files. Signing rejects
standalone packages whose provenance records a dirty source tree.

The signing job checks out only the trusted controller commit. It validates and
extracts the candidate as data, imports the approved identity into an ephemeral
Keychain using a compiled Security-framework helper, signs, verifies, notarizes
and staples the application and DMG. Passphrases travel through stdin, never
process arguments. No candidate binary, dependency script or executable runs in
this job. The identity import and Keychain ACL need a real signed CI run before
they can be considered proven.

Only a checked, signed and notarized source commit advances `azure-nightly`.
Publication creates a new draft, uploads the complete asset set, downloads and
hashes every draft asset, then publishes once. An existing tag is never updated.
The publisher verifies immutable-release status and downloads the public assets
again. Failures leave the previous release available and retain incomplete drafts
for diagnosis. Inspect the failed run; do not reuse its reserved version or edit
its assets. The release history lookup is bounded to 1,000 entries.

## Isolated updater acceptance

Normal fork launches use `~/.t3-azure-nightly/default`. Launch state cannot select
official `~/.t3`, official Electron profiles or Windows credential migration.
Development retains the backend home selected by `--home-dir` or the worktree
launcher, including worktrees under `~/.t3/worktrees`. Clerk uses that home's
`userdata` directory. Official backend and Electron profile paths, including
symlink aliases, are rejected before creating profile files. Electron development
data remains in the separate fork profile. Both desktop build preparation and
bootstrap require the reviewed Electron version in
`scripts/lib/desktop-electron-version.ts`. Review native storage initialization
order before upgrading that pin.

For updater proof, place the unmodified signed application in this reserved layout
using canonical real paths and no symlinked ancestors.

```text
<owned-root>/.t3-desktop-isolated/update-proof/
  profile.json
  Applications/T3 Code (Azure Nightly).app
  data/
```

The binding is outside the replaced app and must contain this identity.

```json
{
  "version": 1,
  "profileId": "update-proof",
  "bundleId": "com.jonathanm10.t3code.azure",
  "appName": "T3 Code (Azure Nightly).app"
}
```

A missing, inconsistent or escaping binding fails before Clerk or safeStorage.
Both A and B resolve the binding from their executable path after Squirrel
relaunches without inherited arguments or environment variables. The synchronous
bootstrap sets the application name, userData, sessionData, logs and crash paths
before main loads. Clerk storage/lock, backend state, preview sessions, compile
cache and updater cache derive from the same profile. The non-secret
`data/backend/desktop-profile.json` records the running PID, version, resolved
paths and derived Keychain service/account for inspection.

Native Clerk passkeys are absent. Fork packages carry no inherited passkey
entitlements. In proof mode, preview response policy denies both WebAuthn
operations and external protocol registration is disabled. No official cookies,
credentials or encrypted connection files are imported.

Root acceptance still requires signed A-to-B update through the real feed and
existing UI, actual running and installed-byte checks, signature/notarization
verification, the same profile and synthetic encrypted/preview/backend sentinels,
and a packaged native Azure read. A profile fixture or successful typecheck is
not updater, Keychain, Apple account or runtime isolation proof.

The desktop uses its own external and renderer scheme. Shared/server CORS and provider-return validators admit the exact fork origins,
and generated hosted Codex handoffs and prompt links target the fork. The desktop
consumes only its own scheme. It does not claim official-app callbacks.
The installed Clerk SDK derives its redirect URL and handler from the configured
renderer scheme. Its source accepts the fork scheme, but the compiled public
Clerk instance must allow that redirect. A real Connect/OAuth sign-in is still
required to establish service authorization; source inspection does not prove it.

Electron's [pinned startup source](https://raw.githubusercontent.com/electron/electron/v44.4.5/shell/browser/electron_browser_main_parts.cc)
loads and joins app code in `PostEarlyInitialization`, then sets macOS Keychain
service/account from the app name in `PostCreateMainMessageLoop`. The workflow
uses the standard [`macos-15` Apple Silicon runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
and checks its architecture explicitly.
