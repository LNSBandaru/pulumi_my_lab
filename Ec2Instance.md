# Ecs2Instance

[[_TOC_]]

## Summary

* Source Code: [/src/Ec2Instance.ts](/src/Ec2Instance.ts)

Creates a EC2 with AMI and Security Group. See the source code for supported arguments and environment variables.

## Created Resources

The `Ec2Instance` component creates the following resources:
* [Ec2Instance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html)
* [SecurityGroup](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html)
    * Defines the ingress and egress rules for the Ec2Instance
* [IAM Role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) and [IAM Policies](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies.html)

## Example Usage

The following minimal example shows how one might create `Ec2Instance` with all its dependencies:

```typescript
import * as pulumi from '@pulumi/pulumi';
import * as tp from '@securustablets/libraries.pulumi';
import { NodeConfig } from './NodeConfig';

const Ec2Instance = new tp.Ec2Instance(
  tp.name('my-ec2instance'),
  {}
);
```

## Documentation

In order for the environment variables to be included in the service `README.md` automatically via the `envdoc` tool, the following must be added under `generate.subheaders` of the `.envdoc.yml` file:

```yml
- name: Ec2Instance Configuration
  regex: '^EC2_INSTANCE_'
```
