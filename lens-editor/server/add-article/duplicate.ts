/**
 * An import that resolves to a document already in the library.
 *
 * This is not a failure: nothing went wrong and there is nothing to retry --
 * the requested content is already there. Carrying the existing document's
 * path lets the queue mark the job "skipped" and link straight to it.
 */
export class DuplicateDocumentError extends Error {
  constructor(
    message: string,
    readonly docPath: string,
  ) {
    super(message);
    this.name = "DuplicateDocumentError";
  }
}
