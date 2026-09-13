/**
 * Pure offset/page pagination math — the search-endpoint counterpart to the
 * keyset cursor codec in `cursor.ts`. Framework-agnostic (no Effect/zod/drizzle);
 * see offset.test.ts.
 */
export type OffsetMeta = {
  readonly count: number;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly pageCount: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
};

export type OffsetPage<A> = {
  readonly data: ReadonlyArray<A>;
  readonly meta: OffsetMeta;
};

/** SQL OFFSET for a 1-based page. */
export const offsetOf = (page: number, pageSize: number): number => (page - 1) * pageSize;

/** Build the list envelope's `meta` from the page inputs and the row total. */
export const offsetMeta = (
  page: number,
  pageSize: number,
  total: number,
  count: number,
): OffsetMeta => {
  const pageCount = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    count,
    page,
    pageSize,
    total,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1,
  };
};
