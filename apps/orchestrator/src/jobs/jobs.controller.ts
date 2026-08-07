import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateBatchJobDto } from './dto/create-batch-job.dto';
import { CreateJobDto } from './dto/create-job.dto';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  create(@Body() dto: CreateJobDto) {
    return this.jobsService.create(dto);
  }

  @Post('batch')
  createBatch(@Body() dto: CreateBatchJobDto) {
    return this.jobsService.createBatch(dto);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.jobsService.findOne(id);
  }
}
