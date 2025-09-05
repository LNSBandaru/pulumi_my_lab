import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { _ } from '@securustablets/libraries.utils';
import { Global, GlobalEnv } from './Global';
import { TpComponentResource } from './TpComponentResource';
import { Network } from './Network';
import { name as makeName, tags } from './ResourceBuilder';
import { validators } from './Validators';

export interface Ec2VolumeSpec {
  deviceName: string; // e.g., "/dev/xvdb" (Nitro shows as /dev/nvme*)
  sizeGiB: number;
  type?: string;  // defaut gp3
  iops?: number;      // needed for io1/io2; optional for gp3
  throughput?: number; // gp3 only (MiB/s)
  encrypted?: boolean;  // default true (recommended)
  kmsKeyId?: string;  // optional CMK
  deleteOnTermination?: boolean;  // default true for data vols too
}

export interface Ec2Instance {
  amiId: string;
  instanceType: string;
  vpcId?: string;
  subnetId: string[];
  securityGroupIds: string;
  keyName?: string;
  userData?: string;
  associateEip?: boolean;

  /** Storage */
  rootVolume?: Omit<Ec2VolumeSpec, "deviceName"> & { sizeGib: number } //deviceName not required for root
  dataVolumes?: Ec2VolumeSpec[]; // Mapped as ebsBlockDevices
  instanceStoreDevices?: string[]; // e.g., ["dev/xvdc"] if supported
}

export interface Ec2InstanceEnv extends Pick<GlobalEnv, 'DELETION_PROTECTION_ENABLED'> {
  EC2_INSTANCE_SUBNET_ID: string;
  EC2_INSTANCE_SECURITY_GROUP_IDS: string[];
  EC2_INSTANCE_TYPE: string;
  EC2_INSTANCE_KEY_NAME: string;
  EC2_INSTANCE_AMI_ID: string;
  EC2_INSTANCE_USER_DATA: string;
  EC2_INSTANCE_ASSOCIATE_EIP: boolean;
  EC2_INSTANCE_ROOT_VOLUME: number;
  EC2_INSTANCE_DATA_VOLUME: number;

  // Storage
  // Root Volume
  EC2_INSTANCE_ROOT_VOLUME_SIZE: number;
  EC2_INSTANCE_ROOT_VOLUME_TYPE: string;
  EC2_INSTANCE_ROOT_VOLUME_IOPS: number;
  EC2_INSTNCE_ROOT_VOLUME_THROUGHPUT: number;
  EC2_INSTNCE_ROOT_VOLUME_KMS: string;
  EC2_INSTANCE_ROOT_VOLUME_THROUGHPUT: number;
  EC2_INSTANCE_ROOT_VOLUME_KMSKEY_ID: string;
  // Blocked Volume
}

export interface Ec2InstanceArgs {  
}

export class Ec2Instance extends TpComponentResource<
  Ec2InstanceArgs,
  Ec2InstanceEnv
