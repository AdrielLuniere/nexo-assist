import type { User } from '@nexo/shared';
import type { PrismaClient } from '../infra/prisma.js';

/** Leitura de usuários. A API nunca expõe credenciais: esta demonstração nem armazena senhas. */
export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
}

export function createPrismaUserRepository(prisma: PrismaClient): UserRepository {
  const toUser = (row: {
    id: string;
    email: string;
    name: string;
    role: User['role'];
    analystLevel: User['analystLevel'];
    department: string | null;
  }): User => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    analystLevel: row.analystLevel,
    department: row.department,
  });

  return {
    async findByEmail(email) {
      const row = await prisma.user.findUnique({ where: { email } });
      return row ? toUser(row) : null;
    },
    async findById(id) {
      const row = await prisma.user.findUnique({ where: { id } });
      return row ? toUser(row) : null;
    },
  };
}

export function createInMemoryUserRepository(users: readonly User[]): UserRepository {
  return {
    async findByEmail(email) {
      return users.find((user) => user.email === email) ?? null;
    },
    async findById(id) {
      return users.find((user) => user.id === id) ?? null;
    },
  };
}
