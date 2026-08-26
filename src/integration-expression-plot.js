import { Buffer } from "node:buffer";

export const INTEGRATION_EXPRESSION_PLOT_SCHEMA_VERSION = "aginti-integration-expression-plot-v1";

const MAX_EXPRESSION_BYTES = 256;
const MAX_TOKENS = 128;
const MAX_AST_NODES = 128;
const MAX_PARSE_DEPTH = 24;
const MAX_LITERAL_MAGNITUDE = 1_000_000;
const X_MINIMUM = -5;
const X_MAXIMUM = 5;
const SAMPLE_COUNT = 201;
const MAX_DISPLAY_CHARACTERS = 80;
const FUNCTIONS = new Map([
  ["abs", "abs"],
  ["acos", "math.acos"],
  ["asin", "math.asin"],
  ["atan", "math.atan"],
  ["ceil", "math.ceil"],
  ["cos", "math.cos"],
  ["cosh", "math.cosh"],
  ["exp", "math.exp"],
  ["floor", "math.floor"],
  ["ln", "math.log"],
  ["log", "math.log"],
  ["log10", "math.log10"],
  ["log2", "math.log2"],
  ["sin", "math.sin"],
  ["sinh", "math.sinh"],
  ["sqrt", "math.sqrt"],
  ["tan", "math.tan"],
  ["tanh", "math.tanh"],
]);
const CONSTANTS = new Map([
  ["e", "math.e"],
  ["pi", "math.pi"],
]);
const MATH_SIGNAL =
  /(?:[\^+*/π×÷−]|(?:^|[^A-Za-z])x(?:[^A-Za-z]|$)|\b(?:e|pi|abs|acos|asin|atan|ceil|cos|cosh|exp|floor|ln|log|log10|log2|sin|sinh|sqrt|tan|tanh)\b)/iu;
