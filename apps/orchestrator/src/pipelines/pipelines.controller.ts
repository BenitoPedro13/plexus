import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { CreatePipelineDto } from './dto/create-pipeline.dto';
import { LinearDagValidationError } from './linear-dag.validator';
import { PipelinesService } from './pipelines.service';

@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly pipelinesService: PipelinesService) {}

  @Post()
  async create(@Body() dto: CreatePipelineDto) {
    try {
      return await this.pipelinesService.create(dto);
    } catch (err) {
      if (err instanceof LinearDagValidationError) {
        throw new BadRequestException({
          reason: err.reason,
          message: err.message,
        });
      }
      throw err;
    }
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.pipelinesService.findOne(id);
  }
}
