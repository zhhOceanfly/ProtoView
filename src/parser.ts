import { MetaBadge, badgesFromMeta, parseMetaOption } from "./meta";

export interface SourceLoc {
  line: number;
  endLine: number;
}

export interface FieldDef {
  name: string;
  typeName: string;
  mapKey?: string;
  mapValue?: string;
  repeated: boolean;
  optional: boolean;
  number: number;
  comment: string;
  loc: SourceLoc;
}

export interface OneofDef {
  name: string;
  comment: string;
  fields: FieldDef[];
  loc: SourceLoc;
}

export interface EnumValueDef {
  name: string;
  number: number;
  comment: string;
  loc: SourceLoc;
}

export interface EnumDef {
  name: string;
  fullName: string;
  comment: string;
  values: EnumValueDef[];
  loc: SourceLoc;
}

export type MessageMember =
  | { kind: "field"; field: FieldDef }
  | { kind: "oneof"; oneof: OneofDef };

export interface MessageDef {
  name: string;
  fullName: string;
  comment: string;
  fields: FieldDef[];
  oneofs: OneofDef[];
  members: MessageMember[];
  nestedMessages: MessageDef[];
  nestedEnums: EnumDef[];
  loc: SourceLoc;
}

export interface RpcDef {
  name: string;
  comment: string;
  request: string;
  response: string;
  requestStream: boolean;
  responseStream: boolean;
  httpVerb?: string;
  httpPath?: string;
  httpBody?: string;
  timeout?: string;
  auth?: string;
  closed?: boolean;
  badges: MetaBadge[];
  source: string;
  loc: SourceLoc;
}

export interface ServiceDef {
  name: string;
  comment: string;
  rpcs: RpcDef[];
  loc: SourceLoc;
}

export interface ProtoFile {
  path: string;
  relPath: string;
  package: string;
  imports: string[];
  services: ServiceDef[];
  messages: MessageDef[];
  enums: EnumDef[];
}

