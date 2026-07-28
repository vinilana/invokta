import { InstallerError } from "./installer-error.js";
import type { SuspendedDescriptor } from "./installer-state.js";
import {
  createJsonTargetAdapter,
  jsonDefinition,
} from "./json-target-adapter.js";
import {
  createJson5TargetAdapter,
  json5Definition,
} from "./json5-target-adapter.js";
import type {
  CapabilityInstallDescriptor,
  ConfigurationTargetId,
  RegistryCompatibilityAdapters,
} from "./registry.js";
import {
  createTargetAdapterCounters,
  type TargetAdapter,
  type TargetAdapterCounters,
} from "./target-adapter.js";
import {
  createTomlTargetAdapter,
  tomlDefinition,
} from "./toml-target-adapter.js";
import {
  createYamlTargetAdapter,
  yamlDefinition,
} from "./yaml-target-adapter.js";

export type { TargetAdapter, TargetAdapterCounters };
export { createTargetAdapterCounters };

export const openClawEnvironmentPolicyCommit =
  "f308af8a344a30432e1b13fa348533e54cd190c8";

export const openClawDeniedEnvironmentNameSnapshot = Object.freeze([
  "ANSIBLE_CALLBACK_PLUGINS",
  "ANSIBLE_COLLECTIONS_PATH",
  "ANSIBLE_CONFIG",
  "ANSIBLE_CONNECTION_PLUGINS",
  "ANSIBLE_FILTER_PLUGINS",
  "ANSIBLE_INVENTORY_PLUGINS",
  "ANSIBLE_LIBRARY",
  "ANSIBLE_LOOKUP_PLUGINS",
  "ANSIBLE_MODULE_UTILS",
  "ANSIBLE_REMOTE_TEMP",
  "ANSIBLE_ROLES_PATH",
  "ANSIBLE_STRATEGY_PLUGINS",
  "ANT_OPTS",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "BASHOPTS",
  "BASH_ENV",
  "BROWSER",
  "BUNDLE_GEMFILE",
  "BUN_CONFIG_REGISTRY",
  "BZR_EDITOR",
  "BZR_PLUGIN_PATH",
  "BZR_SSH",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTDOC",
  "CARGO_HOME",
  "CATALINA_OPTS",
  "CC",
  "CFLAGS",
  "CGO_CFLAGS",
  "CGO_LDFLAGS",
  "CLASSPATH",
  "CMAKE_CXX_COMPILER",
  "CMAKE_C_COMPILER",
  "CMAKE_TOOLCHAIN_FILE",
  "COMPOSER_HOME",
  "CONDA_DEFAULT_ENV",
  "CONDA_PREFIX",
  "CONFIG_SHELL",
  "CONFIG_SITE",
  "CORECLR_PROFILER",
  "CORECLR_PROFILER_PATH",
  "CPATH",
  "CPLUS_INCLUDE_PATH",
  "CPP",
  "CURL_HOME",
  "CXX",
  "CXXCPP",
  "C_INCLUDE_PATH",
  "DENO_DIR",
  "DOTNET_ADDITIONAL_DEPS",
  "DOTNET_STARTUP_HOOKS",
  "EDITOR",
  "ELIXIR_ERL_OPTIONS",
  "EMACSLOADPATH",
  "ENV",
  "ERL_AFLAGS",
  "ERL_FLAGS",
  "ERL_ZFLAGS",
  "EXINIT",
  "FCEDIT",
  "FPATH",
  "GCONV_PATH",
  "GEM_HOME",
  "GEM_PATH",
  "GIT_ALLOW_PROTOCOL",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ASKPASS",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_HOOK_PATH",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PROTOCOL_FROM_USER",
  "GIT_PROXY_COMMAND",
  "GIT_SEQUENCE_EDITOR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_NO_VERIFY",
  "GIT_TEMPLATE_DIR",
  "GIT_WORK_TREE",
  "GLIBC_TUNABLES",
  "GOENV",
  "GOFLAGS",
  "GONOPROXY",
  "GONOSUMCHECK",
  "GONOSUMDB",
  "GOPATH",
  "GOPRIVATE",
  "GOPROXY",
  "GRADLE_OPTS",
  "GVIMINIT",
  "HELM_HOME",
  "HELM_PLUGINS",
  "HGEDITOR",
  "HGMERGE",
  "HGRCPATH",
  "HOSTALIASES",
  "IFS",
  "JAVA_OPTS",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "JULIA_EDITOR",
  "KSH_ENV",
  "LDFLAGS",
  "LESSCLOSE",
  "LESSOPEN",
  "LIBRARY_PATH",
  "LUA_CPATH",
  "LUA_INIT",
  "LUA_INIT_5_1",
  "LUA_INIT_5_2",
  "LUA_INIT_5_3",
  "LUA_INIT_5_4",
  "LUA_PATH",
  "MAKE",
  "MAKEFLAGS",
  "MAVEN_OPTS",
  "MFLAGS",
  "MYVIMRC",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REDIRECT_WARNINGS",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_REPL_HISTORY",
  "NODE_V8_COVERAGE",
  "OBJC_INCLUDE_PATH",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "PACKER_PLUGIN_PATH",
  "PERL5DB",
  "PERL5DBCMD",
  "PERL5LIB",
  "PERL5OPT",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  "PIP_CONFIG_FILE",
  "PIP_EXTRA_INDEX_URL",
  "PIP_FIND_LINKS",
  "PIP_INDEX_URL",
  "PIP_PYPI_URL",
  "PIP_TRUSTED_HOST",
  "PROMPT_COMMAND",
  "PS4",
  "PYTHONBREAKPOINT",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "RUBYLIB",
  "RUBYOPT",
  "RUBYSHELL",
  "RUSTC",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTC_WRAPPER",
  "RUSTDOC",
  "RUSTFLAGS",
  "R_ENVIRON",
  "R_ENVIRON_USER",
  "R_LIBS_USER",
  "R_PROFILE",
  "R_PROFILE_USER",
  "SBT_OPTS",
  "SHELL",
  "SHELLOPTS",
  "SSH_ASKPASS",
  "SSLKEYLOGFILE",
  "SUDO_ASKPASS",
  "SUDO_EDITOR",
  "SVN_EDITOR",
  "SVN_SSH",
  "TCLLIBPATH",
  "TF_CLI_CONFIG_FILE",
  "TF_PLUGIN_CACHE_DIR",
  "UV_DEFAULT_INDEX",
  "UV_EXTRA_INDEX_URL",
  "UV_INDEX",
  "UV_INDEX_URL",
  "UV_PYTHON",
  "VAGRANT_VAGRANTFILE",
  "VIMINIT",
  "VIRTUAL_ENV",
  "VISUAL",
  "WGETRC",
  "YARN_RC_FILENAME",
  "_JAVA_OPTIONS",
] as const);

