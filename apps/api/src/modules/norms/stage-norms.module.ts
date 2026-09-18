import { Module } from '@nestjs/common';
import { StageNormsService } from './stage-norms.service';
import { StageNormsController } from './stage-norms.controller';

/**
 * Нормативы этапов (задача 1.3.4).
 *
 * Отдельный модуль, а не часть справочников: у нормативов нет `isActive` на
 * уровне записи и нет удаления — набор версионируется целиком, и это другое
 * поведение, чем у простых справочников задачи 1.3.1.
 *
 * `PrismaModule` глобальный, импортировать его не нужно.
 */
@Module({
  controllers: [StageNormsController],
  providers: [StageNormsService],
  exports: [StageNormsService],
})
export class StageNormsModule {}