export class ProtoParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message}（第 ${line} 行）`);
    this.name = "ProtoParseError";
  }
}

interface Token {
  kind: "id" | "str" | "num" | "sym";
  value: string;
  line: number;
  lead: string;
  trail: string;
  from: number;
  to: number;
  leadFrom: number;
}

const SCALARS = new Set([
  "double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64",
  "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes",
]);

export function isScalar(typeName: string): boolean {
  return SCALARS.has(typeName.replace(/^\./, ""));
}

export function parseProto(text: string, filePath: string, relPath = filePath): ProtoFile {
  const tokens = tokenize(text);
  const parser = new Parser(tokens, filePath, text);
  return parser.parseFile(relPath);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const state = { lineDirty: false, tokenOnLine: false, last: null as Token | null };
  const lead: string[] = [];
  let leadFrom = -1;

  const push = (kind: Token["kind"], value: string, tokLine: number, from: number, to: number) => {
    const tok: Token = {
      kind,
      value,
      line: tokLine,
      lead: lead.join("\n").trim(),
      trail: "",
      from,
      to,
      leadFrom,
    };
    lead.length = 0;
    leadFrom = -1;
    tokens.push(tok);
    state.last = tok;
    state.lineDirty = true;
    state.tokenOnLine = true;
  };

  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      if (!state.lineDirty) {
        lead.length = 0;
        leadFrom = -1;
      }
      line++;
      state.lineDirty = false;
      state.tokenOnLine = false;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const commentFrom = i;
      const start = i + 2;
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      const raw = text.slice(start, i).replace(/^\s+/, "").replace(/\s+$/, "");
      state.lineDirty = true;
      if (state.tokenOnLine && state.last) {
        state.last.trail = state.last.trail ? `${state.last.trail} ${raw}` : raw;
      } else if (raw) {
        if (leadFrom < 0) leadFrom = commentFrom;
        lead.push(raw);
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const commentFrom = i;
      const startLine = line;
      i += 2;
      const start = i;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      const raw = text.slice(start, i)
        .split("\n")
        .map((part) => part.replace(/^\s*\* ?/, "").trim())
        .filter((part, idx, arr) => part.length > 0 || (idx > 0 && idx < arr.length - 1))
        .join("\n")
        .trim();
      if (text[i] === "*") i += 2;
      state.lineDirty = true;
      const sameLine = startLine === (state.tokenOnLine ? state.last?.line : -1);
      if (state.tokenOnLine && state.last && sameLine) {
        state.last.trail = state.last.trail ? `${state.last.trail}\n${raw}` : raw;
      } else if (raw && !/^\*+$/.test(raw.replace(/\s/g, "")) && !/^\*+ .+ \*+$/.test(raw)) {
        if (leadFrom < 0) leadFrom = commentFrom;
        lead.push(raw);
      } else if (raw && !/service|message|enum/i.test(raw)) {
        if (leadFrom < 0) leadFrom = commentFrom;
        lead.push(raw);
      }
      continue;
    }
    if (c === "\"" || c === "'") {
      const quote = c;
      const tokLine = line;
      const from = i;
      i++;
      let value = "";
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") {
          value += text[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (text[i] === "\n") line++;
        value += text[i];
        i++;
      }
      i++;
      push("str", value, tokLine, from, i);
      continue;
    }
    if (c >= "0" && c <= "9") {
      const tokLine = line;
      const start = i;
      if (text.startsWith("0x", i) || text.startsWith("0X", i)) {
        i += 2;
        while (i < text.length && /[0-9a-fA-F]/.test(text[i])) i++;
      } else {
        while (i < text.length && /[0-9]/.test(text[i])) i++;
      }
      push("num", text.slice(start, i), tokLine, start, i);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const tokLine = line;
      const start = i;
      i++;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
      push("id", text.slice(start, i), tokLine, start, i);
      continue;
    }
    push("sym", c, line, i, i + 1);
    i++;
  }
  return tokens;
}

class Parser {
  private i = 0;

  constructor(private readonly tokens: Token[], private readonly filePath: string, private readonly text: string) {}

  parseFile(relPath: string): ProtoFile {
    const file: ProtoFile = {
      path: this.filePath,
      relPath,
      package: "",
      imports: [],
      services: [],
      messages: [],
      enums: [],
    };
    while (!this.done()) {
      if (this.matchSym(";")) {
        this.eat();
        continue;
      }
      const kw = this.expectKind("id").value;
      if (kw === "syntax" || kw === "option" || kw === "extend") {
        this.readStatement();
      } else if (kw === "package") {
        file.package = this.readDottedName();
        this.expectSym(";");
      } else if (kw === "import") {
        if (this.peekId() === "public" || this.peekId() === "weak") this.eat();
        const spec = this.expectKind("str").value;
        this.expectSym(";");
        file.imports.push(spec);
      } else if (kw === "message") {
        file.messages.push(this.parseMessage(this.previous().lead, ""));
      } else if (kw === "enum") {
        file.enums.push(this.parseEnum(this.previous().lead, ""));
      } else if (kw === "service") {
        file.services.push(this.parseService(this.previous().lead));
      } else {
        this.readStatement();
      }
    }
    if (!file.package) {
      file.package = relPath.replace(/\\/g, "/").split("/").pop()?.replace(/\.proto$/, "") || "default";
    }
    return file;
  }

  private parseService(comment: string): ServiceDef {
    const nameTok = this.expectKind("id");
    const start = nameTok.line;
    this.expectSym("{");
    const rpcs: RpcDef[] = [];
    while (!this.matchSym("}") && !this.done()) {
      if (this.matchSym(";")) {
        this.eat();
        continue;
      }
      const kw = this.expectKind("id");
      if (kw.value === "rpc") {
        rpcs.push(this.parseRpc(kw));
      } else {
        this.readStatement();
      }
    }
    const end = this.expectSym("}").line;
    if (this.matchSym(";")) this.eat();
    return { name: nameTok.value, comment: cleanDoc(comment), rpcs, loc: { line: start, endLine: end } };
  }

  private parseRpc(kw: Token): RpcDef {
    const comment = kw.lead;
    const nameTok = this.expectKind("id");
    this.expectSym("(");
    let requestStream = false;
    if (this.peekId() === "stream") {
      requestStream = true;
      this.eat();
    }
    const request = this.readDottedName();
    this.expectSym(")");
    const returns = this.expectKind("id");
    if (returns.value !== "returns") {
      throw new ProtoParseError(`期望 returns，实际是 ${returns.value}`, returns.line);
    }
    this.expectSym("(");
    let responseStream = false;
    if (this.peekId() === "stream") {
      responseStream = true;
      this.eat();
    }
    const response = this.readDottedName();
    this.expectSym(")");
    let httpVerb: string | undefined;
    let httpPath: string | undefined;
    let httpBody: string | undefined;
    let timeout: string | undefined;
    let auth: string | undefined;
    let closed: boolean | undefined;
    const badges: MetaBadge[] = [];
    let endLine = nameTok.line;
    if (this.matchSym("{")) {
      this.eat();
      while (!this.matchSym("}") && !this.done()) {
        if (this.matchSym(";")) {
          this.eat();
          continue;
        }
        const kw = this.peek();
        if (kw?.kind === "id" && kw.value === "option") {
          this.eat();
          const stmt = this.readStatement();
          const text = stmt.map((tok) => (tok.kind === "str" ? `"${tok.value}"` : tok.value)).join(" ");
          const meta = parseMetaOption(stmt);
          if (meta) badges.push(...badgesFromMeta(meta));
          const http = text.match(/\b(get|post|put|delete|patch)\s*:\s*"([^"]+)"/i);
          if (http) {
            httpVerb = http[1].toUpperCase();
            httpPath = http[2];
          }
          const body = text.match(/\bbody\s*:\s*"([^"]+)"/);
          if (body) httpBody = body[1];
          const timeoutHit = text.match(/\bTimeout\s*:\s*(\d+)/);
          if (timeoutHit) timeout = timeoutHit[1];
          const authHit = text.match(/\bAuthOption\s*:\s*([A-Za-z0-9_]+)/);
          if (authHit) auth = authHit[1];
          if (/\bClosed\s*:\s*true\b/.test(text)) closed = true;
        } else {
          this.readStatement();
        }
      }
      endLine = this.expectSym("}").line;
    }
    if (this.matchSym(";")) this.eat();
    const end = this.previous();
    const sourceStart = kw.leadFrom >= 0 ? kw.leadFrom : kw.from;
    return {
      name: nameTok.value,
      comment: cleanDoc(comment),
      request,
      response,
      requestStream,
      responseStream,
      httpVerb,
      httpPath,
      httpBody,
      timeout,
      auth,
      closed,
      badges,
      source: this.text.slice(sourceStart, end.to).trim(),
      loc: { line: nameTok.line, endLine },
    };
  }

  private parseMessage(comment: string, parent: string): MessageDef {
    const nameTok = this.expectKind("id");
    const fullName = parent ? `${parent}.${nameTok.value}` : nameTok.value;
    this.expectSym("{");
    const fields: FieldDef[] = [];
    const oneofs: OneofDef[] = [];
    const members: MessageMember[] = [];
    const nestedMessages: MessageDef[] = [];
    const nestedEnums: EnumDef[] = [];
    while (!this.matchSym("}") && !this.done()) {
      if (this.matchSym(";")) {
        this.eat();
        continue;
      }
      const lead = this.peek()?.lead ?? "";
      const kw = this.peekId();
      if (kw === "message") {
        this.eat();
        nestedMessages.push(this.parseMessage(lead, fullName));
      } else if (kw === "enum") {
        this.eat();
        nestedEnums.push(this.parseEnum(lead, fullName));
      } else if (kw === "oneof") {
        this.eat();
        const oneof = this.parseOneof(lead);
        oneofs.push(oneof);
        members.push({ kind: "oneof", oneof });
      } else if (kw === "option" || kw === "reserved" || kw === "extensions" || kw === "extend") {
        this.eat();
        this.readStatement();
      } else {
        const field = this.parseField();
        fields.push(field);
        members.push({ kind: "field", field });
      }
    }
    const end = this.expectSym("}").line;
    if (this.matchSym(";")) this.eat();
    return {
      name: nameTok.value,
      fullName,
      comment: cleanDoc(comment),
      fields,
      oneofs,
      members,
      nestedMessages,
      nestedEnums,
      loc: { line: nameTok.line, endLine: end },
    };
  }

  private parseOneof(comment: string): OneofDef {
    const nameTok = this.expectKind("id");
    this.expectSym("{");
    const fields: FieldDef[] = [];
    while (!this.matchSym("}") && !this.done()) {
      if (this.matchSym(";")) {
        this.eat();
        continue;
      }
      const kw = this.peekId();
      if (kw === "option") {
        this.eat();
        this.readStatement();
      } else {
        fields.push(this.parseField());
      }
    }
    const end = this.expectSym("}").line;
    return { name: nameTok.value, comment: cleanDoc(comment), fields, loc: { line: nameTok.line, endLine: end } };
  }

  private parseEnum(comment: string, parent: string): EnumDef {
    const nameTok = this.expectKind("id");
    const fullName = parent ? `${parent}.${nameTok.value}` : nameTok.value;
    this.expectSym("{");
    const values: EnumValueDef[] = [];
    while (!this.matchSym("}") && !this.done()) {
      if (this.matchSym(";")) {
        this.eat();
        continue;
      }
      const kw = this.peekId();
      if (kw === "option" || kw === "reserved") {
        this.eat();
        this.readStatement();
      } else {
        values.push(this.parseEnumValue());
      }
    }
    const end = this.expectSym("}").line;
    if (this.matchSym(";")) this.eat();
    return {
      name: nameTok.value,
      fullName,
      comment: cleanDoc(comment),
      values,
      loc: { line: nameTok.line, endLine: end },
    };
  }

  private parseEnumValue(): EnumValueDef {
    const nameTok = this.expectKind("id");
    this.expectSym("=");
    const num = this.expectKind("num");
    if (this.matchSym("[")) this.skipGroup("[", "]");
    const semi = this.expectSym(";");
    return {
      name: nameTok.value,
      number: Number(num.value),
      comment: joinDoc(nameTok.lead, semi.trail),
      loc: { line: nameTok.line, endLine: semi.line },
    };
  }

  private parseField(): FieldDef {
    const start = this.peek();
    let repeated = false;
    let optional = false;
    const kw = this.peekId();
    if (kw === "repeated" || kw === "optional" || kw === "required") {
      this.eat();
      repeated = kw === "repeated";
      optional = kw === "optional";
    }
    let typeName = "";
    let mapKey: string | undefined;
    let mapValue: string | undefined;
    if (this.peekId() === "map") {
      this.eat();
      this.expectSym("<");
      mapKey = this.readDottedName();
      this.expectSym(",");
      mapValue = this.readDottedName();
      this.expectSym(">");
      typeName = `map<${mapKey}, ${mapValue}>`;
    } else {
      typeName = this.readDottedName();
    }
    const nameTok = this.expectKind("id");
    this.expectSym("=");
    const num = this.expectKind("num");
    if (this.matchSym("[")) this.skipGroup("[", "]");
    const semi = this.expectSym(";");
    return {
      name: nameTok.value,
      typeName,
      mapKey,
      mapValue,
      repeated,
      optional,
      number: Number(num.value),
      comment: joinDoc(start?.lead ?? "", semi.trail || nameTok.trail),
      loc: { line: nameTok.line, endLine: semi.line },
    };
  }

  private readDottedName(): string {
    let name = "";
    if (this.matchSym(".")) {
      this.eat();
      name = ".";
    }
    name += this.expectKind("id").value;
    while (this.matchSym(".") && this.tokens[this.i + 1]?.kind === "id") {
      this.eat();
      name += `.${this.eat().value}`;
    }
    return name;
  }

  private readStatement(): Token[] {
    const out: Token[] = [];
    let depth = 0;
    while (!this.done()) {
      const tok = this.peek()!;
      if (tok.kind === "sym" && (tok.value === "{" || tok.value === "(" || tok.value === "[" || tok.value === "<")) {
        depth++;
        out.push(this.eat());
        continue;
      }
      if (tok.kind === "sym" && (tok.value === "}" || tok.value === ")" || tok.value === "]" || tok.value === ">")) {
        if (depth === 0) return out;
        depth--;
        out.push(this.eat());
        continue;
      }
      if (tok.kind === "sym" && tok.value === ";" && depth === 0) {
        out.push(this.eat());
        return out;
      }
      out.push(this.eat());
    }
    return out;
  }

  private skipGroup(open: string, close: string): void {
    this.expectSym(open);
    let depth = 1;
    while (depth > 0 && !this.done()) {
      const tok = this.eat();
      if (tok.kind === "sym" && tok.value === open) depth++;
      else if (tok.kind === "sym" && tok.value === close) depth--;
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private peekId(): string | undefined {
    const tok = this.peek();
    return tok?.kind === "id" ? tok.value : undefined;
  }

  private matchSym(value: string): boolean {
    const tok = this.peek();
    return tok?.kind === "sym" && tok.value === value;
  }

  private eat(): Token {
    const tok = this.tokens[this.i];
    if (!tok) throw new ProtoParseError(`文件提前结束：${this.filePath}`, this.previousLine());
    this.i++;
    return tok;
  }

  private expectKind(kind: Token["kind"]): Token {
    const tok = this.peek();
    if (!tok || tok.kind !== kind) {
      throw new ProtoParseError(`期望 ${kind}，实际是 ${tok ? tok.value : "文件结束"}`, tok?.line ?? this.previousLine());
    }
    return this.eat();
  }

  private expectSym(value: string): Token {
    const tok = this.peek();
    if (!tok || tok.kind !== "sym" || tok.value !== value) {
      throw new ProtoParseError(`期望「${value}」，实际是 ${tok ? tok.value : "文件结束"}`, tok?.line ?? this.previousLine());
    }
    return this.eat();
  }

  private previous(): Token {
    return this.tokens[this.i - 1];
  }

  private previousLine(): number {
    return this.tokens[this.i - 1]?.line ?? 1;
  }

  private done(): boolean {
    return this.i >= this.tokens.length;
  }
}

function cleanDoc(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\*+$/.test(line) && !/^\*{2,}.+\*{2,}$/.test(line))
    .join("\n")
    .trim();
}

function joinDoc(lead: string, trail: string): string {
  const a = cleanDoc(lead);
  const b = cleanDoc(trail);
  if (a && b) return `${a} ${b}`.trim();
  return a || b;
}

export function flattenMessages(messages: MessageDef[]): MessageDef[] {
  const out: MessageDef[] = [];
  const walk = (list: MessageDef[]) => {
    for (const message of list) {
      out.push(message);
      walk(message.nestedMessages);
    }
  };
  walk(messages);
  return out;
}

export function flattenEnums(messages: MessageDef[], enums: EnumDef[]): EnumDef[] {
  const out = [...enums];
  const walk = (list: MessageDef[]) => {
    for (const message of list) {
      out.push(...message.nestedEnums);
      walk(message.nestedMessages);
    }
  };
  walk(messages);
  return out;
}
