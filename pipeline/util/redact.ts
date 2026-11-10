/**
 * Credential patterns shared by the logger (redaction) and the publish-time
 * secret scan. Patterns are deliberately specific so that ordinary prose such
 * as "send a Bearer token in the header" is not flagged.
 */
export interface SecretPattern {
  name: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'GitHub personal access token (classic)', regex: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'GitHub fine-grained token', regex: /github_pat_[A-Za-z0-9_]{22,}/g },
  { name: 'GitHub OAuth token', regex: /gho_[A-Za-z0-9]{36,}/g },
  { name: 'GitHub server-to-server token', regex: /ghs_[A-Za-z0-9]{36,}/g },
  { name: 'GitHub user-to-server token', regex: /ghu_[A-Za-z0-9]{36,}/g },
  { name: 'GitHub refresh token', regex: /ghr_[A-Za-z0-9]{36,}/g },
  { name: 'Bearer credential', regex: /Bearer\s+[A-Za-z0-9_\-.=+/]{20,}/g },
];

/** Replace anything that looks like a credential (and any extra literal values) with a marker. */
export function redact(text: string, literals: readonly string[] = []): string {
  let out = text;
  for (const literal of literals) {
    if (literal && literal.length >= 8) out = out.split(literal).join('[REDACTED]');
  }
  for (const { regex } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(regex.source, regex.flags), '[REDACTED]');
  }
  return out;
}
