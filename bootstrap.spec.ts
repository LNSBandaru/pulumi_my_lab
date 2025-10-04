import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { expect } from 'chai';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';

describe('Handler - Unit', () => {
  let secretsMock;
  before(() => {
    secretsMock = mockClient(SecretsManagerClient);
  });

  afterEach(() => {
    secretsMock.reset();
    sinon.restore();
  });

  function setUp(envOverrides = {}) {
    const env = {
      MASTER_USER_SECRET: 'master-test',
      APP_USER_SECRET: 'app-test',
      CDC_USER_SECRET: 'cdc-test',
      APP_DATABASE_NAME: 'app_database',
      APP_SCHEMA_NAME: 'app_schema',
      CDC_DATABASE_NAME: 'cdc_database',
      CDC_SCHEMA_NAME: 'cdc_schema',
      RDS_HOST: 'example',
      ...envOverrides,
    };

    const appDatabase = env.APP_DATABASE_NAME ?? 'myapp';
    const cdcDatabase = env.CDC_DATABASE_NAME ?? 'cdcapp';

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
    const cdcClientStub = {
      database: cdcDatabase,
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };
    const pgStub = sinon
      .stub()
      .callsFake((options) =>
        options.database === appDatabase 
      ? serviceClientStub : mainClientStub,
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
      cdcClientStub,
      consoleSpy,
    };
  }

  describe('handler', () => {
    it('should complete happy path', async () => {
      const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } =
        setUp();

      const result = await handler.handler();

      expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      expect(pgStub.secondCall.args[0]).to.deep.equal({
        database: 'app_database',
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // Verify statements against master DB
      expect(mainClientStub.connect.calledOnce).to.equal(true);
      expect(mainClientStub.query.getCall(0).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
      );
      expect(mainClientStub.query.getCall(1).args[0]).to.equal(
        `CREATE DATABASE app_database`,
      );
      expect(mainClientStub.query.getCall(2).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`,
      );
      expect(mainClientStub.query.getCall(3).args[0]).to.equal(
        `CREATE USER myapp_user WITH ENCRYPTED PASSWORD 'myapp_password'`,
      );
      expect(mainClientStub.end.calledOnce).to.equal(true);

      // Verify statements against service DB
      expect(serviceClientStub.connect.calledOnce).to.equal(true);
      expect(serviceClientStub.query.getCall(0).args[0]).to.equal(
        `CREATE SCHEMA IF NOT EXISTS app_schema`,
      );
      expect(serviceClientStub.query.getCall(1).args[0]).to.equal(
        `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA app_schema CASCADE`,
      );
      expect(serviceClientStub.query.getCall(2).args[0]).to.equal(
        `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA app_schema CASCADE`,
      );
      expect(serviceClientStub.query.getCall(3).args[0]).to.equal(
        `GRANT CONNECT ON DATABASE app_database TO myapp_user`,
      );
      expect(serviceClientStub.query.getCall(4).args[0]).to.equal(
        `GRANT CREATE ON DATABASE app_database TO myapp_user`,
      );
      expect(serviceClientStub.query.getCall(5).args[0]).to.equal(
        `CREATE SCHEMA IF NOT EXISTS app_schema`,
      );
      expect(serviceClientStub.query.getCall(6).args[0]).to.equal(
        `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
      );
      expect(serviceClientStub.query.getCall(7).args[0]).to.equal(
        `REVOKE ALL ON DATABASE app_database FROM PUBLIC`,
      );
      expect(serviceClientStub.query.getCall(8).args[0]).to.equal(
        `GRANT USAGE, CREATE ON SCHEMA app_schema TO myapp_user`,
      );
      expect(serviceClientStub.query.getCall(9).args[0]).to.equal(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA app_schema GRANT ALL PRIVILEGES ON TABLES TO myapp_user`,
      );
      expect(serviceClientStub.query.getCall(10).args[0]).to.equal(
        `GRANT ALL PRIVILEGES on DATABASE app_database to myapp_user`,
      );
      expect(serviceClientStub.query.getCall(11).args[0]).to.equal(
        `ALTER DATABASE app_database OWNER TO myapp_user`,
      );
      expect(serviceClientStub.end.calledOnce).to.equal(true);

      // Verify logs for each statement.
      expect(consoleSpy.firstCall.args[0]).to.equal(
        `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
      );

      expect(consoleSpy.callCount).to.equal(16);

      // Verify lambda result.
      expect(result).to.deep.equal({
        message: `Database 'app_database' for username 'myapp_user' is ready for use!`,
      });
    });
    it('should provide default values for some configs', async () => {
      const { handler, pgStub, mainClientStub, serviceClientStub, consoleSpy } =
        setUp({
          APP_DATABASE_NAME: undefined,
          APP_SCHEMA_NAME: undefined,
        });

      const result = await handler.handler();

      expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // Verify statements against master DB
      expect(mainClientStub.connect.calledOnce).to.equal(true);
      expect(mainClientStub.query.getCall(0).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('myapp'))`,
      );
      expect(mainClientStub.query.getCall(1).args[0]).to.equal(
        `CREATE DATABASE myapp`,
      );
      expect(mainClientStub.query.getCall(2).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`,
      );
      expect(mainClientStub.query.getCall(3).args[0]).to.equal(
        `CREATE USER myapp_user WITH ENCRYPTED PASSWORD 'myapp_password'`,
      );
      expect(mainClientStub.end.calledOnce).to.equal(true);

      // Verify statements against service DB
      expect(serviceClientStub.connect.calledOnce).to.equal(true);
      expect(serviceClientStub.query.getCall(0).args[0]).to.equal(
        `CREATE SCHEMA IF NOT EXISTS myapp_user`,
      );
      expect(serviceClientStub.query.getCall(1).args[0]).to.equal(
        `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA myapp_user CASCADE`,
      );
      expect(serviceClientStub.query.getCall(2).args[0]).to.equal(
        `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA myapp_user CASCADE`,
      );
      expect(serviceClientStub.query.getCall(3).args[0]).to.equal(
        `GRANT CONNECT ON DATABASE myapp TO myapp_user`,
      );
      expect(serviceClientStub.query.getCall(4).args[0]).to.equal(
        `GRANT CREATE ON DATABASE myapp TO myapp_user`,
      );
      expect(serviceClientStub.query.getCall(5).args[0]).to.equal(
        `CREATE SCHEMA IF NOT EXISTS myapp_user`,
      );
      expect(serviceClientStub.query.getCall(6).args[0]).to.equal(
        `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
      );
      expect(serviceClientStub.query.getCall(7).args[0]).to.equal(
        `REVOKE ALL ON DATABASE myapp FROM PUBLIC`,
      );
      expect(serviceClientStub.query.getCall(8).args[0]).to.equal(
        `GRANT USAGE, CREATE ON SCHEMA myapp_user TO myapp_user`,
      );
      expect(serviceClientStub.query.getCall(9).args[0]).to.equal(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA myapp_user GRANT ALL PRIVILEGES ON TABLES TO myapp_user`,
      );
      expect(serviceClientStub.query.getCall(10).args[0]).to.equal(
        `GRANT ALL PRIVILEGES on DATABASE myapp to myapp_user`,
      );
      expect(serviceClientStub.query.getCall(11).args[0]).to.equal(
        `ALTER DATABASE myapp OWNER TO myapp_user`,
      );
      expect(serviceClientStub.end.calledOnce).to.equal(true);

      // Verify logs for each statement.
      expect(consoleSpy.firstCall.args[0]).to.equal(
        `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('myapp'))`,
      );

      // Verify lambda result.
      expect(result).to.deep.equal({
        message: `Database 'myapp' for username 'myapp_user' is ready for use!`,
      });
      
      expect(consoleSpy.callCount).to.equal(16);

    });
    it('should handle database and user already exist', async () => {
      const { handler, mainClientStub } = setUp();

      // Set the stub's behavior so that "SELECT exist" statements return true,
      // which should cause the handler not to run "CREATE" statements.
      mainClientStub.query = sinon.stub().callsFake((statement) => {
        if (statement.includes('SELECT exists')) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [{}] };
      });

      await handler.handler();

      // Verify "EXISTS"" statements execute but "CREATE" statements do not.
      expect(mainClientStub.query.getCall(0).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
      );
      expect(mainClientStub.query.getCall(1).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='myapp_user')`,
      );
      expect(mainClientStub.query.callCount).to.equal(2);
    });
  });
});
