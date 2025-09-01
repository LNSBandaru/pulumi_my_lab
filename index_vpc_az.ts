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
    name: pulumi.Input<string>;
    cidrBlock?: string;
    azCount?: number;
    natPerAz?: boolean;
    tags?: Record<string, pulumi.Input<string>>
}

export class MyVpc extends pulumi.ComponentResource {

    public readonly vpc: aws.ec2.Vpc;
    public readonly igw: aws.ec2.InternetGateway;

    public readonly publicSubnets: aws.ec2.Subnet[] = [];
    public readonly privateSubnets: aws.ec2.Subnet[] = [];

    public readonly publicRouteTables: aws.ec2.RouteTable[] = [];
    public readonly privateRouteTables: aws.ec2.RouteTable[] = [];

    public readonly natEips: aws.ec2.Eip[] = [];
    public readonly natGws: aws.ec2.NatGateway[] = [];

    public readonly routeTableAssoc: aws.ec2.RouteTableAssociation;
    public readonly securityGroup: aws.ec2.SecurityGroup

    constructor(args: MyVpcArgs, opts?: pulumi.ComponentResourceOptions){
        super('custom:resource:MultiAzVpcComponent', `${args.name}-vpc`, {}, opts);

        const cidrBlock = args.cidrBlock ?? "10.0.0.0/16";
        const azCount = Math.max(2, Math.min(args.azCount ?? 2, 3)); // clamp 2..3
        const natPerAz = args.natPerAz ?? true;

        this.vpc = new aws.ec2.Vpc(`${args.name}-vpc`, {
            cidrBlock: args.cidrBlock,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            tags: { 
                Name: `${args.name}-vpc`, 
                ...args.tags,
            }
        }, { parent: this });

        this.igw = new aws.ec2.InternetGateway(`${args.name}-igw`, {
            vpcId: this.vpc.id,
            tags: {
                Name: `${args.name}-igw`,
                ...(args.tags ?? {})
            },
        }, { parent: this });

        // Get AZs

        const azNames = aws.getAvailabilityZonesOutput({ state: "available" }).names;

        //Helper to make simple /24s without awsx
        const pubCidr = (i: number) => `10.0.${i}.0/24`;
        const privCidr = (i: number) => `10.0.${100 + i}.0/24`;

        // Create per-AZ public subnets + RTs + default route to IGW
        for (let i = 0; i < azCount; i++) {
            const az = azNames.apply(z => z[i]);

            const pub = new aws.ec2.Subnet(`${args.name}-pub-${i}`, {
                vpcId: this.vpc.id,
                cidrBlock: pubCidr(i),
                mapPublicIpOnLaunch: true,
                availabilityZone: az,
                tags: {
                    Name: `${args.name}-pub-${i}`,
                    Tier: "public",
                    ...(args.tags || {})
                }
            }, 
            { parent: this });
            this.publicSubnets.push(pub);

            const rt = new aws.ec2.RouteTable(`${args.name}-pub-rt-${i}`, {
                vpcId: this.vpc.id,
                routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: this.igw.id }],
                tags: { Name: `${args.name}-pub-rt-${i}`, ...(args.tags ?? {}) },
            }, { parent: this })
            this.publicRouteTables.push(rt);

            new aws.ec2.RouteTableAssociation(`${args.name}-pub-rta-${i}`, {
                subnetId: pub.id,
                routeTableId: rt.id,
              }, { parent: this });
        }

        // NAT gateways (EIP per NAT)
        const natIndexes = natPerAz ? [...Array(azCount).keys()] : [0];
        for (const idx of natIndexes) {
          const eip = new aws.ec2.Eip(`${args.name}-nat-eip-${idx}`, {
            domain: "vpc",
            tags: { Name: `${args.name}-nat-eip-${idx}`, ...(args.tags ?? {}) },
          }, { parent: this });
          this.natEips.push(eip);
    
          const nat = new aws.ec2.NatGateway(`${args.name}-nat-${idx}`, {
            allocationId: eip.allocationId,
            subnetId: this.publicSubnets[idx].id,
            tags: { Name: `${args.name}-nat-${idx}`, ...(args.tags ?? {}) },
          }, { parent: this, dependsOn: [this.igw] });
          this.natGws.push(nat);
        }
    
        // Private subnets + RTs (default route to appropriate NAT)
        for (let i = 0; i < azCount; i++) {
          const az = azNames.apply(zs => zs[i]);
    
          const priv = new aws.ec2.Subnet(`${args.name}-priv-${i}`, {
            vpcId: this.vpc.id,
            cidrBlock: privCidr(i),
            mapPublicIpOnLaunch: false,
            availabilityZone: az,
            tags: { Name: `${args.name}-priv-${i}`, Tier: "private", ...(args.tags ?? {}) },
          }, { parent: this });
          this.privateSubnets.push(priv);
    
          const natIndex = natPerAz ? i : 0;
          const rt = new aws.ec2.RouteTable(`${args.name}-priv-rt-${i}`, {
            vpcId: this.vpc.id,
            routes: [{
              cidrBlock: "0.0.0.0/0",
              natGatewayId: this.natGws[natIndex].id,
            }],
            tags: { Name: `${args.name}-priv-rt-${i}`, ...(args.tags ?? {}) },
          }, { parent: this });
          this.privateRouteTables.push(rt);
    
          new aws.ec2.RouteTableAssociation(`${args.name}-priv-rta-${i}`, {
            subnetId: priv.id,
            routeTableId: rt.id,
          }, { parent: this });
        }

        // this.routeTable = new aws.ec2.RouteTable(`${args.name}-rt`, {
        //     vpcId: this.vpc.id,
        //     routes: [{ cidrBlock: args.cidrBlock, gatewayId: this.igw.id }],
        //     tags: {
        //         Name: `${args.name}-rt`,
        //         ...args.tags
        //     }
        // }, { parent: this });
        // this.routeTableAssoc = new aws.ec2.RouteTableAssociation(`${args.name}-rta`, {
        //     subnetId: this.subnet.id,
        //     routeTableId: this.routeTable.id
        // }, { parent: this });

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
        }, { parent: this });
        
        this.registerOutputs({
            vpcId: this.vpc.id,
            publicSubnetIds: this.publicSubnets.map(s => s.id),
            privateSubnetIds: this.privateSubnets.map(s => s.id),
            defaultSecurityGroupId: this.securityGroup.id,
            natGatewayIds: this.natGws.map(n => n.id),
        });

    }
}

