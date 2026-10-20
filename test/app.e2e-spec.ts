import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

describe('nest-lab (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    process.env.CHAOS_ENABLED = 'true';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    delete process.env.CHAOS_ENABLED;
    await app.close();
  });

  it('GET / returns app info', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.body).toMatchObject({ app: 'nest-lab', env: 'local' });
  });

  it('GET /config reports a missing config file without failing', async () => {
    const res = await request(app.getHttpServer()).get('/config').expect(200);
    expect(res.body.fromFile.loaded).toBe(false);
  });

  it('readiness flips with /chaos/ready', async () => {
    const server = app.getHttpServer();
    await request(server).get('/health/ready').expect(200);
    await request(server).post('/chaos/ready?state=false').expect(201);
    await request(server).get('/health/ready').expect(503);
    await request(server).get('/health/live').expect(200);
  });
});
