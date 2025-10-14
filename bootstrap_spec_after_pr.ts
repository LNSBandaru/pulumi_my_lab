import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { expect } from 'chai';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';

describe('bootstrap.ts – full mutation-safe coverage', () => {
  let secretsMock: ReturnType<typeof mockClient>;
  before(() => (secretsMock = mockClient(SecretsManagerClient)));
  afterEach(() => {
    secretsMock.reset();
    sinon.restore();
  });

  function setup(envOverrides: Record<string, any> = {}, cdcSecret?: any) {
    const env = {
      MASTER_USER_SECRET: 'master',
      APP_USER_SECRET: 'app',
      CDC_USER_SECRET: 'cdc',
      APP_DATABASE_NAME: 'appdb',
      APP_SCHEMA_NAME: 'appschema',
      RDS_HOST: 'example',
      ...envOverrides,
    };

    // Secrets
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'master' })
      .resolves({ SecretString: JSON.stringify({ username: 'root', password: 'rootpw' }) });
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'app' })
      .resolves({ SecretString: JSON.stringify({ username: 'svc', password: 'svcpw' }) });
    if (env.CDC_USER_SECRET)
      secretsMock
        .on(GetSecretValueCommand, { SecretId: env.CDC_USER_SECRET })
        .resolves({ SecretString: cdcSecret });

    const mainClient = {
      database: 'postgres',
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };
    const svcClient = {
      database: env.APP_DATABASE_NAME,
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };
    const pgStub = sinon.stub().callsFake((o: any) =>
      o?.database === env.APP_DATABASE_NAME ? svcClient : mainClient,
    );
    const handler = proxyquire('../../src/bootstrap', {
      pg: { Client: pgStub },
      envalid: { cleanEnv: () => env },
    });
    return { handler, env, mainClient, svcClient, pgStub };
  }

  it('happy path full initialization', async () => {
    const { handler, mainClient, svcClient } = setup({}, JSON.stringify({ username: 'cdc', password: 'cdcpw' }));
    const r = await handler.handler();
    const sql = svcClient.query.args.map((a) => a[0]);
    expect(sql).to.include(`CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`);
    expect(r.message).to.equal(`Database 'appdb' for username(s) 'svc & cdc' is ready for use!`);
    expect(mainClient.end.called).to.be.true;
    expect(svcClient.end.callCount).to.be.greaterThan(1);
  });

  it('default db/schema when undefined', async () => {
    const { handler } = setup({ APP_DATABASE_NAME: undefined, APP_SCHEMA_NAME: undefined });
    const r = await handler.handler();
    expect(r.message).to.match(/Database 'myapp'/);
  });

  it('skip CDC entirely if env var missing', async () => {
    const { handler } = setup({ CDC_USER_SECRET: undefined });
    const r = await handler.handler();
    expect(r.message).to.equal('CDC_USER_SECRET not set; skipping CDC user/publication setup.');
  });

  it('skip CDC if SecretString undefined', async () => {
    const { handler } = setup({}, undefined);
    const r = await handler.handler();
    expect(r.message).to.equal('CDC_USER_SECRET not set; skipping CDC user/publication setup.');
  });

  it('CDC secret with missing keys handled safely', async () => {
    const { handler } = setup({}, JSON.stringify({}));
    const r = await handler.handler();
    expect(r.message).to.equal('CDC_USER_SECRET not set; skipping CDC user/publication setup.');
  });

  it('skip CREATEs when DB & roles already exist', async () => {
    const { handler, mainClient } = setup({}, JSON.stringify({ username: 'cdc', password: 'pw' }));
    mainClient.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('SELECT exists')) return { rows: [{ exists: true }] };
      return { rows: [{}] };
    });
    const r = await handler.handler();
    expect(r.message).to.include('is ready');
    expect(mainClient.query.callCount).to.be.greaterThan(2);
  });

  it('ensures finally for service connection', async () => {
    const { handler, svcClient } = setup();
    svcClient.query.onFirstCall().rejects(new Error('fail'));
    try {
      await handler.handler();
    } catch {}
    expect(svcClient.end.called).to.be.true;
  });

  it('ensures finally for admin connection', async () => {
    const { handler, mainClient } = setup();
    mainClient.query.onFirstCall().rejects(new Error('boom'));
    try {
      await handler.handler();
    } catch {}
    expect(mainClient.end.called).to.be.true;
  });

  it('hits CDC else {} branch (user exists true)', async () => {
    const { handler, mainClient } = setup();
    let check = 0;
    mainClient.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('rolname=\'cdc')) {
        check++;
        return { rows: [{ exists: true }] };
      }
      if (sql.includes('rolname=\'svc')) return { rows: [{ exists: false }] };
      return { rows: [{ exists: false }] };
    });
    const r = await handler.handler();
    expect(r.message).to.include('is ready');
    expect(check).to.be.greaterThan(0);
  });

  it('covers empty APP_SCHEMA_NAME edge', async () => {
    const { handler } = setup({ APP_SCHEMA_NAME: '' }, JSON.stringify({ username: 'cdc', password: 'pw' }));
    const r = await handler.handler();
    expect(r.message).to.include('svc');
  });

  it('verifies combined usernames join order', async () => {
    const { handler } = setup({}, JSON.stringify({ username: 'cdcX', password: 'pw' }));
    const r = await handler.handler();
    expect(r.message.endsWith("'svc & cdcX' is ready for use!")).to.be.true;
  });

  it('invalid secret JSON handled', async () => {
    const { handler } = setup({}, '{invalid-json');
    let msg = '';
    try {
      await handler.handler();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).to.match(/Unexpected token/);
  });
});
