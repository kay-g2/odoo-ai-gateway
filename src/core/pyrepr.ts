/**
 * Python `repr()` of JSON values, byte-for-byte.
 *
 * Odoo signs and verifies the completion webhook with `odoo.tools.misc.hmac`, which hashes
 * `repr((scope, message))` where `message` holds the values Python's `json.loads` produced from the
 * body we POSTed. To compute the same signature we must reproduce CPython's repr of those values:
 *
 * - `dict` -> `{'k': v, 'k2': v2}` in the order the keys appear in the JSON text;
 * - `list` -> `[a, b]`, tuples -> `(a, b)` / `(a,)`;
 * - `True` / `False` / `None`;
 * - JSON numbers without `.`/`e` parse to `int` (arbitrary precision), others to `float`
 *   (shortest round-trip digits, exponent form when the decimal exponent is < -4 or >= 16);
 * - `str` uses CPython's `unicode_repr` quoting and escaping rules.
 *
 * The input must be what `JSON.parse(JSON.stringify(x))` yields for the body actually sent
 * (see `normalizeForJson`), so that key order and number tokens match the serialized JSON.
 */

import { NEWER_PYTHON_PRINTABLE, PY312_NON_PRINTABLE } from "./python-unicode.js";

/** Marker for a Python tuple (JSON has none; the webhook message is a tuple). */
export class PyTuple {
  readonly items: readonly unknown[];
  constructor(...items: unknown[]) {
    this.items = items;
  }
}

export function pyRepr(value: unknown): string {
  if (value instanceof PyTuple) {
    const inner = value.items.map(pyRepr);
    return inner.length === 1 ? `(${inner[0]},)` : `(${inner.join(", ")})`;
  }
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pyNumberRepr(value);
  if (typeof value === "string") return pyStrRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as object).map(
      (key) => `${pyStrRepr(key)}: ${pyRepr((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(", ")}}`;
  }
  throw new TypeError(`pyRepr: unsupported value of type ${typeof value}`);
}

/**
 * repr() of the Python object `json.loads` builds from `JSON.stringify(n)`.
 *
 * `JSON.stringify` prints integral values below 1e21 as plain digits (Python: `int`), everything
 * else with a `.` or an exponent (Python: `float`). Non-finite numbers serialize to `null`.
 */
export function pyNumberRepr(n: number): string {
  if (!Number.isFinite(n)) return "None";
  const token = JSON.stringify(n);
  if (!/[.eE]/.test(token)) {
    // Python int parsed from the exact digits JavaScript printed.
    return token;
  }
  return pyFloatRepr(n);
}

/** CPython `float.__repr__` (the 'r' format with `Py_DTSF_ADD_DOT_0`). */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";

  const sign = x < 0 ? "-" : "";
  // toExponential() without argument yields the shortest round-trip digits, like repr().
  const [mantissa, expPart] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const exponent = Number(expPart); // value = d.ddd * 10^exponent
  const decpt = exponent + 1; // value = 0.ddd * 10^decpt

  if (decpt <= -4 || decpt > 16) {
    const frac = digits.length > 1 ? `.${digits.slice(1)}` : "";
    const expSign = exponent < 0 ? "-" : "+";
    const expDigits = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${digits[0]}${frac}e${expSign}${expDigits}`;
  }
  if (decpt <= 0) {
    return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  }
  if (decpt >= digits.length) {
    return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

function inRanges(ranges: readonly number[], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid * 2]!) hi = mid - 1;
    else if (cp > ranges[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * CPython's `Py_UNICODE_ISPRINTABLE` (false for Cc, Cf, Cs, Co, Cn, Zl, Zp, Zs except ' '), from
 * Python 3.12's Unicode 15.0 database, NOT the JavaScript engine's (Node 22 ships Unicode 17):
 * a character assigned after 15.0 is Cn, hence escaped, on the Python side.
 */
export function pyIsPrintable(cp: number): boolean {
  return !inRanges(PY312_NON_PRINTABLE, cp);
}

// Engine view of "assigned and printable", to catch characters newer than the generated tables.
const ENGINE_NON_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/**
 * True when Pythons supported by Odoo 20 (3.12 to 3.14) could disagree on escaping this
 * character: non-printable for Python 3.12 but printable for a newer Unicode database.
 */
export function printabilityVaries(cp: number): boolean {
  if (pyIsPrintable(cp)) return false;
  return inRanges(NEWER_PYTHON_PRINTABLE, cp) || !ENGINE_NON_PRINTABLE.test(String.fromCodePoint(cp));
}

function hex(codePoint: number, width: number): string {
  return codePoint.toString(16).padStart(width, "0");
}

/** CPython `str.__repr__` (Objects/unicodeobject.c: unicode_repr). */
export function pyStrRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";

  let out = quote;
  // Iterate by code point; lone surrogates come out as single code units.
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") {
      out += `\\${ch}`;
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (cp < 0x20 || cp === 0x7f) {
      out += `\\x${hex(cp, 2)}`;
    } else if (cp < 0x7f) {
      out += ch;
    } else if (pyIsPrintable(cp)) {
      out += ch;
    } else if (cp <= 0xff) {
      out += `\\x${hex(cp, 2)}`;
    } else if (cp <= 0xffff) {
      out += `\\u${hex(cp, 4)}`;
    } else {
      out += `\\U${hex(cp, 8)}`;
    }
  }
  return out + quote;
}
