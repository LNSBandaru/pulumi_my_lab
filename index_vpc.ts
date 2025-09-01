import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { VpcArgs } from "@pulumi/aws/ec2";


// const randomNum = Math.floor(Math.random() * 1000000); // 0–999999
// // Create an AWS resource (S3 Bucket)
// const bucket = new aws.s3.Bucket(`lakshmi-test-${randomNum}`);

// // Export the name of the bucket
// const bucketName = bucket.id;

// console.log("The Cucket Name", { bucketName });

export interface MyVpcArgs {
    name: pulumi.Input<string>,
    cidrBlock?: string,
    tags?: {
        [key: string]: pulumi.Input<string>
    }
}

export class MyVpc extends pulumi.ComponentResource {

    public readonly vpc: aws.ec2.Vpc;
    public readonly subnet: aws.ec2.Subnet;
    public readonly igw: aws.ec2.InternetGateway;
    public readonly routeTable: aws.ec2.RouteTable;
    public readonly routeTableAssoc: aws.ec2.RouteTableAssociation;
    public readonly securityGroup: aws.ec2.SecurityGroup

    constructor(args: MyVpcArgs, opts?: pulumi.ComponentResourceOptions){
        super('custom:resource:VpcComponent', `${args.name}-vpc`, {}, opts);

        this.vpc = new aws.ec2.Vpc(`${args.name}-vpc`, {
            cidrBlock: args.cidrBlock,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            tags: { 
                Name: `${args.name}-vpc`, 
                ...args.tags,
            }
        }, { parent: this });
        this.subnet = new aws.ec2.Subnet(`${args.name}-subnet`, {
            vpcId: this.vpc.id,
            cidrBlock: args.cidrBlock,
            mapPublicIpOnLaunch: true,
            availabilityZone: 'ap-southeast-1',
            tags: {
                Name: `${args.name}-subnet`,
                ...args.tags
            }
        }, { parent: this });
        this.igw = new aws.ec2.InternetGateway(`${args.name}-igw`, {
            vpcId: this.vpc.id,
            tags: {
                Name: `${args.name}-igw`,
                ...args.tags
            }
        }, { parent: this });
        this.routeTable = new aws.ec2.RouteTable(`${args.name}-rt`, {
            vpcId: this.vpc.id,
            routes: [{ cidrBlock: args.cidrBlock, gatewayId: this.igw.id }],
            tags: {
                Name: `${args.name}-rt`,
                ...args.tags
            }
        }, { parent: this });
        this.routeTableAssoc = new aws.ec2.RouteTableAssociation(`${args.name}-rta`, {
            subnetId: this.subnet.id,
            routeTableId: this.routeTable.id
        }, { parent: this });
        this.securityGroup = new aws.ec2.SecurityGroup(`${args.name}-sg`, {
            vpcId: this.vpc.id,
            description: "All trafic allow",
            ingress: [
                { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] }
            ],
            egress: [
                { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }
            ],
            tags: {
                Name: `${args.name}-sg`,
                ...args.tags
            }
        }, { parent: this })
    }
}

export interface MyEc2InstanceArgs {
    name: pulumi.Input<string>;
    amiId: pulumi.Input<string>;
    subnetIds: pulumi.Input<string>;
    sgIds: pulumi.Input<string>;
    instanceType?: pulumi.Input<string>;
    keyName?: pulumi.Input<string>;
    tags?: { [key: string]: pulumi.Input<string> };
}

export class MyEc2Instance extends pulumi.ComponentResource {
    public readonly instance: aws.ec2.Instance;

    constructor(args: MyEc2InstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:resource:Ec2InstanceComponent", `${args.name}-ec2`, {}, opts);
        
        this.instance = new aws.ec2.Instance("MyEc2Instance", {
            ami: args.amiId,
            instanceType: args.instanceType,
            subnetId: args.subnetIds,
            vpcSecurityGroupIds: [args.sgIds],
            keyName: args.keyName,
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

// Create VPC
const vpc = new MyVpc({
    name: "MyVpc",
    cidrBlock: "10.0.0.0/16",
    tags: {
        Environment: 'dev'
    }
})

// Create EC2 
const ec2 = new MyEc2Instance({
    name: 'MyEc2Instance',
    amiId: 'ami-0779c82fbb81e731c',
    subnetIds: vpc.subnet.id,
    sgIds: vpc.securityGroup.id,
    instanceType: 't2.micro',
    keyName: 'my-key',
    tags: {
        Environment: 'dev',
        Project: 'MyEc2Instance'
    },
});

export const ec2Id = ec2.instance.id;
export const ec2PublicIp = ec2.instance.publicIp;

console.log('EC2 Instance Details', { ec2 });
