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

const codex = createTomlTargetAdapter({
  compatibility: portableCompatibility,
  descriptorToDefinition: codexDefinition,
});

const hermes = createYamlTargetAdapter({
  compatibility: portableCompatibility,
  descriptorToDefinition: hermesDefinition,
});

const openclaw = createJson5TargetAdapter({
  compatibility: openClawCompatibility,
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
});

const cursor = createJsonTargetAdapter({
  targetId: "cursor",
  dialect: "cursor",
  toggleStrategy: "detached",
  compatibility: portableCompatibility,
  descriptorToDefinition: cursorDefinition,
});

const kimiCode = createJsonTargetAdapter({
  targetId: "kimi-code",
  dialect: "kimi",
  toggleStrategy: "native-enabled",
  compatibility: kimiCompatibility,
  descriptorToDefinition: (descriptor) => {
    if (!kimiCompatibility(descriptor).supported) {
      throw new InstallerError("TARGET_UNSUPPORTED");
    }
    return kimiDefinition(descriptor);
  },
});

export const configurationTargetAdapters = Object.freeze({
  antigravity,
  "claude-code": claudeCode,
  codex,
  cursor,
  hermes,
  "kimi-code": kimiCode,
  openclaw,
} as const);

const unsupportedCompatibility = () =>
  ({ supported: false, reason: "target-adapter-not-implemented" }) as const;

export const registryCompatibilityAdapters: RegistryCompatibilityAdapters =
  Object.freeze({
    antigravity: antigravity.compatibility,
    "claude-code": claudeCode.compatibility,
    codex: codex.compatibility,
    cursor: cursor.compatibility,
    "grok-build": unsupportedCompatibility,
    hermes: hermes.compatibility,
    "kimi-code": kimiCode.compatibility,
    openclaw: openclaw.compatibility,
    "opencode-v2": unsupportedCompatibility,
  } satisfies Record<
    ConfigurationTargetId,
    RegistryCompatibilityAdapters[ConfigurationTargetId]
  >);
