/**
 * Makes a fresh clone runnable with a single `npm install`.
 *
 * NitroStack resolves every @Widget route to `src/widgets/out/<name>/index.html`
 * at startup, so a clone that has never been built dies immediately with
 * "Exported HTML for route 'architecture-map' not found" — and the MCP client
 * just reports that the server shut down, which points nowhere near the cause.
 * That build output is derived, so it is correctly absent from git; the fix is
 * to produce it automatically rather than to document a step people will miss.
 *
 * This deliberately NEVER fails the install. A production or CI install without
 * devDependencies genuinely cannot run the build, and `npm install` blowing up
 * over an optional convenience would be worse than the problem it solves. On
 * failure it prints the one command that fixes things and exits 0.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const widgets = join(root, 'src', 'widgets');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Opt-out for CI and Docker layers that build explicitly. */
if (process.env.BRIDGE_SKIP_POSTINSTALL === 'true') process.exit(0);

const say = (msg) => console.log(`[bridge:postinstall] ${msg}`);

/** True when at least one widget has been exported to static HTML. */
function widgetsAreBuilt() {
  const out = join(widgets, 'out');
  if (!existsSync(out)) return false;
  return readdirSync(out, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(join(out, entry.name, 'index.html'))
  );
}

try {
  if (!existsSync(join(widgets, 'node_modules'))) {
    say('installing widget dependencies…');
    execFileSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: widgets, stdio: 'inherit' });
  }

  if (widgetsAreBuilt()) {
    say('widgets already built — nothing to do.');
    process.exit(0);
  }

  say('building widgets so the MCP server can boot…');
  execFileSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit' });
  say('ready. Start the server with `npm run dev`, or open the folder in NitroStudio.');
} catch (error) {
  console.warn(
    `\n[bridge:postinstall] Could not prepare the widget bundle automatically.\n` +
      `  Reason: ${error instanceof Error ? error.message : String(error)}\n\n` +
      `  The MCP server will NOT start until the widgets are built. Run this once:\n\n` +
      `      npm run setup\n\n` +
      `  (This is only a warning — the install itself succeeded.)\n`
  );
  process.exit(0);
}
