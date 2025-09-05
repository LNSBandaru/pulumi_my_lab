# EcsLambda

[[_TOC_]]

## Summary

* Source Code: [/src/EcsLambda.ts](/src/EcsLambda.ts)

Creates a lambda to trigger the provided ECS task in the provided cluster. See the source code for supported arguments and environment variables.

## Created Resources

The `EcsLambda` component creates the following resources:
* [Lambda](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)
    * The function used to trigger the provided `EcsTask` to start
* [SecurityGroup](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html)
    * Defines the ingress and egress rules for the lambda
* [IAM Role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) and [IAM Policies](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html)
    * Sets the permissions for the Lamdba, allowing it to launch the provided `EcsTask`
* [FunctionUrl](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)
    * Created only if `ECS_LAMBDA_ENABLE_URL` is set to `true`
    * Provides a public endpoint that can be called to trigger the lambda

## Example Usage

The following minimal example shows how one might create `EcsLambda` with all its dependencies:

```typescript
import * as pulumi from '@pulumi/pulumi';
import * as tp from '@securustablets/libraries.pulumi';
import { NodeConfig } from './NodeConfig';

const ecsCluster = new tp.EcsCluster(tp.name('my-cluster'));

const image = new tp.BundledContainerImage(
  tp.name('my-image'),
  {
    packageName: 'my-code'
  },
)

const task = new tp.EcsTask(
  tp.name('my-task'),
  {
    image,
    command: ['yarn', 'exec', 'node', 'dist/scripts/ingest-data.js']
  },
);

const lambda = new tp.EcsLambda(
  tp.name('my-lambda'),
  {
    cluster: ecsCluster,
    taskDefinition: task
  }
);
```

## Documentation

In order for the environment variables to be included in the service `README.md` automatically via the `envdoc` tool, the following must be added under `generate.subheaders` of the `.envdoc.yml` file:

```yml
- name: ECS Lambda Configuration
  regex: '^ECS_LAMBDA_'
```
