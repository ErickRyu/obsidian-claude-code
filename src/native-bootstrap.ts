import { Notice, requestUrl } from "obsidian";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

const GITHUB_REPO = "ErickRyu/obsidian-claude-code";

function getPlatformKey(): string {
  const platform = process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

function isNodePtyInstalled(pluginDir: string): boolean {
  const ptyPath = path.join(pluginDir, "node-pty", "build", "Release", "pty.node");
  return fs.existsSync(ptyPath);
}

async function getLatestRelease(): Promise<string> {
  const resp = await requestUrl({
    url: `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  return resp.json.tag_name;
}

async function downloadAndExtract(
  pluginDir: string,
  tag: string,
  platformKey: string
): Promise<void> {
  const assetName = `node-pty-${platformKey}.tar.gz`;
  const url = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${assetName}`;

  new Notice(`Downloading native module for ${platformKey}...`);

  const resp = await requestUrl({ url });
  const tarPath = path.join(pluginDir, assetName);
  fs.writeFileSync(tarPath, Buffer.from(resp.arrayBuffer));

  // Extract: tar -xzf archive.tar.gz -C pluginDir
  execSync(`tar -xzf "${tarPath}" -C "${pluginDir}"`, { timeout: 30000 });

  // Move from platformKey/node-pty to node-pty
  const extracted = path.join(pluginDir, platformKey, "node-pty");
  const target = path.join(pluginDir, "node-pty");
  if (fs.existsSync(extracted) && !fs.existsSync(target)) {
    fs.renameSync(extracted, target);
  }

  // Cleanup
  fs.unlinkSync(tarPath);
  const platformDir = path.join(pluginDir, platformKey);
  if (fs.existsSync(platformDir)) {
    fs.rmdirSync(platformDir, { recursive: true } as fs.RmDirOptions);
  }

  new Notice("Native module installed successfully.");
}

export async function ensureNodePty(pluginDir: string): Promise<boolean> {
  if (isNodePtyInstalled(pluginDir)) {
    return true;
  }

  try {
    const platformKey = getPlatformKey();
    const tag = await getLatestRelease();
    await downloadAndExtract(pluginDir, tag, platformKey);
    return isNodePtyInstalled(pluginDir);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    new Notice(
      `Failed to download native module: ${msg}. See README for manual installation.`
    );
    return false;
  }
}
