import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../../common/auth/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Проверки живости для оркестратора (docs/01-architecture.md §7).
 *
 * /health/live  — процесс жив (не трогает БД: иначе при недоступной БД
 *                 оркестратор начнёт перезапускать здоровые процессы).
 * /health/ready — приложение готово принимать трафик (проверяет зависимости).
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Процесс жив' })
  live(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Готовность: проверка БД' })
  async ready(): Promise<{
    status: string;
    checks: Record<string, { status: string; latencyMs?: number; error?: string }>;
  }> {
    const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
    } catch (error) {
      checks.database = {
        status: 'error',
        latencyMs: Date.now() - dbStart,
        error: error instanceof Error ? error.message : 'неизвестная ошибка',
      };
    }

    const allOk = Object.values(checks).every((check) => check.status === 'ok');
    return { status: allOk ? 'ok' : 'degraded', checks };
  }
}