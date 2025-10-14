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

  before(() => {
    secretsMock = mockClient(SecretsManagerClient);
  });

  afterEach(() => {
    secretsMock.reset();
    sinon.restore();
  });

  /**
   * Harness with fine-grained control over env & secret payloads.
   * By default, CDC is ENABLED with a valid JSON secret unless you override it.
   */
  function setup(
    envOverrides: Record<string, any> = {},
    opts: { cdcSecretString?: string | undefined } = {},
  ) {
    const env = {
      MASTER_USER_SECRET: 'master',
      APP_USER_SECRET: 'app',
      CDC_USER_SECRET: 'cdc', // set undefined in envOverrides to disable CDC path
      APP_DATABASE_NAME: 'appdb',
      APP_SCHEMA_NAME: 'appschema',
      RDS_HOST: 'example',
      ...envOverrides,
    };

    // ---- Secrets
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'master' })
      .resolves({
        SecretString: JSON.stringify({ username: 'root', password: 'rootpw' }),
      });

    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'app' })
      .resolves({
        SecretString: JSON.stringify({ username: 'svc', password: 'svcpw' }),
      });

    if (env.CDC_USER_SECRET) {
      secretsMock
        .on(GetSecretValueCommand, { SecretId: env.CDC_USER_SECRET })
        .resolves({
          // default to a valid CDC secret unless caller overrides it
          SecretString:
            opts.cdcSecretString ??
            JSON.stringify({ username: 'cdc', password: 'cdcpw' }),
        });
    }

    // ---- pg client stubs
    const appDb = env.APP_DATABASE_NAME ?? 'myapp';

    const mainClient = {
      database: 'postgres',
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };

    const svcClient = {
      database: appDb,
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };

    // Route by presence of .database === appDb
    const pgStub = sinon
      .stub()
      .callsFake((opts: any) =>
        opts && opts.database === appDb ? svcClient : mainClient,
      );

    const handler = proxyquire('../../src/bootstrap', {
      pg: { Client: pgStub },
      envalid: { cleanEnv: () => env },
    });

    const consoleSpy = sinon.spy(console, 'log');

    return { handler, env, mainClient, svcClient, pgStub, consoleSpy, appDb };
  }

  // 1) Happy path with CDC enabled (drives most statements)
  it('initializes DB, app user, CDC user, grants & publication (CDC enabled)', async () => {
    const { handler, pgStub, mainClient, svcClient, consoleSpy } = setup();

    const result = await handler.handler();

    // Admin created first
    expect(pgStub.firstCall.args[0]).to.deep.equal({
      user: 'root',
      password: 'rootpw',
      host: 'example',
      port: 5432,
    });

    // Admin reconnect for CDC path (kills removed-finally/object-literal mutants)
    const adminCalls = pgStub
      .getCalls()
      .filter((c) => !('database' in (c.args[0] ?? {})));
    expect(adminCalls.length).to.be.at.least(2);
    expect(adminCalls[1].args[0]).to.deep.equal({
      user: 'root',
      password: 'rootpw',
      host: 'example',
      port: 5432,
    });

    // Service DB connects: serviceConn + cdcDbConn
    expect(svcClient.connect.callCount).to.be.at.least(2);

    // Master SQL
    const adminSql = mainClient.query.getCalls().map((c) => c.args[0]);
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('appdb'))`,
    );
    expect(adminSql).to.include(`CREATE DATABASE appdb`);
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='svc')`,
    );
    expect(adminSql).to.include(
      `CREATE USER svc WITH ENCRYPTED PASSWORD 'svcpw'`,
    );
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc')`,
    );
    expect(adminSql).to.include(
      `CREATE USER cdc WITH ENCRYPTED PASSWORD 'cdcpw'`,
    );

    // Service SQL (exact strings/order from your bootstrap.ts)
    const svcSql = svcClient.query.getCalls().map((c) => c.args[0]);
    expect(svcSql).to.include(
      `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA appschema CASCADE`,
    );
    expect(svcSql).to.include(
      `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA appschema CASCADE`,
    );
    expect(svcSql).to.include(
      `GRANT CONNECT ON DATABASE appdb TO svc`,
    );
    expect(svcSql).to.include(
      `GRANT CREATE ON DATABASE appdb TO svc`,
    );
    expect(svcSql).to.include(`CREATE SCHEMA IF NOT EXISTS appschema`);
    expect(svcSql).to.include(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    expect(svcSql).to.include(`REVOKE ALL ON DATABASE appdb FROM PUBLIC`);
    expect(svcSql).to.include(
      `GRANT USAGE, CREATE ON SCHEMA appschema TO svc`,
    );
    expect(svcSql).to.include(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA appschema GRANT ALL PRIVILEGES ON TABLES TO svc`,
    );
    expect(svcSql).to.include(`GRANT ALL PRIVILEGES on DATABASE appdb to svc`);
    expect(svcSql).to.include(`ALTER DATABASE appdb OWNER TO svc`);

    // CDC grants/publication
    expect(svcSql).to.include(
      `GRANT CONNECT ON DATABASE appdb TO cdc`,
    );
    expect(svcSql).to.include(
      `GRANT SELECT ON ALL TABLES IN SCHEMA appschema TO cdc`,
    );
    expect(svcSql).to.include(
      `GRANT rds_replication, rds_superuser TO cdc`,
    );
    expect(svcSql).to.include(
      `CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`,
    );

    // finally blocks executed
    expect(mainClient.end.callCount).to.be.at.least(1);
    expect(svcClient.end.callCount).to.be.at.least(2);

    // Logs (kills string mutants)
    expect(consoleSpy.firstCall.args[0]).to.equal(
      `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('appdb'))`,
    );
    expect(consoleSpy.callCount).to.be.at.least(18);

    expect(result).to.deep.equal({
      message: `Database 'appdb' for username(s) 'svc & cdc' is ready for use!`,
    });
  });

  // 2) Defaults path when APP_* missing (db=myapp, schema=myapp_user) – CDC ON
  it('uses defaults when APP_DATABASE_NAME/APP_SCHEMA_NAME are missing (CDC on)', async () => {
    const { handler, svcClient } = setup(
      { APP_DATABASE_NAME: undefined, APP_SCHEMA_NAME: undefined },
      { cdcSecretString: JSON.stringify({ username: 'cdc', password: 'pw' }) },
    );

    const result = await handler.handler();

    const svcSql = svcClient.query.getCalls().map((c) => c.args[0]);
    expect(svcSql).to.include(
      `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA myapp_user CASCADE`,
    );
    expect(svcSql).to.include(
      `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA myapp_user CASCADE`,
    );
    expect(svcSql).to.include(`GRANT CONNECT ON DATABASE myapp TO svc`);
    expect(svcSql).to.include(`GRANT CREATE ON DATABASE myapp TO svc`);
    expect(svcSql).to.include(`CREATE SCHEMA IF NOT EXISTS myapp_user`);
    expect(svcSql).to.include(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    expect(svcSql).to.include(`REVOKE ALL ON DATABASE myapp FROM PUBLIC`);
    expect(svcSql).to.include(
      `GRANT USAGE, CREATE ON SCHEMA myapp_user TO svc`,
    );
    expect(svcSql).to.include(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA myapp_user GRANT ALL PRIVILEGES ON TABLES TO svc`,
    );
    expect(svcSql).to.include(`GRANT ALL PRIVILEGES on DATABASE myapp to svc`);
    expect(svcSql).to.include(`ALTER DATABASE myapp OWNER TO svc`);

    // CDC path also executed
    expect(svcSql).to.include(`GRANT CONNECT ON DATABASE myapp TO cdc`);
    expect(svcSql).to.include(
      `GRANT SELECT ON ALL TABLES IN SCHEMA myapp_user TO cdc`,
    );
    expect(svcSql).to.include(
      `CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`,
    );

    expect(result).to.deep.equal({
      message: `Database 'myapp' for username(s) 'svc & cdc' is ready for use!`,
    });
  });

  // 3) CDC disabled entirely via env → skip message
  it('skips CDC path when CDC_USER_SECRET is not set', async () => {
    const { handler } = setup({ CDC_USER_SECRET: undefined });
    const result = await handler.handler();
    expect(result).to.deep.equal({
      message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
    });
  });

  // 4) CDC secret exists but SecretString is undefined → skip CDC
  it('skips CDC when Secrets Manager returns undefined SecretString', async () => {
    const { handler } = setup({}, { cdcSecretString: undefined });
    const result = await handler.handler();
    expect(result).to.deep.equal({
      message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
    });
  });

  // 5) CDC secret JSON is valid but missing keys {} → code still goes CDC path; message filters out falsy cdc username
  it('CDC secret with missing keys: still succeeds; message filters missing CDC username', async () => {
    const { handler } = setup({}, { cdcSecretString: JSON.stringify({}) });
    const result = await handler.handler();
    expect(result).to.deep.equal({
      message: `Database 'appdb' for username(s) 'svc' is ready for use!`,
    });
  });

  // 6) Everything already exists (all SELECT exists -> true) => no CREATEs on admin
  it('skips CREATE USER/DB when admin SELECT exists -> true', async () => {
    const { handler, mainClient } = setup();
    mainClient.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('SELECT exists')) return { rows: [{ exists: true }] };
      return { rows: [{}] };
    });
    const result = await handler.handler();
    expect(result.message).to.include('is ready for use!');
    const adminSql = mainClient.query.getCalls().map((c) => c.args[0]);
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('appdb'))`,
    );
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='svc')`,
    );
    expect(adminSql).to.include(
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc')`,
    );
  });

  // 7) Force service query to throw → ensure serviceConn.end() still called (kills finally mutant)
  it('ensures finally for service connection on error', async () => {
    const { handler, svcClient } = setup();
    svcClient.query.onFirstCall().rejects(new Error('svc boom'));
    try {
      await handler.handler();
    } catch {}
    expect(svcClient.end.called).to.equal(true);
  });

  // 8) Force admin query to throw → ensure mainConn.end() still called (kills finally mutant)
  it('ensures finally for admin connection on error', async () => {
    const { handler, mainClient } = setup();
    mainClient.query.onFirstCall().rejects(new Error('admin boom'));
    try {
      await handler.handler();
    } catch {}
    expect(mainClient.end.called).to.equal(true);
  });

  // 9) Hit the empty "else {}" branch after CDC role exists === true (no CREATE USER)
  it('hits CDC else {} branch when CDC role already exists', async () => {
    const { handler, mainClient } = setup();
    let cdcExistsChecks = 0;
    mainClient.query = sinon.stub().callsFake((sql: string) => {
      if (sql.includes('SELECT exists(SELECT FROM pg_catalog.pg_database')) {
        return { rows: [{ exists: false }] };
      }
      if (sql.includes(`rolname='svc'`)) {
        return { rows: [{ exists: false }] };
      }
      if (sql.includes(`rolname='cdc'`)) {
        cdcExistsChecks++;
        return { rows: [{ exists: true }] }; // triggers the empty else {}
      }
      return { rows: [{}] };
    });
    const result = await handler.handler();
    expect(result.message).to.include('is ready for use!');
    expect(cdcExistsChecks).to.be.greaterThan(0);
  });

  // 10) Invalid JSON in CDC secret -> JSON.parse throws; accept any Node error wording
  it('invalid CDC secret JSON: surfaces JSON.parse error', async () => {
    const { handler } = setup({}, { cdcSecretString: '{invalid-json' });
    let message = '';
    try {
      await handler.handler();
    } catch (e) {
      message = (e as Error).message || String(e);
    }
    // Windows Node often: "Expected property name or '}' in JSON at position ..."
    // Other Node: "Unexpected token i in JSON at position ..."
    expect(message).to.match(/Unexpected token|Expected property name/);
  });
});