const NUMERIC_MATH_EXPRESSION = /^[\s0-9.eE()+*/^×÷−-]+$/u;
const CODE_SYNTAX_SIGNAL =
  /(?:\b(?:compile|eval|exec|open)\s*\(|\b(?:import|lambda)\b|__[A-Za-z]|[A-Za-z_][A-Za-z0-9_]*\s*\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(|;)/iu;
const NUMBER_PREFIX = /^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/u;
const IDENTIFIER_PREFIX = /^[A-Za-z][A-Za-z0-9]*/u;

export class IntegrationExpressionPlotError extends Error {
  constructor(message) {
    super(message);
    this.name = "IntegrationExpressionPlotError";
    this.code = "ANALYSIS_EXPRESSION_PLOT_INVALID";
    this.publicCode = this.code;
    this.status = 400;
    this.statusCode = 400;
  }
}

function invalid(message = "The requested mathematical plot expression is invalid or unsupported.") {
  throw new IntegrationExpressionPlotError(message);
}

function imperativeActionText(value) {
  let text = String(value ?? "").trim();
  text = text.replace(/^(?:please|kindly)\s+/iu, "");
  text = text.replace(/^(?:can|could|would|will)\s+you\s+(?:(?:please|kindly)\s+)?/iu, "");
  text = text.replace(/^i(?:'d| would)?\s+(?:like|want|need)\s+(?:you\s+)?to\s+/iu, "");
  text = text.replace(/^let(?:'s| us)\s+/iu, "");
  return text;
}

function expressionFromPrompt(value) {
  const match =
    /^plot\s+(?!(?:is|means?|refers?|describes?|if|whether|would|could|might|may|should|can)\b)([\s\S]+)$/iu
      .exec(imperativeActionText(value));
  if (!match) return null;
  const expression = match[1]
    .trim()
    .replace(/[?!]\s*$/u, "")
    .trim()
    .replace(/^y\s*=\s*/iu, "")
    .trim();
  if (
    !expression ||
    !(MATH_SIGNAL.test(expression) || NUMERIC_MATH_EXPRESSION.test(expression) || CODE_SYNTAX_SIGNAL.test(expression))
  ) {
    return null;
  }
  if (Buffer.byteLength(expression, "utf8") > MAX_EXPRESSION_BYTES) {
    invalid("The requested mathematical plot expression exceeds its safe size limit.");
  }
  return expression
    .replaceAll("π", "pi")
    .replaceAll("×", "*")
    .replaceAll("÷", "/")
    .replaceAll("−", "-");
}

export function permitsIntegrationExpressionPlotModelFallback(value) {
  const match =
    /^plot\s+(?!(?:is|means?|refers?|describes?|if|whether|would|could|might|may|should|can)\b)([\s\S]+)$/iu
      .exec(imperativeActionText(value));
  if (!match) return false;
  const expression = match[1]
    .trim()
    .replace(/[?!]\s*$/u, "")
    .trim()
    .replace(/^y\s*=\s*/iu, "")
    .trim();
  return expression.length > 0 &&
    Buffer.byteLength(expression, "utf8") <= MAX_EXPRESSION_BYTES &&
    !CODE_SYNTAX_SIGNAL.test(expression);
}

function rawTokens(expression) {
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    const remainder = expression.slice(index);
    const number = NUMBER_PREFIX.exec(remainder)?.[0];
    if (number) {
      const numeric = Number(number);
      if (!Number.isFinite(numeric) || Math.abs(numeric) > MAX_LITERAL_MAGNITUDE) {
        invalid("The requested mathematical plot contains an unsupported numeric literal.");
      }
      tokens.push({ kind: "number", value: number, numeric });
      index += number.length;
    } else {
      const identifier = IDENTIFIER_PREFIX.exec(remainder)?.[0];
      if (identifier) {
        tokens.push({ kind: "identifier", value: identifier.toLowerCase() });
        index += identifier.length;
      } else if ("+-*/^()".includes(character)) {
        tokens.push({
          kind: character === "(" ? "left" : character === ")" ? "right" : "operator",
          value: character,
        });
        index += 1;
      } else {
        invalid("The requested mathematical plot contains unsupported syntax.");
      }
    }
    if (tokens.length > MAX_TOKENS) {
      invalid("The requested mathematical plot exceeds its safe token limit.");
    }
  }
  if (tokens.length === 0) invalid();
  return tokens;
}

function endsValue(token) {
  return token?.kind === "number" || token?.kind === "right" ||
    (token?.kind === "identifier" && (token.value === "x" || CONSTANTS.has(token.value)));
}

function startsValue(token) {
  return token?.kind === "number" || token?.kind === "left" || token?.kind === "identifier";
}

function tokenize(expression) {
  const input = rawTokens(expression);
  const output = [];
  for (const token of input) {
    const previous = output.at(-1);
    if (
      endsValue(previous) &&
      startsValue(token) &&
      !(previous.kind === "number" && token.kind === "number")
    ) {
      output.push({ kind: "operator", value: "*" });
    }
    output.push(token);
    if (output.length > MAX_TOKENS) {
      invalid("The requested mathematical plot exceeds its safe token limit.");
    }
  }
  return output;
}

class ExpressionParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
    this.nodes = 0;
    this.depth = 0;
  }

  node(type, fields) {
    this.nodes += 1;
    if (this.nodes > MAX_AST_NODES) {
      invalid("The requested mathematical plot exceeds its safe complexity limit.");
    }
    return Object.freeze({ type, ...fields });
  }

  nested(callback) {
    this.depth += 1;
    if (this.depth > MAX_PARSE_DEPTH) {
      invalid("The requested mathematical plot exceeds its safe nesting limit.");
    }
    try {
      return callback();
    } finally {
      this.depth -= 1;
    }
  }

  current() {
    return this.tokens[this.index] || null;
  }

  take(value) {
    if (this.current()?.value !== value) return false;
    this.index += 1;
    return true;
  }

  parse() {
    const result = this.nested(() => this.additive());
    if (this.current()) invalid("The requested mathematical plot contains unsupported syntax.");
    return result;
  }

  additive() {
    let left = this.multiplicative();
    while (this.current()?.value === "+" || this.current()?.value === "-") {
      const operator = this.current().value;
      this.index += 1;
      const right = this.multiplicative();
      left = this.node("binary", { operator, left, right });
    }
    return left;
  }

  multiplicative() {
    let left = this.unary();
    while (this.current()?.value === "*" || this.current()?.value === "/") {
      const operator = this.current().value;
      this.index += 1;
      const right = this.unary();
      left = this.node("binary", { operator, left, right });
    }
    return left;
  }

  unary() {
    if (this.current()?.value === "+" || this.current()?.value === "-") {
      const operator = this.current().value;
      this.index += 1;
      return this.nested(() => this.node("unary", { operator, value: this.unary() }));
    }
    return this.power();
  }

  power() {
    const left = this.primary();
    if (!this.take("^")) return left;
    const right = this.nested(() => this.unary());
    return this.node("binary", { operator: "^", left, right });
  }

  primary() {
    const token = this.current();
    if (!token) invalid("The requested mathematical plot expression is incomplete.");
    if (token.kind === "number") {
      this.index += 1;
      return this.node("number", { value: token.numeric });
    }
    if (token.kind === "identifier") {
      this.index += 1;
      if (token.value === "x") return this.node("variable", {});
      if (CONSTANTS.has(token.value)) return this.node("constant", { name: token.value });
      if (!FUNCTIONS.has(token.value) || !this.take("(")) {
        invalid("The requested mathematical plot uses an unsupported name or function.");
      }
      const argument = this.nested(() => this.additive());
      if (!this.take(")")) invalid("The requested mathematical plot has unmatched parentheses.");
      return this.node("function", { name: token.value, argument });
    }
    if (this.take("(")) {
      const value = this.nested(() => this.additive());
      if (!this.take(")")) invalid("The requested mathematical plot has unmatched parentheses.");
      return value;
    }
    invalid("The requested mathematical plot contains unsupported syntax.");
  }
}

function pythonNumber(value) {
  if (!Number.isFinite(value)) invalid();
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function pythonExpression(node) {
  if (node.type === "number") return pythonNumber(node.value);
  if (node.type === "variable") return "x";
  if (node.type === "constant") return CONSTANTS.get(node.name);
  if (node.type === "function") {
    return `float(${FUNCTIONS.get(node.name)}(${pythonExpression(node.argument)}))`;
  }
  if (node.type === "unary") return `(${node.operator}${pythonExpression(node.value)})`;
  if (node.type === "binary") {
    const operator = node.operator === "^" ? "**" : node.operator;
    return `(${pythonExpression(node.left)} ${operator} ${pythonExpression(node.right)})`;
  }
  invalid();
}

function displayExpression(tokens) {
  const text = tokens.map(({ value }) => value).join(" ");
  const characters = Array.from(text);
  if (characters.length <= MAX_DISPLAY_CHARACTERS) return text;
  return `${characters.slice(0, MAX_DISPLAY_CHARACTERS - 1).join("")}…`;
}

function pythonSource(expression, display) {
  const title = `Plot of ${display}`;
  const seriesName = `f(x) = ${display}`;
  const step = (X_MAXIMUM - X_MINIMUM) / (SAMPLE_COUNT - 1);
  return [
    "import math",
    "_points = []",
    `for _index in range(${SAMPLE_COUNT}):`,
    `    x = ${pythonNumber(X_MINIMUM)} + _index * ${pythonNumber(step)}`,
    "    try:",
    `        _value = ${expression}`,
    "        if isinstance(_value, (bool, complex)):",
    "            continue",
    "        _value = float(_value)",
    "        if math.isfinite(_value) and abs(_value) <= 1000000000000.0:",
    "            _points.append({'x': x, 'y': _value})",
    "    except (ArithmeticError, ValueError, TypeError):",
    "        continue",
    "if len(_points) < 2:",
    "    raise ValueError('Expression produced too few finite samples in the fixed plotting range.')",
    `emit_plot(${JSON.stringify(title)}, {` +
      "'schemaVersion':'1','type':'scatter','xLabel':'x','yLabel':'f(x)'," +
      `'series':[{'name':${JSON.stringify(seriesName)},'points':_points}]})`,
    "print('Generated a bounded expression plot with', len(_points), 'finite samples.')",
  ].join("\n");
}

export function compileIntegrationExpressionPlotPrompt(value) {
  const expression = expressionFromPrompt(value);
  if (expression === null) return null;
  const tokens = tokenize(expression);
  const ast = new ExpressionParser(tokens).parse();
  const display = displayExpression(tokens);
  const compiledExpression = pythonExpression(ast);
  return Object.freeze({
    schemaVersion: INTEGRATION_EXPRESSION_PLOT_SCHEMA_VERSION,
    expression: display,
    source: pythonSource(compiledExpression, display),
    xMinimum: X_MINIMUM,
    xMaximum: X_MAXIMUM,
    sampleCount: SAMPLE_COUNT,
  });
}
