import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PathValidationError,
  validatePath,
  recheckPath,
} from "../../src/adapter/path-validator.js";

const NUL = String.fromCharCode(0);

let TMP_ROOT_RAW: string;
let TMP_ROOT: string;

beforeAll(() => {
  TMP_ROOT_RAW = mkdtempSync(path.join(os.tmpdir(), "kimi-pathv-"));
  TMP_ROOT = realpathSync(TMP_ROOT_RAW);
});

afterAll(() => {
  rmSync(TMP_ROOT_RAW, { recursive: true, force: true });
});

describe("validatePath — shape checks", () => {
  it("rejects relative paths", () => {
    expect(() => validatePath({ path: "relative/dir", field: "workDir" })).toThrow(
      PathValidationError,
    );
  });

  it("rejects paths containing NUL bytes", () => {
    expect(() =>
      validatePath({ path: `/abs/dir${NUL}injected`, field: "workDir" }),
    ).toThrow(PathValidationError);
  });

  it("rejects empty string", () => {
    expect(() => validatePath({ path: "", field: "workDir" })).toThrow(PathValidationError);
  });

  it("rejects non-existent paths with code='not_found'", () => {
    const ghost = path.join(TMP_ROOT, "does-not-exist");
    try {
      validatePath({ path: ghost, field: "workDir" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PathValidationError);
      expect((err as PathValidationError).code).toBe("not_found");
      expect((err as PathValidationError).field).toBe("workDir");
    }
  });
});

describe("validatePath — realpath", () => {
  it("returns the resolved symlink target", () => {
    const target = path.join(TMP_ROOT, "real");
    const link = path.join(TMP_ROOT, "link");
    mkdirSync(target);
    symlinkSync(target, link);

    const v = validatePath({ path: link, field: "workDir", allowEphemeral: true });

    expect(v.original).toBe(link);
    expect(v.resolved).toBe(realpathSync(target));
  });
});

describe("validatePath — allowedRoots", () => {
  it("accepts paths under an allowed root", () => {
    const inside = path.join(TMP_ROOT, "inside");
    mkdirSync(inside, { recursive: true });

    const v = validatePath({
      path: inside,
      field: "workDir",
      allowedRoots: [TMP_ROOT],
      allowEphemeral: true,
    });

    expect(v.resolved).toBe(realpathSync(inside));
  });

  it("rejects paths outside all allowed roots", () => {
    const otherRoot = mkdtempSync(path.join(os.tmpdir(), "kimi-pathv-other-"));
    try {
      expect(() =>
        validatePath({
          path: realpathSync(otherRoot),
          field: "workDir",
          allowedRoots: [TMP_ROOT],
          allowEphemeral: true,
        }),
      ).toThrow(PathValidationError);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects sibling sharing a prefix substring (no path-boundary confusion)", () => {
    const sibling = mkdtempSync(path.join(os.tmpdir(), "kimi-pathv-"));
    try {
      // sibling starts with /tmp/kimi-pathv- like TMP_ROOT but is a different dir
      expect(() =>
        validatePath({
          path: realpathSync(sibling),
          field: "workDir",
          allowedRoots: [TMP_ROOT],
          allowEphemeral: true,
        }),
      ).toThrow(PathValidationError);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe("validatePath — ephemeral roots", () => {
  it("rejects /tmp/* (and equivalents) by default", () => {
    // TMP_ROOT itself resolves under /private/var/folders or /tmp on macOS.
    expect(() => validatePath({ path: TMP_ROOT, field: "workDir" })).toThrow(
      PathValidationError,
    );
  });

  it("allows ephemeral roots when allowEphemeral=true", () => {
    const v = validatePath({ path: TMP_ROOT, field: "workDir", allowEphemeral: true });
    expect(v.resolved).toBe(TMP_ROOT);
  });
});

describe("recheckPath — TOCTOU", () => {
  it("passes when realpath is unchanged", () => {
    const dir = path.join(TMP_ROOT, "recheck-stable");
    mkdirSync(dir, { recursive: true });
    const v = validatePath({ path: dir, field: "workDir", allowEphemeral: true });
    expect(() => recheckPath(v)).not.toThrow();
  });

  it("throws code='toctou' when symlink target is swapped between validate and recheck", () => {
    const a = path.join(TMP_ROOT, "a-target");
    const b = path.join(TMP_ROOT, "b-target");
    const link = path.join(TMP_ROOT, "swap-link");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    symlinkSync(a, link);

    const v = validatePath({ path: link, field: "workDir", allowEphemeral: true });
    rmSync(link);
    symlinkSync(b, link);

    try {
      recheckPath(v);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PathValidationError);
      expect((err as PathValidationError).code).toBe("toctou");
    }
  });

  it("throws code='toctou' when path is removed between validate and recheck", () => {
    const dir = path.join(TMP_ROOT, "vanishing");
    mkdirSync(dir, { recursive: true });
    const v = validatePath({ path: dir, field: "workDir", allowEphemeral: true });
    rmSync(dir, { recursive: true, force: true });

    try {
      recheckPath(v);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PathValidationError);
      expect((err as PathValidationError).code).toBe("toctou");
    }
  });
});
