import { z } from 'zod';
import { TicketCategorySchema } from './enums.js';
import { IdSchema } from './user.js';

/** Artigo da central de ajuda (Anexo B: 5 a 10 artigos curtos). */
export const HelpArticleSchema = z.object({
  id: IdSchema,
  slug: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  category: TicketCategorySchema.nullable(),
  tags: z.array(z.string()),
});
export type HelpArticle = z.infer<typeof HelpArticleSchema>;
