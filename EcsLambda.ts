import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { _ } from '@securustablets/libraries.utils';
import { bool, json } from 'envalid';
import { EcsCluster } from './EcsCluster';
import { EcsTask } from './EcsTask';
import { Global, GlobalEnv } from './Global';
import { LambdaSource } from './LambdaSource';
import { Network } from './Network';
import { name as makeName, tags } from './ResourceBuilder';
import { TpComponentResource } from './TpComponentResource';
import { Validators } from './Validators';

export interface EcsLambdaArgs {
  /**
   * Override the source code for the lambda. It is unlikely you will want to do this.
   */
  source?: LambdaSource;
  /**
   * Provide the ecsCluster which contains the taskDefinition you would like to launch.
   */
  cluster: EcsCluster;
  /**
   * Provide the taskDefinition you would like to launch.
   */
  taskDefinition: EcsTask;
}

export interface EcsLambdaEnv extends Pick<GlobalEnv, 'ARTIFACT_BUCKET'> {
  ECS_LAMBDA_ENABLE_URL: boolean;
  ECS_LAMBDA_ENABLE_CORS: boolean;
  ECS_LAMBDA_CORS_ALLOW_ORIGINS: string[];
  ECS_LAMBDA_CORS_ALLOW_HEADERS: string[] | undefined;
  ECS_LAMBDA_CORS_EXPOSE_HEADERS: string[] | undefined;
  ECS_LAMBDA_CORS_ALLOW_METHODS: string[] | undefined;
  ECS_LAMBDA_CORS_ALLOW_CREDENTIALS: boolean;
}

/**
 * Creates a lambda which triggers an EcsTask you provide.
 */
export class EcsLambda extends TpComponentResource<
  EcsLambdaArgs,
  EcsLambdaEnv
