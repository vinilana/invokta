/**
 * Dependency-free diagnostic surface.
 *
 * `@invokta/installer-core` re-exports these from its main entry point too, but
 * an adapter that must stay cold on its usage and version paths — the
 * `invokta-installer` executable, for one — imports them from here instead. This
 * module reaches no configuration format parser, no filesystem, and no state, so
 * importing it costs nothing.
 */

export type { InstallerErrorCode } from "./installer-error.js";
export {
  InstallerError,
  installerErrorMessages,
  renderInstallerDiagnostic,
} from "./installer-error.js";
