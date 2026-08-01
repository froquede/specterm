# Releasing

Distributable installers are built in CI by `.github/workflows/release.yml`:

- **Linux** → AppImage + `.deb` (built in an Ubuntu 20.04 container, so the
  native `node-pty` links against glibc 2.31 and runs on Ubuntu 20.04+)
- **Windows** → NSIS installer (`.exe`)
- **macOS** → `.dmg` + `.zip` (Apple silicon, unsigned)

Versioning is semantic (`MAJOR.MINOR.FIX`). To cut a release: land the work on
`main`, bump `version` in `package.json`, update `CHANGELOG.md`, then push a
matching tag — the tag push is what triggers the build.

```bash
# after bumping "version" in package.json (e.g. 0.18.0)
git commit -am "chore: release v0.18.0"
git push origin main
git tag -a v0.18.0 -m "v0.18.0"
git push origin refs/tags/v0.18.0
```

## Three things the workflow won't do for you

**Push the tag by its full ref.** Release work is staged on a branch named after
the version (`v0.18.0`), which collides with the tag of the same name — `git push
origin v0.18.0` is ambiguous and fails with *"matches more than one"*. Use
`refs/tags/…`, or delete the branch first.

**Write the release notes.** The workflow only uploads binaries; the GitHub
Release body comes out empty. Fill it in afterwards
(`gh release edit <tag> --notes-file …`).

**Guarantee every asset uploaded.** The three platform jobs race to create the
release, and the losers can fail with a 422 instead of attaching their artifact.
Always check the release has all of them, and re-run what's missing:

```bash
gh release view v0.18.0 --json assets --jq '.assets[].name'
gh run rerun --failed <run-id>
```

## macOS: unsigned builds

The macOS build is unsigned, so first launch fails with *"Specterm is damaged and
can't be opened"* — Gatekeeper's message for a quarantined ad-hoc bundle. Clear
the quarantine attribute once after installing:

```bash
xattr -dr com.apple.quarantine /Applications/Specterm.app
```

See [macos-install.md](macos-install.md) for the full explanation and what
notarizing would take.
