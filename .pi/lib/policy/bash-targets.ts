/**
 * Extract paths that a shell command would *create*, for the project structure
 * guard.
 *
 * Shell is not statically analysable in general, so this deliberately errs
 * toward missing a creation rather than blocking a legitimate command: a false
 * positive makes the guard hostile and gets it disabled, while a false negative
 * only leaves the pre-existing gap. Anything whose target cannot be read
 * literally — command substitution, variables, globs, heredocs, or a working
 * directory changed mid-command — yields no candidates at all.
 */

/** Commands whose non-flag operands name paths they create. */
const CREATE_ALL_OPERANDS = new Set(["touch", "mkdir", "tee"]);
/** Commands that create their final operand (the destination). */
const CREATE_LAST_OPERAND = new Set(["cp", "mv", "install", "ln"]);
/** Constructs that make literal reasoning unsound. */
const UNPARSEABLE = /\$\(|`|\$\{|\$[A-Za-z_]|<<|\*|\?|\[/;

interface Token { value: string; quoted: boolean; }

/** Split a command into tokens, tracking whether each was quoted. */
function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  let quote: '"' | "'" | undefined;
  const push = () => { if (started) tokens.push({ value: current, quoted }); current = ""; quoted = false; started = false; };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) { quote = undefined; continue; }
      current += char; started = true; continue;
    }
    if (char === '"' || char === "'") { quote = char; quoted = true; started = true; continue; }
    if (char === "\\") { const next = command[++index]; if (next !== undefined) { current += next; started = true; } continue; }
    if (/\s/.test(char)) { push(); continue; }
    // Operators are their own tokens so redirects and separators stay visible.
    if (char === ">" || char === "<" || char === ";" || char === "|" || char === "&" || char === "\n") {
      push();
      let operator = char;
      while (command[index + 1] === char && operator.length < 2) { operator += command[++index]; }
      tokens.push({ value: operator, quoted: false });
      continue;
    }
    current += char; started = true;
  }
  if (quote) return undefined; // unbalanced quoting: refuse to guess
  push();
  return tokens;
}

const SEPARATORS = new Set([";", "|", "||", "&", "&&", "\n"]);

/**
 * Paths a command would create. Returns an empty array whenever the command
 * cannot be read literally, which the caller treats as "nothing to check".
 */
export function bashCreationTargets(command: string): string[] {
  if (typeof command !== "string" || !command.trim()) return [];
  // A heredoc or substitution anywhere means operands may not be literal.
  if (/<<|\$\(|`/.test(command)) return [];
  const tokens = tokenize(command);
  if (!tokens) return [];

  const targets: string[] = [];
  let segment: Token[] = [];
  let aborted = false;
  const flush = () => {
    if (!segment.length) return;
    const result = segmentTargets(segment);
    // `cd` rebinds the working directory for every later segment too, so one
    // unreadable segment invalidates the whole command rather than just itself.
    if (result === undefined) aborted = true;
    else targets.push(...result);
    segment = [];
  };
  for (const token of tokens) {
    if (!token.quoted && SEPARATORS.has(token.value)) { flush(); if (aborted) return []; continue; }
    segment.push(token);
  }
  flush();
  return aborted ? [] : targets.filter(Boolean);
}

/** Returns undefined when the segment makes literal reasoning unsound. */
function segmentTargets(tokens: Token[]): string[] | undefined {
  const targets: string[] = [];
  const operands: Token[] = [];
  let command: string | undefined;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.quoted && (token.value === ">" || token.value === ">>")) {
      const destination = tokens[++index];
      // `> file` creates it; a quoted ">" inside an argument never reaches here.
      if (destination && !isLiteralPath(destination)) continue;
      if (destination) targets.push(destination.value);
      continue;
    }
    if (!token.quoted && token.value === "<") { index++; continue; }
    if (command === undefined) {
      // `cd` changes the directory the rest of the command resolves against;
      // resolving that correctly is out of scope, so claim nothing.
      const name = token.value.split("/").pop() ?? token.value;
      if (name === "cd" || name === "pushd") return undefined;
      command = name;
      continue;
    }
    if (token.value.startsWith("-")) continue; // flag, not a path
    operands.push(token);
  }

  if (!command) return targets;
  if (CREATE_ALL_OPERANDS.has(command)) {
    for (const operand of operands) { if (!isLiteralPath(operand)) return targets; targets.push(operand.value); }
    return targets;
  }
  if (CREATE_LAST_OPERAND.has(command) && operands.length >= 2) {
    const destination = operands[operands.length - 1];
    // `cp a b c/` with several sources creates entries *inside* the
    // destination directory; only the single-source form names its own target.
    if (operands.length === 2 && isLiteralPath(destination)) targets.push(destination.value);
    return targets;
  }
  return targets;
}

/** A path is usable only when it is literal and not a shell special file. */
function isLiteralPath(token: Token): boolean {
  const value = token.value;
  if (!value || UNPARSEABLE.test(value)) return false;
  if (value.startsWith("/dev/") || value.startsWith("&")) return false;
  return true;
}