const openClawDeniedEnvironmentNames: ReadonlySet<string> = new Set<string>(
  openClawDeniedEnvironmentNameSnapshot,
);

function openClawDeniedEnvironment(name: string): boolean {
  const normalized = name.trim().toUpperCase();
  return (
    openClawDeniedEnvironmentNames.has(normalized) ||
    normalized.startsWith("BASH_FUNC_") ||
    normalized.startsWith("DYLD_") ||
    normalized.startsWith("LD_")
  );
}

function portableCompatibility(): { readonly supported: true } {
  return { supported: true };
}

const environmentNamePattern = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const serverNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const reservedHeaderNames: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function invalidDefinitionInverse(): never {
  throw new InstallerError("HARNESS_CONFIG_INVALID");
}

function inverseRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (prototype !== Object.prototype && prototype !== null)
    ) {
      return invalidDefinitionInverse();
    }
    return value;
  } catch {
    return invalidDefinitionInverse();
  }
}

function inverseEntries(
  record: Readonly<Record<string, unknown>>,
): readonly (readonly [string, unknown])[] {
  const entries: Array<readonly [string, unknown]> = [];
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    return invalidDefinitionInverse();
  }
  for (const key of keys) {
    if (typeof key !== "string") return invalidDefinitionInverse();
    const property = Object.getOwnPropertyDescriptor(record, key);
    if (
      property === undefined ||
      property.enumerable !== true ||
      !("value" in property)
    ) {
      return invalidDefinitionInverse();
    }
    entries.push([key, property.value]);
  }
  return Object.freeze(entries);
}

function inverseOwn(
  record: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  let property: PropertyDescriptor | undefined;
  try {
    property = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    return invalidDefinitionInverse();
  }
  if (
    property === undefined ||
    property.enumerable !== true ||
    !("value" in property)
  ) {
    return invalidDefinitionInverse();
  }
  return property.value;
}

