export const FINDINGS_SCHEMA_VERSION = "findings_v1" as const;

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const CATEGORIES = new Set([
  "correctness",
  "security",
  "performance",
  "maintainability",
  "style",
  "other",
]);
const STANCES = new Set(["rebut", "expand", "missed", "exaggerated", "confirm"]);
const ID_RE = /^f-[a-z0-9]{4,16}$/;

export type Severity = "critical" | "high" | "medium" | "low";
export type Stance = "rebut" | "expand" | "missed" | "exaggerated" | "confirm";

export interface Finding {
  id: string;
  severity: Severity;
  category?: string;
  title: string;
  body: string;
  file: string;
  line_start: number;
  line_end: number;
  confidence: number;
  recommendation?: string;
  responding_to?: string[];
  stance?: Stance;
}

export interface FindingsV1 {
  schema_version: typeof FINDINGS_SCHEMA_VERSION;
  verdict: "approve" | "needs-attention";
  summary: string;
  findings: Finding[];
  next_steps: string[];
  attack_round?: 1 | 2;
}

export type ValidationResult =
  | { ok: true; value: FindingsV1 }
  | { ok: false; error: string };

export function extractAndValidateFindings(raw: string): ValidationResult {
  const json = extractJsonBlob(raw);
  if (json === null) return { ok: false, error: "no JSON object found in response" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${(err as Error).message}` };
  }

  return validate(parsed);
}

export function validate(parsed: unknown): ValidationResult {
  if (!isObj(parsed)) return { ok: false, error: "root must be an object" };

  if (parsed.schema_version !== FINDINGS_SCHEMA_VERSION) {
    return { ok: false, error: `schema_version must be "${FINDINGS_SCHEMA_VERSION}"` };
  }
  if (parsed.verdict !== "approve" && parsed.verdict !== "needs-attention") {
    return { ok: false, error: "verdict must be 'approve' or 'needs-attention'" };
  }
  if (typeof parsed.summary !== "string" || parsed.summary.length === 0) {
    return { ok: false, error: "summary must be a non-empty string" };
  }
  if (!Array.isArray(parsed.findings)) {
    return { ok: false, error: "findings must be an array" };
  }
  if (!Array.isArray(parsed.next_steps) || parsed.next_steps.some((s) => typeof s !== "string" || s.length === 0)) {
    return { ok: false, error: "next_steps must be an array of non-empty strings" };
  }

  let attackRound: 1 | 2 = 1;
  if (parsed.attack_round !== undefined) {
    if (parsed.attack_round !== 1 && parsed.attack_round !== 2) {
      return { ok: false, error: "attack_round must be 1 or 2" };
    }
    attackRound = parsed.attack_round;
  }

  const ids = new Set<string>();
  const findings: Finding[] = [];
  for (let i = 0; i < parsed.findings.length; i++) {
    const f = parsed.findings[i];
    const result = validateFinding(f, i, attackRound);
    if (!result.ok) return result;
    if (ids.has(result.value.id)) {
      return { ok: false, error: `duplicate finding id: ${result.value.id}` };
    }
    ids.add(result.value.id);
    findings.push(result.value);
  }

  return {
    ok: true,
    value: {
      schema_version: FINDINGS_SCHEMA_VERSION,
      verdict: parsed.verdict as "approve" | "needs-attention",
      summary: parsed.summary,
      findings,
      next_steps: parsed.next_steps as string[],
      attack_round: attackRound,
    },
  };
}

function validateFinding(
  f: unknown,
  idx: number,
  attackRound: 1 | 2,
): { ok: true; value: Finding } | { ok: false; error: string } {
  if (!isObj(f)) return { ok: false, error: `findings[${idx}] must be an object` };
  const required = ["id", "severity", "title", "body", "file", "line_start", "line_end", "confidence"];
  for (const k of required) {
    if (!(k in f)) return { ok: false, error: `findings[${idx}] missing required field "${k}"` };
  }
  if (typeof f.id !== "string" || !ID_RE.test(f.id)) {
    return { ok: false, error: `findings[${idx}].id must match /^f-[a-z0-9]{4,16}$/` };
  }
  if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) {
    return { ok: false, error: `findings[${idx}].severity invalid` };
  }
  for (const k of ["title", "body", "file"] as const) {
    const v = f[k];
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, error: `findings[${idx}].${k} must be a non-empty string` };
    }
  }
  for (const k of ["line_start", "line_end"] as const) {
    const v = f[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { ok: false, error: `findings[${idx}].${k} must be a positive integer` };
    }
  }
  if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) {
    return { ok: false, error: `findings[${idx}].confidence must be a number in [0,1]` };
  }
  if (f.category !== undefined && (typeof f.category !== "string" || !CATEGORIES.has(f.category))) {
    return { ok: false, error: `findings[${idx}].category invalid` };
  }
  if (f.recommendation !== undefined && typeof f.recommendation !== "string") {
    return { ok: false, error: `findings[${idx}].recommendation must be a string` };
  }
  if (f.responding_to !== undefined) {
    if (attackRound !== 2) {
      return { ok: false, error: `findings[${idx}].responding_to only allowed when attack_round=2` };
    }
    if (!Array.isArray(f.responding_to)) {
      return { ok: false, error: `findings[${idx}].responding_to must be an array` };
    }
    for (const ref of f.responding_to) {
      if (typeof ref !== "string" || !ID_RE.test(ref)) {
        return { ok: false, error: `findings[${idx}].responding_to contains invalid id "${ref}"` };
      }
    }
  }
  if (f.stance !== undefined) {
    if (attackRound !== 2) {
      return { ok: false, error: `findings[${idx}].stance only allowed when attack_round=2` };
    }
    if (typeof f.stance !== "string" || !STANCES.has(f.stance)) {
      return { ok: false, error: `findings[${idx}].stance invalid` };
    }
  }
  return { ok: true, value: f as unknown as Finding };
}

function extractJsonBlob(raw: string): string | null {
  if (raw.length === 0) return null;
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced && fenced[1] !== undefined) return fenced[1].trim();
  // Fall back to first balanced top-level object
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
