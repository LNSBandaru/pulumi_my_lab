import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

type VolumeType =  "gp3"|"gp2"|"io2"|"io1"|"st1"|"sc1"|"standard";

export interface MyEc2InstanceVolumeSpec {
    deviceName: string;
    sizeGiB: number;
    type?: VolumeType | "gp3";  // default is gp3
    iops?: number;
    throughput?: number;
    encrypted?: boolean | true;
    kmsKeyId?: pulumi.Input<string>;
    deleteOnTermination?: boolean | true;
    tags?: Record<string, pulumi.Input<string>>;
}

export interface MyEc2InstanceArgs {
    name: pulumi.Input<string>;
    vpcId?: pulumi.Input<string>;
    subnetIds: pulumi.Input<string>;
    sgIds: pulumi.Input<string>[];
    instanceType?: pulumi.Input<string>;
    keyName?: pulumi.Input<string>;
    amiId?: pulumi.Input<string>;
    userData?: pulumi.Input<string>;
    associateEip?: boolean;

    /** STORAGE */
    rootVolume?: Omit<MyEc2InstanceVolumeSpec, "deviceName"> & { sizeGiB?: number }; // device name not required for root
    dataVolumes?: MyEc2InstanceVolumeSpec[];    // mapped as ebsBlockDevices
    instanceStoreDevices?: string[];    // e.g., ["/dev/xvdc"] If supported

    tags?: { [key: string]: pulumi.Input<string> };
}

export class MyEc2Instance extends pulumi.ComponentResource {
    public readonly instance: aws.ec2.Instance;
    public readonly eip?: aws.ec2.Eip;
    public readonly eipAssoc?: aws.ec2.EipAssociation;


    constructor(args: MyEc2InstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:resource:Ec2InstanceComponent", "MyEc2Instance", {}, opts);

        /** Default & Safe */
        const root = {
            sizeGiB: args.rootVolume?.sizeGiB ?? 30,
            type: args.rootVolume?.type ?? "gp3",
            iops: args.rootVolume?.iops,
            throughput: args.rootVolume?.throughput,
            encrypted: args.rootVolume?.encrypted ?? true,
            kmsKeyId: args.rootVolume?.kmsKeyId,
            deleteOnTermination: args.rootVolume?.deleteOnTermination ?? true,
            tags: args.rootVolume?.tags,
        }
        
        this.instance = new aws.ec2.Instance("MyEc2Instance", {
            ami: args.amiId,
            instanceType: args.instanceType ?? "t3.micro",
            subnetId: args.subnetIds,
            vpcSecurityGroupIds: args.sgIds,
            keyName: args.keyName,
            userData: args.userData,
            associatePublicIpAddress: true,
            ebsOptimized: true,
            monitoring: true,
            metadataOptions: { httpTokens: "required" },

            // Configure Storeage (maps to Console steps)
            rootBlockDevice: {
                volumeSize: root.sizeGiB,
                volumeType: root.type,
                iops: root.iops,
                throughput: root.throughput,
                encrypted: root.encrypted,
                kmsKeyId: root.kmsKeyId,
                deleteOnTermination: root.deleteOnTermination,
                tags: root.tags
            },
            ebsBlockDevices: (args.dataVolumes ?? []).map(v => ({
                deviceName: v.deviceName,    // e.g., "/dev/xvdb"
                volumeSize: v.sizeGiB,
                volumeType: v.type ?? "gp3",
                iops: v.iops,
                throughput: v.throughput,
                encrypted: v.encrypted ?? true,
                kmsKeyId: v.kmsKeyId,
                deleteOnTermination: v.deleteOnTermination ?? true,
                tags: v.tags,
            })),
            ephemeralBlockDevices: (args.instanceStoreDevices ?? []).map(d => ({
                deviceName: d,
                virtualName: 'ephemeral0'
            })),

            tags: {
                Name: `${args.name}-ec2`,
                ...args.tags,
            },
        }, { parent: this });


        this.registerOutputs({
            instanceId: this.instance.id,
            publicIp: this.instance.publicIp,
            privateIp: this.instance.privateIp
        })
    }
}

const ec2 = new MyEc2Instance({
    name: 'MyEc2Instance',
    vpcId: 'vpc-07984328f95df8565',
    subnetIds: 'subnet-07d26bc30c1931ab3',
    sgIds: ['sg-042f8867e12af295c'],
    keyName: 'my-key',
    amiId: "ami-0779c82fbb81e731c",
    instanceType: "t3.micro",
    // Root: gp3 50GiB with tuned perf
    rootVolume: {
        sizeGiB: 50,
        type: "gp3",
        iops: 3000,
        throughput: 125,
        encrypted: true,
        deleteOnTermination: true
    },

    dataVolumes: [
        {
            deviceName: "/dev/xvdb",
            sizeGiB: 100,
            type: "gp3",
            iops: 6000,
            throughput: 250,
            encrypted: true,
            deleteOnTermination: true,
            tags: { Purpose: "apps" },
        },    
        {
            deviceName: "/dev/xvdc",
            sizeGiB: 500,
            type: "io2",
            iops: 12000,       // io2 requires IOPS
            encrypted: true,
            deleteOnTermination: true,
            tags: { Purpose: "db" },
        }
    ],
    associateEip: false,
    tags: {
        Environment: 'dev',
        Project: 'MyEc2Instance',
        Role: "api"
    },
});

console.log('EC2 Instance Details', { ec2 });