function inverseOptionalOwn(
  record: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  let property: PropertyDescriptor | undefined;
  try {
    property = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    return invalidDefinitionInverse();
  }
  if (property === undefined) return undefined;
  if (property.enumerable !== true || !("value" in property)) {
    return invalidDefinitionInverse();
  }
  return property.value;
}

function inverseShape(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): void {
  const keys = inverseEntries(record).map(([key]) => key);
  const allowedKeys = new Set(allowed);
  if (
    keys.some((key) => !allowedKeys.has(key)) ||
    required.some(
      (key) => Object.getOwnPropertyDescriptor(record, key) === undefined,
    )
  ) {
    invalidDefinitionInverse();
  }
}

function inverseString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = inverseOwn(record, key);
  if (typeof value !== "string") return invalidDefinitionInverse();
  return value;
}

function inverseOptionalEnvironmentName(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = inverseOptionalOwn(record, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !environmentNamePattern.test(value)) {
    return invalidDefinitionInverse();
  }
  return value;
}

function inverseStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = inverseOwn(record, key);
  if (!Array.isArray(value)) return invalidDefinitionInverse();
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return invalidDefinitionInverse();
  }
  if (
    keys.length !== value.length + 1 ||
    !keys.includes("length") ||
    keys.some(
      (arrayKey) =>
        arrayKey !== "length" &&
        (typeof arrayKey !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(arrayKey) ||
          Number(arrayKey) >= value.length),
    )
  ) {
    return invalidDefinitionInverse();
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      property === undefined ||
      property.enumerable !== true ||
      !("value" in property) ||
      typeof property.value !== "string"
    ) {
      return invalidDefinitionInverse();
    }
    result.push(property.value);
  }
  return Object.freeze(result);
}

type PlaceholderStyle = "plain" | "cursor" | "opencode";

function barePlaceholder(name: string, style: PlaceholderStyle): string {
  return style === "plain"
    ? `\${${name}}`
    : style === "cursor"
      ? `\${env:${name}}`
      : `{env:${name}}`;
}

function inverseEnvironmentObject(
  value: unknown,
  style: PlaceholderStyle,
): readonly string[] {
  const record = inverseRecord(value as Readonly<Record<string, unknown>>);
  const result: string[] = [];
  for (const [name, placeholder] of inverseEntries(record)) {
    if (
      !environmentNamePattern.test(name) ||
      placeholder !== barePlaceholder(name, style)
    ) {
      return invalidDefinitionInverse();
    }
    result.push(name);
  }
  return Object.freeze(result);
}

function placeholderEnvironmentName(
  value: unknown,
  style: PlaceholderStyle,
  bearer: boolean,
): string {
  if (typeof value !== "string") return invalidDefinitionInverse();
  const prefix = bearer ? "Bearer " : "";
  if (!value.startsWith(prefix)) return invalidDefinitionInverse();
  const placeholder = value.slice(prefix.length);
  const match =
    style === "plain"
      ? /^\$\{([A-Z_][A-Z0-9_]{0,127})\}$/u.exec(placeholder)
      : style === "cursor"
        ? /^\$\{env:([A-Z_][A-Z0-9_]{0,127})\}$/u.exec(placeholder)
        : /^\{env:([A-Z_][A-Z0-9_]{0,127})\}$/u.exec(placeholder);
  if (match?.[1] === undefined) return invalidDefinitionInverse();
  return match[1];
}

function inversePlaceholderHeaders(
  value: unknown,
  style: PlaceholderStyle,
): {
  readonly authentication:
    | { readonly type: "none" }
    | { readonly type: "bearer-env"; readonly variable: string };
  readonly headersFromEnv: Readonly<Record<string, string>>;
} {
  const record = inverseRecord(value as Readonly<Record<string, unknown>>);
  const headers: Record<string, string> = {};
  let bearerVariable: string | undefined;
  for (const [name, placeholder] of inverseEntries(record)) {
    if (
      name !== name.toLowerCase() ||
      !httpFieldNamePattern.test(name) ||
      reservedHeaderNames.has(name)
    ) {
      return invalidDefinitionInverse();
    }
    if (
      name === "authorization" &&
      typeof placeholder === "string" &&
      placeholder.startsWith("Bearer ")
    ) {
      if (bearerVariable !== undefined) return invalidDefinitionInverse();
      bearerVariable = placeholderEnvironmentName(placeholder, style, true);
    } else {
      headers[name] = placeholderEnvironmentName(placeholder, style, false);
    }
  }
  return Object.freeze({
    authentication:
      bearerVariable === undefined
        ? Object.freeze({ type: "none" as const })
        : Object.freeze({
            type: "bearer-env" as const,
            variable: bearerVariable,
          }),
    headersFromEnv: Object.freeze(headers),
  });
}

