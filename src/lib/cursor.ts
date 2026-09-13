/**
 * Opaque keyset cursor codec. A cursor is just the last item's UUIDv7 id
 * (time-sortable), base64url-encoded so clients treat it as an opaque token and
 * don't build assumptions on its contents. Pure — see cursor.test.ts.
 */
export const encodeCursor = (id: string): string => Buffer.from(id, "utf8").toString("base64url");

export const decodeCursor = (cursor: string): string =>
  Buffer.from(cursor, "base64url").toString("utf8");
