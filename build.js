#!/usr/bin/env node
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const got = require("got");
const program = require("commander");
const yazl = require("yazl");
const stream = require("stream");
const { promisify } = require("util");
const replace = require("replace-in-file");
const pipeline = promisify(stream.pipeline);

program
  .option("-a, --arch [arch]", "Target architecture, ia32, x64, arm", "x64")
  .option(
    "-v, --version [version]",
    "Build FFmpeg for the specified NW.js version or Branch",
    false
  )
  .option("-c, --clean", "Clean the workspace, removes downloaded source code")
  .option("-d, --download", "Download Prebuild binaries.")
  .option("--get-download-url", "Get Download Url for Prebuild binaries.")
  .option(
    "-p, --platform [platform]",
    "Download platform, darwin, win, linux",
    process.platform
  )
  .option(
    "-o, --out [out]",
    "Output Directory",
    path.join(process.cwd(), "build", "out")
  );

program.parse(process.argv);
const outDir = program.out;

function execAsync(code, ...a) {
  return new Promise(resolve => {
    const proc = spawn(code, a, {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        Path: process.env.PATH
      }
    });
    proc.addListener("exit", resolve);
  });
}

async function setupLinux() {
  await execAsync(
    `./build/install-build-deps.sh`,
    `--no-prompt`,
    `--no-nacl`,
    `--no-chromeos-fonts`,
    `--no-syms`
  );
}

async function setupMac() {}

async function setupWin() {}

async function main() {
  const pkg = await got("https://nwjs.io/versions.json").json();
  const nwVersion = program.version || pkg["stable"];
  const version = pkg.versions.find(e => e.version.includes(nwVersion));
  if (!version) {
    console.error(`NW.js version ${nwVersion} could not be found.`);
    process.exit(1);
  }
  const chromiumVersion = version["components"]["chromium"];
  let libName = null;
  let zipName = null;
  const platform = program.platform || process.platform;
  if (platform === "darwin") {
    libName = "libffmpeg.dylib";
    zipName = `${version.version}-osx-${program.arch}.zip`.slice(1);
  } else if (platform === "win32" || platform === "win") {
    libName = "ffmpeg.dll";
    zipName = `${version.version}-win-${program.arch}.zip`.slice(1);
  } else if (platform === "linux") {
    libName = "libffmpeg.so";
    zipName = `${version.version}-linux-${program.arch}.zip`.slice(1);
  } else {
    console.error("Platform not supported");
    process.exit(1);
  }
  const downloadUrl = `https://github.com/iteufel/nwjs-ffmpeg-prebuilt/releases/download/${version.version.slice(
    1
  )}/${zipName}`;
  if (program.getDownloadUrl) {
    process.stdout.write(downloadUrl);
    process.exit(0);
  }

  await fs.ensureDir(outDir);
  if (program.download) {
    console.log(
      `Downloading NW.js ${version.version} - FFmpeg - (Chromium ${chromiumVersion})`
    );
    await pipeline(
      got.stream(downloadUrl),
      fs.createWriteStream(path.join(outDir, zipName))
    );
    return;
  }
  console.log(
    `Building NW.js ${version.version} - FFmpeg - (Chromium ${chromiumVersion})`
  );
  await fs.ensureDir("./build");
  if (program.clean) {
    console.log("Cleaning build Directory");
    await fs.emptyDir("./build");
  }
  process.chdir("./build");
  if (!(await fs.pathExists("./depot_tools"))) {
    await execAsync(
      "git",
      "clone",
      "https://chromium.googlesource.com/chromium/tools/depot_tools.git"
    );
  }
  if (platform === "win32" || platform === "win") {
    process.env.DEPOT_TOOLS_WIN_TOOLCHAIN = "0";
    process.env.PATH = `${process.env.PATH};${path.resolve("./depot_tools")}`;
  } else {
    process.env.PATH = `${process.env.PATH}:${path.resolve("./depot_tools")}`;
  }
  await fs.ensureDir("./chromium");
  process.chdir("./chromium");
  const hasSrc = await fs.pathExists("./src");
  console.log(`Clone chromium.src`);
  if (!hasSrc) {
    const gclient = `
solutions = [
    { "name"        : 'src',
        "url"         : 'https://chromium.googlesource.com/chromium/src.git',
        "deps_file"   : 'DEPS',
        "managed"     : False,
        "custom_deps" : {

        },
        "custom_vars": {},
    },
]
${platform === "arm" ? 'target_cpu=["arm"]' : ""}
        `.trim();
    await fs.writeFile(".gclient", gclient);
    await execAsync(
      "git",
      "clone",
      "https://chromium.googlesource.com/chromium/src.git",
      "--branch",
      chromiumVersion,
      "--single-branch",
      "--depth",
      1
    );
  }
  process.chdir("./src");
  if (hasSrc) {
    await execAsync(
      "git",
      "fetch",
      "https://chromium.googlesource.com/chromium/src.git",
      `+refs/tags/${chromiumVersion}`,
      "--depth",
      1
    );
  }

  await execAsync("git", "reset", "--hard", `tags/${chromiumVersion}`);

  if (process.platform === "linux") {
    await setupLinux(program.arch === "arm");
  } else if (process.platform === "darwin") {
    await setupMac();
  } else if (platform === "win32" || platform === "win") {
    await setupWin();
  }

  try {
    const options = {
      files: "./media/media_options.gni",
      from:
        "enable_platform_ac3_eac3_audio = proprietary_codecs && is_chromecast",
      to: "enable_platform_ac3_eac3_audio = true"
    };
    const changedFiles = replace.sync(options);
    console.log(changedFiles);
  } catch (error) {
    console.error("Error occurred:", error);
    process.exit();
  }

  try {
    const options = {
      files: "./media/media_options.gni",
      from: "enable_platform_hevc = proprietary_codecs && is_chromecast",
      to: "enable_platform_hevc = true"
    };
    const changedFiles = replace.sync(options);
    console.log(changedFiles);
  } catch (error) {
    console.error("Error occurred:", error);
    process.exit();
  }

  await execAsync("gclient", "sync", "--with_branch_heads");
  //await execAsync("gclient", "runhooks");

  if (program.arch === "ia32") {
    await execAsync(
      "gn",
      "gen",
      "out/Default",
      '--args="is_debug=false is_component_ffmpeg=true proprietary_codecs=true enable_platform_ac3_eac3_audio=true enable_platform_hevc=true is_official_build=true target_cpu=\\"x86\\" ffmpeg_branding=\\"Chrome\\""'
    );
  } else if (program.arch === "x64") {
    await execAsync(
      "gn",
      "gen",
      "out/Default",
      '--args="is_debug=false is_component_ffmpeg=true  is_official_build=true target_cpu=\\"x64\\" ffmpeg_branding=\\"Chrome\\""'
    );
  } else if (program.arch === "arm") {
    await execAsync(
      "gn",
      "gen",
      "out/Default",
      '--args="is_debug=false is_component_ffmpeg=true is_official_build=true target_cpu=\\"arm\\" ffmpeg_branding=\\"Chrome\\""'
    );
  }
  await execAsync("autoninja", "-C", "out/Default", libName);

  if (!fs.existsSync("./artifacts")) {
    fs.mkdirSync("./artifacts");
  }

  const zipFile = new yazl.ZipFile();
  zipFile.addFile(`out/Default/${libName}`, libName);

  zipFile.outputStream
    .pipe(fs.createWriteStream(path.resolve(outDir, "artifacts", zipName)))
    .on("close", () => {
      console.log(zipName);
    });
  zipFile.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
