import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { cleanEnv } from 'envalid';
import { Client } from 'pg';
import { validators } from './bootstrap-validators';

const env = cleanEnv(process.env, validators());

const secretClient = new SecretsManagerClient({});

export const handler = async () => {
  // Main credentials
  const mainSecret = JSON.parse(
    (
      await secretClient.send(
        new GetSecretValueCommand({
          SecretId: env.MASTER_USER_SECRET,
        }),
      )
    ).SecretString!,
  );

  // Service credentials
  const serviceSecret = JSON.parse(
    (
      await secretClient.send(
        new GetSecretValueCommand({
          SecretId: env.APP_USER_SECRET,
        }),
      )
    ).SecretString!,
  );

  // cdc credentials
  const cdcUserSecret = JSON.parse(
    (
      await secretClient.send(
        new GetSecretValueCommand({
          SecretId: env.CDC_USER_SECRET,
        }),
      )
    ).SecretString!,
  );

  let { username, password } = serviceSecret;
  let database =
    env.APP_DATABASE_NAME ?? serviceSecret.username.replace('_user', '');
  let schema = env.APP_SCHEMA_NAME ?? serviceSecret.username;

  const mainConn = new Client({
    user: mainSecret.username,
    password: mainSecret.password,
    host: env.RDS_HOST,
    port: 5432,
  });

  const serviceConn = new Client({
    database,
    user: mainSecret.username,
    password: mainSecret.password,
    host: env.RDS_HOST,
    port: 5432,
  });

  await mainConn.connect();
  try {
    const {
      rows: [{ exists: databaseExists }],
    } = await query(
      mainConn,
      `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('${database}'))`,
    );
    if (!databaseExists) {
      await query(mainConn, `CREATE DATABASE ${database}`);
    }

    const {
      rows: [{ exists: userExists }],
    } = await query(
      mainConn,
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='${username}')`,
    );
    if (!userExists) {
      await query(
        mainConn,
        `CREATE USER ${username} WITH ENCRYPTED PASSWORD '${password}'`,
      );
    }
  } finally {
    await mainConn.end();
  }

  await serviceConn.connect();
  try {
    await query(serviceConn, `CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await query(
      serviceConn,
      `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ${schema} CASCADE`,
    );
    await query(
      serviceConn,
      `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA ${schema} CASCADE`,
    );
    await query(
      serviceConn,
      `GRANT CONNECT ON DATABASE ${database} TO ${username}`,
    );
    await query(
      serviceConn,
      `GRANT CREATE ON DATABASE ${database} TO ${username}`,
    );
    await query(serviceConn, `CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await query(serviceConn, `REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await query(serviceConn, `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await query(
      serviceConn,
      `GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${username}`,
    );
    await query(
      serviceConn,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL PRIVILEGES ON TABLES TO ${username}`,
    );
    await query(
      serviceConn,
      `GRANT ALL PRIVILEGES on DATABASE ${database} to ${username}`,
    );
    await query(serviceConn, `ALTER DATABASE ${database} OWNER TO ${username}`);
  } finally {
    await serviceConn.end();
  }

  
  const cdcConn = new Client({
    database,
    user: cdcUserSecret.username,
    password: cdcUserSecret.password,
    host: env.RDS_HOST,
    port: 5432,
  });

  ({ username, password } = cdcUserSecret);
  database =
    env.APP_DATABASE_NAME ?? cdcUserSecret.username.replace('_user', '');
  schema = env.APP_SCHEMA_NAME ?? cdcUserSecret.username;
 
  await mainConn.connect();
  try {
    const {
      rows: [{ exists: databaseExists }],
    } = await query(
      mainConn,
      `SELECT exists(SELECT FROM pg_catalog.pg_database WHERE lower(datname) = lower('${database}'))`,
    );
    if (!databaseExists) {
      await query(mainConn, `CREATE DATABASE ${database}`);
    }

    const {
      rows: [{ exists: userExists }],
    } = await query(
      mainConn,
      `SELECT exists(SELECT FROM pg_roles WHERE rolname='${username}')`,
    );
    if (!userExists) {
      await query(
        mainConn,
        `CREATE USER ${username} WITH ENCRYPTED PASSWORD '${password}'`,
      );
    }
  } finally {
    await mainConn.end();
  }

  await cdcConn.connect();
  try {
    await query(cdcConn, `CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await query(
      cdcConn,
      `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ${schema} CASCADE`,
    );
    await query(
      cdcConn,
      `CREATE EXTENSION IF NOT EXISTS intarray SCHEMA ${schema} CASCADE`,
    );
    await query(
      cdcConn,
      `GRANT CONNECT ON DATABASE ${database} TO ${username}`,
    );
    await query(
      cdcConn,
      `GRANT CREATE ON DATABASE ${database} TO ${username}`,
    );
    await query(cdcConn, `CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await query(cdcConn, `REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await query(cdcConn, `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await query(
      cdcConn,
      `GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${username}`,
    );
    await query(
      cdcConn,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL PRIVILEGES ON TABLES TO ${username}`,
    );
    await query(
      cdcConn,
      `GRANT ALL PRIVILEGES on DATABASE ${database} to ${username}`,
    );
    await query(cdcConn, `ALTER DATABASE ${database} OWNER TO ${username}`);
    await query(cdcConn, `ALTER USER ${username} WITH REPLICATION`);
  } finally {
    await cdcConn.end();
  }

  return {
    message: `Database '${database}' for usernames '${cdcUserSecret.username} & ${serviceSecret.username}' &  is ready for use!`,
  };
};

function query(connection: Client, statement: string) {
  console.log(`[${connection.database}] ${statement}`);
  return connection.query(statement);
}