function inverseDirectHeaders(
  value: unknown,
): Readonly<Record<string, string>> {
  const record = inverseRecord(value as Readonly<Record<string, unknown>>);
  const headers: Record<string, string> = {};
  for (const [name, environmentName] of inverseEntries(record)) {
    if (
      name !== name.toLowerCase() ||
      !httpFieldNamePattern.test(name) ||
      reservedHeaderNames.has(name) ||
      typeof environmentName !== "string" ||
      !environmentNamePattern.test(environmentName)
    ) {
      return invalidDefinitionInverse();
    }
    headers[name] = environmentName;
  }
  return Object.freeze(headers);
}

function inverseToggle(
  record: Readonly<Record<string, unknown>>,
  key: "enabled" | "disabled",
): void {
  if (typeof inverseOwn(record, key) !== "boolean") {
    invalidDefinitionInverse();
  }
}

function frozenStdioTransport(
  command: string,
  args: readonly string[],
  forwardEnv: readonly string[],
) {
  return Object.freeze({
    type: "stdio" as const,
    command,
    args: Object.freeze([...args]),
    forwardEnv: Object.freeze([...forwardEnv]),
  });
}

function frozenHttpTransport(
  url: string,
  authentication:
    | { readonly type: "none" }
    | { readonly type: "bearer-env"; readonly variable: string },
  headersFromEnv: Readonly<Record<string, string>>,
) {
  return Object.freeze({
    type: "streamable-http" as const,
    url,
    authentication: Object.freeze({ ...authentication }),
    headersFromEnv: Object.freeze({ ...headersFromEnv }),
  });
}

