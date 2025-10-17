
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

  // Updated setUp function to include CDC_USER_SECRET for testing
  function setUp(envOverrides = {}) {
    const env = {
      MASTER_USER_SECRET: 'master-test',
      APP_USER_SECRET: 'app-test',
      APP_DATABASE_NAME: 'app_database',
      APP_SCHEMA_NAME: 'app_schema',
      RDS_HOST: 'example',
      CDC_USER_SECRET: 'cdc-test', // Include default for CDC user secret
      ...envOverrides,
    };

    // The logic in bootstrap.ts derives defaults from serviceSecret.username
    const serviceSecretUsername = 'myapp_user';
    const appDatabase = env.APP_DATABASE_NAME ?? serviceSecretUsername.replace('_user', '');
    const appSchema = env.APP_SCHEMA_NAME ?? serviceSecretUsername;

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
        username: serviceSecretUsername,
        password: 'myapp_password',
      }),
    });
    
    // Mock the CDC user secret retrieval
    if (env.CDC_USER_SECRET) {
      secretsMock.on(GetSecretValueCommand, { SecretId: 'cdc-test' }).resolves({
        SecretString: JSON.stringify({
          username: 'cdc_user',
          password: 'cdc_password',
        }),
      });
    }

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
    const cdcClientStub = { // Stub for the new CDC connection
      database: appDatabase,
      connect: sinon.stub().returnsThis(),
      end: sinon.stub().resolves(),
      query: sinon.stub().resolves({ rows: [{}] }),
    };

    const pgStub = sinon
      .stub()
      .callsFake((options) => {
        if (options.database === appDatabase && options.user === serviceSecretUsername) {
            // This case might not happen based on bootstrap.ts, but keeping for clarity
            return serviceClientStub; 
        }
        if (options.database === appDatabase) {
            // The connection to the service DB is made with 'admin_user'
            return serviceClientStub; 
        }
        if (options.database && options.database !== 'postgres') {
            // The CDC connection is also to the app database with 'admin_user'
            return cdcClientStub; 
        }
        return mainClientStub;
      });

    // The bootstrap.ts file requires these to be defined for cleanEnv to work properly
    // This part is a slight deviation but necessary for proxyquire and envalid usage
    const handler = proxyquire('../../src/bootstrap', {
      pg: { Client: pgStub },
      envalid: { 
        cleanEnv: () => env,
        validators: () => ({
            MASTER_USER_SECRET: {},
            APP_USER_SECRET: {},
            RDS_HOST: {},
            APP_DATABASE_NAME: { default: undefined },
            APP_SCHEMA_NAME: { default: undefined },
            CDC_USER_SECRET: { default: undefined },
        }) 
      },
    });

    const consoleSpy = sinon.spy(console, 'log');

    return {
      handler,
      pgStub,
      mainClientStub,
      serviceClientStub,
      cdcClientStub, // return the new stub
      consoleSpy,
      appDatabase,
      appSchema,
      serviceSecretUsername,
      serviceSecretPassword: 'myapp_password',
      cdcUsername: 'cdc_user',
    };
  }

  describe('handler', () => {
    it('should complete happy path with all users and explicit configs', async () => {
      const { 
        handler, 
        pgStub, 
        mainClientStub, 
        serviceClientStub, 
        cdcClientStub, 
        consoleSpy, 
        appDatabase, 
        appSchema, 
        serviceSecretUsername, 
        serviceSecretPassword,
        cdcUsername,
      } = setUp({
        APP_DATABASE_NAME: 'test_db',
        APP_SCHEMA_NAME: 'test_schema',
      });
      
      const expectedDatabase = 'test_db';
      const expectedSchema = 'test_schema';

      const result = await handler.handler();
      
      // The serviceSecret.username in setUp is 'myapp_user'
      // The cdcUserSecret.username is 'cdc_user'

      // Verification of main connection details (to master DB)
      expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });
      // Verification of service connection details (to app DB with admin user)
      expect(pgStub.secondCall.args[0]).to.deep.equal({
        database: expectedDatabase,
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });
      // Verification of CDC connection details (to app DB with admin user)
      expect(pgStub.thirdCall.args[0]).to.deep.equal({
        database: expectedDatabase,
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // Verify statements against master DB
      expect(mainClientStub.connect.calledOnce).to.equal(true);
      expect(mainClientStub.query.getCall(0).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('${expectedDatabase}'))`,
      );
      expect(mainClientStub.query.getCall(1).args[0]).to.equal(
        `CREATE DATABASE ${expectedDatabase}`,
      );
      expect(mainClientStub.query.getCall(2).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='${serviceSecretUsername}')`,
      );
      expect(mainClientStub.query.getCall(3).args[0]).to.equal(
        `CREATE USER ${serviceSecretUsername} WITH ENCRYPTED PASSWORD '${serviceSecretPassword}'`,
      );
      expect(mainClientStub.query.getCall(4).args[0]).to.equal( // New: Check for CDC user
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='${cdcUsername}')`,
      );
      expect(mainClientStub.query.getCall(5).args[0]).to.equal( // New: Create CDC user
        `CREATE USER ${cdcUsername} WITH ENCRYPTED PASSWORD 'cdc_password'`,
      );
      expect(mainClientStub.end.calledOnce).to.equal(true);

      // Verify statements against service DB (by admin user)
      expect(serviceClientStub.connect.calledOnce).to.equal(true);
      expect(serviceClientStub.query.getCall(0).args[0]).to.equal(
        `CREATE SCHEMA IF NOT EXISTS ${expectedSchema}`,
      );
      expect(serviceClientStub.query.getCall(1).args[0]).to.equal(
        `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ${expectedSchema} CASCADE`,
      );
      expect(serviceClientStub.query.getCall(2).args[0]).to.equal(
        `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA ${expectedSchema} CASCADE`,
      );
      expect(serviceClientStub.query.getCall(3).args[0]).to.equal(
        `GRANT CONNECT ON DATABASE ${expectedDatabase} TO ${serviceSecretUsername}`,
      );
      expect(serviceClientStub.query.getCall(4).args[0]).to.equal(
        `GRANT CREATE ON DATABASE ${expectedDatabase} TO ${serviceSecretUsername}`,
      );
      expect(serviceClientStub.query.getCall(5).args[0]).to.equal(
        `CREATE SCHEMA IF NOT EXISTS ${expectedSchema}`,
      );
      expect(serviceClientStub.query.getCall(6).args[0]).to.equal(
        `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
      );
      expect(serviceClientStub.query.getCall(7).args[0]).to.equal(
        `REVOKE ALL ON DATABASE ${expectedDatabase} FROM PUBLIC`,
      );
      expect(serviceClientStub.query.getCall(8).args[0]).to.equal(
        `GRANT USAGE, CREATE ON SCHEMA ${expectedSchema} TO ${serviceSecretUsername}`,
      );
      expect(serviceClientStub.query.getCall(9).args[0]).to.equal(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${expectedSchema} GRANT ALL PRIVILEGES ON TABLES TO ${serviceSecretUsername}`,
      );
      expect(serviceClientStub.query.getCall(10).args[0]).to.equal(
        `GRANT ALL PRIVILEGES on DATABASE ${expectedDatabase} to ${serviceSecretUsername}`,
      );
      expect(serviceClientStub.query.getCall(11).args[0]).to.equal(
        `ALTER DATABASE ${expectedDatabase} OWNER TO ${serviceSecretUsername}`,
      );
      expect(serviceClientStub.end.calledOnce).to.equal(true);
      
      // Verify statements against CDC DB connection (by admin user)
      expect(cdcClientStub.connect.calledOnce).to.equal(true);
      expect(cdcClientStub.query.getCall(0).args[0]).to.equal(
        `GRANT CONNECT ON DATABASE ${expectedDatabase} TO ${cdcUsername}`,
      );
      expect(cdcClientStub.query.getCall(1).args[0]).to.equal(
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${expectedSchema} TO ${cdcUsername}`,
      );
      expect(cdcClientStub.query.getCall(2).args[0]).to.equal(
        `GRANT rds_replication, rds_superuser TO ${cdcUsername}`,
      );
      expect(cdcClientStub.query.getCall(3).args[0]).to.equal(
        `CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`,
      );
      expect(cdcClientStub.end.calledOnce).to.equal(true);

      // Verify logs. Total logs should be (6 master queries + 12 service queries + 4 cdc queries) = 22 queries + 4 Secret fetches = 26 logs in total.
      // Wait, console.log is only for 'query' calls. So it should be 6 + 12 + 4 = 22 queries.
      expect(consoleSpy.callCount).to.equal(22);

      // Verify lambda result.
      expect(result).to.deep.equal({
        message: `Database '${expectedDatabase}' for username '${serviceSecretUsername}' is ready for use!`,
      });
    });
    
    // Updated test for default values
    it('should provide default values for some configs and exclude CDC steps if secret is missing', async () => {
      const { handler, pgStub, mainClientStub, serviceClientStub, cdcClientStub, consoleSpy, serviceSecretUsername } =
        setUp({
          APP_DATABASE_NAME: undefined,
          APP_SCHEMA_NAME: undefined,
          CDC_USER_SECRET: undefined, // Test case where CDC is not configured
        });

      const expectedDatabase = serviceSecretUsername.replace('_user', ''); // 'myapp'
      const expectedSchema = serviceSecretUsername; // 'myapp_user'

      const result = await handler.handler();

      // Verification of main connection details
      expect(pgStub.firstCall.args[0]).to.deep.equal({
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });

      // Verification of service connection details
      expect(pgStub.secondCall.args[0]).to.deep.equal({
        database: expectedDatabase,
        user: 'admin_user',
        password: 'admin_password',
        host: 'example',
        port: 5432,
      });
      
      // Only two calls to pgStub: mainConn and serviceConn. No cdcDbConn.
      expect(pgStub.callCount).to.equal(2); 

      // Verify statements against master DB
      expect(mainClientStub.connect.calledOnce).to.equal(true);
      expect(mainClientStub.query.getCall(0).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('${expectedDatabase}'))`,
      );
      expect(mainClientStub.query.getCall(1).args[0]).to.equal(
        `CREATE DATABASE ${expectedDatabase}`,
      );
      expect(mainClientStub.query.getCall(2).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='${serviceSecretUsername}')`,
      );
      expect(mainClientStub.query.getCall(3).args[0]).to.equal(
        `CREATE USER ${serviceSecretUsername} WITH ENCRYPTED PASSWORD 'myapp_password'`,
      );
      // Only 4 queries on mainClientStub - no CDC user check/create
      expect(mainClientStub.query.callCount).to.equal(4);
      expect(mainClientStub.end.calledOnce).to.equal(true);

      // Verify statements against service DB
      expect(serviceClientStub.connect.calledOnce).to.equal(true);
      expect(serviceClientStub.query.getCall(0).args[0]).to.equal(
        `CREATE SCHEMA IF NOT EXISTS ${expectedSchema}`,
      );
      // ... (Rest of serviceClientStub queries remain the same but use defaults)
      expect(serviceClientStub.query.getCall(1).args[0]).to.equal(
        `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ${expectedSchema} CASCADE`,
      );
      expect(serviceClientStub.query.getCall(11).args[0]).to.equal(
        `ALTER DATABASE ${expectedDatabase} OWNER TO ${serviceSecretUsername}`,
      );
      expect(serviceClientStub.query.callCount).to.equal(12);
      expect(serviceClientStub.end.calledOnce).to.equal(true);
      
      // Verify CDC client was never connected or queried
      expect(cdcClientStub.connect.called).to.equal(false);
      expect(cdcClientStub.query.called).to.equal(false);
      
      // Logs check: 4 master queries + 12 service queries = 16
      expect(consoleSpy.firstCall.args[0]).to.equal(
        `[postgres] SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('${expectedDatabase}'))`,
      );
      expect(consoleSpy.callCount).to.equal(16);

      // Verify lambda result.
      expect(result).to.deep.equal({
        message: `Database '${expectedDatabase}' for username '${serviceSecretUsername}' is ready for use!`,
      });
    });
    
    // Updated test for existing database/user
    it('should handle database and all users already exist', async () => {
      const { handler, mainClientStub, serviceClientStub, cdcClientStub, serviceSecretUsername, cdcUsername } = setUp();

      // Set the stub's behavior so that "SELECT exist" statements return true,
      // which should cause the handler not to run "CREATE" statements.
      mainClientStub.query = sinon.stub().callsFake((statement) => {
        if (statement.includes('SELECT exists')) {
          return { rows: [{ exists: true }] };
        }
        return { rows: [{}] };
      });
      
      // All other stubs (serviceClientStub, cdcClientStub) are left to resolve with { rows: [{}] }
      // This means the service and CDC database grants will still run, as they are not conditional on 'exists' checks.

      await handler.handler();

      // Verify "EXISTS" statements execute but "CREATE" statements do not.
      expect(mainClientStub.query.getCall(0).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
      );
      expect(mainClientStub.query.getCall(1).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='${serviceSecretUsername}')`,
      );
      expect(mainClientStub.query.getCall(2).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='${cdcUsername}')`,
      );
      // Only 3 queries on mainClientStub: DB check, service user check, CDC user check.
      expect(mainClientStub.query.callCount).to.equal(3);
      
      // Service and CDC steps should still execute.
      expect(serviceClientStub.query.callCount).to.equal(12);
      expect(cdcClientStub.query.callCount).to.equal(4);
    });
    
    // New test case: Existing CDC user grants only
    it('should handle existing service user and non-existing CDC user', async () => {
      const { handler, mainClientStub, serviceClientStub, cdcClientStub, serviceSecretUsername, cdcUsername } = setUp();
      
      // Stub mainClient queries to simulate database and service user existing, but CDC user not existing
      mainClientStub.query = sinon.stub().callsFake((statement) => {
        if (statement.includes(`rolname='${serviceSecretUsername}'`)) {
          return { rows: [{ exists: true }] }; // Service user exists
        }
        if (statement.includes(`rolname='${cdcUsername}'`)) {
          return { rows: [{ exists: false }] }; // CDC user does not exist
        }
        if (statement.includes('pg_database')) {
          return { rows: [{ exists: true }] }; // Database exists
        }
        return { rows: [{}] };
      });
      
      await handler.handler();
      
      // Verify mainClient queries
      expect(mainClientStub.query.getCall(0).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('app_database'))`,
      ); // Check DB
      expect(mainClientStub.query.getCall(1).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='${serviceSecretUsername}')`,
      ); // Check service user
      expect(mainClientStub.query.getCall(2).args[0]).to.equal(
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='${cdcUsername}')`,
      ); // Check CDC user
      expect(mainClientStub.query.getCall(3).args[0]).to.equal(
        `CREATE USER ${cdcUsername} WITH ENCRYPTED PASSWORD 'cdc_password'`,
      ); // Create CDC user (since it didn't exist)
      expect(mainClientStub.query.callCount).to.equal(4);
      
      // Service and CDC grant steps should still execute.
      expect(serviceClientStub.query.callCount).to.equal(12);
      expect(cdcClientStub.query.callCount).to.equal(4);
    });
  });
});