> {
    public readonly instance: aws.ec2.Instance;
    public readonly eip?: aws.ec2.Eip;
    public readonly eipAssoc?: aws.ec2.EipAssociation;
    private privateNetwork = Network.getPrivateNetwork();
    private ec2SecurityGroup: aws.ec2.SecurityGroup;

    constructor(name: string, args: Ec2InstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:resource:Ec2InstanceComponent", name, args, opts);

        /** Default & Safe */
        const root = {
            sizeGiB: this.config.lookup('EC2_INSTANCE_ROOT_VOLUME_SIZE'),
            type:  this.config.lookup('EC2_INSTANCE_ROOT_VOLUME_TYPE') ?? 'gp3',
            iops: this.config.lookup('EC2_INSTANCE_ROOT_VOLUME_IOPS'), // args.rootVolume?.iops,
            throughput: this.config.lookup('EC2_INSTANCE_ROOT_VOLUME_THROUGHPUT'), //args.rootVolume?.throughput,
            encrypted: true,
            kmsKeyId: this.config.lookup('EC2_INSTANCE_ROOT_VOLUME_KMSKEY_ID'),
            deleteOnTermination: this.config.lookup('DELETION_PROTECTION_ENABLED'), // args.rootVolume?.deleteOnTermination ?? true,
            tags: tags(),
        }
        
        this.instance = new aws.ec2.Instance(`${name}-ec2`, {
            ami: this.config.lookup('EC2_INSTANCE_AMI_ID'),
            instanceType: this.config.lookup('EC2_INSTANCE_TYPE'),
            subnetId: this.config.lookup('EC2_INSTANCE_SUBNET_ID'),
            vpcSecurityGroupIds: this.config.lookup('EC2_INSTANCE_SECURITY_GROUP_IDS'),
            keyName: this.config.lookup('EC2_INSTANCE_KEY_NAME'),
            associatePublicIpAddress: true,
            ebsOptimized: true,
            monitoring: true,
            metadataOptions: { httpTokens: "required" },

            // Configure Storeage (maps to Console steps)
            rootBlockDevice: {
                volumeSize: this.config.lookup('EC2_INSTANCE_ROOT_VOLUME_SIZE'),
                volumeType: this.config.lookup('EC2_INSTANCE_ROOT_VOLUME_TYPE'),
                iops: this.config.lookup('EC2_INSTANCE_ROOT_VOLUME_IOPS'),
                throughput: this.config.lookup('EC2_INSTNCE_ROOT_VOLUME_THROUGHPUT'),
                encrypted: true,
                kmsKeyId: this.config.lookup('EC2_INSTNCE_ROOT_VOLUME_KMS'),
                deleteOnTermination: this.config.lookup('DELETION_PROTECTION_ENABLED'),
                tags: tags()
            },
            ebsBlockDevices: [{
                deviceName: this.config.lookup('EC2_INSTANCE_BLOCK_DEVICE_NAME'),    // e.g., "/dev/xvdb"
                volumeSize: this.config.lookup('EC2_INSTANCE_BLOCK_VOLUME_SIZE'), // v.sizeGiB,
                volumeType: this.config.lookup('EC2_INSTANCE_BLOCK_VOLUME_TYPE') ?? "gp3",
                iops: v.iops,
                throughput: v.throughput,
                encrypted: v.encrypted ?? true,
                kmsKeyId: v.kmsKeyId,
                deleteOnTermination: v.deleteOnTermination ?? true,
                tags: tags(),
            },{
                deviceName: v.deviceName,    // e.g., "/dev/xvdb"
                volumeSize: v.sizeGiB,
                volumeType: v.type ?? "gp3",
                iops: v.iops,
                throughput: v.throughput,
                encrypted: v.encrypted ?? true,
                kmsKeyId: v.kmsKeyId,
                deleteOnTermination: v.deleteOnTermination ?? true,
                tags: tags(),
              }
            ],
            ephemeralBlockDevices: (args.instanceStoreDevices ?? []).map(d => ({
                deviceName: d,
                virtualName: 'ephemeral0'
            })),

            tags: tags(),
        }, { parent: this });


    }

    private buildSecurityGroup() {
      this.ec2SecurityGroup = new aws.ec2.SecurityGroup(
        makeName(`${this.shortName}-ec2instance-sg`),
        {
          vpcId: Network.getVpc(),
          ingress: [
            {
              protocol: 'tcp',
              fromPort: 22,
              toPort: 22,
              cidrBlocks: ["0.0.0.0/0"], // for testing, whitelisting all traffic
              ipv6CidrBlocks: ['::/0']
            }
          ],
          egress: [
            {
              protocol: '-1',
              fromPort: 0,
              toPort: 0,
              cidrBlocks: ['0.0.0.0/0'],
              ipv6CidrBlocks: ['::/0'],
            },
          ],
          tags: tags()
        },
        { parent: this }
      );
    }
  }
