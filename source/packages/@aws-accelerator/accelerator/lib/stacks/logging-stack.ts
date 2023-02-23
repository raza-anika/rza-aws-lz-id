/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { pascalCase } from 'pascal-case';
import path from 'path';

import { SnsTopicConfig, VpcFlowLogsConfig, CloudWatchLogsExclusionConfig } from '@aws-accelerator/config';
import * as t from '@aws-accelerator/config/lib/common-types/types';
import {
  Bucket,
  BucketAccessType,
  BucketEncryptionType,
  BucketReplicationProps,
  CentralLogsBucket,
  CloudWatchDestination,
  CloudWatchLogsSubscriptionFilter,
  CloudWatchToS3Firehose,
  KeyLookup,
  NewCloudWatchLogEvent,
  Organization,
  S3PublicAccessBlock,
  SsmParameterLookup,
} from '@aws-accelerator/constructs';

import { AcceleratorElbRootAccounts } from '../accelerator';
import { Logger } from '../logger';
import { AcceleratorStack, AcceleratorStackProps } from './accelerator-stack';

export type cloudwatchExclusionProcessedItem = {
  account: string;
  region: string;
  excludeAll?: boolean;
  logGroupNames?: string[];
};

export class LoggingStack extends AcceleratorStack {
  private cloudwatchKey: cdk.aws_kms.IKey;
  private organizationId: string | undefined;
  private lambdaKey: cdk.aws_kms.IKey;
  private centralLogsBucketName: string;
  private centralLogsBucket: CentralLogsBucket | undefined;
  private centralLogBucketKey: cdk.aws_kms.IKey | undefined;
  private centralSnsKey: cdk.aws_kms.IKey | undefined;
  private snsForwarderFunction: cdk.aws_lambda.IFunction | undefined;

