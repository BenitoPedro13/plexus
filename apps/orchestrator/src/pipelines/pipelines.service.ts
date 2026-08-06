import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { pipelines, type Pipeline } from '../db/schema';
import { CreatePipelineDto } from './dto/create-pipeline.dto';
import { resolveLinearOrder } from './linear-dag.validator';

@Injectable()
export class PipelinesService {
  constructor(private readonly dbService: DbService) {}

  async create(dto: CreatePipelineDto): Promise<Pipeline> {
    const orderedSteps = resolveLinearOrder(dto.steps);

    const [row] = await this.dbService.db
      .insert(pipelines)
      .values({ name: dto.name, definition: orderedSteps })
      .returning();

    return row;
  }

  async findOne(id: string): Promise<Pipeline> {
    const [row] = await this.dbService.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.id, id));

    if (!row) {
      throw new NotFoundException(`Pipeline "${id}" not found`);
    }

    return row;
  }
}
