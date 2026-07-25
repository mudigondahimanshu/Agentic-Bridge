/**
 * WorkspaceService — the single gatekeeper for every filesystem read the swarm performs.
 *
 * The proposal calls for hard operational boundaries so an agent loop cannot
 * exfiltrate a thirty-year-old codebase or exhaust memory. Rather than trusting
 * each tool to behave, all traversal funnels through here, which enforces:
 *
 *   - an allow-list of roots (the bundled fixture + anything the operator opts in to)
 *   - a maximum file count, maximum single-file size, and maximum total bytes read
 *   - symlink resolution before the containment check, so `..` and link escapes fail
 *   - a skip-list for vendored/build directories
 */
import { Injectable } from '@nitrostack/core';
import * as fs from 'fs';
import * as path from 'path';

export interface TraversalLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: TraversalLimits = {
  maxFiles: 4000,
  maxFileBytes: 2 * 1024 * 1024, // 2 MB per file
  maxTotalBytes: 64 * 1024 * 1024, // 64 MB per traversal
};

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  '.bridge',
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.java', '.py', '.rb', '.go', '.rs',
  '.cs', '.php', '.kt', '.scala', '.sql', '.sh', '.bash',
  '.json', '.yml', '.yaml', '.toml', '.ini', '.xml', '.properties',
  '.css', '.scss', '.less', '.html', '.md', '.txt', '.gradle',
]);

/** Files with no extension that we still want to read. */
const NAMED_FILES = new Set(['Jenkinsfile', 'Dockerfile', 'Makefile', 'Procfile']);

export interface TraversalResult {
  files: string[];
  truncated: boolean;
  reason?: string;
  bytesRead: number;
}

@Injectable()
export class WorkspaceService {
  /** Directory of this NitroStack project (resolved from the compiled/ts entry). */
  readonly projectRoot: string;
  /** The bundled legacy fixture used when no target is supplied. */
  readonly fixtureRoot: string;
  /** Durable state directory. */
  readonly stateRoot: string;
  /** Directory generated skills are written to. */
  readonly skillsRoot: string;
  /** Mock enterprise system payloads. */
  readonly dataRoot: string;

  private readonly extraRoots: string[] = [];

  constructor() {
    this.projectRoot = WorkspaceService.locateProjectRoot();
    this.fixtureRoot = path.join(this.projectRoot, 'fixtures', 'legacy-monolith');
    this.stateRoot = path.join(this.projectRoot, '.bridge');
    this.skillsRoot = path.join(this.projectRoot, 'src', 'skills');
    this.dataRoot = path.join(this.projectRoot, 'data');

    for (const dir of [this.stateRoot, this.skillsRoot]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Operators can widen the allow-list without editing code.
    const extra = process.env.BRIDGE_ALLOWED_ROOTS;
    if (extra) {
      for (const raw of extra.split(path.delimiter)) {
        const trimmed = raw.trim();
        if (trimmed) this.extraRoots.push(path.resolve(trimmed));
      }
    }
  }

  /**
   * Walk up from this file until we find the directory holding package.json.
   * Works identically under `tsx src/index.ts` and `node dist/index.js`.
   */
  private static locateProjectRoot(): string {
    let dir = path.dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }

  /** Roots the swarm is permitted to read from. */
  get allowedRoots(): string[] {
    return [this.projectRoot, this.fixtureRoot, ...this.extraRoots];
  }

  /**
   * Resolve a caller-supplied target into a real, allow-listed directory.
   * Throws with an actionable message rather than silently falling back.
   */
  resolveTarget(target?: string): string {
    if (!target || !target.trim()) {
      if (!fs.existsSync(this.fixtureRoot)) {
        throw new Error(
          `No target supplied and the bundled fixture is missing at ${this.fixtureRoot}. ` +
            `Pass an absolute path via the "target" parameter.`
        );
      }
      return this.fixtureRoot;
    }

    const resolved = path.resolve(target.trim());
    if (!fs.existsSync(resolved)) {
      throw new Error(`Target path does not exist: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Target must be a directory, got a file: ${resolved}`);
    }

    const real = fs.realpathSync(resolved);
    const permitted = this.allowedRoots.some((root) => this.contains(root, real));
    if (!permitted) {
      throw new Error(
        `Refusing to traverse ${real}: outside the allow-list. ` +
          `Allowed roots: ${this.allowedRoots.join(', ')}. ` +
          `Add it with BRIDGE_ALLOWED_ROOTS="${real}" to opt in.`
      );
    }
    return real;
  }

  /** True when `child` is `parent` or lives beneath it. */
  private contains(parent: string, child: string): boolean {
    const rel = path.relative(fs.existsSync(parent) ? fs.realpathSync(parent) : parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /**
   * Enumerate readable text files beneath `root`, honouring the traversal budget.
   * Returns absolute paths. Never throws on a single unreadable entry.
   */
  walk(root: string, limits: TraversalLimits = DEFAULT_LIMITS): TraversalResult {
    const files: string[] = [];
    let bytesRead = 0;
    let truncated = false;
    let reason: string | undefined;

    const stack: string[] = [root];
    while (stack.length) {
      if (files.length >= limits.maxFiles) {
        truncated = true;
        reason = `file count limit (${limits.maxFiles}) reached`;
        break;
      }
      if (bytesRead >= limits.maxTotalBytes) {
        truncated = true;
        reason = `total byte budget (${limits.maxTotalBytes}) reached`;
        break;
      }

      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory — skip, do not abort the traversal
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue; // ignore symlinks/sockets/devices
        if (!this.isTextFile(entry.name)) continue;

        let size: number;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        if (size > limits.maxFileBytes) continue;

        files.push(full);
        bytesRead += size;
        if (files.length >= limits.maxFiles) break;
      }
    }

    return { files, truncated, reason, bytesRead };
  }

  isTextFile(name: string): boolean {
    if (NAMED_FILES.has(name)) return true;
    if (name.startsWith('.') && !name.startsWith('.eslintrc') && !name.startsWith('.prettierrc')) {
      // Allow dot-configs we care about, skip the rest of the dotfile noise.
      if (!['.env.example', '.babelrc', '.nvmrc'].includes(name)) return false;
    }
    return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
  }

  /** Read a file as UTF-8, returning null instead of throwing. */
  read(file: string): string | null {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  rel(root: string, file: string): string {
    return path.relative(root, file).split(path.sep).join('/');
  }
}
