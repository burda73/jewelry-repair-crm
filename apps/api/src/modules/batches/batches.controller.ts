import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiConsumes } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { PERMISSION } from '@app/shared';

import { BatchesService } from './batches.service';
import type { BatchActDto, BatchDetailDto, BatchDto, BatchPhotoDto } from './batches.service';

/** Ограничение числа файлов задаётся в контроллере, не в сервисе. */
const MAX_FILES_PER_REQUEST = 10;
import { RequirePermission } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/**
 * Логистика: партии (задача 2.1, ТЗ п. 2.6, docs/07 §8).
 *
 * Права: чтение — `logistics:read`, изменение состава — `logistics:manage`.
 * По матрице ролей (docs/02 §4) партии ведут логист и руководитель
 * производства; руководитель и администратор их видят.
 *
 * Область видимости различается по ролям и вычисляется в сервисе: логист и
 * руководитель производства видят все рейсы, приёмщик — только свои.
 *
 * Разбор тел идёт через `safeParse` и `BadRequestException`, как в остальных
 * контроллерах проекта: схема — единственный источник правил, и её сообщение
 * об ошибке должно доходить до интерфейса целиком, а не превращаться в
 * «Bad Request».
 */
@ApiTags('batches')
@ApiCookieAuth()
@Controller('batches')
export class BatchesController {
  constructor(private readonly batchesService: BatchesService) {}

  @Get()
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Список партий' })
  list(
    @Query() rawQuery: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ items: BatchDto[]; nextCursor: string | null }> {
    return this.batchesService.list(rawQuery, user);
  }

  @Get('in-transit')
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Партии в пути, самые задержанные сверху' })
  listInTransit(@CurrentUser() user: AuthenticatedUser): Promise<BatchDto[]> {
    return this.batchesService.listInTransit(user);
  }

