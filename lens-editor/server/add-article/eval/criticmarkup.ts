/** Detect CriticMarkup so the builder can flag dirty gold for curation.
 *  Nothing is ever stripped — the eval compares gold to output as-is. */
export function hasCriticMarkup(md: string): boolean {
  return /\{>>[\s\S]*?<<\}|\{\+\+[\s\S]*?\+\+\}|\{--[\s\S]*?--\}|\{~~[\s\S]*?~>[\s\S]*?~~\}/.test(md);
}
