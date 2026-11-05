// Approximates a Web-standard host inside Node.js before the entry point
// loads: every Node.js built-in module is unavailable to `import` and
// `require`, `process.getBuiltinModule` is gone, and `navigator.userAgent`
// names another runtime, so the core uses its portable type-introspection
// fallback instead of failing closed as on Node.js. Run the entry point with
// `--disallow-code-generation-from-strings` to forbid `eval` and
// `new Function`, as Cloudflare Workers do.
import { isBuiltin, registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) {
      throw new Error(
        `Node.js built-in ${specifier} requested by ${context.parentURL ?? "the entry point"}.`,
      );
    }
    return nextResolve(specifier, context);
  },
});

if (!Reflect.deleteProperty(process, "getBuiltinModule")) {
  throw new Error("process.getBuiltinModule could not be removed.");
}
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  enumerable: true,
  value: { userAgent: "Invokta-Web-Host-Simulation" },
});
