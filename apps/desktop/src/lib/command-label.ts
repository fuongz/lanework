// What a shell command a harness ran is called in a chat's tool row: `Ran rg`
// rather than the whole line (`rg -n '…' src; cat src/…`), as t3code labels
// its work log. The full command stays in the row's tooltip and panel.
//
// NOTE: A reading, never a run, and a small one: zsh/bash as the harnesses on
// macOS write them. Anything it cannot place (shell syntax, a function, a
// broken quote) gives null, and the row falls back to the command itself.

/** `zsh -lc '<script>'` and its kin: the script, as the agent wrote it. */
const SHELL_WRAPPER =
  /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:(?:--[a-z-]+\s+[^\s'"]+|-[a-zA-Z]+(?<!c))\s+)*-[a-zA-Z]*c\s+(['"])([\s\S]*)\1\s*$/;

/** Steps that only prepare the next one: `cd x && npm test` is `npm`. */
const SETUP = new Set([
  "cd",
  "pushd",
  "popd",
  "source",
  ".",
  "export",
  "unset",
  "set",
  "setopt",
  "true",
  ":",
  "eval",
]);

/** Run the next word as the program: `sudo`, `timeout 10s`, `env X=1`. */
const WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "builtin",
  "exec",
  "time",
  "nohup",
  "nice",
  "noglob",
  "nocorrect",
  "timeout",
]);

/** Shell syntax rather than a program: the segment names nothing. */
const SYNTAX = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "repeat",
  "return",
  "test",
  "[",
  "[[",
  "{",
  "}",
  "(",
  "((",
  "!",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** The command without its `zsh -lc '…'` wrapper. */
export function commandText(command: string): string {
  const match = SHELL_WRAPPER.exec(command);
  if (!match) return command.trim();
  const script = match[2] ?? "";
  // Inside single quotes a quote is written `'\''`.
  return (match[1] === "'" ? script.replaceAll("'\\''", "'") : script).trim();
}

/**
 * The script's steps, split at `&&`, `||`, `;`, `|`, `&` and newlines
 * outside quotes, each a list of its words; null on an unclosed quote.
 */
function steps(script: string): string[][] | null {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | null = null;
  const endWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const endStep = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let at = 0; at < script.length; at++) {
    const char = script[at] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') word += script[++at] ?? "";
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      // An empty quoted word still counts as a word.
      word += "";
      continue;
    }
    if (char === "\\") {
      if (script[at + 1] === "\n") at++;
      else word += script[++at] ?? "";
      continue;
    }
    if (char === "#" && !word) {
      // A comment runs to the end of its line.
      while (at < script.length && script[at] !== "\n") at++;
      endStep();
      continue;
    }
    if (";|&\n".includes(char)) {
      endStep();
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    word += char;
  }
  if (quote) return null;
  endStep();
  return out;
}

/** The program one step runs, past assignments and wrappers; null if none. */
function programOf(words: string[]): string | null {
  let at = 0;
  while (at < words.length) {
    const word = words[at] as string;
    if (ASSIGNMENT.test(word)) {
      at++;
      continue;
    }
    if (WRAPPERS.has(word)) {
      at++;
      // The wrapper's own flags and values: `sudo -u root`, `timeout 10s`,
      // `env -u DEBUG X=1`.
      while (at < words.length) {
        const next = words[at] as string;
        if (next.startsWith("-")) {
          at += /^-[uCgp]$/.test(next) ? 2 : 1;
        } else if (ASSIGNMENT.test(next) || /^\d+[smhd]?$/.test(next)) {
          at++;
        } else break;
      }
      continue;
    }
    break;
  }
  const word = words[at];
  if (!word || SYNTAX.has(word) || /^[<>(){}[\]$`!%@:#]/.test(word))
    return null;
  if (word.endsWith("()")) return null;
  const name = word.split("/").pop() ?? "";
  return name || null;
}

/**
 * The program a command runs, for its row: `rg` for
 * `zsh -lc 'cd src && rg -n x | head'`. Setup steps (`cd`, `source`,
 * `export`) are passed over for the step after them.
 *
 * @returns null when no step names a program a person would recognise.
 */
export function commandProgram(command: string): string | null {
  const parsed = steps(commandText(command));
  if (!parsed) return null;
  for (const words of parsed) {
    const program = programOf(words);
    if (program && !SETUP.has(program)) return program;
  }
  return null;
}
