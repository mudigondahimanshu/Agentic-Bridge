/**
 * Startup guard for the widget bundle.
 *
 * NitroStack resolves every `@Widget` route to a static export at
 * `src/widgets/out/<name>/index.html` while it is building the tool list. If that
 * export is missing the factory throws before the transport is even created, the
 * process exits, and an MCP client reports only "the server shut down" — a
 * message that points nowhere near the actual cause. It is the first thing that
 * happens to anyone who clones the repo and runs it without building.
 *
 * `scripts/postinstall.mjs` normally prevents this at install time. This is the
 * second line of defence for the cases that slips past: `--ignore-scripts`, a
 * deleted `out/` directory, or a clone that is run before its install finishes.
 *
 * The build's own stdout is redirected to stderr (fd 2). That is not cosmetic —
 * under the stdio transport, stdout carries the JSON-RPC stream, and a stray
 * line of build output would corrupt the protocol.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from this file to the directory that owns both package.json and the widgets. */
function findProjectRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'widgets'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True when at least one widget has been exported to static HTML. */
function widgetsAreBuilt(root: string): boolean {
  const out = join(root, 'src', 'widgets', 'out');
  if (!existsSync(out)) return false;
  return readdirSync(out, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(join(out, entry.name, 'index.html'))
  );
}

/**
 * Build the widget bundle if it is missing. Throws a message that names the fix
 * if the build itself fails — better than letting the factory throw a stack
 * trace about one arbitrary route.
 */
export function ensureWidgetsBuilt(): void {
  const root = findProjectRoot();
  if (!root || widgetsAreBuilt(root)) return;

  console.error('[bridge] Widget bundle missing — building it now (first run only)…');

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    if (!existsSync(join(root, 'src', 'widgets', 'node_modules'))) {
      execFileSync(npm, ['install', '--no-audit', '--no-fund'], {
        cwd: join(root, 'src', 'widgets'),
        stdio: ['ignore', 2, 2], // never let build output reach stdout
      });
    }
    execFileSync(npm, ['run', 'build'], { cwd: root, stdio: ['ignore', 2, 2] });
    console.error('[bridge] Widget bundle ready.');
  } catch (error) {
    throw new Error(
      `The widget bundle is missing and could not be built automatically.\n` +
        `  Reason: ${error instanceof Error ? error.message : String(error)}\n\n` +
        `  The server cannot start without it. Run this once, then start again:\n\n` +
        `      npm run setup\n`
    );
  }
}
