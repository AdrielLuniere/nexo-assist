import type { HelpArticle, TicketCategory } from '@nexo/shared';
import { tokenize } from '@nexo/ticket-service';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Busca na central de ajuda (Anexo B: 5 a 10 artigos curtos).
 *
 * Determinística e sem modelo: pontua palavras da consulta encontradas no título (3), nas tags (2) e
 * no corpo (1), com a mesma normalização da regra de duplicidade (sem acentos, sem palavras vazias).
 * Com poucos artigos isso é rápido, explicável e não custa tokens; com uma base grande, troca-se por
 * busca textual do PostgreSQL ou vetorial sem mudar a porta.
 */

export interface HelpCenter {
  search(query: string, limit: number): Promise<HelpArticle[]>;
}

/** Abaixo disso a coincidência é fraca demais (ex.: uma palavra só no corpo). */
export const MIN_ARTICLE_SCORE = 2;

export function rankArticles(articles: readonly HelpArticle[], query: string, limit: number): HelpArticle[] {
  const terms = tokenize(query);
  if (terms.size === 0) return [];
  return articles
    .map((article) => {
      const title = tokenize(article.title);
      const tags = tokenize(article.tags.join(' '));
      const body = tokenize(article.body);
      let score = 0;
      for (const term of terms) score += title.has(term) ? 3 : tags.has(term) ? 2 : body.has(term) ? 1 : 0;
      return { article, score };
    })
    .filter((entry) => entry.score >= MIN_ARTICLE_SCORE)
    .sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title))
    .slice(0, limit)
    .map((entry) => entry.article);
}

export function createPrismaHelpCenter(prisma: PrismaClient): HelpCenter {
  return {
    async search(query, limit) {
      const rows = await prisma.helpArticle.findMany({ orderBy: { slug: 'asc' } });
      const articles: HelpArticle[] = rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        body: row.body,
        category: row.category as TicketCategory | null,
        tags: row.tags,
      }));
      return rankArticles(articles, query, limit);
    },
  };
}

export function createInMemoryHelpCenter(articles: readonly HelpArticle[]): HelpCenter {
  return { search: async (query, limit) => rankArticles(articles, query, limit) };
}
