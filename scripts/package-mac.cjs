const path = require("path");
const os = require("os");
const packager = require("@electron/packager");

(async () => {
  try {
    const projectRoot = path.resolve(__dirname, "..");
    const outDir = path.join(projectRoot, "dist");
    const arch = os.arch() === "arm64" ? "arm64" : "x64";

    const appPaths = await packager({
      dir: projectRoot,
      out: outDir,
      overwrite: true,
      platform: "darwin",
      arch,
      appBundleId: "com.desktoptranscriber.app",
      executableName: "DesktopTranscriber",
      prune: false,
    });

    if (!appPaths?.length) {
      console.error("Electron Packager did not return an app path.");
      process.exit(1);
    }

    console.log(`Packaged app at: ${appPaths.join(", ")}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
