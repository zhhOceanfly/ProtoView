import {
  EnumDef,
  FieldDef,
  MessageDef,
  ProtoFile,
  ServiceDef,
  flattenEnums,
  flattenMessages,
  isScalar,
} from "./parser";

export interface Usage {
  navId: string;
  label: string;
  detail: string;
}

export interface LinkedType {
  text: string;
  navId?: string;
}

export interface FieldView {
  name: string;
  number: number;
  comment: string;
  line: number;
  file: string;
  prefix: string;
  key?: LinkedType;
  value: LinkedType;
  oneof?: string;
}

export interface MessageView {
  id: string;
  package: string;
  name: string;
  fullName: string;
  comment: string;
  file: string;
  relPath: string;
  line: number;
  endLine: number;
  fields: FieldView[];
  nested: { id: string; kind: "message" | "enum"; name: string; comment: string }[];
  usages: Usage[];
}

export interface EnumView {
  id: string;
  package: string;
  name: string;
  fullName: string;
  comment: string;
  file: string;
  relPath: string;
  line: number;
  endLine: number;
  values: { name: string; number: number; comment: string; line: number }[];
  usages: Usage[];
}

export interface RpcView {
  id: string;
  package: string;
  serviceId: string;
  service: string;
  name: string;
  comment: string;
  file: string;
  relPath: string;
  line: number;
  endLine: number;
  request: LinkedType;
  response: LinkedType;
  requestStream: boolean;
  responseStream: boolean;
  httpVerb?: string;
  httpPath?: string;
  httpBody?: string;
  timeout?: string;
  auth?: string;
  closed?: boolean;
  badges: { text: string; warn?: boolean }[];
  source: string;
  requestMessageId?: string;
  responseMessageId?: string;
}

export interface ServiceView {
  id: string;
  package: string;
  name: string;
  comment: string;
  file: string;
  relPath: string;
  line: number;
  endLine: number;
  rpcs: RpcView[];
}

export interface PackageView {
  name: string;
  id: string;
  files: { relPath: string; path: string }[];
  services: ServiceView[];
  messages: MessageView[];
  enums: EnumView[];
  wellKnown: boolean;
}

export interface Catalog {
  packages: PackageView[];
  byId: Map<string, PackageView | ServiceView | RpcView | MessageView | EnumView>;
  errors: { file: string; message: string }[];
}

interface TypeHit {
  kind: "message" | "enum";
  id: string;
  package: string;
  fullName: string;
  file: string;
}

const SERVICE_RANK: Record<string, number> = {
  ApiService: 0,
  PublicService: 1,
  InternalService: 2,
};

export function isWellKnownPackage(name: string): boolean {
  return name === "google" || name.startsWith("google.");
}

