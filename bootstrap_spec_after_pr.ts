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
      CDC_USER_SECRET: 'cdc-test', // present → CDC path runs
      APP_DATABASE_NAME: 'app_database',
      APP_SCHEMA_NAME: 'app_schema',
      // legacy (unused but kept for compat)
      CDC_DATABASE_NAME: 'cdc_database',
      CDC_SCHEMA_NAME: 'cdc_schema',
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

    secretsMock.on(GetSecretValueCommand, { SecretId: 'app-test' }).resolves({
      SecretString: JSON.stringify({
        username: 'myapp_user',
        password: 'myapp_password',
      }),
    });

    if (env.CDC_USER_SECRET) {
      secretsMock.on(GetSecretValueCommand, { SecretId: env.CDC_USER_SECRET }).resolves({
        SecretString: JSON.stringify({
          username: 'cdc_user',
          password: 'cdc_password',
        }),
      });
    }

    // pg client stubs
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

    // Route by database: app DB → service stub; everything else → main stub
    const pgStub = sinon.stub().callsFake((options: any) =>
      options.database === appDatabase ? serviceClientStub : mainClientStub,
    );

    const handler = proxyquire('../../src/bootstrap', {
      pg: { Client: pgStub },
      envalid: { cleanEnv: () => env },
    });

    const consoleSpy = sinon.spy(console, 'log');

    return {
      handler,
      pgStub,
      mainClientStub,
      serviceClientStub,
      consoleSpy,
      appDatabase,
      env,
    };
  }

  describe('handler', () => {
    it('should complete happy path', async () => {
    const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } =
        setUp();

    const result = await handler.handler();

    // Admin client first
    expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
    });

    // Admin reconnect for CDC path
    const adminCalls = pgStub.getCalls().filter((c) => !('database' in (c.args[0] ?? {})));
    expect(adminCalls.length).to.be.at.least(2);
    expect(adminCalls[1].args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
    });

    // Two app DB clients: serviceConn + cdcDbConn
    const appDbCalls = pgStub.getCalls().filter((c) => c.args[0]?.database === 'app_database');
    expect(appDbCalls.length).to.be.at.least(2);

    // Master/admin SQL — DB/app user/CDC user created
    const masterSql = mainClientStub.query.getCalls().map((c) => c.args[0]);
    expect(masterSql).to.include(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
    );
    expect(masterSql).to.include(`CREATE DATABASE app_database`);
    expect(masterSql).to.include(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`,
    );
    expect(masterSql).to.include(
        `CREATE USER myapp_user WITH ENCRYPTED PASSWORD 'myapp_password'`,
    );
    expect(masterSql).to.include(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`,
    );
    expect(masterSql).to.include(
        `CREATE USER cdc_user WITH ENCRYPTED PASSWORD 'cdc_password'`,
    );

    // Service DB SQL
    const svcSql = serviceClientStub.query.getCalls().map((c) => c.args[0]);
    expect(svcSql).to.include(
        `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA app_schema CASCADE`,
    );
    expect(svcSql).to.include(
        `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA app_schema CASCADE`,
    );
    expect(svcSql).to.include(
        `GRANT CONNECT ON DATABASE app_database TO myapp_user`,
    );
    expect(svcSql).to.include(
        `GRANT CREATE ON DATABASE app_database TO myapp_user`,
    );
    expect(svcSql).to.include(`CREATE SCHEMA IF NOT EXISTS app_schema`);
    expect(svcSql).to.include(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    expect(svcSql).to.include(`REVOKE ALL ON DATABASE app_database FROM PUBLIC`);
    expect(svcSql).to.include(
        `GRANT USAGE, CREATE ON SCHEMA app_schema TO myapp_user`,
    );
    expect(svcSql).to.include(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA app_schema GRANT ALL PRIVILEGES ON TABLES TO myapp_user`,
    );
    expect(svcSql).to.include(
        `GRANT ALL PRIVILEGES on DATABASE app_database to myapp_user`,
    );
    expect(svcSql).to.include(`ALTER DATABASE app_database OWNER TO myapp_user`);

    // CDC grants/publication (on SAME DB)
    expect(svcSql).to.include(
        `GRANT CONNECT ON DATABASE app_database TO cdc_user`,
    );
    expect(svcSql).to.include(
        `GRANT SELECT ON ALL TABLES IN SCHEMA app_schema TO cdc_user`,
    );
    expect(svcSql).to.include(
        `GRANT rds_replication, rds_superuser TO cdc_user`,
    );
    expect(svcSql).to.include(
        `CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`,
    );

    // Finally blocks executed
    expect(mainClientStub.end.callCount).to.be.at.least(2);
    expect(serviceClientStub.end.callCount).to.be.at.least(2);

    // Logs
    expect(consoleSpy.firstCall.args[0]).to.equal(
        `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
    );

    // ✅ Final message (order: service first, then CDC)
    expect(result).to.deep.equal({
        message: `Database 'app_database' for username(s) 'myapp_user & cdc_user' is ready for use!`,
    });
    });

    it('should provide default values for some configs (CDC on)', async () => {
    const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } =
        setUp({
        APP_DATABASE_NAME: undefined,
        APP_SCHEMA_NAME: undefined,
        });

    const result = await handler.handler();

    // Admin client first
    expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
    });

    // Master DB ensures with defaults
    const masterSql = mainClientStub.query.getCalls().map((c) => c.args[0]);
    expect(masterSql).to.include(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('myapp'))`,
    );
    expect(masterSql).to.include(`CREATE DATABASE myapp`);
    expect(masterSql).to.include(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`,
    );
    expect(masterSql).to.include(
        `CREATE USER myapp_user WITH ENCRYPTED PASSWORD 'myapp_password'`,
    );
    expect(masterSql).to.include(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`,
    );
    expect(masterSql).to.include(
        `CREATE USER cdc_user WITH ENCRYPTED PASSWORD 'cdc_password'`,
    );

    // Service DB SQL (defaults)
    const svcSql = serviceClientStub.query.getCalls().map((c) => c.args[0]);
    expect(svcSql).to.include(
        `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA myapp_user CASCADE`,
    );
    expect(svcSql).to.include(
        `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA myapp_user CASCADE`,
    );
    expect(svcSql).to.include(`GRANT CONNECT ON DATABASE myapp TO myapp_user`);
    expect(svcSql).to.include(`GRANT CREATE ON DATABASE myapp TO myapp_user`);
    expect(svcSql).to.include(`CREATE SCHEMA IF NOT EXISTS myapp_user`);
    expect(svcSql).to.include(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    expect(svcSql).to.include(`REVOKE ALL ON DATABASE myapp FROM PUBLIC`);
    expect(svcSql).to.include(
        `GRANT USAGE, CREATE ON SCHEMA myapp_user TO myapp_user`,
    );
    expect(svcSql).to.include(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA myapp_user GRANT ALL PRIVILEGES ON TABLES TO myapp_user`,
    );
    expect(svcSql).to.include(`GRANT ALL PRIVILEGES on DATABASE myapp to myapp_user`);
    expect(svcSql).to.include(`ALTER DATABASE myapp OWNER TO myapp_user`);

    // CDC grants/publication on defaults
    expect(svcSql).to.include(`GRANT CONNECT ON DATABASE myapp TO cdc_user`);
    expect(svcSql).to.include(
        `GRANT SELECT ON ALL TABLES IN SCHEMA myapp_user TO cdc_user`,
    );
    expect(svcSql).to.include(
        `GRANT rds_replication, rds_superuser TO cdc_user`,
    );
    expect(svcSql).to.include(
        `CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`,
    );

    expect(result).to.deep.equal({
        message: `Database 'myapp' for username(s) 'myapp_user & cdc_user' is ready for use!`,
    });

    expect(consoleSpy.firstCall.args[0]).to.equal(
        `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('myapp'))`,
    );
    });

    it('skips CDC when Secrets Manager returns undefined SecretString', async () => {
        const { handler } = setUp({}, { cdcSecretString: undefined });

        const result = await handler.handler();

        expect(result).to.deep.equal({
            message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
        });
    });

