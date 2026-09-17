import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Prisma доступна всем модулям без повторного импорта.
 * Единственный экземпляр клиента на процесс — см. packages/db/src/index.ts.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
