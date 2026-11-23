export type AdsStatus = "Draft" | "Reviewing" | "Approved" | "Deprecated";

export type AdsRuleSeverity = "error" | "warn" | "off";

export interface AdsIgnoreEntry {
  readonly path?: string;
  readonly method?: string;
  readonly schema?: string;
  readonly reason?: string;
}

export interface AdsRuleOptions {
  readonly ignore?: readonly AdsIgnoreEntry[];
}

export type AdsRuleConfig =
  | AdsRuleSeverity
  | ({
      readonly severity: AdsRuleSeverity;
    } & AdsRuleOptions);

export interface AdsRuleMetadata {
  readonly name: string;
  readonly id: string;
  readonly severity: AdsRuleSeverity;
  readonly summary: string;
}

export interface AdsStandardMetadata {
  readonly ads: string;
  readonly slug: string;
  readonly folder: string;
  readonly rules: readonly AdsRuleMetadata[];
}

export interface RedoclySource {
  readonly absoluteRef?: string;
}

export interface RedoclyLocation {
  readonly source?: RedoclySource;
  readonly pointer: string;
  readonly absolutePointer?: string;
  child(keys: string | number | readonly (string | number)[]): RedoclyLocation;
  key(): RedoclyLocation;
}

export interface RedoclyReport {
  message: string;
  location?: RedoclyLocation | RedoclyLocation[] | { reportOnKey?: boolean };
  suggest?: string[];
  from?: RedoclyLocation;
}

export interface RedoclyResolveChainItem<T = unknown> {
  node?: T;
  location?: RedoclyLocation;
}

export interface RedoclyResolveResult<T = unknown> {
  node?: T;
  location?: RedoclyLocation;
  chain?: readonly RedoclyResolveChainItem<T>[];
  error?: unknown;
}

export interface RedoclyUserContext {
  report(problem: RedoclyReport): void;
  location: RedoclyLocation;
  rawLocation?: RedoclyLocation;
  key: string | number;
  parent: unknown;
  rawNode: unknown;
  specVersion?: string;
  resolve<T = unknown>(node: { $ref: string }, from?: string): RedoclyResolveResult<T>;
}

export type RedoclyVisitorHook<T = unknown> = (node: T, ctx: RedoclyUserContext) => void;

export interface RedoclyVisitorObject<T = unknown> {
  enter?: RedoclyVisitorHook<T>;
  leave?: RedoclyVisitorHook<T>;
  skip?: (node: T, ctx: RedoclyUserContext) => boolean;
  PathItem?: RedoclyVisitorHook | RedoclyVisitorObject;
  Operation?: RedoclyVisitorHook | RedoclyVisitorObject;
  Parameter?: RedoclyVisitorHook | RedoclyVisitorObject;
  Schema?: RedoclyVisitorHook | RedoclyVisitorObject;
  Response?: RedoclyVisitorHook | RedoclyVisitorObject;
}

export interface RedoclyOas3Visitor {
  Root?: RedoclyVisitorHook | RedoclyVisitorObject;
  Paths?: RedoclyVisitorHook | RedoclyVisitorObject;
  PathItem?: RedoclyVisitorHook | RedoclyVisitorObject;
  Operation?: RedoclyVisitorHook | RedoclyVisitorObject;
  Parameter?: RedoclyVisitorHook | RedoclyVisitorObject;
  Schema?: RedoclyVisitorHook | RedoclyVisitorObject;
  NamedSchemas?: RedoclyVisitorHook | RedoclyVisitorObject;
  Response?: RedoclyVisitorHook | RedoclyVisitorObject;
  [nodeType: string]: RedoclyVisitorHook | RedoclyVisitorObject | undefined;
}

export type RedoclyOas3Rule = (options?: Record<string, unknown>) => RedoclyOas3Visitor;

export interface RedoclyPresetConfig {
  rules: Record<string, AdsRuleSeverity>;
}

export interface RedoclyPlugin {
  id: string;
  configs?: Record<string, RedoclyPresetConfig>;
  rules: {
    oas3: Record<string, RedoclyOas3Rule>;
  };
}