export interface MyEc2InstanceArgs {
    name: pulumi.Input<string>;
    amiId: pulumi.Input<string>;
    subnetId: pulumi.Input<string>;
    sgIds: pulumi.Input<string>[];
    instanceType?: pulumi.Input<string>;
    keyName?: pulumi.Input<string>;
    userData?: pulumi.Input<string>;
    associateEip?: boolean;
    tags?: Record<string, pulumi.Input<string>>;
}

export class MyEc2Instance extends pulumi.ComponentResource {
    public readonly instance: aws.ec2.Instance;
    public readonly eip?: aws.ec2.Eip;
    public readonly eipAssoc?: aws.ec2.EipAssociation;

    constructor(args: MyEc2InstanceArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:resource:Ec2InstanceComponent", `${args.name}-ec2`, {}, opts);
        
        this.instance = new aws.ec2.Instance("MyEc2Instance", {
            ami: args.amiId,
            instanceType: args.instanceType,
            subnetId: args.subnetId,
            vpcSecurityGroupIds: args.sgIds,
            keyName: args.keyName,
            userData: args.userData,
            associatePublicIpAddress: true, // needed to bind EIP on public subnet
            ebsOptimized: true,
            disableApiTermination: false,
            monitoring: false,
            metadataOptions: { httpTokens: "required" },
            rootBlockDevice: {
                volumeSize: 16,
                volumeType: "gp3",
                deleteOnTermination: true,
                encrypted: true
            },
            tags: {
                Name: `${args.name}-ec2`,
                ...args.tags,
            },
        }, { parent: this });

        if (args.associateEip) {
            this.eip = new aws.ec2.Eip(`${args.name}-eip`, {
                domain: "vpc",
                tags: {
                    Name: `${args.name}-eip`, 
                    ...(args.tags ?? {})
                }
            }, { parent: this })

            this.eipAssoc = new aws.ec2.EipAssociation(`${args.name}-eip-assoc`, {
                allocationId: this.eip.allocationId,
                instanceId: this.instance.id
            }, { parent: this });
        }
        
        this.registerOutputs({
            instanceId: this.instance.id,
            publicIp: this.instance.publicIp,
            privateIp: this.instance.privateIp,
            eipAllocationId: this.eip?.allocationId
        })
    }
}

// Create VPC with AZ and NAT gateway config
const vpc = new MyVpc({
    name: "MyVpc",
    cidrBlock: "10.0.0.0/16",
    azCount: 2,
    natPerAz: true,
    tags: {
        Environment: 'dev',
        Project: 'MyEc2Instance'
    }
})

// Create PUBLIC EC2 with Elastic IP (static)
const ec2 = new MyEc2Instance({
    name: 'MyEc2Instance',
    amiId: 'ami-0779c82fbb81e731c',
    subnetId: vpc.publicSubnets[0].id,
    sgIds: [vpc.securityGroup.id],
    instanceType: 't2.micro',
    keyName: 'my-key',
    associateEip: true,
    tags: {
        Environment: 'dev',
        Project: 'MyEc2Instance'
    },
});

export const ec2Id = ec2.instance.id;
export const ec2PublicIp = vpc.publicSubnets.map(t => t.id);
export const ec2PrivateId = vpc.privateSubnets.map(t => t.id);
export const eip = ec2.eip?.publicIp;

console.log('EC2 Instance Details', { ec2 });
