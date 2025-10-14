import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { expect } from 'chai';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';

describe('bootstrap.ts – mutation-safe 100% coverage', () => {
  let secretsMock: ReturnType<typeof mockClient>;
  before(() => (secretsMock = mockClient(SecretsManagerClient)));
  afterEach(() => {
    secretsMock.reset();
    sinon.restore();
  });

  function setup(
    envOverrides: Record<string, any> = {},
    opts: { cdcSecretString?: string | undefined } = {},
  ) {
    const env = {
      MASTER_USER_SECRET: 'master',
      APP_USER_SECRET: 'app',
      CDC_USER_SECRET: 'cdc',
      APP_DATABASE_NAME: 'appdb',
      APP_SCHEMA_NAME: 'appschema',
      RDS_HOST: 'example',
      ...envOverrides,
    };

    // Secrets mocking
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'master' })
      .resolves({ SecretString: JSON.stringify({ username: 'root', password: 'rootpw' }) });
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'app' })
      .resolves({ SecretString: JSON.stringify({ username: 'svc', password: 'svcpw' }) });

    if (env.CDC_USER_SECRET) {
      secretsMock
        .on(GetSecretValueCommand, { SecretId: env.CDC_USER_SECRET })
        .resolves({
          SecretString:
            opts.cdcSecretString ?? JSON.stringify({ username: 'cdc', password: 'cdcpw' }),
        });
    }

    const mainClient = {
      database: 'postgres',
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().callsFake((sql: string) => {
        // Force DB and roles as non-existent to trigger full creation flow
        if (sql.includes('SELECT exists')) return { rows: [{ exists: false }] };
        return { rows: [{}] };
      }),
    };

    const svcClient = {
      database: env.APP_DATABASE_NAME,
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };

    const pgStub = sinon
      .stub()
      .callsFake((o: any) =>
        o?.database === env.APP_DATABASE_NAME ? svcClient : mainClient,
      );

    const handler = proxyquire('../../src/bootstrap', {
      pg: { Client: pgStub },
      envalid: { cleanEnv: () => env },
    });

    return { handler, env, mainClient, svcClient };
  }

  // 1) Happy Path
  it('initializes DB, users, grants, and CDC publication', async () => {
    const { handler } = setup();
    const result = await handler.handler();
    expect(result).to.deep.equal({
      message: `Database 'appdb' for username(s) 'svc & cdc' is ready for use!`,
    });
  });

  // 2) Defaults Path (forces schema/db creation)
  it('uses defaults when APP_* missing', async () => {
    const { handler, mainClient, svcClient } = setup(
      { APP_DATABASE_NAME: undefined, APP_SCHEMA_NAME: undefined },
      { cdcSecretString: JSON.stringify({ username: 'cdc', password: 'pw' }) },
    );
    mainClient.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('SELECT exists')) return { rows: [{ exists: false }] };
      return { rows: [{}] };
    });

    const result = await handler.handler();
    const svcSql = svcClient.query.args.map((a) => a[0]);
    expect(svcSql.join()).to.include('pg_trgm');
    expect(result.message).to.include('Database \'myapp\'');
  });

  // 3) Skip CDC (SecretString undefined → skip)
  it('skips CDC when Secrets Manager returns undefined SecretString', async () => {
    const { handler } = setup({}, { cdcSecretString: undefined });
    const result = await handler.handler();
    expect(result).to.deep.equal({
      message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
    });
  });

  // 4) CDC disabled via env
  it('skips CDC path when env CDC_USER_SECRET not set', async () => {
    const { handler } = setup({ CDC_USER_SECRET: undefined });
    const result = await handler.handler();
    expect(result.message).to.include('skipping CDC');
  });

  // 5) Missing keys in CDC secret
  it('handles CDC secret with missing keys gracefully', async () => {
    const { handler } = setup({}, { cdcSecretString: JSON.stringify({}) });
    const result = await handler.handler();
    expect(result.message).to.include('svc');
    expect(result.message).to.not.include('cdc');
  });

  // 6) Everything already exists (all exists=true)
  it('skips CREATE when DB/roles already exist', async () => {
    const { handler, mainClient } = setup();
    mainClient.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('SELECT exists')) return { rows: [{ exists: true }] };
      return { rows: [{}] };
    });
    const result = await handler.handler();
    expect(result.message).to.include('is ready');
  });

  // 7) Finally path (admin)
  it('ensures finally for admin connection on error', async () => {
    const { handler, mainClient } = setup();
    mainClient.query.onFirstCall().rejects(new Error('adminFail'));
    try {
      await handler.handler();
    } catch {}
    expect(mainClient.end.called).to.be.true;
  });

  // 8) Finally path (service)
  it('ensures finally for service connection on error', async () => {
    const { handler, svcClient } = setup();
    svcClient.query.onFirstCall().rejects(new Error('svcFail'));
    try {
      await handler.handler();
    } catch {}
    expect(svcClient.end.called).to.be.true;
  });

  // 9) CDC user exists branch (else {})
  it('hits CDC user-exists else branch', async () => {
    const { handler, mainClient } = setup();
    mainClient.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('rolname=\'cdc')) return { rows: [{ exists: true }] };
      return { rows: [{ exists: false }] };
    });
    const result = await handler.handler();
    expect(result.message).to.include('ready');
  });

  // 10) Invalid JSON parse
  it('invalid CDC secret JSON surfaces parse error', async () => {
    const { handler } = setup({}, { cdcSecretString: '{invalid-json' });
    let msg = '';
    try {
      await handler.handler();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).to.match(/Unexpected token|Expected property name/);
  });
});
