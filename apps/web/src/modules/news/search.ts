/**
 * PostgREST `or` filter matching a term against title or body, case-insensitively.
 * `*` is PostgREST's wildcard for ilike; % and _ inside the term are escaped so they match literally.
 * The term must already be validated by parseSearchTerm (no , ( ) " \ or *).
 */
export function newsSearchOrFilter(term: string): string {
  const escaped = term.replace(/[%_]/g, (char) => `\\${char}`);
  return `title.ilike.*${escaped}*,body.ilike.*${escaped}*`;
}
