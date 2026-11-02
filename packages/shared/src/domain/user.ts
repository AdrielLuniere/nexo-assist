import { z } from 'zod';
import { AnalystLevelSchema, UserRoleSchema } from './enums.js';

export const IdSchema = z.string().min(1).max(64);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Usuário como exposto pela API (nunca inclui credenciais). */
export const UserSchema = z.object({
  id: IdSchema,
  email: z.email(),
  name: z.string().min(1),
  role: UserRoleSchema,
  analystLevel: AnalystLevelSchema.nullable(),
  department: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;
