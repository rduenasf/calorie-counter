// Safe arithmetic evaluator for the meal calculator (no eval).
// Supports + - × ÷ (and * /), parentheses, decimals and unary minus.

function tokenize(expr) {
  const tokens = [];
  const src = expr.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/,/g, ".");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " ") {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = Number(src.slice(i, j));
      if (Number.isNaN(num)) throw new Error("Bad number");
      tokens.push(num);
      i = j;
    } else if ("+-*/()".includes(ch)) {
      tokens.push(ch);
      i++;
    } else {
      throw new Error(`Unexpected "${ch}"`);
    }
  }
  return tokens;
}

// Recursive descent: expr = term (('+'|'-') term)*, term = factor (('*'|'/') factor)*
export function evaluate(expr) {
  const tokens = tokenize(expr);
  if (tokens.length === 0) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function factor() {
    const t = next();
    if (t === "-") return -factor();
    if (t === "+") return factor();
    if (t === "(") {
      const v = parseExpr();
      if (next() !== ")") throw new Error("Missing )");
      return v;
    }
    if (typeof t === "number") return t;
    throw new Error("Incomplete");
  }

  function term() {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const rhs = factor();
      if (op === "/" && rhs === 0) throw new Error("Divide by 0");
      v = op === "*" ? v * rhs : v / rhs;
    }
    return v;
  }

  function parseExpr() {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = term();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error("Unexpected input");
  return result;
}

// Evaluates without throwing; returns null when the expression is incomplete.
export function tryEvaluate(expr) {
  try {
    const v = evaluate(expr);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
