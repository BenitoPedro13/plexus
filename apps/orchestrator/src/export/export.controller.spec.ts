import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { ExportModule } from './export.module';

// Proxies against a real local http.Server standing in for
// workers/cmd/renderserver, not a mock of NestJS internals — consistent
// with the codebase's "don't mock what you can run for real" spirit
// (CLAUDE.md's no-mocking rule is scoped to DB/queue, but this controller
// has neither; a real socket is the more honest test of the actual
// fetch()-based proxy behavior). See docs/tasks/TASK-editor-export.md.
describe('ExportController', () => {
  let fakeRenderServer: http.Server | undefined;
  let app: INestApplication<App> | undefined;
  const originalRenderServerUrl = process.env.RENDER_SERVER_URL;

  function startFakeRenderServer(
    handler: http.RequestListener,
  ): Promise<string> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        fakeRenderServer = server;
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  async function bootApp(): Promise<INestApplication<App>> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ExportModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (fakeRenderServer) {
      await new Promise((resolve) =>
        fakeRenderServer!.close(() => resolve(undefined)),
      );
      fakeRenderServer = undefined;
    }
    process.env.RENDER_SERVER_URL = originalRenderServerUrl;
  });

  it('proxies a successful render, preserving status/content-type/content-disposition/body', async () => {
    const rendered = Buffer.from('fake-rendered-jpeg-bytes');
    let receivedBody = Buffer.alloc(0);
    let receivedRecipeField: string | undefined;

    const url = await startFakeRenderServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks);
        receivedRecipeField = receivedBody.toString('utf-8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="export.jpeg"',
        );
        res.end(rendered);
      });
    });
    process.env.RENDER_SERVER_URL = url;

    const app = await bootApp();

    const res = await request(app.getHttpServer())
      .post('/export')
      .field('recipe', JSON.stringify([{ processor: 'image.crop' }]))
      .attach('file', Buffer.from('source-bytes'), 'source.jpg');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-disposition']).toContain('export.jpeg');
    expect(Buffer.compare(res.body as Buffer, rendered)).toBe(0);
    // The multipart body the controller forwarded upstream must contain
    // both parts it received, proving it's a real proxy and not just
    // echoing the fake server's own response.
    expect(receivedBody.length).toBeGreaterThan(0);
    expect(receivedRecipeField).toContain('image.crop');
  });

  it('rejects the request before touching the render server when no file is uploaded', async () => {
    process.env.RENDER_SERVER_URL = 'http://127.0.0.1:1';
    const app = await bootApp();

    const res = await request(app.getHttpServer())
      .post('/export')
      .field('recipe', '[]');

    expect(res.status).toBe(400);
  });

  it('returns 502 when the render server is unreachable', async () => {
    process.env.RENDER_SERVER_URL = 'http://127.0.0.1:1';
    const app = await bootApp();

    const res = await request(app.getHttpServer())
      .post('/export')
      .field('recipe', '[]')
      .attach('file', Buffer.from('source-bytes'), 'source.jpg');

    expect(res.status).toBe(502);
  });

  it('forwards a non-2xx render server response as-is', async () => {
    const url = await startFakeRenderServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.statusCode = 422;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('render recipe: step 0: unknown processor "bogus"');
      });
    });
    process.env.RENDER_SERVER_URL = url;
    const app = await bootApp();

    const res = await request(app.getHttpServer())
      .post('/export')
      .field('recipe', JSON.stringify([{ processor: 'bogus' }]))
      .attach('file', Buffer.from('source-bytes'), 'source.jpg');

    expect(res.status).toBe(422);
    expect(res.text).toContain('unknown processor');
  });
});