it('handles CDC role already existing (hits empty else {})', async () => {
  const { handler, mainClientStub } = setUp();

  // Make only the CDC role "exists" true; DB & app user are created
  mainClientStub.query = sinon.stub().callsFake((sql: string) => {
    if (sql.includes(`FROM pg_catalog.pg_database`)) {
      return { rows: [{ exists: false }] }; // DB create
    }
    if (sql.includes(`rolname='myapp_user'`)) {
      return { rows: [{ exists: false }] }; // app user create
    }
    if (sql.includes(`rolname='cdc_user'`)) {
      return { rows: [{ exists: true }] };  // CDC exists → falls into empty else {}
    }
    return { rows: [{}] };
  });

  const result = await handler.handler();
  // Should still be a success message including both usernames
  expect(result).to.deep.equal({
    message: `Database 'app_database' for username(s) 'myapp_user & cdc_user' is ready for use!`,
  });
});

it('skips CDC when CDC_USER_SECRET env is not set', async () => {
  const { handler } = setUp({ CDC_USER_SECRET: undefined });

  const result = await handler.handler();

  expect(result).to.deep.equal({
    message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
  });
});

it('closes admin connection in finally even if a query throws', async () => {
  const { handler, mainClientStub } = setUp();
  mainClientStub.query.onFirstCall().rejects(new Error('boom'));
  try { await handler.handler(); } catch {}
  expect(mainClientStub.end.called).to.equal(true);
});

it('closes CDC DB connection in finally even if a CDC grant throws', async () => {
  const { handler, serviceClientStub } = setUp();
  // Simulate an error on a CDC grant (executed on the same DB stub)
  const original = serviceClientStub.query;
  serviceClientStub.query = sinon.stub().callsFake((sql: string) => {
    if (sql.includes('GRANT rds_replication')) throw new Error('grant-failed');
    return original.call(serviceClientStub, sql);
  });
  try { await handler.handler(); } catch {}
  expect(serviceClientStub.end.callCount).to.be.at.least(2);
});



  });
});
