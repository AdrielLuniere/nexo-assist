/**
 * Similaridade determinística entre chamados, para a regra "sem duplicidade" (Anexo A).
 * Sem modelo: explicável, testável e sem custo por chamada.
 *
 * score = max(sobreposição dos títulos, Jaccard de título + descrição), em 0..1.
 */

/** A partir daqui o chamado é sugerido como possível duplicado (o agente decide com o funcionário). */
export const DUPLICATE_CANDIDATE_THRESHOLD = 0.34;

/** A partir daqui a criação é recusada: atualize o chamado existente em vez de abrir outro. */
export const DUPLICATE_BLOCK_THRESHOLD = 0.6;

const STOPWORDS = new Set([
  'para', 'com', 'sem', 'que', 'uma', 'uns', 'umas', 'dos', 'das', 'nos', 'nas', 'por', 'pelo', 'pela',
  'meu', 'minha', 'meus', 'minhas', 'esta', 'estou', 'esse', 'essa', 'isso', 'aqui', 'ainda', 'depois',
  'apos', 'muito', 'muita', 'mais', 'menos', 'nao', 'como', 'quando', 'desde', 'sobre', 'ontem', 'hoje',
  'tem', 'tenho', 'foi', 'ser', 'fica', 'ficou', 'problema', 'erro',
]);

function stem(token: string): string {
  return token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token;
}

export function tokenize(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ');
  const tokens = normalized
    .split(' ')
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    .map(stem);
  return new Set(tokens);
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count++;
  return count;
}

export function similarityScore(
  a: { title: string; description: string },
  b: { title: string; description: string },
): number {
  const titleA = tokenize(a.title);
  const titleB = tokenize(b.title);
  const titleOverlap =
    titleA.size === 0 || titleB.size === 0 ? 0 : intersectionSize(titleA, titleB) / Math.min(titleA.size, titleB.size);

  const fullA = tokenize(`${a.title} ${a.description}`);
  const fullB = tokenize(`${b.title} ${b.description}`);
  const union = fullA.size + fullB.size - intersectionSize(fullA, fullB);
  const jaccard = union === 0 ? 0 : intersectionSize(fullA, fullB) / union;

  return Math.max(titleOverlap, jaccard);
}
