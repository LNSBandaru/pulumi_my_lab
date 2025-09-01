import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";


// const randomNum = Math.floor(Math.random() * 1000000); // 0–999999
// // Create an AWS resource (S3 Bucket)
// const bucket = new aws.s3.Bucket(`lakshmi-test-${randomNum}`);

// // Export the name of the bucket
// const bucketName = bucket.id;

// console.log("The Cucket Name", { bucketName });

export interface MyEc2InstanceArgs {
    name: pulumi.Input<string>;
    amiId: pulumi.Input<string>;
    vpcId: pulumi.Input<string>;
    subnetIds: pulumi.Input<string>;
    sgIds: pulumi.Input<string>;
    instanceType?: pulumi.Input<string>;
    keyName?: pulumi.Input<string>;
    tags?: { [key: string]: pulumi.Input<string> };
}

export class MyEc2Instance extends pulumi.ComponentResource {
    public readonly instance: aws.ec2.Instance;

    constructor(args: MyEc2InstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:resource:Ec2InstanceComponent", "MyEc2Instance", {}, opts);
        
        this.instance = new aws.ec2.Instance("MyEc2Instance", {
            ami: args.amiId,
            instanceType: args.instanceType,
            subnetId: args.subnetIds,
            vpcSecurityGroupIds: [args.sgIds],
            keyName: args.keyName,
            tags: {
                Name: `${args.name}`,
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
    amiId: 'ami-0779c82fbb81e731c',
    vpcId: 'vpc-07984328f95df8565',
    subnetIds: 'subnet-07d26bc30c1931ab3',
    sgIds: 'sg-042f8867e12af295c',
    instanceType: '',
    keyName: 'my-key',
    tags: {
        Environment: 'dev',
        Project: 'MyEc2Instance'
    },
});

console.log('EC2 Instance Details', { ec2 });
