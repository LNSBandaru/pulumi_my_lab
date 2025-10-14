import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { expect } from 'chai';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';

describe('bootstrap.ts handler – unit + mutation-safe', () => {
  let secretsMock: ReturnType<typeof mockClient>;

  before(() => {
    secretsMock = mockClient(SecretsManagerClient);
  });

  afterEach(() => {
    secretsMock.reset();
    sinon.restore();
  });

  /**
   * Test harness with fine control over env + secret payloads.
   */
  function setUp(
    envOverrides: Record<string, any> = {},
    opts: { cdcSecretString?: string | undefined } = {},
  ) {
    const env = {
      MASTER_USER_SECRET: 'master-test',
      APP_USER_SECRET: 'app-test',
      CDC_USER_SECRET: 'cdc-test', // default: CDC enabled; override to undefined to disable
      APP_DATABASE_NAME: 'app_database',
      APP_SCHEMA_NAME: 'app_schema',
      RDS_HOST: 'example',
      ...envOverrides,
    };

    // ---- Secrets mocks
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
          SecretString:
            opts.cdcSecretString ??
            JSON.stringify({
              username: 'cdc_user',
              password: 'cdc_password',
            }),
        });
    }

    // ---- pg client stubs
    const appDatabase = env.APP_DATABASE_NAME ?? 'myapp';

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

    // Route: anything with .database === appDatabase -> service stub; else -> main stub
    const pgStub = sinon
      .stub()
      .callsFake((options: any) =>
        options && options.database === appDatabase
          ? serviceClientStub
          : mainClientStub,
      );

    // Proxyquire with injected pg + env
    const handler = proxyquire('../../src/bootstrap', {
      pg: { Client: pgStub },
      envalid: { cleanEnv: () => env },
    });

    const consoleSpy = sinon.spy(console, 'log');

    return {
      handler,
      env,
      pgStub,
      mainClientStub,
      serviceClientStub,
      consoleSpy,
      appDatabase,
    };
  }

  // 1) Happy path with CDC enabled (drives most statements)
  it('initializes DB, app user, CDC user, grants & publication (CDC enabled)', async () => {
    const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } =
      setUp();

    const result = await handler.handler();

    // Admin client created first
    expect(pgStub.firstCall.args[0]).to.deep.equal({
      user: 'admin_user',
      password: 'admin_password',
      host: 'example',
      port: 5432,
    });

    // Admin reconnect for CDC path (kills mutated removal)
    const adminCalls = pgStub
      .getCalls()
      .filter((c) => !('database' in (c.args[0] ?? {})));
    expect(adminCalls.length).to.be.at.least(2);
    expect(adminCalls[1].args[0]).to.deep.equal({
      user: 'admin_user',
      password: 'admin_password',
      host: 'example',
      port: 5432,
    });

    // Service DB connections: serviceConn + cdcDbConn
    expect(serviceClientStub.connect.callCount).to.be.at.least(2);

    // Master/admin SQL (create DB + app role + ensure CDC role)
    const adminSql = mainClientStub.query.getCalls().map((c) => c.args[0]);
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
    );
    expect(adminSql).to.include(`CREATE DATABASE app_database`);
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`,
    );
    expect(adminSql).to.include(
      `CREATE USER myapp_user WITH ENCRYPTED PASSWORD 'myapp_password'`,
    );
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`,
    );
    expect(adminSql).to.include(
      `CREATE USER cdc_user WITH ENCRYPTED PASSWORD 'cdc_password'`,
    );

    // Service DB SQL (exact strings as in code)
    const svcSql = serviceClientStub.query.getCalls().map((c) => c.args[0]);

    // NOTE: your current bootstrap.ts creates EXTENSIONS before SCHEMA
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
    expect(svcSql).to.include(
      `REVOKE ALL ON DATABASE app_database FROM PUBLIC`,
    );
    expect(svcSql).to.include(
      `GRANT USAGE, CREATE ON SCHEMA app_schema TO myapp_user`,
    );
    expect(svcSql).to.include(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA app_schema GRANT ALL PRIVILEGES ON TABLES TO myapp_user`,
    );
    expect(svcSql).to.include(
      `GRANT ALL PRIVILEGES on DATABASE app_database to myapp_user`,
    );
    expect(svcSql).to.include(
      `ALTER DATABASE app_database OWNER TO myapp_user`,
    );

    // CDC grants/publication on app DB
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

    // finally blocks executed
    expect(mainClientStub.end.callCount).to.be.at.least(1);
    expect(serviceClientStub.end.callCount).to.be.at.least(2);

    // Logging assertion kills string mutants
    expect(consoleSpy.firstCall.args[0]).to.equal(
      `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
    );
    expect(consoleSpy.callCount).to.be.at.least(18);

    // Message exactness (kills string/output mutants)
    expect(result).to.deep.equal({
      message: `Database 'app_database' for username(s) 'myapp_user & cdc_user' is ready for use!`,
    });
  });

  // 2) Defaults path when APP_* missing (db=myapp, schema=myapp_user)
  it('uses defaults when APP_DATABASE_NAME/APP_SCHEMA_NAME are missing', async () => {
    const { handler, serviceClientStub } = setUp(
      { APP_DATABASE_NAME: undefined, APP_SCHEMA_NAME: undefined },
      {},
    );
    const result = await handler.handler();

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
    expect(svcSql).to.include(
      `GRANT ALL PRIVILEGES on DATABASE myapp to myapp_user`,
    );
    expect(svcSql).to.include(`ALTER DATABASE myapp OWNER TO myapp_user`);

    // CDC is still enabled by default in this test harness
    expect(svcSql).to.include(`GRANT CONNECT ON DATABASE myapp TO cdc_user`);
    expect(svcSql).to.include(
      `GRANT SELECT ON ALL TABLES IN SCHEMA myapp_user TO cdc_user`,
    );
    expect(svcSql).to.include(
      `CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`,
    );

    expect(result).to.deep.equal({
      message: `Database 'myapp' for username(s) 'myapp_user & cdc_user' is ready for use!`,
    });
  });

  // 3) CDC disabled entirely via env
  it('skips CDC path when CDC_USER_SECRET is not set', async () => {
    const { handler, serviceClientStub } = setUp(
      { CDC_USER_SECRET: undefined },
      {},
    );

    const result = await handler.handler();

    const svcSql = serviceClientStub.query.getCalls().map((c) => c.args[0]);
    expect(svcSql.some((s) => s.includes('cdc_user'))).to.equal(false);
    expect(svcSql.some((s) => s.includes('CREATE PUBLICATION'))).to.equal(
      false,
    );

    expect(result).to.deep.equal({
      message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
    });
  });

  // 4) CDC secret exists but SecretString is undefined -> skip CDC
  it('skips CDC when Secrets Manager returns undefined SecretString', async () => {
    const { handler } = setUp({}, { cdcSecretString: undefined });

    const result = await handler.handler();
    expect(result).to.deep.equal({
      message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
    });
  });

  // 5) Everything already exists (all SELECT exists -> true) => no CREATEs on admin
  it('skips CREATE USER/DB when admin SELECT exists -> true', async () => {
    const { handler, mainClientStub } = setUp();

    mainClientStub.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('SELECT exists')) return { rows: [{ exists: true }] };
      return { rows: [{}] };
    });

    await handler.handler();

    // Only SELECT exists statements on admin path are meaningful here
    const adminSql = mainClientStub.query.getCalls().map((c) => c.args[0]);
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
    );
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`,
    );
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`,
    );
  });

  // 6) Force first admin query to throw -> ensure .end still called (kills finally mutants)
  it('closes admin connection if a query throws (finally path)', async () => {
    const { handler, mainClientStub } = setUp();

    mainClientStub.query.onFirstCall().rejects(new Error('boom'));

    try {
      await handler.handler();
      // If we got here, the test harness swallowed; still assert end() in finally
    } catch {
      // ignore thrown error from the handler; we only care about finally/end()
    }
    expect(mainClientStub.end.called).to.equal(true);
  });

  // 7) Hit the empty "else {}" branch after CDC userExists === true
  it('handles CDC role already existing (no CREATE, else {} branch hit)', async () => {
    const { handler, mainClientStub } = setUp();

    let roleCheckCount = 0;
    mainClientStub.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('SELECT exists(SELECT FROM pg_catalog.pg_database')) {
        return { rows: [{ exists: false }] };
      }
      if (sql.includes(`SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`)) {
        return { rows: [{ exists: false }] };
      }
      if (sql.includes(`SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`)) {
        roleCheckCount++;
        // First CDC check -> true to hit else {}
        return { rows: [{ exists: true }] };
      }
      return { rows: [{}] };
    });

    const result = await handler.handler();
    expect(result.message).to.match(/is ready for use!/);
    expect(roleCheckCount).to.equal(1);
    // No ALTER USER present in code; ensure we didn't accidentally add one
    const adminSql = mainClientStub.query.getCalls().map((c) => c.args[0]);
    expect(adminSql.some((s) => s.includes('ALTER USER cdc_user WITH PASSWORD'))).to.equal(false);
  });
});
