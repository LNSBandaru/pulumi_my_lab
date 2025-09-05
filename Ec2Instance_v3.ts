import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { _ } from '@securustablets/libraries.utils';
import { bool, json } from 'envalid';
import { Global, GlobalEnv } from './Global';
import { name as makeName, tags } from './ResourceBuilder';
import { TpComponentResource } from './TpComponentResource';
import { Validators } from './Validators';

export type Ec2InstanceArgs = Record<string, never>;

export interface Ec2InstanceEnv extends Pick<GlobalEnv, 'DELETION_PROTECTION_ENABLED'> {
  EC2_INSTANCE_AMI_ID: string;
  EC2_INSTANCE_TYPE: string;
  EC2_INSTANCE_KEY_NAME: string;
  EC2_INSTANCE_SUBNET_ID: string;
  EC2_INSTANCE_VPC_ID: string;
//   EC2_INSTANCE_SECURITY_GROUP_IDS: string[];
  /* three stogare configurations
    / 1. RootBlockDevice
    / 2. ebsBlockDevices
  */
    // 1. Root Block Device Configruation
  EC2_INSTANCE_ROOT_BLOCK_DEVICE_NAME: string;
  EC2_INSTANCE_ROOT_BLOCK_SIZE: number;
  EC2_INSTANCE_ROOT_BLOCK_TYPE: string;

    // 1. EBS Block Device Configruation
  EC2_INSTANCE_EBS_BLOCK_DEVICE_NAME: string;
  EC2_INSTANCE_EBS_BLOCK_VOLUME_SIZE: number;
  EC2_INSTANCE_EBS_BLOCK_VOLUME_TYPE: string;
}

export class Ec2Instance extends TpComponentResource<
    Ec2InstanceArgs,
    Ec2InstanceEnv
> {
  public readonly instance: aws.ec2.Instance;
  private ec2SecurityGroup: aws.ec2.SecurityGroup;

  constructor(
    name: string, 
    args: Ec2InstanceArgs, 
    opts?: pulumi.ComponentResourceOptions
  ){
    super("tp:Ec2Instance:Ec2Instance", name, args, opts);
    this.ec2SecurityGroup =  new aws.ec2.SecurityGroup(
      makeName(`${name}-sg`), {
      vpcId: this.config.lookup('EC2_INSTANCE_VPC_ID'),
      description: "All trafic allow",
      ingress: [
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] }
      ],
      egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }
      ],
      tags: tags()
    }, { parent: this })

    this.instance = new aws.ec2.Instance(
      makeName(`${name}-ec2`), {
      ami: this.config.lookup('EC2_INSTANCE_AMI_ID'),
      instanceType: this.config.lookup('EC2_INSTANCE_TYPE'),
      keyName: this.config.lookup('EC2_INSTANCE_KEY_NAME'),
      subnetId: this.config.lookup('EC2_INSTANCE_SUBNET_ID'),
      // vpcSecurityGroupIds: this.config.lookup('EC2_INSTANCE_SECURITY_GROUP_IDS'),
      vpcSecurityGroupIds: [this.ec2SecurityGroup.id],
      associatePublicIpAddress: true,
      ebsOptimized: true,
      monitoring: false,

    rootBlockDevice: {
      deviceName: this.config.lookup('EC2_INSTANCE_ROOT_BLOCK_DEVICE_NAME') ?? "/dev/sda1",
      volumeSize: this.config.lookup('EC2_INSTANCE_ROOT_BLOCK_SIZE') ?? 20,
      volumeType: this.config.lookup('EC2_INSTANCE_ROOT_BLOCK_TYPE') ?? "gp3",
      deleteOnTermination: this.config.lookup('DELETION_PROTECTION_ENABLED') ?? true,
      encrypted: true,
      tags: tags()
    },
    // BBlock Device Mapping configured with two device configurations
    ebsBlockDevices: [{
      deviceName: this.config.lookup('EC2_INSTANCE_EBS_BLOCK_DEVICE_NAME') ?? "/dev/sdb",
      volumeSize: this.config.lookup('EC2_INSTANCE_EBS_BLOCK_VOLUME_SIZE') ?? 20,
      volumeType: this.config.lookup('EC2_INSTANCE_EBS_BLOCK_VOLUME_TYPE') ?? "gp3",
      deleteOnTermination: this.config.lookup('DELETION_PROTECTION_ENABLED') ?? true,
      encrypted: true,
      tags: tags(),
    }],
    tags: tags(),
    }, { parent: this }); 
  }

  static envValidators(name: string): Validators<Ec2InstanceEnv> {
    return {
      ..._.pick(Global.envValidators(), ['DELETION_PROTECTION_ENABLED']),
      ...Validators.makeLocal(name, {
        EC2_INSTANCE_AMI_ID: str({
          default: undefined,
          desc: 'The domain name or ip address of the tracing agent. If not provided, tracing will not be enabled',
        }),
      }),
    };
  }
}