function definitionToSuspendedDescriptor(
  targetId: ConfigurationTargetId,
  serverName: string,
  definition: Readonly<Record<string, unknown>>,
): SuspendedDescriptor {
  try {
    if (!serverNamePattern.test(serverName)) return invalidDefinitionInverse();
    const record = inverseRecord(definition);
    const transport = inverseString(record, "transport");
    let canonicalTransport: SuspendedDescriptor["transport"];

    if (transport === "stdio") {
      let command: string;
      let args: readonly string[];
      let forwardEnv: readonly string[];
      if (targetId === "opencode-v2") {
        inverseShape(record, [
          "transport",
          "type",
          "command",
          "environment",
          "disabled",
        ]);
        if (inverseString(record, "type") !== "local") {
          return invalidDefinitionInverse();
        }
        const commandLine = inverseStringArray(record, "command");
        if (commandLine.length === 0) return invalidDefinitionInverse();
        command = commandLine[0] as string;
        args = Object.freeze(commandLine.slice(1));
        forwardEnv = inverseEnvironmentObject(
          inverseOwn(record, "environment"),
          "opencode",
        );
        inverseToggle(record, "disabled");
      } else {
        const environmentField =
          targetId === "codex"
            ? "env_vars"
            : targetId === "antigravity" || targetId === "kimi-code"
              ? undefined
              : "env";
        const typeField = targetId === "claude-code" ? "type" : undefined;
        const toggleField =
          targetId === "claude-code" || targetId === "cursor"
            ? undefined
            : targetId === "antigravity"
              ? "disabled"
              : "enabled";
        inverseShape(record, [
          "transport",
          ...(typeField === undefined ? [] : [typeField]),
          "command",
          "args",
          ...(environmentField === undefined ? [] : [environmentField]),
          ...(toggleField === undefined ? [] : [toggleField]),
        ]);
        if (
          typeField !== undefined &&
          inverseString(record, typeField) !== "stdio"
        ) {
          return invalidDefinitionInverse();
        }
        command = inverseString(record, "command");
        args = inverseStringArray(record, "args");
        if (environmentField === undefined) {
          forwardEnv = Object.freeze([]);
        } else if (targetId === "codex") {
          forwardEnv = inverseStringArray(record, environmentField);
          if (
            forwardEnv.some((name) => !environmentNamePattern.test(name)) ||
            new Set(forwardEnv).size !== forwardEnv.length
          ) {
            return invalidDefinitionInverse();
          }
        } else {
          forwardEnv = inverseEnvironmentObject(
            inverseOwn(record, environmentField),
            targetId === "cursor" ? "cursor" : "plain",
          );
        }
        if (toggleField !== undefined) {
          inverseToggle(record, toggleField as "enabled" | "disabled");
        }
      }
      if (command === "" || command.includes("\0")) {
        return invalidDefinitionInverse();
      }
      canonicalTransport = frozenStdioTransport(command, args, forwardEnv);
    } else if (transport === "streamable-http") {
      let url: string;
      let authentication:
        | { readonly type: "none" }
        | { readonly type: "bearer-env"; readonly variable: string };
      let headersFromEnv: Readonly<Record<string, string>>;
      if (targetId === "antigravity") {
        inverseShape(record, ["transport", "serverUrl", "disabled"]);
        url = inverseString(record, "serverUrl");
        inverseToggle(record, "disabled");
        authentication = Object.freeze({ type: "none" });
        headersFromEnv = Object.freeze({});
      } else if (targetId === "codex") {
        inverseShape(
          record,
          [
            "transport",
            "url",
            "bearer_token_env_var",
            "env_http_headers",
            "enabled",
          ],
          ["transport", "url", "env_http_headers", "enabled"],
        );
        url = inverseString(record, "url");
        const bearer = inverseOptionalEnvironmentName(
          record,
          "bearer_token_env_var",
        );
        authentication =
          bearer === undefined
            ? Object.freeze({ type: "none" })
            : Object.freeze({ type: "bearer-env", variable: bearer });
        headersFromEnv = inverseDirectHeaders(
          inverseOwn(record, "env_http_headers"),
        );
        if (
          authentication.type === "bearer-env" &&
          Object.hasOwn(headersFromEnv, "authorization")
        ) {
          return invalidDefinitionInverse();
        }
        inverseToggle(record, "enabled");
      } else if (targetId === "kimi-code") {
        inverseShape(
          record,
          ["transport", "url", "bearerTokenEnvVar", "enabled"],
          ["transport", "url", "enabled"],
        );
        url = inverseString(record, "url");
        const bearer = inverseOptionalEnvironmentName(
          record,
          "bearerTokenEnvVar",
        );
        authentication =
          bearer === undefined
            ? Object.freeze({ type: "none" })
            : Object.freeze({ type: "bearer-env", variable: bearer });
        headersFromEnv = Object.freeze({});
        inverseToggle(record, "enabled");
      } else {
        const headersField = "headers";
        const typeField =
          targetId === "claude-code" || targetId === "opencode-v2"
            ? "type"
            : undefined;
        const oauthField = targetId === "opencode-v2" ? "oauth" : undefined;
        const toggleField =
          targetId === "claude-code" || targetId === "cursor"
            ? undefined
            : targetId === "opencode-v2"
              ? "disabled"
              : "enabled";
        inverseShape(record, [
          "transport",
          ...(typeField === undefined ? [] : [typeField]),
          "url",
          ...(oauthField === undefined ? [] : [oauthField]),
          headersField,
          ...(toggleField === undefined ? [] : [toggleField]),
        ]);
        if (
          typeField !== undefined &&
          inverseString(record, typeField) !==
            (targetId === "opencode-v2" ? "remote" : "http")
        ) {
          return invalidDefinitionInverse();
        }
        if (
          oauthField !== undefined &&
          inverseOwn(record, oauthField) !== false
        ) {
          return invalidDefinitionInverse();
        }
        url = inverseString(record, "url");
        const headers = inversePlaceholderHeaders(
          inverseOwn(record, headersField),
          targetId === "cursor"
            ? "cursor"
            : targetId === "opencode-v2"
              ? "opencode"
              : "plain",
        );
        authentication = headers.authentication;
        headersFromEnv = headers.headersFromEnv;
        if (toggleField !== undefined) {
          inverseToggle(record, toggleField as "enabled" | "disabled");
        }
      }
      canonicalTransport = frozenHttpTransport(
        url,
        authentication,
        headersFromEnv,
      );
    } else {
      return invalidDefinitionInverse();
    }

    return Object.freeze({ name: serverName, transport: canonicalTransport });
  } catch {
    return invalidDefinitionInverse();
  }
}

