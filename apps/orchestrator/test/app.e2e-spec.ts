import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { corsOptions } from './../src/cors';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirrors main.ts's bootstrap -- this suite builds the app directly
    // from AppModule rather than running main.ts, so CORS wouldn't
    // otherwise be exercised at all (the bug this file's CORS test
    // guards against: TASK-apply-to-batch.md's browser flow silently
    // failing preflight until app.enableCors() was added).
    app.enableCors(corsOptions());
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('reflects a cross-origin Origin header back on Access-Control-Allow-Origin', () => {
    return request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://localhost:3001')
      .expect(200)
      .expect('Access-Control-Allow-Origin', 'http://localhost:3001');
  });

  afterEach(async () => {
    await app.close();
  });
});