> {
  public lambda: aws.lambda.Function;
  private source: LambdaSource;
  private lambdaSecurityGroup: aws.ec2.SecurityGroup;
  private privateNetwork = Network.getPrivateNetwork();
  private functionUrl: aws.lambda.FunctionUrl;

  constructor(
    name: string,
    args: EcsLambdaArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super('tp:EcsLambda:EcsLambda', name, args, opts);
    this.source = args.source || {
      s3Bucket: this.config.lookup('ARTIFACT_BUCKET'),
      s3Key: 'lambdas-to-go/2.1.0.zip',
      handler: 'launch-task.handler',
      runtime: 'nodejs20.x',
    };
    this.buildSecurityGroup();
    this.buildLambda();
    if (this.config.lookup('ECS_LAMBDA_ENABLE_URL')) {
      this.buildLambdaUrl();
    }
  }

  private buildSecurityGroup() {
    this.lambdaSecurityGroup = new aws.ec2.SecurityGroup(
      makeName(`${this.shortName}-ecslambda-sg`),
      {
        vpcId: Network.getVpc(),
        egress: [
          {
            protocol: '-1',
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ['0.0.0.0/0'],
            ipv6CidrBlocks: ['::/0'],
          },
        ],
        tags: tags(),
      },
      { parent: this },
    );
  }

  private buildLambda() {
    const EcsLambdaRole = this.buildLambdaRole(
      makeName(`${this.shortName}-ecslambda-role`),
      [
        {
          name: 'EcsRunTask',
          policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Action: [
                  'ecs:List*',
                  'ecs:Describe*',
                  'ecs:RunTask',
                  'iam:PassRole',
                ],
                Resource: '*',
                Effect: 'Allow',
              },
            ],
          }),
        },
      ],
      {
        parent: this,
      },
    );

    this.lambda = new aws.lambda.Function(
      makeName(`${this.shortName}-ecslambda`),
      {
        ...this.source,
        role: EcsLambdaRole.arn,
        timeout: 600,
        vpcConfig: {
          subnetIds: this.privateNetwork.getSubnetIds(),
          securityGroupIds: [this.lambdaSecurityGroup.id],
        },
        environment: {
          variables: {
            CLUSTER_NAME: this.args.cluster.cluster.name,
            TASK_DEFINITION_NAME:
              this.args.taskDefinition.taskDefinition.taskDefinition.family,
            CONTAINER_NAME: this.args.taskDefinition.containerName,
            TASK_SUBNETS: this.privateNetwork
              .getSubnetIds()
              .apply((subnetIds) => subnetIds.join(',')),
            TASK_SECURITY_GROUP: this.lambdaSecurityGroup.id,
          },
        },
        tags: tags(),
      },
      {
        parent: this,
      },
    );
  }

  private buildLambdaRole(
    name: string,
    inlinePolicies: pulumi.Input<aws.types.input.iam.RoleInlinePolicy>[],
    opts?: pulumi.ResourceOptions,
  ) {
    return new aws.iam.Role(
      name,
      {
        assumeRolePolicy: {
          Statement: [
            {
              Effect: 'Allow',
              Action: 'sts:AssumeRole',
              Principal: {
                Service: 'lambda.amazonaws.com',
              },
            },
          ],
          Version: '2012-10-17',
        },
        inlinePolicies: [
          {
            name: 'AWSLambdaBasicExecutionRole',
            policy: JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: [
                    'logs:CreateLogGroup',
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                  ],
                  Resource: '*',
                },
              ],
            }),
          },
          {
            name: 'AWSLambdaVPCAccessExecutionRole',
            policy: JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: [
                    'logs:CreateLogGroup',
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                    'ec2:CreateNetworkInterface',
                    'ec2:DescribeNetworkInterfaces',
                    'ec2:DeleteNetworkInterface',
                    'ec2:AssignPrivateIpAddresses',
                    'ec2:UnassignPrivateIpAddresses',
                  ],
                  Resource: '*',
                },
              ],
            }),
          },
          ...inlinePolicies,
        ],
        tags: tags(),
      },
      opts,
    );
  }

  private buildLambdaUrl() {
    let cors: aws.types.input.lambda.FunctionUrlCors | undefined;
    if (this.config.lookup('ECS_LAMBDA_ENABLE_CORS')) {
      cors = {
        allowCredentials: this.config.lookup(
          'ECS_LAMBDA_CORS_ALLOW_CREDENTIALS',
        ),
        allowHeaders: this.config.lookup('ECS_LAMBDA_CORS_ALLOW_HEADERS'),
        allowMethods: this.config.lookup('ECS_LAMBDA_CORS_ALLOW_METHODS'),
        allowOrigins: this.config.lookup('ECS_LAMBDA_CORS_ALLOW_ORIGINS'),
        exposeHeaders: this.config.lookup('ECS_LAMBDA_CORS_EXPOSE_HEADERS'),
      };
    }
    this.functionUrl = new aws.lambda.FunctionUrl(
      makeName(`${this.shortName}-ecslambda-url`),
      {
        authorizationType: 'NONE',
        functionName: this.lambda.arn,
        cors,
      },
      { parent: this },
    );
  }

  static envValidators(name: string): Validators<EcsLambdaEnv> {
    return {
      ..._.pick(Global.envValidators(), ['ARTIFACT_BUCKET']),
      ...Validators.makeLocal(name, {
        ECS_LAMBDA_ENABLE_URL: bool({
          default: false,
          desc: 'Specifies whether to enable a public URL for triggering the lambda.',
        }),
        ECS_LAMBDA_ENABLE_CORS: bool({
          default: false,
          desc: 'Specifies whether to enable CORS rules on the function URL. This has no affect if ECS_LAMBDA_ENABLE_URL is false.',
        }),
        ECS_LAMBDA_CORS_ALLOW_ORIGINS: json({
          default: ['*'],
          desc: 'Specifies the origins allowed to call the function URL. This has no affect if ECS_LAMBDA_ENABLE_URL or ECS_LAMBDA_ENABLE_CORS is false.',
        }),
        ECS_LAMBDA_CORS_EXPOSE_HEADERS: json({
          default: undefined,
          desc: 'Choose the HTTP headers in your function response that you want to expose to origins that call your function URL. This has no affect if ECS_LAMBDA_ENABLE_URL or ECS_LAMBDA_ENABLE_CORS is false.',
        }),
        ECS_LAMBDA_CORS_ALLOW_HEADERS: json({
          default: undefined,
          desc: 'Choose the HTTP headers that origins can include in requests to your function URL. This has no affect if ECS_LAMBDA_ENABLE_URL or ECS_LAMBDA_ENABLE_CORS is false.',
        }),
        ECS_LAMBDA_CORS_ALLOW_METHODS: json({
          default: undefined,
          desc: 'Choose the HTTP methods that are allowed when calling your function URL. This has no affect if ECS_LAMBDA_ENABLE_URL or ECS_LAMBDA_ENABLE_CORS is false.',
        }),
        ECS_LAMBDA_CORS_ALLOW_CREDENTIALS: bool({
          default: false,
          desc: 'Choose whether you want to allow cookies or other credentials in requests to your function URL. This has no affect if ECS_LAMBDA_ENABLE_URL or ECS_LAMBDA_ENABLE_CORS is false.',
        }),
      }),
    };
  }
}
