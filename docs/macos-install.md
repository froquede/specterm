# Installing on macOS

The macOS build is **unsigned** — there is no Apple Developer ID behind it, so
the bundle carries only an ad-hoc signature (see `scripts/adhoc-sign.cjs`) and
is not notarized.

## "Specterm is damaged and can't be opened"

This is the expected — and misleading — Gatekeeper message for an ad-hoc signed
app on Apple silicon. Nothing is actually corrupted.

When you download the `.dmg` (or `.zip`) with a browser, macOS tags the file
with the `com.apple.quarantine` extended attribute. The app copied out of it
inherits the tag. Gatekeeper then evaluates the bundle, finds no Developer ID
and no notarization ticket, and reports it as damaged rather than as untrusted.
Since macOS 15 (Sequoia) the old right-click → **Open** escape hatch no longer
clears it either.

### Fix

Install the app, then strip the quarantine attribute once:

```bash
xattr -dr com.apple.quarantine /Applications/Specterm.app
```

Open it normally afterwards. You only ever do this for the first install — the
in-app updater downloads its payload directly (not through a browser), so
updated bundles are never quarantined.

If you moved the app somewhere other than `/Applications`, point the command at
wherever it actually lives.

### Why not just fix it in the build?

Only notarization removes the prompt, and notarization requires a paid Apple
Developer Program membership ($99/year) plus a Developer ID Application
certificate. Signing the bundle better — or differently — does not help: an
ad-hoc signature is *valid*, it simply is not one Gatekeeper will trust for a
quarantined download.

If a certificate becomes available, the change is confined to the release
workflow: supply `CSC_LINK` / `CSC_KEY_PASSWORD` and the notarization
credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), drop
`CSC_IDENTITY_AUTO_DISCOVERY: false` from `.github/workflows/release.yml`, and
replace `mac.identity: null` in `package.json` with the Developer ID — at which
point `scripts/adhoc-sign.cjs` becomes dead weight and should go.
