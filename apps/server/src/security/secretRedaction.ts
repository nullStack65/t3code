/**
 * Shared secret detection and redaction for prompts, webhooks, and provider logs (CLO-1099).
 */

export const SECRET_REDACTED = "[redacted]";

const SECRET_VALUE_PATTERN =
  /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?<![A-Za-z0-9_-])sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}|(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9_]{20,}|(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}|(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}|(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{20,}|(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{20,}|(?<![A-Za-z0-9_-])pypi-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9])AKIA[0-9A-Z]{12,}|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,})/g;

const INLINE_SECRET_PATTERN =
  /(?:secret|token|access[_-]?token|refresh[_-]?token|password|passwd|api[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|authorization|credential|bearer|client[_-]?secret|webhook[_-]?secret|session[_-]?(?:token|cookie|id)|cookie[_-]?header)\s*[:=]\s*[^\s,;}\]"']+/gi;

const CREDENTIAL_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-t3-relay-.*)$|token|secret|signature|key|password|passwd|auth|credential|hmac|jwt|assertion/i;

export interface SecretRedactionResult {
  readonly text: string;
  readonly redactedCount: number;
}

export function redactSecretText(input: string): SecretRedactionResult {
  let redactedCount = 0;
  const afterValues = input.replace(SECRET_VALUE_PATTERN, () => {
    redactedCount += 1;
    return SECRET_REDACTED;
  });
  const afterInline = afterValues.replace(
    INLINE_SECRET_PATTERN,
    (match, offset: number, full: string) => {
      // INLINE_SECRET_PATTERN stops before ']', so values already replaced with
      // '[redacted]' match up to '[redacted'. Skip double-counting those.
      const prefix = SECRET_REDACTED.slice(0, -1);
      if (match.endsWith(prefix) && full[offset + match.length] === "]") {
        return match;
      }
      redactedCount += 1;
      return SECRET_REDACTED;
    },
  );
  return { text: afterInline, redactedCount };
}

export function containsSecret(input: string): boolean {
  return redactSecretText(input).redactedCount > 0;
}

function isCredentialKeyName(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key);
}

const MAX_DEEP_DEPTH = 24;

export function redactSecretsDeep(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return redactSecretText(value).text;
  }
  if (value === null || typeof value !== "object" || depth > MAX_DEEP_DEPTH) {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && isCredentialKeyName(key)) {
      out[key] = SECRET_REDACTED;
    } else {
      out[key] = redactSecretsDeep(entry, depth + 1, seen);
    }
  }
  return out;
}