function codexDefinition(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Readonly<Record<string, unknown>> {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    return tomlDefinition({
      transport: "stdio",
      command: transport.command,
      args: [...transport.args],
      env_vars: [...transport.forwardEnv],
      enabled: true,
    });
  }
  return tomlDefinition({
    transport: "streamable-http",
    url: transport.url,
    ...(transport.authentication.type === "bearer-env"
      ? { bearer_token_env_var: transport.authentication.variable }
      : {}),
    env_http_headers: Object.fromEntries(
      Object.entries(transport.headersFromEnv).map(([name, environment]) => [
        name.toLowerCase(),
        environment,
      ]),
    ),
    enabled: true,
  });
}

function placeholderHeaders(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Record<string, string> {
  const transport = descriptor.server.transport;
  if (transport.type !== "streamable-http") return {};
  const headers: Record<string, string> = {};
  if (transport.authentication.type === "bearer-env") {
    headers.authorization = `Bearer \${${transport.authentication.variable}}`;
  }
  for (const [name, environment] of Object.entries(transport.headersFromEnv)) {
    headers[name.toLowerCase()] = `\${${environment}}`;
  }
  return headers;
}

function cursorPlaceholderHeaders(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Record<string, string> {
  const transport = descriptor.server.transport;
  if (transport.type !== "streamable-http") return {};
  const headers: Record<string, string> = {};
  if (transport.authentication.type === "bearer-env") {
    headers.authorization = `Bearer \${env:${transport.authentication.variable}}`;
  }
  for (const [name, environment] of Object.entries(transport.headersFromEnv)) {
    headers[name.toLowerCase()] = `\${env:${environment}}`;
  }
  return headers;
}

function openCodePlaceholderHeaders(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Record<string, string> {
  const transport = descriptor.server.transport;
  if (transport.type !== "streamable-http") return {};
  const headers: Record<string, string> = {};
  if (transport.authentication.type === "bearer-env") {
    headers.authorization = `Bearer {env:${transport.authentication.variable}}`;
  }
  for (const [name, environment] of Object.entries(transport.headersFromEnv)) {
    headers[name.toLowerCase()] = `{env:${environment}}`;
  }
  return headers;
}

function hermesDefinition(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Readonly<Record<string, unknown>> {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    const env = Object.fromEntries(
      transport.forwardEnv.map((name) => [name, `\${${name}}`]),
    );
    return yamlDefinition({
      transport: "stdio",
      command: transport.command,
      args: [...transport.args],
      env,
      enabled: true,
    });
  }
  const headers = placeholderHeaders(descriptor);
  return yamlDefinition({
    transport: "streamable-http",
    url: transport.url,
    headers,
    enabled: true,
  });
}

function openClawCompatibility(descriptor: CapabilityInstallDescriptor) {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    for (const name of transport.forwardEnv) {
      if (openClawDeniedEnvironment(name)) {
        return {
          supported: false as const,
          reason: `openclaw-env-denied:${name}`,
        };
      }
    }
  }
  return { supported: true as const };
}

function openClawDefinition(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Readonly<Record<string, unknown>> {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    for (const name of transport.forwardEnv) {
      if (openClawDeniedEnvironment(name)) {
        throw new InstallerError("TARGET_UNSUPPORTED");
      }
    }
    const env = Object.fromEntries(
      transport.forwardEnv.map((name) => [name, `\${${name}}`]),
    );
    return json5Definition({
      transport: "stdio",
      command: transport.command,
      args: [...transport.args],
      env,
      enabled: true,
    });
  }
  const headers = placeholderHeaders(descriptor);
  return json5Definition({
    url: transport.url,
    transport: "streamable-http",
    headers,
    enabled: true,
  });
}

function claudeDefinition(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Readonly<Record<string, unknown>> {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    return jsonDefinition(
      {
        transport: "stdio",
        type: "stdio",
        command: transport.command,
        args: [...transport.args],
        env: Object.fromEntries(
          transport.forwardEnv.map((name) => [name, `\${${name}}`]),
        ),
      },
      "detached",
    );
  }
  return jsonDefinition(
    {
      transport: "streamable-http",
      type: "http",
      url: transport.url,
      headers: placeholderHeaders(descriptor),
    },
    "detached",
  );
}

function cursorDefinition(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Readonly<Record<string, unknown>> {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    return jsonDefinition(
      {
        transport: "stdio",
        command: transport.command,
        args: [...transport.args],
        env: Object.fromEntries(
          transport.forwardEnv.map((name) => [name, `\${env:${name}}`]),
        ),
      },
      "detached",
    );
  }
  return jsonDefinition(
    {
      transport: "streamable-http",
      url: transport.url,
      headers: cursorPlaceholderHeaders(descriptor),
    },
    "detached",
  );
}

function antigravityCompatibility(descriptor: CapabilityInstallDescriptor) {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    return transport.forwardEnv.length === 0
      ? ({ supported: true } as const)
      : ({
          supported: false,
          reason: "antigravity-forward-env-unsupported",
        } as const);
  }
  if (transport.authentication.type === "bearer-env") {
    return {
      supported: false as const,
      reason: "antigravity-http-authentication-unsupported",
    };
  }
  if (Object.keys(transport.headersFromEnv).length > 0) {
    return {
      supported: false as const,
      reason: "antigravity-http-headers-unsupported",
    };
  }
  return { supported: true as const };
}

function antigravityDefinition(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Readonly<Record<string, unknown>> {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    if (transport.forwardEnv.length > 0) {
      throw new InstallerError("TARGET_UNSUPPORTED");
    }
    return jsonDefinition(
      {
        transport: "stdio",
        command: transport.command,
        args: [...transport.args],
        disabled: false,
      },
      "native-disabled",
    );
  }
  if (
    transport.authentication.type === "bearer-env" ||
    Object.keys(transport.headersFromEnv).length > 0
  ) {
    throw new InstallerError("TARGET_UNSUPPORTED");
  }
  return jsonDefinition(
    {
      transport: "streamable-http",
      serverUrl: transport.url,
      disabled: false,
    },
    "native-disabled",
  );
}

function kimiCompatibility(descriptor: CapabilityInstallDescriptor) {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio" && transport.forwardEnv.length > 0) {
    return {
      supported: false as const,
      reason: "kimi-code-forward-env-unsupported",
    };
  }
  if (
    transport.type === "streamable-http" &&
    Object.keys(transport.headersFromEnv).length > 0
  ) {
    return {
      supported: false as const,
      reason: "kimi-code-http-headers-unsupported",
    };
  }
  return { supported: true as const };
}

