# ADR 0035: Example archive path and subtree validation

- Status: Accepted
- Date: 2026-08-21

## Context

ADR 0020 rejects links and unsupported archive entries when importing a GitHub
example. Applying that rule to every entry in a repository tarball also rejects
safe imports when an unrelated sibling example contains a link, even though the
creator never extracts that sibling.

Scoping type validation to the selected subtree fixes that availability defect,
but introduces two boundaries that must be explicit. First, subtree membership
must be based on complete path components so a prefix neighbor such as
`templates/engine-other` is not treated as part of `templates/engine`. Second,
archive path safety cannot depend on the host platform. `node-tar` normalizes
backslashes to slashes on Windows before exposing a read-entry path, which can
hide the raw spelling and collapse distinct slash and backslash names into the
same destination.

## Decision

This decision amends ADR 0020. The creator rejects symbolic links, hard links,
and unsupported entry types only when their entry path is the selected subtree
root or has that root followed by `/`. An entry whose path merely shares the
root's string prefix is outside the subtree. Entries outside the selected
subtree are not extracted and do not invalidate an otherwise safe import merely
because of their type.

Path safety remains archive-wide. Before `node-tar` applies host-specific path
normalization, the creator validates the decoded raw header path. That value
includes a pending POSIX PAX path or GNU long path when either overrides the
USTAR name. A path containing a backslash is rejected even when it contains no
parent segment and would normalize to a selected path on Windows. The creator
also validates the normalized path as defense in depth. Empty paths, NULs,
absolute paths, Windows drive or UNC paths, and parent-directory segments remain
rejected across the whole archive.

All archive-validation failures keep the sanitized `EXAMPLE_FAILED` diagnostic.
They happen in temporary staging before the target is populated, and the
existing exclusive-write rollback rule remains unchanged.

Official examples must not require symbolic-link privileges to be imported on
Windows. An instruction alias that is part of an official example is therefore
stored as a regular file when the alias does not need symbolic-link identity.

## Consequences

- A link or unsupported type in an unrelated repository subtree no longer
  prevents importing a selected regular-file template.
- Links remain rejected at every depth of the exact selected subtree, while a
  prefix-neighbor subtree remains outside it.
- Raw USTAR, PAX, and GNU path spellings have the same rejection behavior on
  POSIX and Windows, and slash/backslash alias collisions fail before extraction.
- A malformed or unsafe entry anywhere still rejects the archive, including
  entries outside the selected subtree.
- Supporting additional archive path spellings or extracting links would
  require another architectural decision and threat review.
