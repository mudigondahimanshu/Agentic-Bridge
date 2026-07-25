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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const widgets = join(root, 'src', 'widgets');

/**
 * Run npm portably.
 *
 * On Windows the executable is `npm.cmd`, and since Node's fix for
 * CVE-2024-27980 (18.20.2 / 20.12.2+) child_process refuses to launch a
 * .cmd/.bat file unless `shell` is set — it throws EINVAL instead. Without this
 * the whole script failed on Windows, the widgets never got built, and the MCP
 * server then died at startup with "Connection Failed" in the client.
 *
 * `shell: true` is safe here specifically because every argument below is a
 * hardcoded literal; nothing user-supplied is ever interpolated into it.
 */
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const runNpm = (args, opts) =>
  execFileSync(npm, args, { shell: isWindows, windowsHide: true, ...opts });

/** Opt-out for CI and Docker layers that build explicitly. */
if (process.env.BRIDGE_SKIP_POSTINSTALL === 'true') process.exit(0);

const say = (msg) => console.log(`[bridge:postinstall] ${msg}`);

/**
 * True when every widget in the manifest has been exported.
 *
 * Next writes EITHER `out/<route>.html` or `out/<route>/index.html` depending on
 * its trailingSlash setting; this build emits the flat form. Only checking the
 * directory form (as an earlier version did) meant this always answered "no" and
 * rebuilt unconditionally.
 */
function widgetsAreBuilt() {
  const out = join(widgets, 'out');
  if (!existsSync(out)) return false;

  const exported = (route) =>
    existsSync(join(out, `${route}.html`)) || existsSync(join(out, route, 'index.html'));

  try {
    const manifest = JSON.parse(readFileSync(join(widgets, 'widget-manifest.json'), 'utf8'));
    const routes = (manifest.widgets ?? []).map((w) => String(w.uri).replace(/^\//, ''));
    if (routes.length) return routes.every(exported);
  } catch {
    // fall through to the loose check below
  }

  return readdirSync(out, { withFileTypes: true }).some(
    (e) => (e.isFile() && e.name.endsWith('.html')) || (e.isDirectory() && existsSync(join(out, e.name, 'index.html')))
  );
}

try {
  if (!existsSync(join(widgets, 'node_modules'))) {
    say('installing widget dependencies…');
    runNpm(['install', '--no-audit', '--no-fund'], { cwd: widgets, stdio: 'inherit' });
  }

  if (widgetsAreBuilt()) {
    say('widgets already built — nothing to do.');
    process.exit(0);
  }

  say('building widgets so the MCP server can boot…');
  runNpm(['run', 'build'], { cwd: root, stdio: 'inherit' });
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
