import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiConsumes } from '@nestjs/swagger';
import type { Response } from 'express';
import { PhotosService, PHOTO_KINDS, type PhotoKind, type PhotoView } from './photos.service';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { RequirePermission } from '../../common/auth/roles.decorator';
import { PERMISSION } from '@app/shared';
import type { AuthenticatedUser } from '../../common/auth/jwt-auth.guard';

/** Ограничение размера и количества файлов задаётся в контроллере, не в сервисе. */
const MAX_FILES_PER_REQUEST = 10;

@ApiTags('photos')
@ApiCookieAuth()
@Controller()
export class PhotosController {
  constructor(private readonly photosService: PhotosService) {}

  /**
   * Загрузить фотографии изделия.
   *
   * `FilesInterceptor` читает `multipart/form-data`. Файлы держатся в памяти
   * (не на диске): изображение ограничено по размеру, а промежуточные файлы
   * пришлось бы убирать вручную — при падении они остались бы мусором.
   */
  @Post('orders/:orderId/items/:itemId/photos')
  @RequirePermission(PERMISSION.ORDER_UPDATE)
  @UseInterceptors(FilesInterceptor('files', MAX_FILES_PER_REQUEST))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Загрузить фотографии изделия' })
  upload(
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { kind?: string; caption?: string },
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PhotoView[]> {
    const kind = (body.kind ?? 'INTAKE').toUpperCase();
    if (!PHOTO_KINDS.includes(kind as PhotoKind)) {
      throw new BadRequestException({
        code: 'INVALID_PHOTO_KIND',
        message: `Недопустимый вид фото: ${kind}`,
        details: { kind: [`Допустимо: ${PHOTO_KINDS.join(', ')}`] },
      });
    }

    return this.photosService.uploadPhotos({
      orderId,
      itemId,
      kind: kind as PhotoKind,
      caption: body.caption?.trim() === '' ? null : (body.caption?.trim() ?? null),
      files: (files ?? []).map((file) => ({
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      })),
      user,
    });
  }

  /** Фотографии изделия. */
  @Get('orders/:orderId/items/:itemId/photos')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Фотографии изделия' })
  list(
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PhotoView[]> {
    return this.photosService.listByItem(orderId, itemId, user);
  }

  /**
   * Отдать файл фотографии.
   *
   * `private, no-store`: фотография изделия — данные клиента, кэшировать её в
   * браузере или на промежуточном прокси нельзя. Доступ проверяется правами
   * и областью видимости заказа.
   */
  @Get('photos/:id')
  @RequirePermission(PERMISSION.ORDER_READ)
  @ApiOperation({ summary: 'Файл фотографии (полный или уменьшенный)' })
  async download(
    @Param('id') id: string,
    @Query('variant') variant: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.photosService.getFileForDownload(
      id,
      variant === 'thumb' ? 'thumb' : 'full',
      user,
    );

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', String(file.buffer.length));
    res.end(file.buffer);
  }

  /** Удалить фотографию. */
  @Delete('photos/:id')
  @RequirePermission(PERMISSION.ORDER_UPDATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Удалить фотографию' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.photosService.removePhoto(id, user);
  }
}
