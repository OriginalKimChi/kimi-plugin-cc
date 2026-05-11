import { realpathSync } from "node:fs";
import path from "node:path";

export type PathValidationCode =
  | "empty"
  | "relative"
  | "nul_byte"
  | "not_found"
  | "outside_root"
  | "ephemeral_root"
  | "toctou";

export class PathValidationError extends Error {
  readonly code: PathValidationCode;
  readonly field: string;
  readonly original: string;
  constructor(code: PathValidationCode, field: string, original: string, message: string) {
    super(message);
    this.name = "PathValidationError";
    this.code = code;
    this.field = field;
    this.original = original;
  }
}

export interface ValidatePathOptions {
  path: string;
  field: string;
  allowedRoots?: ReadonlyArray<string>;
  allowEphemeral?: boolean;
}

export interface ValidatedPath {
  field: string;
  original: string;
  resolved: string;
  allowedRoots: ReadonlyArray<string>;
  allowEphemeral: boolean;
}

const NUL = String.fromCharCode(0);

const EPHEMERAL_ROOTS = ["/Volumes/", "/private/var/folders/", "/tmp/"];

export function validatePath(opts: ValidatePathOptions): ValidatedPath {
  const { path: p, field } = opts;
  if (typeof p !== "string" || p.length === 0) {
    throw new PathValidationError("empty", field, String(p ?? ""), `${field}: must be a non-empty string`);
  }
  if (p.includes(NUL)) {
    throw new PathValidationError("nul_byte", field, p, `${field}: must not contain NUL bytes`);
  }
  if (!path.isAbsolute(p)) {
    throw new PathValidationError("relative", field, p, `${field}: must be an absolute path`);
  }

  let resolved: string;
  try {
    resolved = realpathSync(p);
  } catch (err) {
    throw new PathValidationError(
      "not_found",
      field,
      p,
      `${field}: realpath failed (${(err as NodeJS.ErrnoException).code ?? "ERR"})`,
    );
  }

  const allowedRoots = (opts.allowedRoots ?? []).map((r) => realpathSync(r));
  if (allowedRoots.length > 0 && !isUnderAnyRoot(resolved, allowedRoots)) {
    throw new PathValidationError(
      "outside_root",
      field,
      p,
      `${field}: resolved path is outside allowed roots`,
    );
  }

  const allowEphemeral = opts.allowEphemeral === true;
  if (!allowEphemeral && isEphemeral(resolved)) {
    throw new PathValidationError(
      "ephemeral_root",
      field,
      p,
      `${field}: resolves under an ephemeral root (set allowEphemeral=true to opt in)`,
    );
  }

  return {
    field,
    original: p,
    resolved,
    allowedRoots,
    allowEphemeral,
  };
}

export function recheckPath(v: ValidatedPath): void {
  let current: string;
  try {
    current = realpathSync(v.original);
  } catch (err) {
    throw new PathValidationError(
      "toctou",
      v.field,
      v.original,
      `${v.field}: path no longer resolvable (${(err as NodeJS.ErrnoException).code ?? "ERR"})`,
    );
  }
  if (current !== v.resolved) {
    throw new PathValidationError(
      "toctou",
      v.field,
      v.original,
      `${v.field}: realpath changed between validate and spawn`,
    );
  }
  if (v.allowedRoots.length > 0 && !isUnderAnyRoot(current, v.allowedRoots)) {
    throw new PathValidationError(
      "outside_root",
      v.field,
      v.original,
      `${v.field}: resolved path is outside allowed roots (recheck)`,
    );
  }
  if (!v.allowEphemeral && isEphemeral(current)) {
    throw new PathValidationError(
      "ephemeral_root",
      v.field,
      v.original,
      `${v.field}: resolves under an ephemeral root (recheck)`,
    );
  }
}

function isUnderAnyRoot(p: string, roots: ReadonlyArray<string>): boolean {
  for (const root of roots) {
    if (p === root) return true;
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (p.startsWith(withSep)) return true;
  }
  return false;
}

function isEphemeral(p: string): boolean {
  return EPHEMERAL_ROOTS.some((r) => p.startsWith(r));
}