function kimiDefinition(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Readonly<Record<string, unknown>> {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    if (transport.forwardEnv.length > 0) {
      throw new InstallerError("TARGET_UNSUPPORTED");
    }
    return jsonDefinition(
      {
        transport: "stdio",
        command: transport.command,
        args: [...transport.args],
        enabled: true,
      },
      "native-enabled",
    );
  }
  if (Object.keys(transport.headersFromEnv).length > 0) {
    throw new InstallerError("TARGET_UNSUPPORTED");
  }
  return jsonDefinition(
    {
      transport: "streamable-http",
      url: transport.url,
      ...(transport.authentication.type === "bearer-env"
        ? { bearerTokenEnvVar: transport.authentication.variable }
        : {}),
      enabled: true,
    },
    "native-enabled",
  );
}

function openCodeDefinition(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Readonly<Record<string, unknown>> {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    return jsonDefinition(
      {
        transport: "stdio",
        type: "local",
        command: [transport.command, ...transport.args],
        environment: Object.fromEntries(
          transport.forwardEnv.map((name) => [name, `{env:${name}}`]),
        ),
        disabled: false,
      },
      "native-disabled",
    );
  }
  return jsonDefinition(
    {
      transport: "streamable-http",
      type: "remote",
      url: transport.url,
      oauth: false,
      headers: openCodePlaceholderHeaders(descriptor),
      disabled: false,
    },
    "native-disabled",
  );
}

function grokDefinition(
  descriptor:
    | CapabilityInstallDescriptor
    | { readonly server: SuspendedDescriptor },
): Readonly<Record<string, unknown>> {
  const transport = descriptor.server.transport;
  if (transport.type === "stdio") {
    return tomlDefinition({
      transport: "stdio",
      command: transport.command,
      args: [...transport.args],
      env: Object.fromEntries(
        transport.forwardEnv.map((name) => [name, `\${${name}}`]),
      ),
      enabled: true,
    });
  }
  return tomlDefinition({
    transport: "streamable-http",
    url: transport.url,
    headers: placeholderHeaders(descriptor),
    enabled: true,
  });
}

const codex = createTomlTargetAdapter({
  targetId: "codex",
  dialect: "codex",
  compatibility: portableCompatibility,
  descriptorToDefinition: codexDefinition,
  definitionToSuspendedDescriptor: (serverName, definition) =>
    definitionToSuspendedDescriptor("codex", serverName, definition),
});