export function buildCatalog(files: ProtoFile[], errors: { file: string; message: string }[] = []): Catalog {
  const byFile = new Map(files.map((file) => [normalize(file.path), file]));
  const messagesByPkg = new Map<string, { message: MessageDef; file: ProtoFile }[]>();
  const enumsByPkg = new Map<string, { item: EnumDef; file: ProtoFile }[]>();

  for (const file of files) {
    for (const message of flattenMessages(file.messages)) {
      push(messagesByPkg, file.package, { message, file });
    }
    for (const item of flattenEnums(file.messages, file.enums)) {
      push(enumsByPkg, file.package, { item, file });
    }
  }

  const hits = new Map<string, TypeHit[]>();
  const addHit = (hit: TypeHit) => {
    const key = `${hit.package}|${hit.fullName}`;
    const list = hits.get(key) ?? [];
    list.push(hit);
    hits.set(key, list);
  };

  const draftMessages: MessageView[] = [];
  const draftEnums: EnumView[] = [];

  for (const [pkg, list] of messagesByPkg) {
    const names = countNames(list.map((item) => item.message.fullName));
    for (const { message, file } of list) {
      const id = symbolId("msg", pkg, message.fullName, file.relPath, names.get(message.fullName)! > 1);
      addHit({ kind: "message", id, package: pkg, fullName: message.fullName, file: file.path });
      draftMessages.push({
        id,
        package: pkg,
        name: message.name,
        fullName: message.fullName,
        comment: message.comment,
        file: file.path,
        relPath: file.relPath,
        line: message.loc.line,
        endLine: message.loc.endLine,
        fields: [],
        nested: [
          ...message.nestedMessages.map((nested) => ({
            id: "",
            kind: "message" as const,
            name: nested.fullName,
            comment: nested.comment,
          })),
          ...message.nestedEnums.map((nested) => ({
            id: "",
            kind: "enum" as const,
            name: nested.fullName,
            comment: nested.comment,
          })),
        ],
        usages: [],
      });
    }
  }

  for (const [pkg, list] of enumsByPkg) {
    const names = countNames(list.map((item) => item.item.fullName));
    for (const { item, file } of list) {
      const id = symbolId("enum", pkg, item.fullName, file.relPath, names.get(item.fullName)! > 1);
      addHit({ kind: "enum", id, package: pkg, fullName: item.fullName, file: file.path });
      draftEnums.push({
        id,
        package: pkg,
        name: item.name,
        fullName: item.fullName,
        comment: item.comment,
        file: file.path,
        relPath: file.relPath,
        line: item.loc.line,
        endLine: item.loc.endLine,
        values: item.values.map((value) => ({
          name: value.name,
          number: value.number,
          comment: value.comment,
          line: value.loc.line,
        })),
        usages: [],
      });
    }
  }

  const messageById = new Map(draftMessages.map((item) => [item.id, item]));
  const enumById = new Map(draftEnums.map((item) => [item.id, item]));

  const resolve = (from: ProtoFile, typeName: string, scope = ""): TypeHit | undefined => {
    const raw = typeName.replace(/^\./, "");
    if (!raw || isScalar(raw) || raw.startsWith("map<")) return undefined;
    const parts = raw.split(".");
    const pick = (list: TypeHit[] | undefined): TypeHit | undefined => {
      if (!list?.length) return undefined;
      return (
        list.find((hit) => normalize(hit.file) === normalize(from.path)) ??
        list.find((hit) => imported(from, hit.file, files, byFile)) ??
        list[0]
      );
    };
    if (scope && !typeName.startsWith(".")) {
      const chain = scope.split(".");
      for (let i = chain.length; i >= 1; i--) {
        const nestedName = `${chain.slice(0, i).join(".")}.${raw}`;
        const nested = pick(hits.get(`${from.package}|${nestedName}`));
        if (nested) return nested;
      }
    }
    const direct = pick(hits.get(`${from.package}|${raw}`));
    if (direct) return direct;
    if (parts.length >= 2) {
      for (let i = 1; i < parts.length; i++) {
        const pkg = parts.slice(0, i).join(".");
        const rest = parts.slice(i).join(".");
        const found = pick(hits.get(`${pkg}|${rest}`));
        if (found) return found;
      }
    }
    for (const spec of from.imports) {
      const importedFile = resolveImport(from, spec, files, byFile);
      if (!importedFile) continue;
      const found = pick(hits.get(`${importedFile.package}|${raw}`))
        ?? (parts.length >= 2 ? pick(hits.get(`${importedFile.package}|${parts[parts.length - 1]}`)) : undefined);
      if (found && found.package === importedFile.package) return found;
    }
    const short = parts[parts.length - 1];
    const global = [...hits.values()].flat().filter((hit) => hit.fullName === short || hit.fullName.endsWith(`.${short}`));
    const unique = new Map(global.map((hit) => [hit.id, hit]));
    if (unique.size === 1) return [...unique.values()][0];
    return undefined;
  };

  const linkType = (from: ProtoFile, typeName: string, scope = ""): LinkedType => {
    const hit = resolve(from, typeName, scope);
    return { text: typeName.replace(/^\./, ""), navId: hit?.id };
  };

  const toField = (from: ProtoFile, field: FieldDef, scope: string, oneof?: string): FieldView => ({
    name: field.name,
    number: field.number,
    comment: field.comment,
    line: field.loc.line,
    file: from.path,
    prefix: field.repeated ? "repeated" : field.optional ? "optional" : "",
    key: field.mapKey ? linkType(from, field.mapKey, scope) : undefined,
    value: linkType(from, field.mapValue ?? field.typeName, scope),
    oneof,
  });

  const fileOfMessage = new Map<string, ProtoFile>();
  for (const [pkg, list] of messagesByPkg) {
    const names = countNames(list.map((item) => item.message.fullName));
    for (const { message, file } of list) {
      const id = symbolId("msg", pkg, message.fullName, file.relPath, names.get(message.fullName)! > 1);
      fileOfMessage.set(id, file);
      const view = messageById.get(id);
      if (!view) continue;
      view.fields = message.members.flatMap((member) => (
        member.kind === "field"
          ? [toField(file, member.field, message.fullName)]
          : member.oneof.fields.map((field) => toField(file, field, message.fullName, member.oneof.name))
      ));
      view.nested = view.nested.map((nested) => {
        const hit = resolve(file, nested.name) ?? resolve(file, `${pkg}.${nested.name}`);
        return { ...nested, id: hit?.id ?? "" };
      });
    }
  }

  const packages = new Map<string, PackageView>();
  const ensurePkg = (name: string): PackageView => {
    let pkg = packages.get(name);
    if (!pkg) {
      pkg = {
        name,
        id: `pkg:${name}`,
        files: [],
        services: [],
        messages: [],
        enums: [],
        wellKnown: isWellKnownPackage(name),
      };
      packages.set(name, pkg);
    }
    return pkg;
  };

  for (const file of files) {
    const pkg = ensurePkg(file.package);
    pkg.files.push({ relPath: file.relPath, path: file.path });
  }
  for (const message of draftMessages) ensurePkg(message.package).messages.push(message);
  for (const item of draftEnums) ensurePkg(item.package).enums.push(item);

  const services: ServiceView[] = [];
  const rpcs: RpcView[] = [];
  for (const file of files) {
    const serviceNames = countNames(file.services.map((service) => service.name));
    for (const service of file.services) {
      const serviceId = symbolId(
        "svc",
        file.package,
        service.name,
        file.relPath,
        (serviceNames.get(service.name) ?? 1) > 1 || sameServiceElsewhere(files, file, service),
      );
      const view: ServiceView = {
        id: serviceId,
        package: file.package,
        name: service.name,
        comment: service.comment,
        file: file.path,
        relPath: file.relPath,
        line: service.loc.line,
        endLine: service.loc.endLine,
        rpcs: [],
      };
      for (const rpc of service.rpcs) {
        const request = linkType(file, rpc.request);
        const response = linkType(file, rpc.response);
        const rpcView: RpcView = {
          id: `${serviceId}:${rpc.name}:${rpc.loc.line}`,
          package: file.package,
          serviceId,
          service: service.name,
          name: rpc.name,
          comment: rpc.comment,
          file: file.path,
          relPath: file.relPath,
          line: rpc.loc.line,
          endLine: rpc.loc.endLine,
          request,
          response,
          requestStream: rpc.requestStream,
          responseStream: rpc.responseStream,
          httpVerb: rpc.httpVerb,
          httpPath: rpc.httpPath,
          httpBody: rpc.httpBody,
          timeout: rpc.timeout,
          auth: rpc.auth,
          closed: rpc.closed,
          badges: rpc.badges,
          source: rpc.source,
          requestMessageId: request.navId,
          responseMessageId: response.navId,
        };
        view.rpcs.push(rpcView);
        rpcs.push(rpcView);
        addUsage(messageById, request.navId, {
          navId: rpcView.id,
          label: `${service.name}.${rpc.name}`,
          detail: "请求",
        });
        addUsage(messageById, response.navId, {
          navId: rpcView.id,
          label: `${service.name}.${rpc.name}`,
          detail: "响应",
        });
      }
      services.push(view);
      ensurePkg(file.package).services.push(view);
    }
  }

  for (const message of draftMessages) {
    const file = fileOfMessage.get(message.id);
    if (!file) continue;
    for (const field of message.fields) {
      for (const type of [field.key, field.value]) {
        if (!type?.navId) continue;
        const usage = {
          navId: message.id,
          label: `${message.fullName}.${field.name}`,
          detail: "字段",
        };
        addUsage(messageById, type.navId, usage);
        addUsage(enumById, type.navId, usage);
      }
    }
  }

  for (const pkg of packages.values()) {
    pkg.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    pkg.services.sort(compareService);
    pkg.messages.sort((a, b) => a.fullName.localeCompare(b.fullName));
    pkg.enums.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  const byId = new Map<string, PackageView | ServiceView | RpcView | MessageView | EnumView>();
  const packageList = [...packages.values()].sort(comparePackage);
  for (const pkg of packageList) {
    byId.set(pkg.id, pkg);
    for (const service of pkg.services) {
      byId.set(service.id, service);
      for (const rpc of service.rpcs) byId.set(rpc.id, rpc);
    }
    for (const message of pkg.messages) byId.set(message.id, message);
    for (const item of pkg.enums) byId.set(item.id, item);
  }

  return { packages: packageList, byId, errors };
}

export function findSymbolAt(catalog: Catalog, filePath: string, line: number): string | undefined {
  const target = normalize(filePath);
  let best: { id: string; span: number } | undefined;
  const consider = (id: string, file: string, start: number, end: number) => {
    if (normalize(file) !== target || line < start || line > end) return;
    const span = Math.max(0, end - start);
    if (!best || span < best.span) best = { id, span };
  };
  for (const item of catalog.byId.values()) {
    if ("messages" in item && "services" in item) continue;
    if ("fields" in item) {
      consider(item.id, item.file, item.line, item.endLine);
    } else if ("values" in item) {
      consider(item.id, item.file, item.line, item.endLine);
    } else if ("rpcs" in item) {
      consider(item.id, item.file, item.line, item.endLine);
      for (const rpc of item.rpcs) consider(rpc.id, rpc.file, rpc.line, rpc.endLine);
    }
  }
  return best?.id;
}

function addUsage(map: Map<string, { usages: Usage[] }>, id: string | undefined, usage: Usage): void {
  if (!id) return;
  const target = map.get(id);
  if (!target) return;
  if (target.usages.some((item) => item.navId === usage.navId && item.detail === usage.detail && item.label === usage.label)) {
    return;
  }
  target.usages.push(usage);
}

function symbolId(kind: string, pkg: string, name: string, relPath: string, collision: boolean): string {
  const base = `${kind}:${pkg}:${name}`;
  return collision ? `${base}:${relPath.replace(/\\/g, "/")}` : base;
}

function countNames(names: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const name of names) map.set(name, (map.get(name) ?? 0) + 1);
  return map;
}

