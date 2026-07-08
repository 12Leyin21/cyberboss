#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SIPS_PATH = "/usr/bin/sips";
const DEFAULT_SIZE = 240;

function main() {
  const args = process.argv.slice(2);
  const inputPath = readFlag(args, "--input");
  const outputPath = readFlag(args, "--output");
  const size = Number.parseInt(readFlag(args, "--size") || String(DEFAULT_SIZE), 10);

  if (!inputPath || !outputPath) {
    throw new Error("Usage: normalize-sticker-gif.js --input <path> --output <path> [--size 240]");
  }
  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputPath = path.resolve(outputPath);
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`Input file does not exist: ${resolvedInputPath}`);
  }
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

  const inputExt = path.extname(resolvedInputPath).toLowerCase();
  if (inputExt === ".gif") {
    fs.copyFileSync(resolvedInputPath, resolvedOutputPath);
    return;
  }

  const normalizedSize = Number.isInteger(size) && size > 0 ? size : DEFAULT_SIZE;

  if (process.platform === "darwin" && fs.existsSync(SIPS_PATH)) {
    runSips(resolvedInputPath, resolvedOutputPath, normalizedSize);
  } else {
    runImageMagick(resolvedInputPath, resolvedOutputPath, normalizedSize);
  }

  if (!fs.existsSync(resolvedOutputPath)) {
    throw new Error(`GIF normalization produced no output: ${resolvedOutputPath}`);
  }
}

function runSips(inputPath, outputPath, size) {
  const result = spawnSync(SIPS_PATH, [
    "-s", "format", "gif",
    "-z", String(size), String(size),
    inputPath,
    "--out", outputPath,
  ], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(`sips gif normalization failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
}

// Linux (and any non-macOS host): use ImageMagick's `convert` (or `magick`
// for ImageMagick 7+, which drops the standalone `convert` binary).
function runImageMagick(inputPath, outputPath, size) {
  const binary = findImageMagickBinary();
  if (!binary) {
    throw new Error(
      "Required tool missing: install ImageMagick (`apt-get install imagemagick` on Debian/Ubuntu) " +
      "to normalize non-GIF stickers on this platform."
    );
  }
  const args = binary.name === "magick" ? ["convert"] : [];
  args.push(inputPath, "-coalesce", "-resize", `${size}x${size}`, outputPath);

  const result = spawnSync(binary.path, args, { encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(`ImageMagick gif normalization failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
}

function findImageMagickBinary() {
  for (const name of ["convert", "magick"]) {
    const probe = spawnSync("which", [name], { encoding: "utf8" });
    const foundPath = String(probe.stdout || "").trim();
    if (probe.status === 0 && foundPath) {
      return { name, path: foundPath };
    }
  }
  return null;
}

function readFlag(args, flag) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return String(args[index + 1] || "").trim();
    }
  }
  return "";
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  console.error(message);
  process.exit(1);
}
