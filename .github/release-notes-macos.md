
### macOS

The macOS build is unsigned, so the first launch reports *"Specterm is damaged
and can't be opened"*. Nothing is corrupted — that is Gatekeeper's message for a
quarantined ad-hoc bundle. Clear the attribute once after installing:

```bash
xattr -dr com.apple.quarantine /Applications/Specterm.app
```

Only the first install needs it; the in-app updater is unaffected.
