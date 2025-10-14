import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { cleanEnv } from 'envalid';
import { Client } from 'pg';
import { validators } from './bootstrap-validators';

const env = cleanEnv(process.env, validators());

const secretClient = new SecretsManagerClient({});

function query(connection: Client, statement: string) {
  console.log(`[${connection.database}] ${statement}`);
  return connection.query(statement);
}

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

  let cdcUserSecret: { username: string; password: string } | undefined;
  // cdc credentials
  if (env.CDC_USER_SECRET) {
    const cdcRaw = (
      await secretClient.send(
        new GetSecretValueCommand({
          SecretId: env.CDC_USER_SECRET,
        }),
      )
    ).SecretString;

    if (cdcRaw) 
      cdcUserSecret = JSON.parse(cdcRaw);

  }

  const { username, password } = serviceSecret;
  const database =
    env.APP_DATABASE_NAME ?? serviceSecret.username.replace('_user', '');
  const schema = env.APP_SCHEMA_NAME ?? serviceSecret.username;

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

  // --- CDC user on the cdc existing app database ---
  if (cdcUserSecret) {
    const cdcUsername = cdcUserSecret.username;
    const cdcPassword = cdcUserSecret.password;

    // mainConn is already ended above; open a fresh main connection
    const adminConn = new Client({
      user: mainSecret.username,
      password: mainSecret.password,
      host: env.RDS_HOST,
      port: 5432,
    });
    await adminConn.connect();
    try {
      // Ensure CDC role exists (create/rotate password)
      const {
        rows: [{ exists: userExists }],
      } = await query(
        adminConn,
        `SELECT exists(SELECT FROM pg_roles WHERE rolname='${cdcUsername}')`,
      );
      if (!userExists) {
        await query(
          adminConn,
          `CREATE USER ${cdcUsername} WITH ENCRYPTED PASSWORD '${cdcPassword}'`,
        );
      } else {}
    } finally {
      await adminConn.end();
    }

    // Minimal DB-level grants for CDC user on the cdc DB
    const cdcDbConn = new Client({
      database,
      user: mainSecret.username,
      password: mainSecret.password,
      host: env.RDS_HOST,
      port: 5432,
    });

    await cdcDbConn.connect();
    try {
      await query(
        cdcDbConn,
        `GRANT CONNECT ON DATABASE ${database} TO ${cdcUsername}`,
      );
      await query(
        cdcDbConn,
        `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${cdcUsername}`,
      );

      // Grant RDS replication capability (Aurora/RDS-PostgreSQL)
      await query(
        cdcDbConn,
        `GRANT rds_replication, rds_superuser TO ${cdcUsername}`,
      );
      await query(
        cdcDbConn, 
        `CREATE PUBLICATION IF NOT EXISTS cdc_publication FOR ALL TABLES`,
      );
    } finally {
      await cdcDbConn.end();
    }

    const usrMsg = [serviceSecret.username, cdcUserSecret?.username]
      .filter(Boolean)
      .join(' & ');
    return {
      message: `Database '${database}' for username(s) '${usrMsg}' is ready for use!`,
    };
  } else {
    return {
      message: 'CDC_USER_SECRET not set; skipping CDC user/publication setup.',
    };
  }
};
