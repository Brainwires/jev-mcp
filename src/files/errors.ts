/**
 * Errors the file layer raises at the caller, rather than swallowing.
 *
 * Every one of these is a condition where continuing would be worse than
 * failing: a glob that matched nothing would otherwise come back as a
 * confident "nothing here is relevant", and a cost ceiling that degraded to a
 * partial scan would silently answer a different question than the one asked.
 */

export type FileErrorKind =
  /** The caller passed no source, or more than one. */
  | "bad_source"
  /** A glob matched no files at all. */
  | "no_matches"
  /** A glob matched more files than the cap allows. */
  | "too_many_matches"
  /** A glob's walk reached more directories or entries than the cap allows. */
  | "walk_too_wide"
  /** Every candidate file was skipped, so there is nothing to judge. */
  | "nothing_readable"
  /** The estimated request cost is over the ceiling. */
  | "cost_ceiling"
  /** A named path does not exist. */
  | "not_found"
  /** A named path resolves outside the project root. */
  | "outside_root"
  /** A named path holds credentials. */
  | "sensitive";

/** Never retryable: the caller has to change the request. */
export class FileSelectionError extends Error {
  readonly kind: FileErrorKind;

  constructor(kind: FileErrorKind, message: string) {
    super(message);
    this.name = "FileSelectionError";
    this.kind = kind;
  }
}
