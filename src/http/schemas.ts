import { z } from "@hono/zod-openapi";

/** Standard error envelope — documented on every route's error responses. */
export const ErrorResponse = z
  .object({
    error: z
      .object({
        code: z.string().openapi({
          description: "Stable, machine-readable error code (never localized).",
          example: "VALIDATION_FAILED",
        }),
        message: z.string().openapi({
          description: "Human-readable message, localized to the caller's locale (en/fr).",
          example: "Request validation failed.",
        }),
        details: z
          .array(z.unknown())
          .openapi({ description: "Optional field-level issues; empty for most errors." }),
      })
      .openapi({
        description: "The error detail (code + localized message + optional field issues).",
      }),
    requestId: z.string().openapi({
      description: "Correlation id — quote it when reporting a problem.",
      example: "req_a1b2c3",
    }),
  })
  .openapi("ErrorResponse");

/** Query params for cursor/keyset pagination (the default for all list endpoints). */
export const CursorQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({ description: "Max items per page (1–100, default 20).", example: 20 }),
  cursor: z.string().optional().openapi({
    description:
      "Opaque cursor: pass the previous page's `meta.nextCursor` to fetch the next page. Omit for the first page.",
  }),
});

/** Wrap an item schema in the standard `{ data, meta }` list envelope. */
export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item).openapi({ description: "The items in this page." }),
    meta: z
      .object({
        count: z
          .number()
          .int()
          .openapi({ description: "Number of items in this page.", example: 20 }),
        limit: z
          .number()
          .int()
          .openapi({ description: "The page size that was applied.", example: 20 }),
        nextCursor: z
          .string()
          .nullable()
          .openapi({ description: "Pass as `?cursor=` for the next page; null on the last page." }),
        hasNextPage: z
          .boolean()
          .openapi({ description: "True when another page is available.", example: true }),
      })
      .openapi({ description: "Cursor-pagination metadata." }),
  });

/**
 * Query params for offset/page pagination — the opt-in exception used by search
 * endpoints, where an arbitrary sort key rules out the default id keyset and a
 * total count is worth the offset cost. `sort` is intentionally NOT here: the
 * allow-list is per-entity and each endpoint adds it via `z.enum([...])`.
 */
export const OffsetQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1).openapi({
    description: "1-based page number (max 10000; use filters to narrow deep results).",
    example: 1,
  }),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({ description: "Items per page (1–100, default 20).", example: 20 }),
  order: z
    .enum(["asc", "desc"])
    .optional()
    .openapi({ description: "Sort direction. Omit to use the sort field's natural default." }),
});

/** Wrap an item schema in the `{ data, meta }` envelope with offset/total metadata. */
export const offsetPaginated = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item).openapi({ description: "The items on this page." }),
    meta: z
      .object({
        count: z
          .number()
          .int()
          .openapi({ description: "Number of items on this page.", example: 20 }),
        page: z.number().int().openapi({ description: "1-based page number.", example: 1 }),
        pageSize: z
          .number()
          .int()
          .openapi({ description: "The page size that was applied.", example: 20 }),
        total: z
          .number()
          .int()
          .openapi({ description: "Total matches across all pages.", example: 137 }),
        pageCount: z.number().int().openapi({ description: "Total number of pages.", example: 7 }),
        hasNextPage: z
          .boolean()
          .openapi({ description: "True when another page is available.", example: true }),
        hasPreviousPage: z
          .boolean()
          .openapi({ description: "True when a previous page exists.", example: false }),
      })
      .openapi({ description: "Offset-pagination metadata." }),
  });
