import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { expect } from 'chai';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';

describe('Handler - Unit (mutation-safe, single admin connection)', () => {
  const secretsMock = mockClient(SecretsManagerClient);

  afterEach(() => {
    secretsMock.reset();
    sinon.restore();
  });

  /** Minimal harness: 1 optional env arg; CDC secret is overridden per-test via secretsMock */
  function setUp(envOverrides: Record<string, any> = {}) {
    const env = {
      MASTER_USER_SECRET: 'master-test',
      APP_USER_SECRET: 'app-test',
      CDC_USER_SECRET: 'cdc-test', // set undefined in tests to skip CDC path
      APP_DATABASE_NAME: 'app_database',
      APP_SCHEMA_NAME: 'app_schema',
      RDS_HOST: 'example',
      ...envOverrides,
    };

    // Secrets
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'master-test' })
      .resolves({
        SecretString: JSON.stringify({ username: 'admin_user', password: 'admin_password' }),
      });
    secretsMock
      .on(GetSecretValueCommand, { SecretId: 'app-test' })
      .resolves({
        SecretString: JSON.stringify({ username: 'myapp_user', password: 'myapp_password' }),
      });
    if (env.CDC_USER_SECRET) {
      secretsMock
        .on(GetSecretValueCommand, { SecretId: env.CDC_USER_SECRET })
        .resolves({
          SecretString: JSON.stringify({ username: 'cdc_user', password: 'cdc_password' }),
        });
    }

    const appDb = env.APP_DATABASE_NAME ?? 'myapp';

    // pg stubs
    const mainClientStub = {
      database: 'postgres',
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };
    const serviceClientStub = {
      database: appDb,
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };

    const pgStub = sinon.stub().callsFake((opts: any) =>
      opts && opts.database === appDb ? serviceClientStub : mainClientStub,
    );

    const handler = proxyquire('../../src/bootstrap', {
      pg: { Client: pgStub },
      envalid: { cleanEnv: () => env },
    });

    const consoleSpy = sinon.spy(console, 'log');

    return { handler, env, pgStub, mainClientStub, serviceClientStub, consoleSpy, appDb };
  }

  // 1) Happy path (CDC on) — single master connection + exact schema log