const hermes = createYamlTargetAdapter({
  compatibility: portableCompatibility,
  descriptorToDefinition: hermesDefinition,
  definitionToSuspendedDescriptor: (serverName, definition) =>
    definitionToSuspendedDescriptor("hermes", serverName, definition),
});

const openclaw = createJson5TargetAdapter({
  compatibility: openClawCompatibility,
  definitionToSuspendedDescriptor: (serverName, definition) =>
    definitionToSuspendedDescriptor("openclaw", serverName, definition),
  descriptorToDefinition: (descriptor) => {
    if (!openClawCompatibility(descriptor).supported) {
      throw new InstallerError("TARGET_UNSUPPORTED");
    }
    return openClawDefinition(descriptor);
  },
});

const antigravity = createJsonTargetAdapter({
  targetId: "antigravity",
  dialect: "antigravity",
  toggleStrategy: "native-disabled",
  compatibility: antigravityCompatibility,
  definitionToSuspendedDescriptor: (serverName, definition) =>
    definitionToSuspendedDescriptor("antigravity", serverName, definition),
  descriptorToDefinition: (descriptor) => {
    if (!antigravityCompatibility(descriptor).supported) {
      throw new InstallerError("TARGET_UNSUPPORTED");
    }
    return antigravityDefinition(descriptor);
  },
});

const claudeCode = createJsonTargetAdapter({
  targetId: "claude-code",
  dialect: "claude",
  toggleStrategy: "detached",
  compatibility: portableCompatibility,
  descriptorToDefinition: claudeDefinition,
  definitionToSuspendedDescriptor: (serverName, definition) =>
    definitionToSuspendedDescriptor("claude-code", serverName, definition),
});

const cursor = createJsonTargetAdapter({
  targetId: "cursor",
  dialect: "cursor",
  toggleStrategy: "detached",
  compatibility: portableCompatibility,
  descriptorToDefinition: cursorDefinition,
  definitionToSuspendedDescriptor: (serverName, definition) =>
    definitionToSuspendedDescriptor("cursor", serverName, definition),
});

const kimiCode = createJsonTargetAdapter({
  targetId: "kimi-code",
  dialect: "kimi",
  toggleStrategy: "native-enabled",
  compatibility: kimiCompatibility,
  definitionToSuspendedDescriptor: (serverName, definition) =>
    definitionToSuspendedDescriptor("kimi-code", serverName, definition),
  descriptorToDefinition: (descriptor) => {
    if (!kimiCompatibility(descriptor).supported) {
      throw new InstallerError("TARGET_UNSUPPORTED");
    }
    return kimiDefinition(descriptor);
  },
});

const openCode = createJsonTargetAdapter({
  targetId: "opencode-v2",
  dialect: "opencode",
  toggleStrategy: "native-disabled",
  compatibility: portableCompatibility,
  descriptorToDefinition: openCodeDefinition,
  definitionToSuspendedDescriptor: (serverName, definition) =>
    definitionToSuspendedDescriptor("opencode-v2", serverName, definition),
});

const grokBuild = createTomlTargetAdapter({
  targetId: "grok-build",
  dialect: "grok",
  compatibility: portableCompatibility,
  descriptorToDefinition: grokDefinition,
  definitionToSuspendedDescriptor: (serverName, definition) =>
    definitionToSuspendedDescriptor("grok-build", serverName, definition),
});

export const configurationTargetAdapters = Object.freeze({
  antigravity,
  "claude-code": claudeCode,
  codex,
  cursor,
  "grok-build": grokBuild,
  hermes,
  "kimi-code": kimiCode,
  openclaw,
  "opencode-v2": openCode,
} as const);

export const registryCompatibilityAdapters: RegistryCompatibilityAdapters =
  Object.freeze({
    antigravity: antigravity.compatibility,
    "claude-code": claudeCode.compatibility,
    codex: codex.compatibility,
    cursor: cursor.compatibility,
    "grok-build": grokBuild.compatibility,
    hermes: hermes.compatibility,
    "kimi-code": kimiCode.compatibility,
    openclaw: openclaw.compatibility,
    "opencode-v2": openCode.compatibility,
  } satisfies Record<
    ConfigurationTargetId,
    RegistryCompatibilityAdapters[ConfigurationTargetId]
  >);