  constructor(scope: Construct, id: string, props: AcceleratorStackProps) {
    super(scope, id, props);

    this.centralLogsBucketName = `${
      AcceleratorStack.ACCELERATOR_CENTRAL_LOGS_BUCKET_NAME_PREFIX
    }-${this.props.accountsConfig.getLogArchiveAccountId()}-${this.props.centralizedLoggingRegion}`;

    // Set Organization ID
    this.setOrganizationId();

    Logger.debug(
      `[logging-stack] Logging stack started for account ${cdk.Stack.of(this).account} and region ${
        cdk.Stack.of(this).region
      }`,
    );
    //
    // Create S3 Key in all account
    const s3Key = this.createS3Key();

    //
    // Create Managed active directory admin user secrets key
    //
    this.createManagedDirectoryAdminSecretsManagerKey();

    //
    // Create KMS keys defined in config
    this.createKeys();

    // create kms key for CloudWatch logs
    // the CloudWatch key for the management account
    // in the home region is created in the prepare stack
    if (
      cdk.Stack.of(this).account === props.accountsConfig.getManagementAccountId() &&
      (cdk.Stack.of(this).region === this.props.globalConfig.homeRegion ||
        cdk.Stack.of(this).region === this.props.globalRegion)
    ) {
      this.cloudwatchKey = this.lookupManagementAccountCloudWatchKey();
    } else {
      this.cloudwatchKey = this.createCloudWatchKey();
    }

    // create kms key for Lambda environment encryption
    // the Lambda environment encryption key for the management account
    // in the home region is created in the prepare stack
    if (
      cdk.Stack.of(this).account === props.accountsConfig.getManagementAccountId() &&
      (cdk.Stack.of(this).region === this.props.globalConfig.homeRegion ||
        cdk.Stack.of(this).region === this.props.globalRegion)
    ) {
      this.lambdaKey = cdk.aws_kms.Key.fromKeyArn(
        this,
        'AcceleratorGetLambdaKey',
        cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          AcceleratorStack.ACCELERATOR_LAMBDA_KEY_ARN_PARAMETER_NAME,
        ),
      );
    } else {
      this.lambdaKey = new cdk.aws_kms.Key(this, 'AcceleratorLambdaKey', {
        alias: AcceleratorStack.ACCELERATOR_LAMBDA_KEY_ALIAS,
        description: AcceleratorStack.ACCELERATOR_LAMBDA_KEY_DESCRIPTION,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      this.ssmParameters.push({
        logicalId: 'AcceleratorLambdaKmsArnParameter',
        parameterName: AcceleratorStack.ACCELERATOR_LAMBDA_KEY_ARN_PARAMETER_NAME,
        stringValue: this.lambdaKey.keyArn,
      });
    }

    //
    // Block Public Access; S3 is global, only need to call in home region. This is done in the
    // logging-stack instead of the security-stack since initial buckets are created in this stack.
    //
    if (
      cdk.Stack.of(this).region === this.props.globalConfig.homeRegion &&
      !this.isAccountExcluded(
        this.props.securityConfig.centralSecurityServices.s3PublicAccessBlock.excludeAccounts ?? [],
      )
    ) {
      if (this.props.securityConfig.centralSecurityServices.s3PublicAccessBlock.enable) {
        new S3PublicAccessBlock(this, 'S3PublicAccessBlock', {
          blockPublicAcls: true,
          blockPublicPolicy: true,
          ignorePublicAcls: true,
          restrictPublicBuckets: true,
          accountId: cdk.Stack.of(this).account,
          kmsKey: this.cloudwatchKey,
          logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
        });
      }
    }

    // SNS Topics creation
    if (
      this.props.globalConfig.snsTopics &&
      cdk.Stack.of(this).account === this.props.accountsConfig.getLogArchiveAccountId() &&
      !this.isRegionExcluded(this.props.globalConfig.snsTopics.deploymentTargets.excludedRegions ?? [])
    ) {
      this.createCentralSnsKey();

      for (const snsTopic of this.props.globalConfig.snsTopics?.topics ?? []) {
        this.createLoggingAccountSnsTopic(snsTopic, this.centralSnsKey!);
      }
    }

    if (
      this.isIncluded(this.props.globalConfig.snsTopics?.deploymentTargets ?? new t.DeploymentTargets()) &&
      cdk.Stack.of(this).account !== this.props.accountsConfig.getLogArchiveAccountId()
    ) {
      const snsKey = this.createSnsKey();
      this.createSnsForwarderFunction();
      for (const snsTopic of this.props.globalConfig.snsTopics?.topics ?? []) {
        this.createSnsTopic(snsTopic, snsKey);
      }
    }

    //
    // Create S3 Bucket for Access Logs - this is required
    //
    const serverAccessLogsBucket = new Bucket(this, 'AccessLogsBucket', {
      encryptionType: BucketEncryptionType.SSE_S3, // Server access logging does not support SSE-KMS
      s3BucketName: `${AcceleratorStack.ACCELERATOR_S3_ACCESS_LOGS_BUCKET_NAME_PREFIX}-${cdk.Stack.of(this).account}-${
        cdk.Stack.of(this).region
      }`,
      s3LifeCycleRules: this.getS3LifeCycleRules(this.props.globalConfig.logging.accessLogBucket?.lifecycleRules),
    });

    // AwsSolutions-S1: The S3 Bucket has server access logs disabled.
    NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/AccessLogsBucket/Resource/Resource`, [
      {
        id: 'AwsSolutions-S1',
        reason: 'AccessLogsBucket has server access logs disabled till the task for access logging completed.',
      },
    ]);

    serverAccessLogsBucket.getS3Bucket().addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'Allow write access for logging service principal',
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        principals: [new iam.ServicePrincipal('logging.s3.amazonaws.com')],
        resources: [serverAccessLogsBucket.getS3Bucket().arnForObjects('*')],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': cdk.Stack.of(this).account,
          },
        },
      }),
    );

    // AwsSolutions-S1: The S3 Bucket has server access logs disabled.
    NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/AccessLogsBucket/Resource/Resource`, [
      {
        id: 'AwsSolutions-S1',
        reason: 'AccessLogsBucket has server access logs disabled till the task for access logging completed.',
      },
    ]);

    //
    // Create Central Logs Bucket - This is done only in the home region of the log-archive account.
    // This is the destination bucket for all logs such as AWS CloudTrail, AWS Config, and VPC Flow
    // Logs. Addition logs can also be sent to this bucket through AWS CloudWatch Logs, such as
    // application logs, OS logs, or server logs.
    //
    //

    this.createCentralLogsBucket(serverAccessLogsBucket);

    //
    // For stacks in CentralLogs bucket region, bucket will be present to get key arn, custom resource will not be needed to get key arn from ssm parameter

    if (this.centralLogsBucket) {
      this.centralLogBucketKey = this.centralLogsBucket.getS3Bucket().getKey();
    } else {
      this.centralLogBucketKey = new KeyLookup(this, 'AcceleratorCentralLogBucketKeyLookup', {
        accountId: this.props.accountsConfig.getLogArchiveAccountId(),
        keyRegion: this.props.centralizedLoggingRegion,
        roleName: CentralLogsBucket.CROSS_ACCOUNT_SSM_PARAMETER_ACCESS_ROLE_NAME,
        keyArnParameterName: CentralLogsBucket.KEY_ARN_PARAMETER_NAME,
        kmsKey: this.cloudwatchKey,
        logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
      }).getKey();
    }

    const replicationProps: BucketReplicationProps = {
      destination: {
        bucketName: this.centralLogsBucketName,
        accountId: this.props.accountsConfig.getLogArchiveAccountId(),
        keyArn: this.centralLogBucketKey!.keyArn,
      },
      kmsKey: this.cloudwatchKey,
      logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
    };

    //
    // Create VPC Flow logs destination bucket
    this.createVpcFlowLogsBucket(s3Key, serverAccessLogsBucket, replicationProps);

    /**
     * Create S3 Bucket for ELB Access Logs, this is created in log archive account
     * For ELB to write access logs bucket is needed to have SSE-S3 server-side encryption
     */
    if (cdk.Stack.of(this).account === this.props.accountsConfig.getLogArchiveAccountId()) {
      const elbAccessLogsBucket = new Bucket(this, 'ElbAccessLogsBucket', {
        encryptionType: BucketEncryptionType.SSE_S3, // Server access logging does not support SSE-KMS
        s3BucketName: `${AcceleratorStack.ACCELERATOR_ELB_LOGS_BUCKET_PREFIX}-${cdk.Stack.of(this).account}-${
          cdk.Stack.of(this).region
        }`,
        replicationProps,
        s3LifeCycleRules: this.getS3LifeCycleRules(this.props.globalConfig.logging.elbLogBucket?.lifecycleRules),
      });
      let elbAccountId = undefined;
      if (AcceleratorElbRootAccounts[cdk.Stack.of(this).region]) {
        elbAccountId = AcceleratorElbRootAccounts[cdk.Stack.of(this).region];
      }
      if (props.networkConfig.elbAccountIds?.find(item => item.region === cdk.Stack.of(this).region)) {
        elbAccountId = props.networkConfig.elbAccountIds?.find(
          item => item.region === cdk.Stack.of(this).region,
        )!.accountId;
      }
      if (elbAccountId === undefined) {
        throw new Error(`elbAccountId is not defined for region: ${cdk.Stack.of(this).region}`);
      }
      // To make sure central log bucket created before elb access log bucket, this is required when logging stack executes in home region
      if (this.centralLogsBucket) {
        elbAccessLogsBucket.node.addDependency(this.centralLogsBucket);
      }

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission.
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `/${this.stackName}/ElbAccessLogsBucket/ElbAccessLogsBucketReplication/` +
          pascalCase(this.centralLogsBucketName) +
          '-ReplicationRole/DefaultPolicy/Resource',
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'Allows only specific policy.',
          },
        ],
      );

      const policies = [
        new cdk.aws_iam.PolicyStatement({
          sid: 'Allow get acl access for SSM principal',
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetBucketAcl'],
          principals: [new iam.ServicePrincipal('ssm.amazonaws.com')],
          resources: [`${elbAccessLogsBucket.getS3Bucket().bucketArn}`],
        }),
        new cdk.aws_iam.PolicyStatement({
          sid: 'Allow write access for ELB Account principal',
          effect: iam.Effect.ALLOW,
          actions: ['s3:PutObject'],
          principals: [new iam.AccountPrincipal(`${elbAccountId}`)],
          resources: [`${elbAccessLogsBucket.getS3Bucket().bucketArn}/*`],
        }),
        new cdk.aws_iam.PolicyStatement({
          sid: 'Allow write access for delivery logging service principal',
          effect: iam.Effect.ALLOW,
          actions: ['s3:PutObject'],
          principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
          resources: [`${elbAccessLogsBucket.getS3Bucket().bucketArn}/*`],
          conditions: {
            StringEquals: {
              's3:x-amz-acl': 'bucket-owner-full-control',
            },
          },
        }),
        new cdk.aws_iam.PolicyStatement({
          sid: 'Allow read bucket ACL access for delivery logging service principal',
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetBucketAcl'],
          principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
          resources: [`${elbAccessLogsBucket.getS3Bucket().bucketArn}`],
        }),
      ];
      policies.forEach(item => {
        elbAccessLogsBucket.getS3Bucket().addToResourcePolicy(item);
      });

      elbAccessLogsBucket.getS3Bucket().addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: 'Allow Organization principals to use of the bucket',
          effect: cdk.aws_iam.Effect.ALLOW,
          actions: ['s3:GetBucketLocation', 's3:PutObject'],
          principals: [new cdk.aws_iam.AnyPrincipal()],
          resources: [
            `${elbAccessLogsBucket.getS3Bucket().bucketArn}`,
            `${elbAccessLogsBucket.getS3Bucket().bucketArn}/*`,
          ],
          conditions: {
            StringEquals: {
              ...this.getPrincipalOrgIdCondition(this.organizationId),
            },
          },
        }),
      );

      // AwsSolutions-S1: The S3 Bucket has server access logs disabled.
      NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/ElbAccessLogsBucket/Resource/Resource`, [
        {
          id: 'AwsSolutions-S1',
          reason: 'ElbAccessLogsBucket has server access logs disabled till the task for access logging completed.',
        },
      ]);

      this.elbLogBucketAddResourcePolicies(elbAccessLogsBucket.getS3Bucket());
    }

    if (this.props.securityConfig.centralSecurityServices.ebsDefaultVolumeEncryption.enable) {
      // create service linked role for autoscaling
      // if ebs default encryption enabled and using a customer master key
      new iam.CfnServiceLinkedRole(this, 'AutoScalingServiceLinkedRole', {
        awsServiceName: 'autoscaling.amazonaws.com',
        description:
          'Default Service-Linked Role enables access to AWS Services and Resources used or managed by Auto Scaling',
      });
    }
    if (
      this.props.securityConfig.centralSecurityServices.ebsDefaultVolumeEncryption.enable &&
      props.partition === 'aws'
    ) {
      new iam.CfnServiceLinkedRole(this, 'AWSServiceRoleForAWSCloud9', {
        awsServiceName: 'cloud9.amazonaws.com',
        description: 'Service linked role for AWS Cloud9',
      });
    }
    // CloudWatchLogs to S3 replication

    // First, logs receiving account will setup Kinesis DataStream and Firehose
    // in LogArchive account home region
    // KMS to encrypt Kinesis, Firehose and any Lambda environment variables for CloudWatchLogs to S3 replication

    // CloudWatch logs replication requires Kinesis Data stream, Firehose and AWS Organizations
    // Some or all of these services may not be available in all regions.
    // Only deploy in standard and GovCloud partitions

    // check to see if users specified enable on CloudWatch logs in global config.
    // Defaults to true if undefined. If set to false, no resources are created.
    if (props.globalConfig.logging.cloudwatchLogs?.enable ?? true) {
      if (props.partition === 'aws' || props.partition === 'aws-us-gov' || props.partition === 'aws-cn') {
        if (cdk.Stack.of(this).account === props.accountsConfig.getLogArchiveAccountId()) {
          const receivingLogs = this.cloudwatchLogReceivingAccount(this.centralLogsBucketName, this.lambdaKey);
          const creatingLogs = this.cloudwatchLogCreatingAccount();

          // Log receiving setup should be complete before logs creation setup can start or else there will be errors about destination not ready.
          creatingLogs.node.addDependency(receivingLogs);
        } else {
          // Any account in LZA needs to setup log subscriptions for CloudWatch Logs
          // The destination needs to be present before its setup
          this.cloudwatchLogCreatingAccount();
        }
      }
    }

    //
    // Create SSM Parameters
    //
    this.createSsmParameters();

    // Setup s3 bucket with CMK to only allow specific role access to the key.
    // this bucket will be used to store private key material for the solution
    // central assets bucket will only be created in the management account in home region
    if (
      cdk.Stack.of(this).account === this.props.accountsConfig.getManagementAccountId() &&
      cdk.Stack.of(this).region === this.props.globalConfig.homeRegion
    ) {
      this.setupCertificateAssets();
    }

    Logger.debug(`[logging-stack] Stack synthesis complete`);
  }

  private setOrganizationId() {
    if (this.props.organizationConfig.enable) {
      this.organizationId = new Organization(this, 'Organization').id;
    }
  }
  /**
   * Function to create S3 Key
   */
  private createS3Key() {
    //
    // Crete S3 key in every account except audit account,
    // this is required for SSM automation to get right KMS key to encrypt unencrypted bucket
    if (cdk.Stack.of(this).account !== this.props.accountsConfig.getAuditAccountId()) {
      Logger.debug(`[Logging-stack] Create S3 Key`);
      const s3Key = new cdk.aws_kms.Key(this, 'Accelerator3Key', {
        alias: AcceleratorStack.ACCELERATOR_S3_KEY_ALIAS,
        description: AcceleratorStack.ACCELERATOR_S3_KEY_DESCRIPTION,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      s3Key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow S3 to use the encryption key`,
          principals: [new cdk.aws_iam.AnyPrincipal()],
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey', 'kms:Describe*'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'kms:ViaService': `s3.${cdk.Stack.of(this).region}.amazonaws.com`,
              ...this.getPrincipalOrgIdCondition(this.organizationId),
            },
          },
        }),
      );

      s3Key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: 'Allow AWS Services to encrypt and describe logs',
          actions: [
            'kms:Decrypt',
            'kms:DescribeKey',
            'kms:Encrypt',
            'kms:GenerateDataKey',
            'kms:GenerateDataKeyPair',
            'kms:GenerateDataKeyPairWithoutPlaintext',
            'kms:GenerateDataKeyWithoutPlaintext',
            'kms:ReEncryptFrom',
            'kms:ReEncryptTo',
          ],
          principals: [new cdk.aws_iam.ServicePrincipal(`delivery.logs.amazonaws.com`)],
          resources: ['*'],
        }),
      );

      this.ssmParameters.push({
        logicalId: 'AcceleratorS3KmsArnParameter',
        parameterName: AcceleratorStack.ACCELERATOR_S3_KEY_ARN_PARAMETER_NAME,
        stringValue: s3Key.keyArn,
      });

      return s3Key;
    } else {
      return this.createAuditAccountS3Key();
    }
  }

  /**
   * Function to create Audit account S3 bucket
   */
  private createAuditAccountS3Key(): cdk.aws_kms.Key {
    Logger.debug(`[key-stack] Create S3 Key`);
    const s3Key = new cdk.aws_kms.Key(this, 'AcceleratorAuditS3Key', {
      alias: AcceleratorStack.ACCELERATOR_S3_KEY_ALIAS,
      description: AcceleratorStack.ACCELERATOR_S3_KEY_DESCRIPTION,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    s3Key.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: `Allow S3 to use the encryption key`,
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `s3.${cdk.Stack.of(this).region}.amazonaws.com`,
            ...this.getPrincipalOrgIdCondition(this.organizationId),
          },
        },
      }),
    );

    s3Key.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'Allow services to confirm encryption',
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            ...this.getPrincipalOrgIdCondition(this.organizationId),
          },
        },
      }),
    );

    const allowedServicePrincipals: { name: string; principal: string }[] = [];

    allowedServicePrincipals.push({ name: 'CloudTrail', principal: 'cloudtrail.amazonaws.com' });

    if (this.props.securityConfig.centralSecurityServices.auditManager?.enable) {
      allowedServicePrincipals.push({ name: 'AuditManager', principal: 'auditmanager.amazonaws.com' });
      s3Key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow Audit Manager service to provision encryption key grants`,
          principals: [new cdk.aws_iam.AnyPrincipal()],
          actions: ['kms:CreateGrant'],
          conditions: {
            StringLike: {
              'kms:ViaService': 'auditmanager.*.amazonaws.com',
              ...this.getPrincipalOrgIdCondition(this.organizationId),
            },
            Bool: { 'kms:GrantIsForAWSResource': 'true' },
          },
          resources: ['*'],
        }),
      );
    }

    allowedServicePrincipals.forEach(item => {
      s3Key.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow ${item.name} service to use the encryption key`,
          principals: [new cdk.aws_iam.ServicePrincipal(item.principal)],
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: ['*'],
        }),
      );
    });

    this.ssmParameters.push({
      logicalId: 'AcceleratorS3KmsArnParameter',
      parameterName: AcceleratorStack.ACCELERATOR_S3_KEY_ARN_PARAMETER_NAME,
      stringValue: s3Key.keyArn,
    });

    return s3Key;
  }

  /**
   * Function to get VPC flow logs configuration when any VPC have S3 flow logs destination
   */
  private getS3FlowLogsDestinationConfig(): VpcFlowLogsConfig | undefined {
    let vpcFlowLogs: VpcFlowLogsConfig;
    for (const vpcItem of [...this.props.networkConfig.vpcs, ...(this.props.networkConfig.vpcTemplates ?? [])] ?? []) {
      // Get account IDs
      const vpcAccountIds = this.getVpcAccountIds(vpcItem);
      if (vpcAccountIds.includes(cdk.Stack.of(this).account) && vpcItem.region === cdk.Stack.of(this).region) {
        if (vpcItem.vpcFlowLogs) {
          vpcFlowLogs = vpcItem.vpcFlowLogs;
        } else {
          vpcFlowLogs = this.props.networkConfig.vpcFlowLogs;
        }
        if (vpcFlowLogs.destinations.includes('s3')) {
          return vpcFlowLogs;
        }
      }
    }
    return undefined;
  }

  /**
   * Function to create VPC FlowLogs bucket.
   * This bucket depends on Central Logs bucket and Server access logs bucket.
   * This bucket also depends on local S3 key.
   * @param s3Key
   * @param serverAccessLogsBucket
   * @param replicationProps
   */
  private createVpcFlowLogsBucket(
    s3Key: cdk.aws_kms.Key,
    serverAccessLogsBucket: Bucket,
    replicationProps: BucketReplicationProps,
  ) {
    const vpcFlowLogsConfig = this.getS3FlowLogsDestinationConfig();
    if (vpcFlowLogsConfig) {
      Logger.info(`[Logging-stack] Create S3 bucket for VPC flow logs destination`);

      const vpcFlowLogsBucket = new Bucket(this, 'AcceleratorVpcFlowLogsBucket', {
        encryptionType: BucketEncryptionType.SSE_KMS,
        s3BucketName: `${AcceleratorStack.ACCELERATOR_VPC_FLOW_LOGS_BUCKET_NAME_PREFIX}-${cdk.Stack.of(this).account}-${
          cdk.Stack.of(this).region
        }`,
        kmsKey: s3Key,
        serverAccessLogsBucket: serverAccessLogsBucket.getS3Bucket(),
        s3LifeCycleRules: this.getS3LifeCycleRules(vpcFlowLogsConfig.destinationsConfig?.s3?.lifecycleRules),
        replicationProps: replicationProps,
      });

      vpcFlowLogsBucket.getS3Bucket().addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: 'Allow read bucket ACL access for delivery logging service principal',
          effect: cdk.aws_iam.Effect.ALLOW,
          actions: ['s3:GetBucketAcl'],
          principals: [new cdk.aws_iam.ServicePrincipal('delivery.logs.amazonaws.com')],
          resources: [`${vpcFlowLogsBucket.getS3Bucket().bucketArn}`],
        }),
      );

      vpcFlowLogsBucket.getS3Bucket().addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          principals: [new cdk.aws_iam.ServicePrincipal('delivery.logs.amazonaws.com')],
          actions: ['s3:GetBucketAcl', 's3:ListBucket'],
          resources: [vpcFlowLogsBucket.getS3Bucket().bucketArn],
        }),
      );

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission.
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `/${this.stackName}/AcceleratorVpcFlowLogsBucket/AcceleratorVpcFlowLogsBucketReplication/` +
          pascalCase(this.centralLogsBucketName) +
          '-ReplicationRole/DefaultPolicy/Resource',
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'Allows only specific policy.',
          },
        ],
      );

      this.ssmParameters.push({
        logicalId: 'AcceleratorVpcFlowLogsBucketArnParameter',
        parameterName: AcceleratorStack.ACCELERATOR_VPC_FLOW_LOGS_DESTINATION_S3_BUCKET_ARN_PARAMETER_NAME,
        stringValue: vpcFlowLogsBucket.getS3Bucket().bucketArn,
      });
    }
  }

  private cloudwatchLogReceivingAccount(centralLogsBucketName: string, lambdaKey: cdk.aws_kms.IKey) {
    const logsReplicationKmsKey = new cdk.aws_kms.Key(this, 'LogsReplicationKey', {
      alias: AcceleratorStack.ACCELERATOR_CLOUDWATCH_LOG_REPLICATION_KEY_ALIAS,
      description: AcceleratorStack.ACCELERATOR_CLOUDWATCH_LOG_REPLICATION_KEY_DESCRIPTION,
      enableKeyRotation: true,
      // kms is used to encrypt kinesis data stream,
      // unlike data store like s3, rds, dynamodb no snapshot/object is encrypted
      // it can be destroyed as encrypts service
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // // Create Kinesis Data Stream
    // Kinesis Stream - data stream which will get data from CloudWatch logs
    const logsKinesisStreamCfn = new cdk.aws_kinesis.CfnStream(this, 'LogsKinesisStreamCfn', {
      retentionPeriodHours: 24,
      shardCount: 1,
      streamEncryption: {
        encryptionType: 'KMS',
        keyId: logsReplicationKmsKey.keyArn,
      },
    });
    const logsKinesisStream = cdk.aws_kinesis.Stream.fromStreamArn(
      this,
      'LogsKinesisStream',
      logsKinesisStreamCfn.attrArn,
    );

    // LogsKinesisStream/Resource AwsSolutions-KDS3
    NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/LogsKinesisStreamCfn`, [
      {
        id: 'AwsSolutions-KDS3',
        reason: 'Customer managed key is being used to encrypt Kinesis Data Stream',
      },
    ]);
    // Cloudwatch logs destination which points to Kinesis Data Stream
    const cloudwatchCfnDestination = new CloudWatchDestination(this, 'LogsDestinationSetup', {
      kinesisKmsKey: logsReplicationKmsKey,
      kinesisStream: logsKinesisStream,
      organizationId: this.organizationId,
      partition: this.props.partition,
      accountIds:
        this.props.partition === 'aws-cn' || !this.organizationId
          ? this.props.accountsConfig.getAccountIds()
          : undefined,
    });

    // Setup Firehose to take records from Kinesis and place in S3
    // Dynamic partition incoming records
    // so files from particular log group can be placed in their respective S3 prefix
    new CloudWatchToS3Firehose(this, 'FirehoseToS3Setup', {
      dynamicPartitioningValue: this.props.globalConfig.logging.cloudwatchLogs?.dynamicPartitioning ?? undefined,
      bucketName: centralLogsBucketName,
      kinesisStream: logsKinesisStream,
      firehoseKmsKey: this.centralLogBucketKey!, // for firehose to access s3
      kinesisKmsKey: logsReplicationKmsKey, // for firehose to access kinesis
      homeRegion: this.props.globalConfig.homeRegion,
      lambdaKey: lambdaKey, // to encrypt lambda environment
      configDir: this.props.configDirPath,
    });
    // FirehosePrefixProcessingLambda/ServiceRole AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/FirehoseToS3Setup/FirehosePrefixProcessingLambda/ServiceRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWS Managed policy for Lambda basic execution attached.',
        },
      ],
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/FirehoseToS3Setup/FirehoseS3ServiceRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Bucket permissions are wildcards to abort downloads and clean up objects. KMS permissions are wildcards to re-encrypt entities.',
        },
      ],
    );

    // Kinesis-Firehose-Stream-Dynamic-Partitioning AwsSolutions-KDF1: The Kinesis Data Firehose delivery stream does have server-side encryption enabled.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/FirehoseToS3Setup/Kinesis-Firehose-Stream-Dynamic-Partitioning`,
      [
        {
          id: 'AwsSolutions-KDF1',
          reason: 'Customer managed key is used to encrypt firehose delivery stream.',
        },
      ],
    );
    return cloudwatchCfnDestination;
  }
  private cloudwatchLogCreatingAccount() {
    const logsDestinationArnValue =
      'arn:' +
      this.props.partition +
      ':logs:' +
      cdk.Stack.of(this).region +
      ':' +
      this.props.accountsConfig.getLogArchiveAccountId() +
      ':destination:AWSAcceleratorCloudWatchToS3';

    // Since this is deployed organization wide, this role is required
    // https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CreateSubscriptionFilter-IAMrole.html
    const subscriptionFilterRole = new cdk.aws_iam.Role(this, 'SubscriptionFilterRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal(`logs.${cdk.Stack.of(this).region}.${cdk.Stack.of(this).urlSuffix}`),
      description: 'Role used by Subscription Filter to allow access to CloudWatch Destination',
      inlinePolicies: {
        accessLogEvents: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              resources: ['*'],
              actions: ['logs:PutLogEvents'],
            }),
          ],
        }),
      },
    });

    const exclusionAccountMap: cloudwatchExclusionProcessedItem[] = this.prepareCloudWatchExclusionList(
      this.props.globalConfig.logging.cloudwatchLogs?.exclusions ?? [],
    );
    let accountRegionExclusion: cloudwatchExclusionProcessedItem | undefined = undefined;
    if (exclusionAccountMap.length > 0) {
      const accountSpecificExclusion = exclusionAccountMap.filter(obj => {
        return obj.account === cdk.Stack.of(this).account && obj.region === cdk.Stack.of(this).region;
      });
      if (accountSpecificExclusion.length > 1) {
        Logger.error(
          `[Logging-stack] (Multiple cloudwatch exclusions ${JSON.stringify(
            accountSpecificExclusion,
          )} found for account: ${cdk.Stack.of(this).account} in region: ${cdk.Stack.of(this).region}`,
        );
      } else {
        accountRegionExclusion = exclusionAccountMap.find(obj => {
          return obj.account === cdk.Stack.of(this).account && obj.region === cdk.Stack.of(this).region;
        });
      }
    }
    // Run a custom resource to update subscription, KMS and retention for all existing log groups
    const customResourceExistingLogs = new CloudWatchLogsSubscriptionFilter(this, 'LogsSubscriptionFilter', {
      logDestinationArn: logsDestinationArnValue,
      logsKmsKey: this.cloudwatchKey,
      logArchiveAccountId: this.props.accountsConfig.getLogArchiveAccountId(),
      logsRetentionInDaysValue: this.props.globalConfig.cloudwatchLogRetentionInDays.toString(),
      subscriptionFilterRoleArn: subscriptionFilterRole.roleArn,
      exclusionSetting: accountRegionExclusion!,
    });

    //For every new log group that is created, set up subscription, KMS and retention
    const newLogCreationEvent = new NewCloudWatchLogEvent(this, 'NewCloudWatchLogsCreateEvent', {
      logDestinationArn: logsDestinationArnValue,
      lambdaEnvKey: this.lambdaKey,
      logsKmsKey: this.cloudwatchKey,
      logArchiveAccountId: this.props.accountsConfig.getLogArchiveAccountId(),
      logsRetentionInDaysValue: this.props.globalConfig.cloudwatchLogRetentionInDays.toString(),
      subscriptionFilterRoleArn: subscriptionFilterRole.roleArn,
      exclusionSetting: accountRegionExclusion!,
    });

    // create custom resource before the new log group logic is created.
    newLogCreationEvent.node.addDependency(customResourceExistingLogs);

    // SubscriptionFilterRole AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission.
    NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/SubscriptionFilterRole/Resource`, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Access is needed to ready all log events across all log groups for replication to S3.',
      },
    ]);
    // SetLogRetentionSubscriptionFunction AwsSolutions-IAM4
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/SetLogRetentionSubscriptionFunction/ServiceRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWS Managed policy for Lambda basic execution attached.',
        },
      ],
    );
    // SetLogRetentionSubscriptionFunction AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/NewCloudWatchLogsCreateEvent/SetLogRetentionSubscriptionFunction/ServiceRole/DefaultPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'This role needs permissions to change retention and subscription filter for any new log group that is created to enable log replication.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWS Managed policy for Lambda basic execution attached.',
        },
      ],
    );
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/NewCloudWatchLogsCreateEvent/SetLogRetentionSubscriptionFunction/ServiceRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'This role needs permissions to change retention and subscription filter for any new log group that is created to enable log replication.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWS Managed policy for Lambda basic execution attached.',
        },
      ],
    );

    return customResourceExistingLogs;
  }

  private prepareCloudWatchExclusionList(exclusionList: CloudWatchLogsExclusionConfig[]) {
    // Input will be an array of OUs and account.
    // Decompose input to account Ids with single regions
    const processedItems: cloudwatchExclusionProcessedItem[] = [];
    for (const exclusion of exclusionList) {
      processedItems.push(...this.convertCloudWatchExclusionToAccountIds(exclusion));
    }

    // Find the unique account, region pair in the given input
    type excludeUniqueItemType = { account: string; region: string };
    const excludeItemsMapUnique: excludeUniqueItemType[] = [];
    processedItems.forEach(item => {
      const output = { account: item.account, region: item.region };
      const findItem = excludeItemsMapUnique.find(obj => {
        return obj.account === output.account && obj.region === output.region;
      });

      if (!findItem) {
        excludeItemsMapUnique.push(output);
      }
    });

    const output: cloudwatchExclusionProcessedItem[] = [];
    for (const uniqueElement of excludeItemsMapUnique) {
      //pick objects from main array which match uniqueElement
      const filteredItems: cloudwatchExclusionProcessedItem[] | undefined = processedItems.filter(item => {
        return item.account === uniqueElement.account && item.region === uniqueElement.region;
      });
      if (filteredItems) {
        // merge excludeAll - if for an account/region there is even one excludeAll then exclude (like IAM policies do Deny)
        // merge logGroupsNames - merge all arrays and run Set to remove duplicates

        const allLogGroupNames: string[] = [];
        let globalExclude: boolean | undefined = undefined;
        filteredItems.forEach(obj => {
          if (obj.excludeAll) {
            globalExclude = true;
          }
        });
        filteredItems.forEach(obj => {
          if (obj.logGroupNames) {
            allLogGroupNames.push(...obj.logGroupNames);
          }
        });
        output.push({
          account: uniqueElement.account,
          region: uniqueElement.region,
          excludeAll: globalExclude,
          logGroupNames: allLogGroupNames,
        });
      }
    }
    return output;
  }

  private convertCloudWatchExclusionToAccountIds(exclusion: CloudWatchLogsExclusionConfig) {
    const output: cloudwatchExclusionProcessedItem[] = [];
    if (exclusion.organizationalUnits) {
      const accountsNamesInOu = this.getAccountsFromOu(exclusion.organizationalUnits);
      const getOuExclusionList: cloudwatchExclusionProcessedItem[] =
        this.convertCloudWatchExclusionAccountsToAccountIds(accountsNamesInOu, exclusion);

      output.push(...getOuExclusionList);
    }
    if (exclusion.accounts) {
      const getAccountExclusionList: cloudwatchExclusionProcessedItem[] =
        this.convertCloudWatchExclusionAccountsToAccountIds(exclusion.accounts, exclusion);
      output.push(...getAccountExclusionList);
    }
    return output;
  }
  private getAccountsFromOu(ouNames: string[]) {
    const allAccounts = [...this.props.accountsConfig.mandatoryAccounts, ...this.props.accountsConfig.workloadAccounts];
    const allAccountNames: string[] = [];
    if (ouNames.includes('Root')) {
      // root means all accounts
      for (const allAccountItem of allAccounts) {
        allAccountNames.push(allAccountItem.name);
      }
    } else {
      for (const ouName of ouNames) {
        // look in all accounts for specific OU
        for (const allAccountItem of allAccounts) {
          if (ouName === allAccountItem.organizationalUnit) {
            allAccountNames.push(allAccountItem.name);
          }
        }
      }
    }
    return allAccountNames;
  }

  private convertCloudWatchExclusionAccountsToAccountIds(
    accountsList: string[],
    exclusion: CloudWatchLogsExclusionConfig,
  ) {
    const output: cloudwatchExclusionProcessedItem[] = [];
    for (const accountItem of accountsList) {
      const outputItem: cloudwatchExclusionProcessedItem[] = this.reduceCloudWatchExclusionAccountByRegion(
        accountItem,
        exclusion,
      );
      output.push(...outputItem);
    }
    return output;
  }
  private reduceCloudWatchExclusionAccountByRegion(accountItem: string, exclusion: CloudWatchLogsExclusionConfig) {
    const processedItems: cloudwatchExclusionProcessedItem[] = [];
    for (const regionItem of exclusion.regions ?? this.props.globalConfig.enabledRegions) {
      const singleProcessedItem: cloudwatchExclusionProcessedItem = {
        account: this.props.accountsConfig.getAccountId(accountItem),
        region: regionItem,
        excludeAll: exclusion.excludeAll,
        logGroupNames: exclusion.logGroupNames,
      };
      processedItems.push(singleProcessedItem);
    }
    return processedItems;
  }

  private lookupManagementAccountCloudWatchKey() {
    const cloudwatchKeyArn = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      AcceleratorStack.ACCELERATOR_CLOUDWATCH_LOG_KEY_ARN_PARAMETER_NAME,
    );

    return cdk.aws_kms.Key.fromKeyArn(this, 'AcceleratorGetCloudWatchKey', cloudwatchKeyArn);
  }

  private createCloudWatchKey() {
    const cloudwatchKey = new cdk.aws_kms.Key(this, 'AcceleratorCloudWatchKey', {
      alias: AcceleratorStack.ACCELERATOR_CLOUDWATCH_LOG_KEY_ALIAS,
      description: AcceleratorStack.ACCELERATOR_CLOUDWATCH_LOG_KEY_DESCRIPTION,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    cloudwatchKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: `Allow Cloudwatch logs to use the encryption key`,
        principals: [
          new cdk.aws_iam.ServicePrincipal(`logs.${cdk.Stack.of(this).region}.${cdk.Stack.of(this).urlSuffix}`),
        ],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${this.props.partition}:logs:${
              cdk.Stack.of(this).region
            }:*:log-group:*`,
          },
        },
      }),
    );

    this.ssmParameters.push({
      logicalId: 'AcceleratorCloudWatchKmsArnParameter',
      parameterName: '/accelerator/kms/cloudwatch/key-arn',
      stringValue: cloudwatchKey.keyArn,
    });

    return cloudwatchKey;
  }

  /**
   * Function to Create Managed active directory admin user secrets key
   */
  private createManagedDirectoryAdminSecretsManagerKey() {
    for (const managedActiveDirectory of this.props.iamConfig.managedActiveDirectories ?? []) {
      const madAccountId = this.props.accountsConfig.getAccountId(managedActiveDirectory.account);
      const madAdminSecretAccountId = this.props.accountsConfig.getAccountId(
        this.props.iamConfig.getManageActiveDirectorySecretAccountName(managedActiveDirectory.name),
      );
      const madAdminSecretRegion = this.props.iamConfig.getManageActiveDirectorySecretRegion(
        managedActiveDirectory.name,
      );

      if (cdk.Stack.of(this).account == madAdminSecretAccountId && cdk.Stack.of(this).region == madAdminSecretRegion) {
        const key = new cdk.aws_kms.Key(this, 'AcceleratorSecretsManagerKmsKey', {
          alias: AcceleratorStack.ACCELERATOR_SECRETS_MANAGER_KEY_ALIAS,
          description: AcceleratorStack.ACCELERATOR_SECRETS_MANAGER_KEY_DESCRIPTION,
          enableKeyRotation: true,
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        key.addToResourcePolicy(
          new cdk.aws_iam.PolicyStatement({
            sid: `Allow MAD instance role to access the key`,
            principals: [new cdk.aws_iam.AccountPrincipal(madAccountId)],
            actions: ['kms:Decrypt'],
            resources: ['*'],
            conditions: {
              StringEquals: {
                'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
                ...this.getPrincipalOrgIdCondition(this.organizationId),
              },
              StringLike: {
                'kms:EncryptionContext:SecretARN': `arn:${cdk.Stack.of(this).partition}:secretsmanager:${
                  cdk.Stack.of(this).region
                }:${madAdminSecretAccountId}:secret:/accelerator/ad-user/*`,
              },
            },
          }),
        );

        const secretsManagerKmsKeyArnParameter = new cdk.aws_ssm.StringParameter(
          this,
          'AcceleratorSecretsManagerKmsKeyArnParameter',
          {
            parameterName: AcceleratorStack.ACCELERATOR_SECRET_MANAGER_KEY_ARN_PARAMETER_NAME,
            stringValue: key.keyArn,
          },
        );

        // Create role to give access to Secret manager KSM arn parameter, this will be used by MAD account to give access to this KMS for MAD instance
        new cdk.aws_iam.Role(this, 'CrossAccountAcceleratorSecretsKmsArnSsmParamAccessRole', {
          roleName: AcceleratorStack.ACCELERATOR_CROSS_ACCOUNT_SECRETS_KMS_ARN_PARAMETER_ROLE_NAME,
          assumedBy: this.getOrgPrincipals(this.organizationId),
          inlinePolicies: {
            default: new cdk.aws_iam.PolicyDocument({
              statements: [
                new cdk.aws_iam.PolicyStatement({
                  effect: cdk.aws_iam.Effect.ALLOW,
                  actions: ['ssm:GetParameters', 'ssm:GetParameter'],
                  resources: [secretsManagerKmsKeyArnParameter.parameterArn],
                  conditions: {
                    ArnLike: {
                      'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                    },
                  },
                }),
                new cdk.aws_iam.PolicyStatement({
                  effect: cdk.aws_iam.Effect.ALLOW,
                  actions: ['ssm:DescribeParameters'],
                  resources: ['*'],
                  conditions: {
                    ArnLike: {
                      'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                    },
                  },
                }),
              ],
            }),
          },
        });

        // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
        NagSuppressions.addResourceSuppressionsByPath(
          this,
          `${this.stackName}/CrossAccountAcceleratorSecretsKmsArnSsmParamAccessRole/Resource`,
          [
            {
              id: 'AwsSolutions-IAM5',
              reason: 'Cross account role needs access ssm parameters',
            },
          ],
        );
        return; // Create only one kms key even if there are multiple AD
      }
    }
  }

  /**
   * Function to create KMS Keys defined in config file
   */
  private createKeys() {
    if (!this.props.securityConfig.keyManagementService) {
      return;
    }

    for (const keyItem of this.props.securityConfig.keyManagementService.keySets) {
      if (!this.isIncluded(keyItem.deploymentTargets)) {
        Logger.info(`[Logging-stack] KMS Key ${keyItem.name} excluded`);
        continue;
      }
      Logger.debug(`[Logging-stack] Create KMS Key ${keyItem.name}`);

      const key = new cdk.aws_kms.Key(this, 'AcceleratorKmsKey-' + pascalCase(keyItem.name), {
        alias: keyItem.alias,
        description: keyItem.description,
        enabled: keyItem.enabled,
        enableKeyRotation: keyItem.enableKeyRotation,
        removalPolicy: keyItem.removalPolicy as cdk.RemovalPolicy,
      });

      if (keyItem.policy) {
        // Read in the policy document which should be properly formatted json
        const policyDocument = JSON.parse(
          this.generatePolicyReplacements(
            path.join(this.props.configDirPath, keyItem.policy),
            false,
            this.organizationId,
          ),
        );

        // Create a statements list using the PolicyStatement factory
        const statements: cdk.aws_iam.PolicyStatement[] = [];
        for (const statement of policyDocument.Statement) {
          statements.push(cdk.aws_iam.PolicyStatement.fromJson(statement));
        }

        // Attach statements to key policy
        statements.forEach(item => key.addToResourcePolicy(item));
      }

      // Create SSM parameter
      this.ssmParameters.push({
        logicalId: 'AcceleratorKmsArnParameter-' + pascalCase(keyItem.name),
        parameterName: `/accelerator/kms/${keyItem.name}/key-arn`,
        stringValue: key.keyArn,
      });

      // AwsSolutions-S1: The KMS Symmetric key does not have automatic key rotation enabled.
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `${this.stackName}` + '/AcceleratorKmsKey-' + pascalCase(keyItem.name) + `/Resource`,
        [
          {
            id: 'AwsSolutions-KMS5',
            reason: 'CMK policy defined by customer provided policy definition file.',
          },
        ],
      );
    }
  }
  /*
   * Function to create CentralLogs bucket in LogArchive account home region only
   * @param serverAccessLogsBucket
   */
  private createCentralLogsBucket(serverAccessLogsBucket: Bucket) {
    if (
      cdk.Stack.of(this).region === this.props.centralizedLoggingRegion &&
      cdk.Stack.of(this).account === this.props.accountsConfig.getLogArchiveAccountId()
    ) {
      const awsPrincipalAccesses: { name: string; principal: string; accessType: string }[] = [];

      if (this.props.securityConfig.centralSecurityServices.macie.enable) {
        awsPrincipalAccesses.push({
          name: 'Macie',
          principal: 'macie.amazonaws.com',
          accessType: BucketAccessType.READWRITE,
        });
      }

      if (this.props.securityConfig.centralSecurityServices.guardduty.enable) {
        awsPrincipalAccesses.push({
          name: 'Guardduty',
          principal: 'guardduty.amazonaws.com',
          accessType: BucketAccessType.READWRITE,
        });
      }

      if (this.props.securityConfig.centralSecurityServices.auditManager?.enable) {
        awsPrincipalAccesses.push({
          name: 'AuditManager',
          principal: 'auditmanager.amazonaws.com',
          accessType: BucketAccessType.READWRITE,
        });
      }

      if (this.props.globalConfig.logging.sessionManager.sendToS3) {
        Logger.debug(`[Logging-stack] Grant Session Manager access to Central Logs Bucket.`);
        awsPrincipalAccesses.push({
          name: 'SessionManager',
          principal: 'session-manager.amazonaws.com',
          accessType: BucketAccessType.NO_ACCESS,
        });
      }

      this.centralLogsBucket = new CentralLogsBucket(this, 'CentralLogsBucket', {
        s3BucketName: this.centralLogsBucketName,
        serverAccessLogsBucket: serverAccessLogsBucket,
        kmsAliasName: 'alias/accelerator/central-logs/s3',
        kmsDescription: 'AWS Accelerator Central Logs Bucket CMK',
        principalOrgIdCondition: this.getPrincipalOrgIdCondition(this.organizationId),
        orgPrincipals: this.getOrgPrincipals(this.organizationId),
        s3LifeCycleRules: this.getS3LifeCycleRules(this.props.globalConfig.logging.centralLogBucket?.lifecycleRules),
        awsPrincipalAccesses,
      });

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission.
      // rule suppression with evidence for this permission.
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `${this.stackName}/CentralLogsBucket/CrossAccountCentralBucketKMSArnSsmParamAccessRole/Resource`,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'Central logs bucket arn SSM parameter needs access from other accounts',
          },
        ],
      );

      this.centralLogBucketAddResourcePolicies();
    }
  }

  private createLoggingAccountSnsTopic(snsTopic: SnsTopicConfig, snsKey: cdk.aws_kms.IKey) {
    Logger.info('[logging-stack] Creating SNS topic in log archive account home region.');

    const topic = new cdk.aws_sns.Topic(this, `${pascalCase(snsTopic.name)}SNSTopic`, {
      displayName: `AWS Accelerator - ${snsTopic.name}`,
      topicName: `aws-accelerator-${snsTopic.name}`,
      masterKey: snsKey,
    });
    for (const email of snsTopic.emailAddresses) {
      topic.addSubscription(new cdk.aws_sns_subscriptions.EmailSubscription(email));
    }

    topic.grantPublish({
      grantPrincipal: new cdk.aws_iam.ServicePrincipal('cloudwatch.amazonaws.com'),
    });

    topic.grantPublish({
      grantPrincipal: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    topic.grantPublish({
      grantPrincipal: this.getOrgPrincipals(this.organizationId),
    });
  }

  private createSnsForwarderFunction() {
    const centralSnsKeyArn = new SsmParameterLookup(this, 'LookupCentralSnsKeyArnParameter', {
      name: AcceleratorStack.ACCELERATOR_SNS_TOPIC_KEY_ARN_PARAMETER_NAME,
      accountId: this.props.accountsConfig.getLogArchiveAccountId(),
      parameterRegion: cdk.Stack.of(this).region,
      roleName: AcceleratorStack.ACCELERATOR_SSM_SNS_TOPIC_PARAMETER_ACCESS_ROLE_NAME,
      kmsKey: this.cloudwatchKey,
      logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
    }).value;

    this.snsForwarderFunction = new cdk.aws_lambda.Function(this, 'SnsTopicForwarderFunction', {
      code: cdk.aws_lambda.Code.fromAsset(path.join(__dirname, '../lambdas/sns-topic-forwarder/dist')),
      runtime: cdk.aws_lambda.Runtime.NODEJS_14_X,
      handler: 'index.handler',
      description: 'Lambda function to forward Accelerator SNS Topics to log archive account',
      timeout: cdk.Duration.minutes(2),
      environmentEncryption: this.lambdaKey,
      environment: {
        SNS_CENTRAL_ACCOUNT: this.props.accountsConfig.getLogArchiveAccountId(),
        PARTITION: `${cdk.Stack.of(this).partition}`,
      },
    });

    new cdk.aws_logs.LogGroup(this, 'SnsForwarderFunctionLogGroup', {
      logGroupName: `/aws/lambda/${this.snsForwarderFunction.functionName}`,
      retention: this.props.globalConfig.cloudwatchLogRetentionInDays,
      encryptionKey: this.cloudwatchKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.snsForwarderFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'sns',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['sns:Publish'],
        resources: [
          `arn:${cdk.Stack.of(this).partition}:sns:${
            cdk.Stack.of(this).region
          }:${this.props.accountsConfig.getLogArchiveAccountId()}:aws-accelerator-*`,
        ],
      }),
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/SnsTopicForwarderFunction/ServiceRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Lambda function managed policy',
        },
      ],
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/SnsTopicForwarderFunction/ServiceRole/DefaultPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Allows only specific topics.',
        },
      ],
    );

    this.snsForwarderFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'kms',
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [centralSnsKeyArn],
      }),
    );
  }

  private createSnsTopic(snsTopic: SnsTopicConfig, snsKey: cdk.aws_kms.IKey) {
    Logger.info(`[logging-stack] Creating SNS topic ${snsTopic.name} in ${cdk.Stack.of(this).account}`);

    const topic = new cdk.aws_sns.Topic(this, `${pascalCase(snsTopic.name)}SNSTopic`, {
      displayName: `AWS Accelerator - ${snsTopic.name}`,
      topicName: `aws-accelerator-${snsTopic.name}`,
      masterKey: snsKey,
    });

    topic.grantPublish({
      grantPrincipal: new cdk.aws_iam.ServicePrincipal('cloudwatch.amazonaws.com'),
    });
    const fmsDelegatedAdminAccount = this.props.networkConfig.firewallManagerService?.delegatedAdminAccount;
    if (
      fmsDelegatedAdminAccount &&
      cdk.Stack.of(this).account === this.props.accountsConfig.getAccountId(fmsDelegatedAdminAccount)
    ) {
      topic.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: 'fms',
          actions: ['sns:Publish'],
          principals: [new cdk.aws_iam.AnyPrincipal()],
          resources: [topic.topicArn],
          conditions: {
            ArnLike: {
              'aws:PrincipalARN': [
                `arn:${cdk.Stack.of(this).partition}:iam::${cdk.Stack.of(this).account}:role/AWSAccelerator-FMS`,
              ],
            },
          },
        }),
      );
    }
    topic.addSubscription(new cdk.aws_sns_subscriptions.LambdaSubscription(this.snsForwarderFunction!));
    if (cdk.Stack.of(this).region === this.props.globalConfig.homeRegion) {
      // Create Notification Role for FMS Notifications if enabled
      this.createFMSNotificationRole();
    }
  }

  private createCentralSnsKey() {
    this.centralSnsKey = new cdk.aws_kms.Key(this, 'AcceleratorSnsTopicKey', {
      alias: AcceleratorStack.ACCELERATOR_SNS_TOPIC_KEY_ALIAS,
      description: AcceleratorStack.ACCELERATOR_SNS_TOPIC_KEY_DESCRIPTION,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.centralSnsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'sns',
        principals: [new cdk.aws_iam.ServicePrincipal('sns.amazonaws.com')],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            ...this.getPrincipalOrgIdCondition(this.organizationId),
          },
        },
      }),
    );

    this.centralSnsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'cloudwatch',
        principals: [new cdk.aws_iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': cdk.Stack.of(this).account,
          },
        },
      }),
    );

    this.centralSnsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'events',
        principals: [new cdk.aws_iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': cdk.Stack.of(this).account,
          },
        },
      }),
    );

    this.centralSnsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'crossaccount',
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            ...this.getPrincipalOrgIdCondition(this.organizationId),
          },
        },
      }),
    );

    new cdk.aws_ssm.StringParameter(this, 'AcceleratorCentralSnsKmsArnParameter', {
      parameterName: AcceleratorStack.ACCELERATOR_SNS_TOPIC_KEY_ARN_PARAMETER_NAME,
      stringValue: this.centralSnsKey.keyArn,
    });

    if (cdk.Stack.of(this).region === this.props.globalConfig.homeRegion) {
      // SSM parameter access IAM Role for central sns topic key
      new cdk.aws_iam.Role(this, 'CrossAccountCentralSnsTopicKMSArnSsmParamAccessRole', {
        roleName: AcceleratorStack.ACCELERATOR_SSM_SNS_TOPIC_PARAMETER_ACCESS_ROLE_NAME,
        assumedBy: this.getOrgPrincipals(this.organizationId),
        inlinePolicies: {
          default: new cdk.aws_iam.PolicyDocument({
            statements: [
              new cdk.aws_iam.PolicyStatement({
                effect: cdk.aws_iam.Effect.ALLOW,
                actions: ['ssm:GetParameters', 'ssm:GetParameter'],
                resources: [
                  `arn:${cdk.Stack.of(this).partition}:ssm:*:*:parameter${
                    AcceleratorStack.ACCELERATOR_SNS_TOPIC_KEY_ARN_PARAMETER_NAME
                  }`,
                ],
                conditions: {
                  StringEquals: {
                    ...this.getPrincipalOrgIdCondition(this.organizationId),
                  },
                  ArnLike: {
                    'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                  },
                },
              }),
              new cdk.aws_iam.PolicyStatement({
                effect: cdk.aws_iam.Effect.ALLOW,
                actions: ['ssm:DescribeParameters'],
                resources: ['*'],
                conditions: {
                  StringEquals: {
                    ...this.getPrincipalOrgIdCondition(this.organizationId),
                  },
                  ArnLike: {
                    'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                  },
                },
              }),
            ],
          }),
        },
      });
    }

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/CrossAccountCentralSnsTopicKMSArnSsmParamAccessRole`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Allows only specific role arns.',
        },
      ],
    );
  }

  private createSnsKey() {
    const snsKey = new cdk.aws_kms.Key(this, 'AcceleratorSnsTopicKey', {
      alias: AcceleratorStack.ACCELERATOR_SNS_TOPIC_KEY_ALIAS,
      description: AcceleratorStack.ACCELERATOR_SNS_TOPIC_KEY_DESCRIPTION,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    snsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'sns',
        principals: [new cdk.aws_iam.ServicePrincipal('sns.amazonaws.com')],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': cdk.Stack.of(this).account,
          },
        },
      }),
    );
    const fmsDelegatedAdminAccount = this.props.networkConfig.firewallManagerService?.delegatedAdminAccount;
    if (
      fmsDelegatedAdminAccount &&
      cdk.Stack.of(this).account === this.props.accountsConfig.getAccountId(fmsDelegatedAdminAccount)
    ) {
      snsKey.addToResourcePolicy(
        new cdk.aws_iam.PolicyStatement({
          sid: `Allow Accelerator Role to use the encryption key`,
          principals: [new cdk.aws_iam.AnyPrincipal()],
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: ['*'],
          conditions: {
            ArnLike: {
              'aws:PrincipalARN': [
                `arn:${cdk.Stack.of(this).partition}:iam::${
                  cdk.Stack.of(this).account
                }:role/AWSAccelerator-FMS-Notifications`,
              ],
            },
          },
        }),
      );
    }

    snsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'cloudwatch',
        principals: [
          new cdk.aws_iam.ServicePrincipal('cloudwatch.amazonaws.com'),
          new cdk.aws_iam.ServicePrincipal('events.amazonaws.com'),
        ],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': cdk.Stack.of(this).account,
          },
        },
      }),
    );

    snsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'accelerator-role',
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'aws:PrincipalARN': [
              `arn:${cdk.Stack.of(this).partition}:iam::${cdk.Stack.of(this).account}:role/AWSAccelerator-*`,
            ],
          },
        },
      }),
    );
    new cdk.aws_ssm.StringParameter(this, 'AcceleratorCentralSnsKmsArnParameter', {
      parameterName: AcceleratorStack.ACCELERATOR_SNS_TOPIC_KEY_ARN_PARAMETER_NAME,
      stringValue: snsKey.keyArn,
    });

    return snsKey;
  }

  private centralLogBucketAddResourcePolicies() {
    Logger.info(`[logging-stack] Adding central log bucket resource policies to KMS`);

    for (const attachment of this.props.globalConfig.logging.centralLogBucket?.kmsResourcePolicyAttachments ?? []) {
      const policyDocument = JSON.parse(
        this.generatePolicyReplacements(path.join(this.props.configDirPath, attachment.policy), false),
      );

      // Create a statements list using the PolicyStatement factory
      const statements: cdk.aws_iam.PolicyStatement[] = [];
      for (const statement of policyDocument.Statement) {
        statements.push(cdk.aws_iam.PolicyStatement.fromJson(statement));
        for (const statement of statements) {
          this.centralLogBucketKey?.addToResourcePolicy(statement);
        }
      }

      Logger.info(`[logging-stack] Adding central log bucket resource policies to S3`);
      const realCentralLogBucket = this.centralLogsBucket?.getS3Bucket().getS3Bucket();
      for (const attachment of this.props.globalConfig.logging.centralLogBucket?.s3ResourcePolicyAttachments ?? []) {
        const policyDocument = JSON.parse(
          this.generatePolicyReplacements(path.join(this.props.configDirPath, attachment.policy), false),
        );
        // Create a statements list using the PolicyStatement factory
        const statements: cdk.aws_iam.PolicyStatement[] = [];
        for (const statement of policyDocument.Statement) {
          statements.push(cdk.aws_iam.PolicyStatement.fromJson(statement));
        }
        for (const statement of statements) {
          realCentralLogBucket?.addToResourcePolicy(statement);
        }
      }
    }
  }

  private createFMSNotificationRole() {
    const fmsConfiguration = this.props.networkConfig.firewallManagerService;

    // Exit if Notification channels don't exist.
    if (!fmsConfiguration?.notificationChannels || fmsConfiguration.notificationChannels.length === 0) {
      return;
    }
    const roleName = `AWSAccelerator-FMS-Notifications`;
    const auditAccountId = this.props.accountsConfig.getAuditAccountId();

    //Create Role for SNS Topic access from security config and global config
    Logger.info('[logging-stack] Creating FMS Notification Channel Role AWSAccelerator - FMS');
    const fmsRole = new cdk.aws_iam.Role(this, `aws-accelerator-fms`, {
      roleName,
      assumedBy: new cdk.aws_iam.ServicePrincipal('fms.amazonaws.com'),
      inlinePolicies: {
        default: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ['sns:Publish'],
              resources: ['*'],
            }),
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
              resources: [
                `arn:${cdk.Stack.of(this).partition}:kms:*:${auditAccountId}:key/*`,
                `arn:${cdk.Stack.of(this).partition}:kms:*:${cdk.Stack.of(this).account}:key/*`,
              ],
            }),
          ],
        }),
      },
    });

    NagSuppressions.addResourceSuppressions(fmsRole, [
      { id: 'AwsSolutions-IAM5', reason: 'Allow cross-account resources to encrypt KMS under this path.' },
    ]);
  }

  private elbLogBucketAddResourcePolicies(elbLogBucket: cdk.aws_s3.IBucket) {
    Logger.info(`[security-resources-stack] Adding elb log bucket resource policies to S3`);
    for (const attachment of this.props.globalConfig.logging.elbLogBucket?.s3ResourcePolicyAttachments ?? []) {
      const policyDocument = JSON.parse(
        this.generatePolicyReplacements(path.join(this.props.configDirPath, attachment.policy), false),
      );
      // Create a statements list using the PolicyStatement factory
      const statements: cdk.aws_iam.PolicyStatement[] = [];
      for (const statement of policyDocument.Statement) {
        statements.push(cdk.aws_iam.PolicyStatement.fromJson(statement));
      }

      for (const statement of statements) {
        elbLogBucket.addToResourcePolicy(statement);
      }
    }
  }

  private setupCertificateAssets() {
    const assetsKmsKey = new cdk.aws_kms.Key(this, 'AssetsKmsKey', {
      alias: AcceleratorStack.ACCELERATOR_ASSETS_KEY_ARN_PARAMETER_NAME,
      description: AcceleratorStack.ACCELERATOR_ASSETS_KEY_DESCRIPTION,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // Allow management account access
    assetsKmsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'Management Actions',
        principals: [new cdk.aws_iam.AccountPrincipal(cdk.Stack.of(this).account)],
        actions: [
          'kms:Create*',
          'kms:Describe*',
          'kms:Enable*',
          'kms:List*',
          'kms:Put*',
          'kms:Update*',
          'kms:Revoke*',
          'kms:Disable*',
          'kms:Get*',
          'kms:Delete*',
          'kms:ScheduleKeyDeletion',
          'kms:CancelKeyDeletion',
          'kms:GenerateDataKey',
        ],
        resources: ['*'],
      }),
    );

    //grant s3 service access
    assetsKmsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: `Allow S3 to use the encryption key`,
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `s3.${cdk.Stack.of(this).region}.amazonaws.com`,
            ...this.getPrincipalOrgIdCondition(this.organizationId),
          },
        },
      }),
    );

    //grant AWSAccelerator-AssetsAccessRole access to KMS
    assetsKmsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          StringLike: {
            'aws:PrincipalARN': `arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-AssetsAccessRole`,
            ...this.getPrincipalOrgIdCondition(this.organizationId),
          },
        },
      }),
    );
    const serverAccessLogsBucket = new Bucket(this, 'AssetsAccessLogsBucket', {
      encryptionType: BucketEncryptionType.SSE_S3, // Server access logging does not support SSE-KMS
      s3BucketName: `aws-accelerator-assets-logs-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      s3LifeCycleRules: this.getS3LifeCycleRules(this.props.globalConfig.logging.accessLogBucket?.lifecycleRules),
    });

    // AwsSolutions-S1: The S3 Bucket has server access logs disabled.
    NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/AssetsAccessLogsBucket/Resource/Resource`, [
      {
        id: 'AwsSolutions-S1',
        reason: 'AccessLogsBucket has server access logs disabled till the task for access logging completed.',
      },
    ]);

    //create assets bucket
    const assetsBucket = new Bucket(this, 'CertificateAssetBucket', {
      encryptionType: BucketEncryptionType.SSE_KMS,
      s3BucketName: `aws-accelerator-assets-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      kmsKey: assetsKmsKey,
      serverAccessLogsBucketName: serverAccessLogsBucket.getS3Bucket().bucketName,
    });
    assetsBucket.getS3Bucket().addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['s3:GetObject*', 's3:ListBucket'],
        resources: [assetsBucket.getS3Bucket().bucketArn, `${assetsBucket.getS3Bucket().bucketArn}/*`],
        conditions: {
          StringEquals: {
            ...this.getPrincipalOrgIdCondition(this.organizationId),
          },
          StringLike: {
            'aws:PrincipalARN': `arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-AssetsAccessRole`,
          },
        },
      }),
    );
    new cdk.CfnOutput(this, 'AWSAcceleratorAssetsBucket', {
      value: assetsBucket.getS3Bucket().bucketName,
      description: 'Name of the bucket which hosts solution assets ',
    });

    const assetBucketKmsKeyArnSsmParameter = new cdk.aws_ssm.StringParameter(
      this,
      'SsmParamAssetsAccountBucketKMSArn',
      {
        parameterName: AcceleratorStack.ACCELERATOR_ASSETS_KEY_ARN_PARAMETER_NAME,
        stringValue: assetsKmsKey.keyArn,
      },
    );

    // SSM parameter access IAM Role for
    new cdk.aws_iam.Role(this, 'CrossAccountAssetsBucketKMSArnSsmParamAccessRole', {
      roleName: AcceleratorStack.ACCELERATOR_ASSETS_CROSS_ACCOUNT_SSM_PARAMETER_ACCESS_ROLE_NAME,
      assumedBy: this.getOrgPrincipals(this.organizationId),
      inlinePolicies: {
        default: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ['ssm:GetParameters', 'ssm:GetParameter'],
              resources: [assetBucketKmsKeyArnSsmParameter.parameterArn],
              conditions: {
                ArnLike: {
                  'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                },
              },
            }),
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ['ssm:DescribeParameters'],
              resources: ['*'],
              conditions: {
                ArnLike: {
                  'aws:PrincipalARN': [`arn:${cdk.Stack.of(this).partition}:iam::*:role/AWSAccelerator-*`],
                },
              },
            }),
          ],
        }),
      },
    });

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/CrossAccountAssetsBucketKMSArnSsmParamAccessRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Cross account role allows AWSAccelerator to have read access on SSM',
        },
      ],
    );
  }
}