it('should complete happy path', async () => {
  const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } = setUp();

  const result = await handler.handler();

  // One admin connection now
  expect(pgStub.firstCall.args[0]).to.deep.equal({
    user: 'admin_user',
    password: 'admin_password',
    host: 'example',
    port: 5432,
  });
  expect(mainClientStub.connect.callCount).to.equal(1);
  expect(mainClientStub.end.callCount).to.equal(1);

  // Master SQL contains service + CDC role paths
  const adminSql = mainClientStub.query.getCalls().map(c => c.args[0]);
  expect(adminSql).to.include(
    `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
  );
  expect(adminSql).to.include(`CREATE DATABASE app_database`);
  expect(adminSql).to.include(`SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`);
  expect(adminSql).to.include(`CREATE USER myapp_user WITH ENCRYPTED PASSWORD 'myapp_password'`);
  expect(adminSql).to.include(`SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`);
  expect(adminSql).to.include(`CREATE USER cdc_user WITH ENCRYPTED PASSWORD 'cdc_password'`);

  // Service DB SQL (incl. CDC grants + publication)
  const svcSql = serviceClientStub.query.getCalls().map(c => c.args[0]);
  expect(svcSql).to.include(`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA app_schema CASCADE`);
  expect(svcSql).to.include(`CREATE EXTENSION IF NOT EXISTS intarray SCHEMA app_schema CASCADE`);
  expect(svcSql).to.include(`GRANT CONNECT ON DATABASE app_database TO myapp_user`);
  expect(svcSql).to.include(`GRANT CREATE ON DATABASE app_database TO myapp_user`);
  expect(svcSql).to.include(`CREATE SCHEMA IF NOT EXISTS app_schema`);
  expect(svcSql).to.include(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  expect(svcSql).to.include(`REVOKE ALL ON DATABASE app_database FROM PUBLIC`);
  expect(svcSql).to.include(`GRANT USAGE, CREATE ON SCHEMA app_schema TO myapp_user`);
  expect(svcSql).to.include(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA app_schema GRANT ALL PRIVILEGES ON TABLES TO myapp_user`,
  );
  expect(svcSql).to.include(`GRANT ALL PRIVILEGES on DATABASE app_database to myapp_user`);
  expect(svcSql).to.include(`ALTER DATABASE app_database OWNER TO myapp_user`);

  // CDC grants & publication
  expect(svcSql).to.include(`GRANT CONNECT ON DATABASE app_database TO cdc_user`);
  expect(svcSql).to.include(`GRANT SELECT ON ALL TABLES IN SCHEMA app_schema TO cdc_user`);
  expect(svcSql).to.include(`GRANT rds_replication, rds_superuser TO cdc_user`);
  expect(svcSql).to.include(`CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`);

  // Verify exact schema creation string literal logged (kills string mutation)
const schemaLogExact = consoleSpy.getCalls()
  .some(call => call.args[0] === `[app_database] CREATE SCHEMA IF NOT EXISTS app_schema`);
expect(schemaLogExact, 'exact schema log must exist').to.equal(true);

  // Kill string-literal mutant: assert EXACT schema-create log line
  const sawExactSchema = consoleSpy.getCalls()
    .some(c => c.args[0] === `[app_database] CREATE SCHEMA IF NOT EXISTS app_schema`);
  expect(sawExactSchema).to.equal(true);

  // Two app-DB connections (service + CDC) closed
  expect(serviceClientStub.end.callCount).to.be.at.least(2);

  // First log line sanity
  expect(consoleSpy.firstCall.args[0]).to.equal(
    `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
  );

  expect(result).to.deep.equal({
    message: `Database 'app_database' for username(s) 'myapp_user & cdc_user' is ready for use!`,
  });
});


  // 2) Defaults (CDC on) — single master connection + exact schema log
it('should provide default values for some configs (CDC on)', async () => {
  const { handler, mainClientStub, serviceClientStub, consoleSpy } = setUp({
    APP_DATABASE_NAME: undefined,
    APP_SCHEMA_NAME: undefined,
  });

  const result = await handler.handler();

  expect(mainClientStub.connect.callCount).to.equal(1);
  expect(mainClientStub.end.callCount).to.equal(1);

  const svcSql = serviceClientStub.query.getCalls().map(c => c.args[0]);
  expect(svcSql).to.include(`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA myapp_user CASCADE`);
  expect(svcSql).to.include(`CREATE EXTENSION IF NOT EXISTS intarray SCHEMA myapp_user CASCADE`);
  expect(svcSql).to.include(`GRANT CONNECT ON DATABASE myapp TO myapp_user`);
  expect(svcSql).to.include(`GRANT CREATE ON DATABASE myapp TO myapp_user`);
  expect(svcSql).to.include(`CREATE SCHEMA IF NOT EXISTS myapp_user`);
  expect(svcSql).to.include(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  expect(svcSql).to.include(`REVOKE ALL ON DATABASE myapp FROM PUBLIC`);
  expect(svcSql).to.include(`GRANT USAGE, CREATE ON SCHEMA myapp_user TO myapp_user`);
  expect(svcSql).to.include(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA myapp_user GRANT ALL PRIVILEGES ON TABLES TO myapp_user`,
  );
  expect(svcSql).to.include(`GRANT ALL PRIVILEGES on DATABASE myapp to myapp_user`);
  expect(svcSql).to.include(`ALTER DATABASE myapp OWNER TO myapp_user`);

  // CDC (defaults)
  expect(svcSql).to.include(`GRANT CONNECT ON DATABASE myapp TO cdc_user`);
  expect(svcSql).to.include(`GRANT SELECT ON ALL TABLES IN SCHEMA myapp_user TO cdc_user`);
  expect(svcSql).to.include(`CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`);

  // Kill string-literal mutant (defaults): exact log line
  const sawExactSchema = consoleSpy.getCalls()
    .some(c => c.args[0] === `[myapp] CREATE SCHEMA IF NOT EXISTS myapp_user`);
  expect(sawExactSchema).to.equal(true);

  expect(result).to.deep.equal({
    message: `Database 'myapp' for username(s) 'myapp_user & cdc_user' is ready for use!`,
  });
});


  // 3) CDC skip & error cases (keep or add if missing)
it('skips CDC when CDC_USER_SECRET env is not set', async () => {
  const { handler } = setUp({ CDC_USER_SECRET: undefined });
  const result = await handler.handler();
  expect(result).to.deep.equal({
    message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
  });
});

it('skips CDC when CDC secret SecretString is undefined', async () => {
  const ctx = setUp();
  secretsMock.on(GetSecretValueCommand, { SecretId: ctx.env.CDC_USER_SECRET })
    .resolves({ SecretString: undefined as any });
  const result = await ctx.handler.handler();
  expect(result).to.deep.equal({
    message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
  });
});

it('skips CDC when CDC secret SecretString is empty', async () => {
  const ctx = setUp();
  secretsMock.on(GetSecretValueCommand, { SecretId: ctx.env.CDC_USER_SECRET })
    .resolves({ SecretString: '' });
  const result = await ctx.handler.handler();
  expect(result).to.deep.equal({
    message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
  });
});

