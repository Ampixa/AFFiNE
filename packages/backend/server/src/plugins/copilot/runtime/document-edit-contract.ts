import { z } from 'zod';

export const DocumentEditScopeSchema = z.object({
  allowCreate: z.boolean(),
  documents: z
    .array(
      z.object({
        docId: z.string(),
        title: z.string(),
        revision: z.string(),
        markdown: z.string(),
      })
    )
    .max(4),
});

export type DocumentEditScope = z.infer<typeof DocumentEditScopeSchema>;

export const DocumentEditSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('create'),
      title: z.string().trim().min(1).max(256),
      content: z.string().trim().min(1).max(32768),
    })
    .strict(),
  z
    .object({
      operation: z.literal('update'),
      docId: z.string().min(1),
      content: z.string().trim().min(1).max(32768),
    })
    .strict(),
  z
    .object({
      operation: z.literal('rename'),
      docId: z.string().min(1),
      title: z.string().trim().min(1).max(256),
    })
    .strict(),
]);

export type DocumentEdit = z.infer<typeof DocumentEditSchema>;