  @Post()
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Создать партию' })
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser): Promise<BatchDetailDto> {
    return this.batchesService.create(body, user);
  }

  @Get(':id')
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Партия с составом' })
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    return this.batchesService.findOne(id, user);
  }

  @Get(':id/candidates')
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Заказы, которые можно включить в партию' })
  candidates(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Awaited<ReturnType<BatchesService['candidates']>>> {
    return this.batchesService.candidates(id, user);
  }

  @Post(':id/orders')
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Добавить заказы в партию' })
  addOrders(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    return this.batchesService.addOrders(id, body, user);
  }

  @Post(':id/act')
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Сформировать электронный акт приёма-передачи' })
  formAct(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<BatchActDto> {
    return this.batchesService.formAct(id, user);
  }

  @Get(':id/act')
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Акт приёма-передачи по партии' })
  findAct(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<BatchActDto> {
    return this.batchesService.findAct(id, user);
  }

  /**
   * PDF акта приёма-передачи.
   *
   * Документ собирается из снимка состава: подписанный акт обязан оставаться
   * тем же документом, даже если заказ позже переименовали.
   */
  @Get(':id/act/pdf')
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @Header('Content-Type', 'application/pdf')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'PDF акта приёма-передачи' })
  async downloadActPdf(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, actNo } = await this.batchesService.buildActPdf(id, user);
    res.setHeader('Content-Length', String(buffer.length));
    /*
     * `inline`, а не `attachment`: акт чаще всего открывают на печать, и
     * скачивание файла заставляло бы искать его в папке загрузок.
     *
     * Имя файла кодируется по RFC 5987. Номер акта начинается с кириллицы
     * («АПП-26-000001»), а HTTP-заголовки — ASCII: прямая подстановка давала
     * `ERR_INVALID_CHAR` и ответ 500 вместо PDF. Дефект найден проверкой на
     * живом сервере; у квитанции заказа его не было, потому что номер заказа
     * ASCII (`MSK1-2609-000001`).
     */
    res.setHeader('Content-Disposition', contentDisposition('inline', `act-${actNo}.pdf`));
    res.end(buffer);
  }

  @Post(':id/act/sign')
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Подписать акт со стороны отправителя или получателя' })
  signAct(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchActDto> {
    return this.batchesService.signAct(id, body, user);
  }

  @Post(':id/act/store')
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Сохранить PDF акта в хранилище' })
  storeAct(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<BatchActDto> {
    return this.batchesService.storeActPdf(id, user);
  }

  /**
   * Отправить партию (задача 2.5).
   *
   * Переводит все заказы партии в «в пути» в ОДНОЙ транзакции: иначе половина
   * рейса уехала бы, а половина осталась, и акт, подписанный на все изделия, не
   * совпадал бы с фактическим составом.
   */
  @Post(':id/dispatch')
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Отправить партию' })
  dispatch(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    return this.batchesService.dispatch(id, user);
  }

  /** Принять партию: заказы переходят в производство или в «готов к выдаче». */
  @Post(':id/receive')
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Принять партию' })
  receive(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    return this.batchesService.receive(id, user);
  }

  /**
   * Загрузить фотофиксацию партии (задача 2.4).
   *
   * `FilesInterceptor` читает `multipart/form-data`. Файлы держатся в памяти, а
   * не на диске: изображение ограничено по размеру, а промежуточные файлы
   * пришлось бы убирать вручную — при падении они остались бы мусором.
   */
  @Post(':id/photos')
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @UseInterceptors(FilesInterceptor('files', MAX_FILES_PER_REQUEST))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Загрузить фотофиксацию партии' })
  uploadPhotos(
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { caption?: string },
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchPhotoDto[]> {
    const caption = body.caption?.trim();
    return this.batchesService.uploadPhotos(
      id,
      {
        caption: caption === undefined || caption === '' ? null : caption,
        files: (files ?? []).map((file) => ({
          buffer: file.buffer,
          originalname: file.originalname,
        })),
      },
      user,
    );
  }

  /** Фотографии партии. */
  @Get(':id/photos')
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Фотографии партии' })
  listPhotos(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchPhotoDto[]> {
    return this.batchesService.listPhotos(id, user);
  }

  /**
   * Отдать файл фото партии.
   *
   * `private, no-store`: фотофиксация — свидетельство о передаче изделий
   * клиентов, кэшировать её в браузере или на промежуточном прокси нельзя.
   */
  @Get('photos/:id')
  @RequirePermission(PERMISSION.LOGISTICS_READ)
  @ApiOperation({ summary: 'Файл фото партии (полный или уменьшенный)' })
  async downloadPhoto(
    @Param('id') id: string,
    @Query('variant') variant: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.batchesService.getPhotoFile(
      id,
      variant === 'thumb' ? 'thumb' : 'full',
      user,
    );
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', String(file.buffer.length));
    res.end(file.buffer);
  }

  /** Удалить фото партии. */
  @Delete('photos/:id')
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Удалить фото партии' })
  async removePhoto(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.batchesService.removePhoto(id, user);
  }

  /**
   * Исключить заказ из партии.
   *
   * `DELETE` с телом — необычно, но причина обязательна, а поместить её в путь
   * нельзя: это свободный текст. Строка при этом не удаляется физически, а
   * помечается `removedAt` с причиной: состав входит в акт приёма-передачи, и
   * «куда делся заказ» должно быть объяснимо после подписания.
   */
  @Delete(':id/orders/:orderId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSION.LOGISTICS_MANAGE)
  @ApiOperation({ summary: 'Убрать заказ из партии (с причиной)' })
  removeOrder(
    @Param('id') id: string,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BatchDetailDto> {
    return this.batchesService.removeOrder(id, orderId, body, user);
  }
}

/**
 * Собрать `Content-Disposition` с именем файла, безопасным для HTTP-заголовка.
 *
 * HTTP-заголовки допускают только ASCII, а номер акта начинается с кириллицы.
 * Поэтому имя отдаётся дважды: ASCII-запасной вариант (`filename`) и точное имя
 * в UTF-8 по RFC 5987 (`filename*`). Браузер выбирает второе и показывает
 * правильное имя; старые клиенты берут первое.
 */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  // Транслитерация для ASCII-варианта: кириллица и прочие не-ASCII заменяются
  // подчёркиванием, чтобы заголовок оставался корректным.
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
