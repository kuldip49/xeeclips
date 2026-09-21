require('reflect-metadata');
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/modules/app/app.module');
const { PrismaService } = require('../dist/modules/database/prisma.service');
const { ProcessingQueueService } = require('../dist/modules/processing/processing-queue.service');
const { VideoProcessorService } = require('../dist/modules/processing/video-processor.service');

async function main() {
  const routeLogs = [];
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService).useValue({})
    .overrideProvider(ProcessingQueueService).useValue({})
    .overrideProvider(VideoProcessorService).useValue({})
    .compile();
  const app = module.createNestApplication();
  app.useLogger({
    log(message, context) {
      const line = String(message);
      if (context === 'RouterExplorer' && line.includes('/ai-providers'))
        routeLogs.push(line);
    },
    error(message) { process.stderr.write(String(message) + '\n'); },
    warn() {}, debug() {}, verbose() {}, fatal() {}
  });
  try {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const base = `http://127.0.0.1:${address.port}`;
    const expected = [
      'Mapped {/ai-providers, GET} route',
      'Mapped {/ai-providers/:id, PATCH} route',
      'Mapped {/ai-providers/reorder, POST} route',
      'Mapped {/ai-providers/:id/test, POST} route'
    ];
    for (const mapping of expected) assert.ok(routeLogs.includes(mapping),
      'Missing startup route mapping: ' + mapping);
    const result = await fetch(base + '/ai-providers/openrouter/test', { method: 'POST' });
    assert.notEqual(result.status, 404, 'OpenRouter test route must be mounted');
    assert.equal(result.status, 201);
    const body = await result.json();
    assert.equal(body.provider, 'openrouter');
    assert.equal(typeof body.configured, 'boolean');
    for (const line of routeLogs) console.log('[RouterExplorer] ' + line);
    console.log('POST /ai-providers/openrouter/test status=' + result.status);
  } finally {
    await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