it('surfaces parse error when CDC secret contains invalid JSON', async () => {
  const ctx = setUp();
  secretsMock.on(GetSecretValueCommand, { SecretId: ctx.env.CDC_USER_SECRET })
    .resolves({ SecretString: '{invalid-json' });
  let msg = '';
  try { await ctx.handler.handler(); } catch (e) { msg = (e as Error).message; }
  expect(msg).to.match(/Unexpected token|Expected property name/);
});



  // 4) “Exists=true” killers (negate the CREATEs)
it('skips database creation when DB already exists', async () => {
  const { handler, mainClientStub } = setUp();
  mainClientStub.query = sinon.stub().callsFake((sql: string) => {
    if (sql.includes('pg_catalog.pg_database')) return { rows: [{ exists: true }] }; // DB exists
    if (sql.includes(`rolname='myapp_user'`))   return { rows: [{ exists: false }] };
    if (sql.includes(`rolname='cdc_user'`))     return { rows: [{ exists: false }] };
    return { rows: [{}] };
  });
  await handler.handler();
  const adminSql = mainClientStub.query.getCalls().map(c => c.args[0]);
  expect(adminSql.some(s => s.startsWith('CREATE DATABASE'))).to.equal(false);
});

it('skips app user creation when user already exists', async () => {
  const { handler, mainClientStub } = setUp();
  mainClientStub.query = sinon.stub().callsFake((sql: string) => {
    if (sql.includes('pg_catalog.pg_database')) return { rows: [{ exists: false }] };
    if (sql.includes(`rolname='myapp_user'`))   return { rows: [{ exists: true }] }; // user exists
    if (sql.includes(`rolname='cdc_user'`))     return { rows: [{ exists: false }] };
    return { rows: [{}] };
  });
  await handler.handler();
  const adminSql = mainClientStub.query.getCalls().map(c => c.args[0]);
  expect(adminSql.some(s => s.startsWith('CREATE USER myapp_user'))).to.equal(false);
});


  // 5) CDC user already exists → hit empty else {} (no create)
  it('skips CDC when CDC secret SecretString is empty', async () => {
    const ctx = setUp();
    secretsMock
      .on(GetSecretValueCommand, { SecretId: ctx.env.CDC_USER_SECRET })
      .resolves({ SecretString: '' });

    const result = await ctx.handler.handler();
    expect(result).to.deep.equal({
      message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
    });
  });

  // 6) Finally-block killers (admin + CDC)
it('closes admin connection in finally even if a query throws', async () => {
  const { handler, mainClientStub } = setUp();
  mainClientStub.query.onFirstCall().rejects(new Error('boom'));
  try { await handler.handler(); } catch {}
  expect(mainClientStub.end.called).to.equal(true);
});

it('closes CDC DB connection in finally even when a CDC grant fails', async () => {
  const { handler, serviceClientStub } = setUp();
  const original = serviceClientStub.query;
  serviceClientStub.query = sinon.stub().callsFake((sql: string) => {
    if (sql.includes('GRANT rds_replication')) throw new Error('grant-failed');
    return original.call(serviceClientStub, sql);
  });
  try { await handler.handler(); } catch {}
  expect(serviceClientStub.end.callCount).to.be.at.least(2);
});

// Kill if (!userExists) mutant (CDC user exists=true branch)
it('does not create CDC user when role already exists (kills !userExists mutant)', async () => {
  const { handler, mainClientStub } = setUp();

  // Simulate existing DB + app user, CDC user already exists
  mainClientStub.query = sinon.stub().callsFake((sql: string) => {
    if (sql.includes('FROM pg_catalog.pg_database'))
      return { rows: [{ exists: false }] };
    if (sql.includes(`rolname='myapp_user'`))
      return { rows: [{ exists: false }] };
    if (sql.includes(`rolname='cdc_user'`))
      return { rows: [{ exists: true }] }; // CDC already exists → skip CREATE
    return { rows: [{}] };
  });

  const result = await handler.handler();

  expect(result.message).to.equal(
    `Database 'app_database' for username(s) 'myapp_user & cdc_user' is ready for use!`,
  );

  const adminSql = mainClientStub.query.getCalls().map(c => c.args[0]);
  // Mutant changes if(!userExists) → if(true); this fails without these asserts
  expect(adminSql.some(s => s.startsWith('CREATE USER cdc_user'))).to.equal(false);
  expect(adminSql.some(s => s.startsWith('CREATE USER myapp_user'))).to.equal(true);
});

// Optional safety (covers finally path for CDC grants)
it('closes CDC DB connection in finally when CDC grant fails mid-way', async () => {
  const { handler, serviceClientStub } = setUp();

  const originalQuery = serviceClientStub.query;
  serviceClientStub.query = sinon.stub().callsFake((sql: string) => {
    if (sql.includes('GRANT rds_replication')) throw new Error('grant-fail');
    return originalQuery.call(serviceClientStub, sql);
  });

  try { await handler.handler(); } catch {}
  expect(serviceClientStub.end.callCount).to.be.at.least(2);
});


});
