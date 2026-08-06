/** Session-storage key the invoke panel reads a staged prefill from. */
export function prefillKeyFor(capabilityId: string): string {
  return `invokta-devtools:prefill:${capabilityId}`;
}

/**
 * Hands a capability over to the Playground. An optional prefill is staged in
 * session storage for the invoke panel, the hash routes to the capability so
 * the link stays shareable, and both panels are notified so the catalog
 * selects the row and the editor applies the staged arguments.
 */
export function openCapabilityInPlayground(
  capabilityId: string,
  prefill?: string,
): void {
  if (prefill !== undefined) {
    try {
      sessionStorage.setItem(prefillKeyFor(capabilityId), prefill);
    } catch {
      // Session storage is a convenience; navigation still happens.
    }
  }
  try {
    if (typeof location !== "undefined") {
      location.hash = `#capabilities/${encodeURIComponent(capabilityId)}`;
    }
  } catch {
    // Hash routing is a convenience; the selection event still fires.
  }
  try {
    if (
      typeof CustomEvent === "function" &&
      typeof document.dispatchEvent === "function"
    ) {
      document.dispatchEvent(
        new CustomEvent("invokta:select-capability", {
          detail: { id: capabilityId },
        }),
      );
    }
  } catch {
    // The panels may not be listening; the prefill remains staged.
  }
}
