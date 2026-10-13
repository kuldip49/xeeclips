const assert = require('node:assert/strict');
const { validateQaStack } = require('./xeefree-qa-safety.cjs');
const fixture = () => ['backend', 'postgres'].map(service => ({ Name: '/xeeqa-' + service, State: { Running: true },
  Config: { Labels: { 'com.docker.compose.project': 'xeeqa', 'com.docker.compose.service': service },
    Env: ['DATABASE_URL=postgresql://qa:fake@postgres:5432/ai_content_platform'] },
  NetworkSettings: { Networks: { xeeqa_default: { Aliases: [service] } } },
  HostConfig: { PortBindings: service === 'backend' ? { '4000/tcp': [{ HostIp: '127.0.0.1', HostPort: '4100' }] } : {} },
  Mounts: [{ Type: 'volume', Name: service === 'postgres' ? 'xeeqa_postgres_data' : 'xeeqa_upload_staging',
    Destination: service === 'postgres' ? '/var/lib/postgresql/data' : '/app/upload-staging' }] }));
assert(validateQaStack(fixture()));
for (const mutate of [
  c => c[0].Name = '/ai-content-backend',
  c => c[1].Config.Labels['com.docker.compose.project'] = 'ai-content-platform',
  c => c[1].Mounts[0].Name = 'ai-content-platform_postgres_data',
  c => c[0].Config.Env = ['DATABASE_URL=postgresql://qa:fake@host.docker.internal:5432/ai_content_platform'],
  c => c[0].HostConfig.PortBindings['4000/tcp'][0].HostPort = '4000',
  c => c[1].HostConfig.PortBindings['5432/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '5432' }],
  c => c[1].NetworkSettings.Networks = { 'ai-content-platform_default': { Aliases: ['postgres'] } }
]) { const c = fixture(); mutate(c); assert.throws(() => validateQaStack(c)); }
console.log('PASS: isolated QA identity accepted; seven production/misrouting cases refused before any credit mutation.');
