import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Fronteiras arquiteturais verificadas automaticamente:
 * - o agente não acessa banco nem a implementação do serviço de chamados;
 * - o serviço de chamados não conhece HTTP, Prisma nem o agente;
 * - contratos compartilhados não dependem de nenhum pacote interno.
 */

const ROOT = join(import.meta.dirname, '..');

function dependenciesOf(workspace: string): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, workspace, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function importsOf(workspace: string): Array<{ file: string; specifier: string }> {
  return sourceFiles(join(ROOT, workspace, 'src')).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => ({
      file: relative(ROOT, file),
      specifier: match[1] ?? '',
    }));
  });
}

const FORBIDDEN: Record<string, RegExp> = {
  'packages/shared': /^(@nexo\/|@prisma\/|prisma$|express$|@mastra\/|pg$)/,
  'packages/ticket-service': /^(@nexo\/(agent|api|web)|@prisma\/|prisma$|express$|@mastra\/|pg$)/,
  'packages/agent': /^(@nexo\/(ticket-service|api|web)|@prisma\/|prisma$|express$|pg$)/,
};

describe('fronteiras entre pacotes', () => {
  for (const [workspace, forbidden] of Object.entries(FORBIDDEN)) {
    it(`${workspace} não declara dependências proibidas`, () => {
      expect(dependenciesOf(workspace).filter((dep) => forbidden.test(dep))).toEqual([]);
    });

    it(`${workspace} não importa módulos proibidos`, () => {
      const violations = importsOf(workspace).filter(({ specifier }) => forbidden.test(specifier));
      expect(violations).toEqual([]);
    });
  }

  it('nenhum pacote importa o cliente Prisma gerado da API', () => {
    const offenders = ['packages/shared', 'packages/ticket-service', 'packages/agent', 'apps/web'].flatMap((ws) =>
      importsOf(ws).filter(({ specifier }) => specifier.includes('generated/prisma')),
    );
    expect(offenders).toEqual([]);
  });

  it('a interface web só depende de contratos compartilhados', () => {
    const internal = dependenciesOf('apps/web').filter((dep) => dep.startsWith('@nexo/'));
    expect(internal).toEqual(['@nexo/shared']);
  });
});
