// What the checkpoint hook strips from text before it leaves the machine: a
// summary, a request, a command line, a log line (FE-78/D3). It also decides
// whether a WIP snapshot may be pushed: an added line it would change keeps
// the snapshot home.
//
// NOTE: It is greedy. A false positive costs a word in a summary, a false
// negative puts a key on a server. It still leaves ordinary flags alone:
// `mkdir -p x`, `git log -p` and `ssh -p 2222 h` are not passwords.

/** One rule: what it finds, and what it puts there. */
type Rule = [RegExp, string];

const R = "[REDACTED]";

/** Option names whose value is a secret, as `--name value` or `--name=value`. */
const SECRET_FLAG =
  /(--(?:password|passwd|pass|token|api-key|apikey|secret|client-secret|access-token|auth-token)(?:=|\s+))(["']?)(?!-)(?!\[REDACTED)[^\s"']+/gi;

const RULES: Rule[] = [
  // PEM and PGP armour, terminated or not: a key cut off mid-paste is still
  // a key.
  [
    /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?(?:-----END \1-----|$)/g,
    "[REDACTED $1]",
  ],
  // lanework's own tokens.
  [/\blw_(?:reg|mch|dev|code)_[A-Za-z0-9_-]+/g, R],
  // Stripe: secret, restricted, publishable keys and webhook secrets.
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, R],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, R],
  // OpenAI, Anthropic and other `sk-` keys.
  [
    /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g,
    R,
  ],
  // GitHub.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  // GitLab.
  [/\bgl(?:pat|dt|rt|ptt|cbt|imt|oas|soat|ft|agent)-[A-Za-z0-9_-]{16,}/g, R],
  // npm, Hugging Face, PyPI.
  [/\bnpm_[A-Za-z0-9]{20,}/g, R],
  [/\bhf_[A-Za-z0-9]{20,}/g, R],
  [/\bpypi-[A-Za-z0-9_-]{30,}/g, R],
  // Slack tokens and webhooks.
  [/\bxox[abposre]-[A-Za-z0-9-]{10,}/g, R],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, R],
  [/\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, `hooks.slack.com/${R}`],
  // AWS access key ids; their secrets are caught by the KEY=value rule.
  [/\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, R],
  // Google API keys and OAuth access tokens.
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, R],
  // JWTs.
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[REDACTED jwt]",
  ],
  // Authorization headers.
  [/\b(Bearer|Basic)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${R}`],
  [
    /(\bAuthorization\s*[:=]\s*["']?(?:[A-Za-z]+\s+)?)(?!\[REDACTED)[^\s"',;]{8,}/gi,
    `$1${R}`,
  ],
  // `user:password@host` in URLs (database URLs included), and a long
  // user-only part, which is a token: `https://<token>@github.com`.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${R}@`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]{16,}@/gi, `$1${R}@`],
  // `curl -u user:pass`, `curl --user user:pass`.
  [/((?:^|\s)(?:-u|--user)(?:=|\s*))(["']?)[^\s"':]+:[^\s"']+/g, `$1$2${R}`],
  // `docker login -p X`, `sshpass -p X`: `-p` is a password only there.
  [
    /(\b(?:docker|podman|nerdctl|helm)\s+(?:registry\s+)?login\b[^\n]*?\s-p\s*)(["']?)(?!-)[^\s"']+/g,
    `$1$2${R}`,
  ],
  [/(\bsshpass\s+(?:-\w+\s+)*?-p\s*)(["']?)(?!-)[^\s"']+/g, `$1$2${R}`],
  // `mysql -pX`: the password is glued to `-p`; a bare `-p` prompts.
  [
    /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]*?\s-p)(["']?)(?![\s"'-])[^\s"']+/g,
    `$1$2${R}`,
  ],
  // `--password=X`, `--token X` and friends.
  [SECRET_FLAG, `$1$2${R}`],
  // KEY=value / "secret": "value" style assignments.
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|passw(?:or)?d|passphrase|token|credential|private[_-]?key|access[_-]?key|auth[_-]?key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"',;]{6,}/gi,
    `$1$2${R}`,
  ],
];

/**
 * Strip anything that looks like a credential.
 *
 * NOTE: It is greedy. A false positive costs a word in a summary, a false
 * negative puts a key on a server.
 */
export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of RULES)
    out = out.replace(pattern, replacement);
  return out;
}
