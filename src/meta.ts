export interface MetaBadge {
  text: string;
  warn?: boolean;
}

export type MetaValue = string | MetaValue[] | { [key: string]: MetaValue };

interface RawTok {
  kind: string;
  value: string;
}

export function parseMetaOption(tokens: RawTok[]): { [key: string]: MetaValue } | undefined {
  const eq = tokens.findIndex((tok) => tok.kind === "sym" && tok.value === "=");
  if (eq < 0) return undefined;
  const head = tokens.slice(0, eq).map((tok) => tok.value).join("");
  if (!head.includes("Meta")) return undefined;
  const parsed = parseValue(tokens, eq + 1);
  if (!parsed || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return undefined;
  return parsed.value;
}

export function badgesFromMeta(meta: { [key: string]: MetaValue }): MetaBadge[] {
  const badges: MetaBadge[] = [];
  const auth = asObj(meta.AuthConfig);
  if (typeof meta.Timeout === "string") badges.push({ text: `timeout ${meta.Timeout}s` });
  if (typeof meta.Log === "string") badges.push({ text: `Log ${meta.Log}` });
  if (typeof meta.Mem === "string") badges.push({ text: `Mem ${meta.Mem}` });
  if (typeof auth?.AuthOption === "string") badges.push({ text: auth.AuthOption });
  if (auth?.JwtSources) badges.push({ text: `JwtSources ${fmtList(auth.JwtSources)}` });
  if (auth?.Tags) badges.push({ text: `Tags ${fmtList(auth.Tags)}` });
  if (auth?.TokenType) badges.push({ text: `TokenType ${fmtList(auth.TokenType)}` });
  const jti = asObj(auth?.JtiCheck);
  if (jti && typeof jti.ClientTtl === "string") badges.push({ text: `JtiCheck ${jti.ClientTtl}s` });
  if (meta.NotSigna === "true") badges.push({ text: "NotSigna", warn: true });
  if (meta.NotTracing === "true") badges.push({ text: "NotTracing" });
  if (meta.ManagerRoles) badges.push({ text: `ManagerRoles ${fmtList(meta.ManagerRoles)}` });
  if (meta.ClientRoles) badges.push({ text: `ClientRoles ${fmtList(meta.ClientRoles)}` });
  const session = asObj(meta.SessionConfig);
  const sessionMode = session ? Object.keys(session)[0] : undefined;
  if (sessionMode) badges.push({ text: `Session ${sessionMode}` });
  if (meta.PodConsistCheck === "true") badges.push({ text: "PodConsistCheck" });
  if (meta.ConsistCheck === "true") badges.push({ text: "ConsistCheck" });
  if (meta.Closed === "true") badges.push({ text: "closed", warn: true });
  const replay = asObj(meta.Replay);
  if (replay && typeof replay.CacheTime === "string") badges.push({ text: `Replay ${replay.CacheTime}s` });
  const limit = asObj(meta.LimitConfig);
  if (limit) {
    for (const [name, value] of Object.entries(limit)) {
      const item = asObj(value);
      if (!item) continue;
      if (typeof item.TimeWindow === "string") {
        badges.push({ text: `${name} ${item.TimeWindow}s/${item.CallCount ?? "?"} ban ${item.BanTime ?? "?"}s` });
      } else if (typeof item.CallCount === "string") {
        badges.push({ text: `${name} ${item.CallCount}/day` });
      }
    }
  }
  const cache = asObj(meta.CacheConfig);
  if (cache) badges.push({ text: `Cache client ${cache.ClientTtl ?? "0"}s server ${cache.ServerTtl ?? "0"}s` });
  if (typeof meta.RequestBodyMode === "string") badges.push({ text: `ReqBody ${meta.RequestBodyMode}` });
  if (typeof meta.ResponseBodyMode === "string") badges.push({ text: `RespBody ${meta.ResponseBodyMode}` });
  const idem = asObj(meta.Idempotent);
  if (idem) {
    const on = idem.Verify === "true" ? "on" : "off";
    badges.push({ text: `Idempotent ${on}${typeof idem.CacheTime === "string" ? ` ${idem.CacheTime}s` : ""}` });
  }
  const circuit = asObj(meta.CircuitConfig);
  if (circuit) badges.push({ text: `Circuit ${circuit.TimeWindow ?? "?"}s/${circuit.FailureThreshold ?? "?"}` });
  if (Array.isArray(meta.Extras) && meta.Extras.length) badges.push({ text: `Extras ${fmtList(meta.Extras)}` });
  return badges;
}

function parseValue(tokens: RawTok[], index: number): { value: MetaValue; index: number } | undefined {
  const tok = tokens[index];
  if (!tok) return undefined;
  if (tok.kind === "sym" && tok.value === "{") {
    const obj: { [key: string]: MetaValue } = {};
    index++;
    while (index < tokens.length && !(tokens[index].kind === "sym" && tokens[index].value === "}")) {
      if (tokens[index].kind === "sym" && (tokens[index].value === "," || tokens[index].value === ";")) {
        index++;
        continue;
      }
      if (tokens[index].kind !== "id") return undefined;
      const key = tokens[index].value;
      index++;
      if (tokens[index]?.kind === "sym" && tokens[index].value === ":") index++;
      const child = parseValue(tokens, index);
      if (!child) return undefined;
      obj[key] = child.value;
      index = child.index;
    }
    if (tokens[index]?.kind === "sym" && tokens[index].value === "}") index++;
    return { value: obj, index };
  }
  if (tok.kind === "sym" && tok.value === "[") {
    const list: MetaValue[] = [];
    index++;
    while (index < tokens.length && !(tokens[index].kind === "sym" && tokens[index].value === "]")) {
      if (tokens[index].kind === "sym" && (tokens[index].value === "," || tokens[index].value === ";")) {
        index++;
        continue;
      }
      const child = parseValue(tokens, index);
      if (!child) return undefined;
      list.push(child.value);
      index = child.index;
    }
    if (tokens[index]?.kind === "sym" && tokens[index].value === "]") index++;
    return { value: list, index };
  }
  if (tok.kind === "id" || tok.kind === "num" || tok.kind === "str") {
    let value = tok.value;
    index++;
    while (tokens[index]?.kind === "sym" && tokens[index].value === "." && tokens[index + 1]?.kind === "id") {
      value += `.${tokens[index + 1].value}`;
      index += 2;
    }
    return { value, index };
  }
  return undefined;
}

function asObj(value: MetaValue | undefined): { [key: string]: MetaValue } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function fmtList(value: MetaValue): string {
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : "")).filter(Boolean).join(", ");
  return typeof value === "string" ? value : "";
}
