import { str } from 'envalid';

export function validators() {
  return {
    MASTER_USER_SECRET: str({
      desc:
        'Name of the secret which contains the administrator login credentials for the RDS cluster.<br/>' +
        'The value of the secret should be JSON-formatted string which contains properties `username` and `password`.',
    }),
    APP_USER_SECRET: str({
      desc:
        'Name of the secret which contains the application login credentials for the RDS cluster.<br/>' +
        'The value of the secret should be a JSON-formatted string which contains properties `username` and `password`.',
    }),
    CDC_USER_SECRET: str({
      desc:
        'Name of the secret which contains the application login credentials for the RDS cluster.<br/>' +
        'The value of the secret should be a JSON-formatted string which contains properties `username` and `password`.',
    }),
    APP_DATABASE_NAME: str({
      default: undefined,
      desc: "Name of the database which should be initialized for the application user. If not provided, it defaults to `username.replace('_user', '')` from `APP_USER_SECRET`",
    }),
    APP_SCHEMA_NAME: str({
      default: undefined,
      desc: 'Name of the postgres schema which should be initialized for the application user. If not provided, it defaults to `username` from `APP_USER_SECRET`',
    }),
    RDS_HOST: str({
      desc: 'RDS host to which the lambda should connect for bootstrapping',
    }),
  };
}
