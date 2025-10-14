import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { expect } from 'chai';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';

describe('Handler - Unit', () => {
  let secretsMock: ReturnType<typeof mockClient>;

  before(() => {
    secretsMock = mockClient(SecretsManagerClient);
  });

  afterEach(() => {
    secretsMock.reset();
    sinon.restore();
  });

  function setUp(envOverrides: Record<string, any> = {}) {
    const env = {
      MASTER_USER_SECRET: 'master-test',
      APP_USER_SECRET: 'app-test',
      CDC_USER_SECRET: 'cdc-test',
      APP_DATABASE_NAME: 'app_database',
      APP_SCHEMA_NAME: 'app_schema',
      RDS_HOST: 'example',
      ...envOverrides,
    };
    const appDatabase = env.APP_DATABASE_NAME ?? 'myapp';

    // Secrets mocks
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'master-test' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'admin_user',
          password: 'admin_password',
        }),
      });
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'app-test' })
      .resolves({
        SecretString: JSON.stringify({
          username: 'myapp_user',
          password: 'myapp_password',
        }),
      });
    if (env.CDC_USER_SECRET) {
      secretsMock
        .on(GetSecretValueCommand, { SecretId: env.CDC_USER_SECRET })
        .resolves({
          SecretString: JSON.stringify({
            username: 'cdc_user',
            password: 'cdc_password',
          }),
        });
    }

    // PG stubs
    const mainClientStub = {
      database: 'postgres',
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };
    const serviceClientStub = {
      database: appDatabase,
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };

    const pgStub = sinon
      .stub()
      .callsFake((opts: any) =>
        opts.database === appDatabase ? serviceClientStub : mainClientStub,
      );

    const handler = proxyquire('../../src/bootstrap', {
      pg: { Client: pgStub },
      envalid: { cleanEnv: () => env },
    });
    const consoleSpy = sinon.spy(console, 'log');

    return { handler, mainClientStub, serviceClientStub, pgStub, consoleSpy };
  }

  // --- MAIN HAPPY PATH ---
  it('should fully initialize database and CDC', async () => {
    const { handler, mainClientStub, serviceClientStub } = setUp();

    const res = await handler.handler();

    expect(mainClientStub.connect.called).to.be.true;
    expect(serviceClientStub.connect.called).to.be.true;
    expect(serviceClientStub.query.args.join(' ')).to.include(
      'CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES',
    );
    expect(res.message).to.include("app_database' for username(s)");
  });

  // --- DEFAULT FALLBACKS ---
  it('should use default DB/schema when APP vars missing', async () => {
    const { handler } = setUp({
      APP_DATABASE_NAME: undefined,
      APP_SCHEMA_NAME: undefined,
    });
    const res = await handler.handler();
    expect(res.message).to.include("myapp' for username(s)");
  });

  // --- CDC_USER_SECRET UNSET ---
  it('should skip CDC flow cleanly if no CDC_USER_SECRET env', async () => {
    const { handler, serviceClientStub } = setUp({ CDC_USER_SECRET: undefined });
    const res = await handler.handler();
    expect(
      serviceClientStub.query.args.flat().some((s) => s.includes('cdc_publication')),
    ).to.be.false;
    expect(res.message).to.equal(
      'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
    );
  });

  // --- SECRETS RETURN EMPTY STRING (cdcRaw undefined) ---
  it('should skip CDC creation when secret string undefined', async () => {
    const { handler } = setUp();
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'cdc-test' })
      .resolves({ SecretString: undefined });

    const res = await handler.handler();
    expect(res.message).to.equal(
      'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
    );
  });

  // --- EXISTING USERS/DB (no CREATE) ---
  it('should skip create statements when DB/user already exist', async () => {
    const { handler, mainClientStub } = setUp();
    mainClientStub.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('SELECT exists')) return { rows: [{ exists: true }] };
      return { rows: [{}] };
    });
    await handler.handler();
    expect(mainClientStub.query.callCount).to.be.greaterThan(2);
  });

  // --- CDC ELSE {} BRANCH (user exists) ---
  it('should handle existing CDC user branch', async () => {
    const { handler, mainClientStub } = setUp();
    let count = 0;
    mainClientStub.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('SELECT exists(SELECT FROM pg_roles WHERE rolname=')) {
        count++;
        // first two (app), third (cdc)
        return { rows: [{ exists: count >= 3 }] };
      }
      return { rows: [{}] };
    });
    const res = await handler.handler();
    expect(res.message).to.include('is ready for use');
  });

  // --- QUERY EXCEPTION & FINALLY EXECUTION ---
  it('should still close connections if query throws error', async () => {
    const { handler, mainClientStub } = setUp();
    mainClientStub.query.onFirstCall().rejects(new Error('boom'));
    try {
      await handler.handler();
    } catch {
      /* swallow */
    }
    expect(mainClientStub.end.called).to.be.true;
  });
});
