import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOLS = ["list_problem_tags", "search_problems", "get_problem"];
const pilotRoot = dirname(fileURLToPath(import.meta.url));
const workspace = join(pilotRoot, "Shef Tutor Chat");
class ConnectError extends Error {}

async function regular(path, directory) {
  try {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile())
    )
      throw new ConnectError(
        "The dedicated workspace must use regular directories and files.",
      );
    return info;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function verifyBridge(args) {
  await new Promise((resolveVerified, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: pilotRoot,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let stage = 0;
    let buffer = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolveVerified();
    };
    const failed = () =>
      finish(
        new ConnectError(
          "The existing Shef bridge did not pass its connection check. No Codex configuration was written. Check your existing setup and retry.",
        ),
      );
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(failed, 60_000);
    child.once("error", failed);
    child.once("close", () => {
      if (!settled) failed();
    });
    child.stdin.on("error", failed);
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) failed();
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > 256 * 1024) return failed();
      buffer += chunk;
      let newline;
      while (!settled && (newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return failed();
        }
        if (
          !message ||
          message.jsonrpc !== "2.0" ||
          message.error ||
          message.id !== stage + 1 ||
          !message.result
        )
          return failed();
        if (stage === 0) {
          if (
            !["2025-03-26", "2025-06-18", "2025-11-25"].includes(
              message.result.protocolVersion,
            )
          )
            return failed();
          stage = 1;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else {
          const listed = message.result.tools;
          if (
            !Array.isArray(listed) ||
            listed.length !== TOOLS.length ||
            TOOLS.some(
              (name) =>
                listed.filter((tool) => tool?.name === name).length !== 1,
            )
          )
            return failed();
          finish();
        }
      }
    });
    child.once("spawn", () =>
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "shef-tutor-direct-setup", version: "1" },
        },
      }),
    );
  });
}

async function directory(path) {
  if (await regular(path, true)) return;
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await regular(path, true);
}

async function saveConfig(content) {
  await directory(workspace);
  const settings = join(workspace, ".codex");
  await directory(settings);
  const target = join(settings, "config.toml");
  const existing = await regular(target, false);
  if (existing) {
    if (existing.size > 64 * 1024)
      throw new ConnectError(
        "The dedicated workspace already has different settings. No existing file was replaced.",
      );
    if ((await readFile(target, "utf8")) === content) return;
    throw new ConnectError(
      "The dedicated workspace already has different settings. No existing file was replaced.",
    );
  }
  const temporary = join(
    settings,
    `.shef-config-${randomBytes(8).toString("hex")}.tmp`,
  );
  let reservation;
  let reservedIdentity;
  try {
    const output = await open(temporary, "wx", 0o600);
    try {
      await output.writeFile(content);
    } finally {
      await output.close();
    }
    // Reserve the absent destination exclusively; never replace a preexisting
    // custom file, even if another invocation creates it after the read above.
    reservation = await open(target, "wx", 0o600);
    reservedIdentity = await reservation.stat();
    await reservation.close();
    reservation = null;
    await regular(workspace, true);
    await regular(settings, true);
    const current = await regular(target, false);
    if (
      !current ||
      current.dev !== reservedIdentity.dev ||
      current.ino !== reservedIdentity.ino ||
      current.size !== 0
    )
      throw new ConnectError(
        "The dedicated workspace settings changed. No existing file was replaced.",
      );
    await rename(temporary, target);
    reservedIdentity = null;
  } finally {
    await reservation?.close();
    await rm(temporary, { force: true });
    if (reservedIdentity) {
      const current = await regular(target, false);
      if (
        current?.dev === reservedIdentity.dev &&
        current?.ino === reservedIdentity.ino &&
        current.size === 0
      )
        await rm(target);
    }
  }
}

async function main() {
  const server = resolve(pilotRoot, "scripts/server.mjs");
  if (!(await regular(server, false)))
    throw new ConnectError(
      "Place connect-codex.mjs inside your existing Shef Tutor Pilot folder, beside the scripts folder.",
    );
  const wrapper = `import { runStdio } from ${JSON.stringify(pathToFileURL(server).href)}; await runStdio();`;
  const args = ["--input-type=module", "-e", wrapper];
  await verifyBridge(args);
  const content = [
    "# Generated by the Shef Tutor Pilot direct connector.",
    "mcp_optional_startup_grace_ms = 0",
    "",
    "[mcp_servers.shef_tutor_direct]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify(args)}`,
    `cwd = ${JSON.stringify(pilotRoot)}`,
    "enabled = true",
    "required = false",
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 60",
    `enabled_tools = ${JSON.stringify(TOOLS)}`,
    'environment_id = "local"',
    "",
  ].join("\n");
  await saveConfig(content);
  process.stdout.write(
    `Verified tools: ${TOOLS.join(", ")}\nWorkspace: ${workspace}\n` +
      "In ChatGPT Desktop select Codex, press Ctrl+O (Cmd+O on macOS), and open the workspace above. Review any folder-trust prompt so its project settings can load. Choose Work in > This computer, start a new local chat, and ask to use shef_tutor_direct.\n",
  );
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof ConnectError ? error.message : "The direct connection setup could not finish. Existing settings were not replaced."}\n`,
  );
  process.exitCode = 1;
});
