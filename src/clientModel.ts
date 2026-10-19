import { Catalog, EnumView, FieldView, MessageView } from "./catalog";

export interface ClientField {
  name: string;
  type: string;
  typeId?: string;
  key?: string;
  keyId?: string;
  repeated: boolean;
  optional: boolean;
  comment: string;
  number: number;
  oneof?: string;
}

export interface ClientRpc {
  id: string;
  name: string;
  comment: string;
  request: string;
  response: string;
  requestId?: string;
  responseId?: string;
  requestFields: ClientField[];
  responseFields: ClientField[];
  file: string;
  path: string;
  line: number;
}

export interface ClientService {
  id: string;
  name: string;
  comment: string;
  file: string;
  path: string;
  rpcs: ClientRpc[];
}

export interface ClientPackage {
  name: string;
  services: ClientService[];
}

export interface ClientType {
  id: string;
  kind: "message" | "enum";
  package: string;
  name: string;
  fullName: string;
  comment: string;
  file: string;
  path: string;
  line: number;
  fields?: ClientField[];
  values?: { name: string; number: number; comment: string }[];
  nested?: { id: string; kind: "message" | "enum"; name: string; comment: string }[];
}

export interface ClientCatalog {
  sourceLabel: string;
  packages: ClientPackage[];
  types: Record<string, ClientType>;
}

export interface ClientEnv {
  id: string;
  name: string;
  host: string;
  note: string;
}

export interface ClientEnvFile {
  activeEnvId: string;
  envs: ClientEnv[];
}

export function toClientCatalog(catalog: Catalog, sourceLabel: string, showGoogle: boolean): ClientCatalog {
  const packages = catalog.packages
    .filter((pkg) => showGoogle || !pkg.wellKnown)
    .map((pkg) => ({
      name: pkg.name,
      services: pkg.services.map((service) => ({
        id: service.id,
        name: service.name,
        comment: service.comment,
        file: service.relPath,
        path: service.file,
        rpcs: service.rpcs.map((rpc) => ({
          id: rpc.id,
          name: rpc.name,
          comment: rpc.comment,
          request: rpc.request.text,
          response: rpc.response.text,
          requestId: rpc.request.navId,
          responseId: rpc.response.navId,
          requestFields: fieldsOf(catalog, rpc.request.navId),
          responseFields: fieldsOf(catalog, rpc.response.navId),
          file: rpc.relPath,
          path: rpc.file,
          line: rpc.line,
        })),
      })),
    }))
    .filter((pkg) => pkg.services.some((service) => service.rpcs.length));

  return { sourceLabel, packages, types: collectTypes(catalog, showGoogle) };
}

export function defaultEnvFile(): ClientEnvFile {
  return {
    activeEnvId: "local",
    envs: [
      { id: "local", name: "local", host: "127.0.0.1:19200", note: "本地" },
      { id: "test", name: "test", host: "", note: "测试" },
    ],
  };
}

function fieldsOf(catalog: Catalog, navId?: string): ClientField[] {
  if (!navId) return [];
  const item = catalog.byId.get(navId);
  if (!item || !("fields" in item)) return [];
  return clientFields((item as MessageView).fields);
}

function clientFields(fields: FieldView[]): ClientField[] {
  return fields.map((field) => ({
    name: field.name,
    type: field.value.text,
    typeId: field.value.navId,
    key: field.key?.text,
    keyId: field.key?.navId,
    repeated: field.prefix === "repeated",
    optional: field.prefix === "optional",
    comment: field.comment,
    number: field.number,
    oneof: field.oneof,
  }));
}

function collectTypes(catalog: Catalog, showGoogle: boolean): Record<string, ClientType> {
  const types: Record<string, ClientType> = {};
  for (const pkg of catalog.packages) {
    if (!showGoogle && pkg.wellKnown) continue;
    for (const message of pkg.messages) types[message.id] = messageType(message);
    for (const item of pkg.enums) types[item.id] = enumType(item);
  }
  return types;
}

function messageType(message: MessageView): ClientType {
  return {
    id: message.id,
    kind: "message",
    package: message.package,
    name: message.name,
    fullName: message.fullName,
    comment: message.comment,
    file: message.relPath,
    path: message.file,
    line: message.line,
    fields: clientFields(message.fields),
    nested: message.nested.filter((item) => item.id),
  };
}

function enumType(item: EnumView): ClientType {
  return {
    id: item.id,
    kind: "enum",
    package: item.package,
    name: item.name,
    fullName: item.fullName,
    comment: item.comment,
    file: item.relPath,
    path: item.file,
    line: item.line,
    values: item.values.map((value) => ({ name: value.name, number: value.number, comment: value.comment })),
  };
}
