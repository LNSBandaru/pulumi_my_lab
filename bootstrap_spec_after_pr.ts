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
      // legacy fields (not used by latest bootstrap, keep for compat)
      CDC_DATABASE_NAME: 'cdc_database',
      CDC_SCHEMA_NAME: 'cdc_schema',
      RDS_HOST: 'example',
      ...envOverrides,
    };

    const appDatabase = env.APP_DATABASE_NAME ?? 'myapp';

    // --- Secrets mocks
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

    secretsMock.on(GetSecretValueCommand, { SecretId: 'cdc-test' }).resolves({
      SecretString: JSON.stringify({
        username: 'cdc_user',
        password: 'cdc_password',
      }),
    });

    // --- pg client stubs
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
    const pgStub = sinon
      .stub()
      .callsFake((options: any) =>
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
    };
  }

  describe('handler', () => {
    it('should complete happy path', async () => {
      const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } =
        setUp();

      const result = await handler.handler();

      // --- First admin client (master)
      expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // --- Admin reconnect must also have full options (kills object-literal {} mutant)
      const adminCalls = pgStub
        .getCalls()
        .filter((c) => !('database' in (c.args[0] ?? {})));
      expect(
        adminCalls.length,
        'expected 2 admin clients (initial + CDC reconnect)',
      ).to.be.at.least(2);
      expect(adminCalls[1].args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // --- Find app DB client creations (order-agnostic: service + CDC same-DB)
      const appDbCalls = pgStub
        .getCalls()
        .filter((c) => c.args[0]?.database === 'app_database');
      expect(
        appDbCalls.length,
        'expected at least one pg.Client for app_database',
      ).to.be.greaterThan(0);
      expect(appDbCalls[0].args[0]).to.include({
        database: 'app_database',
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });
      if (appDbCalls.length > 1) {
        expect(appDbCalls[1].args[0]).to.include({
          database: 'app_database',
          user: 'admin_user',
          password: 'admin_password',
          host: 'example',
          port: 5432,
        });
      }

      // --- Master DB queries (both admin cycles)
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
      // CDC ensure
      expect(masterSql).to.include(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='cdc_user')`,
      );
      expect(masterSql).to.include(
        `CREATE USER cdc_user WITH ENCRYPTED PASSWORD 'cdc_password'`,
      );
      // Admin closed twice (kills finally-block mutant if removed)
      expect(mainClientStub.end.callCount).to.be.at.least(2);

      // --- Service DB statements (order-agnostic presence)
      expect(
        serviceClientStub.connect.callCount,
        'service + CDC same-DB connects',
      ).to.be.at.least(2);
      const svcSql = serviceClientStub.query.getCalls().map((c) => c.args[0]);

      const createSchemaCount = svcSql.filter(
        (s) => s === `CREATE SCHEMA IF NOT EXISTS app_schema`,
      ).length;
      expect(createSchemaCount).to.be.at.least(1);

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

      // CDC grants on same DB
      expect(svcSql).to.include(
        `GRANT CONNECT ON DATABASE app_database TO cdc_user`,
      );
      expect(svcSql).to.include(
        `GRANT SELECT ON ALL TABLES IN SCHEMA app_schema TO cdc_user`,
      );
      expect(svcSql).to.include(
        `GRANT rds_replication, rds_superuser TO cdc_user`,
      );
      expect(svcSql).to.include(`CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`);

      // Both app-DB connections closed (kills finally-block mutant if removed)
      expect(
        serviceClientStub.end.callCount,
        'service + CDC same-DB ends',
      ).to.be.at.least(2);

      // --- Logs & result
      expect(consoleSpy.firstCall.args[0]).to.equal(
        `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
      );
      expect(consoleSpy.callCount).to.be.at.least(19);

      expect(result).to.deep.equal({
        message: `Database 'app_database' for usernames for usernames 'cdc_user & myapp_user' is ready for use!`,
      });
    });

    it('should provide default values for some configs', async () => {
      const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } =
        setUp({
          APP_DATABASE_NAME: undefined,
          APP_SCHEMA_NAME: undefined,
        });

      const result = await handler.handler();

      // --- First admin client (master)
      expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // --- Admin reconnect must also have full options
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

      // --- Find default DB ('myapp') client creations (order-agnostic)
      const defaultDbCalls = pgStub
        .getCalls()
        .filter((c) => c.args[0]?.database === 'myapp');
      expect(defaultDbCalls.length).to.be.greaterThan(0);
      expect(defaultDbCalls[0].args[0]).to.include({
        database: 'myapp',
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });
      if (defaultDbCalls.length > 1) {
        expect(defaultDbCalls[1].args[0]).to.include({
          database: 'myapp',
          user: 'admin_user',
          password: 'admin_password',
          host: 'example',
          port: 5432,
        });
      }

      // --- Master DB ensures with defaults
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

      // --- Service DB statements (order-agnostic)
      expect(serviceClientStub.connect.callCount).to.be.at.least(2);
      const svcSql = serviceClientStub.query.getCalls().map((c) => c.args[0]);

      const createSchemaCount = svcSql.filter(
        (s) => s === `CREATE SCHEMA IF NOT EXISTS myapp_user`,
      ).length;
      expect(createSchemaCount).to.be.at.least(1);

      expect(svcSql).to.include(
        `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA myapp_user CASCADE`,
      );
      expect(svcSql).to.include(
        `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA myapp_user CASCADE`,
      );
      expect(svcSql).to.include(
        `GRANT CONNECT ON DATABASE myapp TO myapp_user`,
      );
      expect(svcSql).to.include(`GRANT CREATE ON DATABASE myapp TO myapp_user`);
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

      // CDC grants on same DB
      expect(svcSql).to.include(`GRANT CONNECT ON DATABASE myapp TO cdc_user`);
      expect(svcSql).to.include(
        `GRANT SELECT ON ALL TABLES IN SCHEMA myapp_user TO cdc_user`,
      );
      expect(svcSql).to.include(
        `GRANT rds_replication, rds_superuser TO cdc_user`,
      );
      expect(svcSql).to.include(`CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`);

      // Both app-DB connections closed (service + CDC)
      expect(serviceClientStub.end.callCount).to.be.at.least(2);

      // --- Logs & result
      expect(consoleSpy.firstCall.args[0]).to.equal(
        `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('myapp'))`,
      );
      expect(consoleSpy.callCount).to.be.at.least(18);

      expect(result).to.deep.equal({
        message: `Database 'myapp' for usernames for usernames 'cdc_user & myapp_user' is ready for use!`,
      });
    });

    it('should handle database and user already exist', async () => {
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

      // Only the three EXISTS checks should be invoked on master in this path
      expect(mainClientStub.query.callCount).to.equal(3);
    });
  });
});
