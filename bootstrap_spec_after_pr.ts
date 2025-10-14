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
    it('should complete happy path with CDC enabled', async () => {
      const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } = setUp();

      const result = await handler.handler();

      // First admin client
      expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // Admin reconnect for CDC path must also have full options
      const adminCalls = pgStub.getCalls().filter((c) => !('database' in (c.args[0] ?? {})));
      expect(adminCalls.length).to.be.at.least(2);
      expect(adminCalls[1].args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // App DB clients (service + CDC DB conn)
      const appDbCalls = pgStub.getCalls().filter((c) => c.args[0]?.database === 'app_database');
      expect(appDbCalls.length).to.be.greaterThan(0);
      expect(appDbCalls[0].args[0]).to.include({
        database: 'app_database',
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // Master queries (both admin cycles)
      expect(mainClientStub.connect.callCount).to.be.at.least(2);
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

      // CDC role ensure on admin connection
      expect(masterSql).to.include(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`,
      );
      expect(masterSql).to.include(
        `CREATE USER cdc_user WITH ENCRYPTED PASSWORD 'cdc_password'`,
      );
      expect(mainClientStub.end.callCount).to.be.at.least(2);

      // Service DB statements (order-agnostic presence)
      expect(serviceClientStub.connect.callCount).to.be.at.least(2);
      const svcSql = serviceClientStub.query.getCalls().map((c) => c.args[0]);

      // Matches your final bootstrap.ts ordering/content
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

      // CDC grants/publication on same DB — exact strings from your code
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

      // Ends called for both serviceConn and cdcDbConn
      expect(serviceClientStub.end.callCount).to.be.at.least(2);

      // Logs & result
      expect(consoleSpy.firstCall.args[0]).to.equal(
        `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
      );
      expect(consoleSpy.callCount).to.be.at.least(18);

      expect(result).to.deep.equal({
        message: `Database 'app_database' for username(s) 'myapp_user & cdc_user' is ready for use!`,
      });
    });

    it('should provide default values for some configs (no APP_* provided)', async () => {
      const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } = setUp({
        APP_DATABASE_NAME: undefined,
        APP_SCHEMA_NAME: undefined,
      });

      const result = await handler.handler();

      // Admin client init
      expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // Admin reconnect
      const adminCalls = pgStub.getCalls().filter((c) => !('database' in (c.args[0] ?? {})));
      expect(adminCalls.length).to.be.at.least(2);
      expect(adminCalls[1].args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // Default DB 'myapp'
      const defaultDbCalls = pgStub.getCalls().filter((c) => c.args[0]?.database === 'myapp');
      expect(defaultDbCalls.length).to.be.greaterThan(0);
      expect(defaultDbCalls[0].args[0]).to.include({
        database: 'myapp',
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // Master SQL
      expect(mainClientStub.connect.callCount).to.be.at.least(2);
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
      // CDC ensure
      expect(masterSql).to.include(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`,
      );
      expect(masterSql).to.include(
        `CREATE USER cdc_user WITH ENCRYPTED PASSWORD 'cdc_password'`,
      );
      expect(mainClientStub.end.callCount).to.be.at.least(2);

      // Service DB SQL (defaults)
      expect(serviceClientStub.connect.callCount).to.be.at.least(2);
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

      // CDC grants/publication on same DB — defaults
      expect(svcSql).to.include(`GRANT CONNECT ON DATABASE myapp TO cdc_user`);
      expect(svcSql).to.include(
        `GRANT SELECT ON ALL TABLES IN SCHEMA myapp_user TO cdc_user`,
      );
      expect(svcSql).to.include(`GRANT rds_replication, rds_superuser TO cdc_user`);
      expect(svcSql).to.include(
        `CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`,
      );

      expect(serviceClientStub.end.callCount).to.be.at.least(2);

      // Logs & message
      expect(consoleSpy.firstCall.args[0]).to.equal(
        `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('myapp'))`,
      );
      expect(consoleSpy.callCount).to.be.at.least(18);

      expect(result).to.deep.equal({
        message: `Database 'myapp' for username(s) 'myapp_user & cdc_user' is ready for use!`,
      });
    });

    it('should handle database and users already exist (skips CREATEs)', async () => {
      const { handler, mainClientStub } = setUp();

      // Make all "SELECT exists(...)" return true → CREATE statements skipped.
      mainClientStub.query = sinon.stub().callsFake((statement: string) => {
        if (statement.includes('SELECT exists')) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [{}] };
      });

      await handler.handler();

      expect(mainClientStub.query.getCall(0).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
      );
      expect(mainClientStub.query.getCall(1).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`,
      );
      expect(mainClientStub.query.getCall(2).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`,
      );
      // Only the three EXISTS checks executed on the admin connection path
      expect(mainClientStub.query.callCount).to.equal(3);
    });

    it('should skip CDC flow cleanly when CDC_USER_SECRET is not set', async () => {
      const { handler, serviceClientStub } = setUp({
        CDC_USER_SECRET: undefined, // CDC disabled
      });

      const result = await handler.handler();

      // Ensure no CDC-specific SQL is executed on service DB when CDC is disabled
      const svcSql = serviceClientStub.query.getCalls().map((c) => c.args[0]);
      expect(svcSql).to.not.include(`GRANT CONNECT ON DATABASE app_database TO cdc_user`);
      expect(svcSql.some((s) => s.includes('GRANT rds_replication'))).to.equal(false);
      expect(svcSql.some((s) => s.includes('CREATE PUBLICATION'))).to.equal(false);

      expect(result).to.deep.equal({
        message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
      });
    });
  });
});
