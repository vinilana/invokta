export type CapabilityDeclarationProvenance =
  | { readonly kind: "local"; readonly localId: string }
  | {
      readonly kind: "atomic";
      readonly sourceName: string;
      readonly sourceVersion?: string;
      readonly defaultId: string;
    }
  | {
      readonly kind: "library";
      readonly libraryName: string;
      readonly libraryVersion: string;
      readonly defaultId: string;
    };

export type CapabilityCompositionIssue =
  | {
      readonly code: "CAPABILITY_ID_COLLISION";
      readonly effectiveId: string;
      readonly declarations: readonly CapabilityDeclarationProvenance[];
    }
  | {
      readonly code: "CAPABILITY_IMPORT_INVALID";
      readonly importKind: "atomic";
      readonly reason: "EXPORTED_CAPABILITY_REQUIRED";
    }
  | {
      readonly code: "CAPABILITY_IMPORT_ID_NOT_FOUND";
      readonly libraryName: string;
      readonly defaultId: string;
    }
  | {
      readonly code: "CAPABILITY_REMAP_NOT_SELECTED";
      readonly libraryName: string;
      readonly defaultId: string;
    };

function freezeIssue(issue: CapabilityCompositionIssue): void {
  if (issue.code === "CAPABILITY_ID_COLLISION") {
    for (const declaration of issue.declarations) Object.freeze(declaration);
    Object.freeze(issue.declarations);
  }
  Object.freeze(issue);
}

export class CapabilityCompositionError extends TypeError {
  readonly code: "CAPABILITY_COMPOSITION_INVALID";
  readonly issues: readonly CapabilityCompositionIssue[];

  constructor(issues: readonly CapabilityCompositionIssue[]) {
    super("Capability composition is invalid.");
    this.name = "CapabilityCompositionError";
    this.code = "CAPABILITY_COMPOSITION_INVALID";
    for (const issue of issues) freezeIssue(issue);
    this.issues = Object.freeze(issues);
    // The snapshot must survive any later mutation attempt by a caller that
    // caught this error, so the diagnostics can never rewrite a valid engine.
    Object.freeze(this);
  }
}

export function isCapabilityCompositionError(
  value: unknown,
): value is CapabilityCompositionError {
  if (typeof value !== "object" || value === null) return false;
  try {
    const code = (value as { readonly code?: unknown }).code;
    const issues = (value as { readonly issues?: unknown }).issues;
    return code === "CAPABILITY_COMPOSITION_INVALID" && Array.isArray(issues);
  } catch {
    // A predicate over a caught value must never replace the original failure.
    return false;
  }
}
