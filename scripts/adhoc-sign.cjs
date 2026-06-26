// electron-builder afterSign hook (macOS only).
//
// Without a Developer ID, electron-builder skips code signing, leaving the
// app with only Electron's linker-signed ad-hoc binary and an unbound
// Info.plist (signing identifier stays "Electron"). macOS LaunchServices and
// Spotlight distrust that bundle and refuse to index it — so the app never
// shows up in Cmd+Space.
//
// Re-signing the whole bundle ad-hoc seals the Info.plist and resources under
// the app's own identifier (com.specterm.terminal). Runs before the dmg/zip is
// assembled, so the packaged artifacts contain the fixed bundle.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterSign] ad-hoc signing ${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