function sameServiceElsewhere(files: ProtoFile[], file: ProtoFile, service: ServiceDef): boolean {
  return files.some((other) => other !== file && other.package === file.package && other.services.some((item) => item.name === service.name));
}

function resolveImport(from: ProtoFile, spec: string, files: ProtoFile[], byFile: Map<string, ProtoFile>): ProtoFile | undefined {
  const norm = spec.replace(/\\/g, "/");
  const fromDir = from.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  const joined = normalizePath(`${fromDir}/${norm}`);
  const direct = byFile.get(normalize(joined));
  if (direct) return direct;
  const matches = files.filter((file) => {
    const rel = file.path.replace(/\\/g, "/");
    return rel.endsWith(`/${norm}`) || rel.endsWith(norm);
  });
  if (matches.length === 1) return matches[0];
  return matches.find((file) => file.path.replace(/\\/g, "/").endsWith(`/${norm}`));
}

function imported(from: ProtoFile, targetPath: string, files: ProtoFile[], byFile: Map<string, ProtoFile>): boolean {
  return from.imports.some((spec) => {
    const file = resolveImport(from, spec, files, byFile);
    return file ? normalize(file.path) === normalize(targetPath) : false;
  });
}

function compareService(a: ServiceView, b: ServiceView): number {
  const rank = (SERVICE_RANK[a.name] ?? 9) - (SERVICE_RANK[b.name] ?? 9);
  if (rank !== 0) return rank;
  return a.name.localeCompare(b.name) || a.relPath.localeCompare(b.relPath);
}

function comparePackage(a: PackageView, b: PackageView): number {
  if (a.wellKnown !== b.wellKnown) return a.wellKnown ? 1 : -1;
  return a.name.localeCompare(b.name);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function normalizePath(filePath: string): string {
  const parts: string[] = [];
  for (const part of filePath.replace(/\\/g, "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
