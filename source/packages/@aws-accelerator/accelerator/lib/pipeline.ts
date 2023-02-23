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
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { Bucket, BucketEncryptionType } from '@aws-accelerator/constructs';

import { AcceleratorStage } from './accelerator-stage';
import * as config_repository from './config-repository';
import { AcceleratorToolkitCommand } from './toolkit';

/**
 *
 */
export interface AcceleratorPipelineProps {
  readonly toolkitRole: cdk.aws_iam.Role;
  readonly sourceRepository: string;
  readonly sourceRepositoryOwner: string;
  readonly sourceRepositoryName: string;
  readonly sourceBranchName: string;
  readonly enableApprovalStage: boolean;
  readonly qualifier?: string;
  readonly managementAccountId?: string;
  readonly managementAccountRoleName?: string;
  readonly managementAccountEmail: string;
  readonly logArchiveAccountEmail: string;
  readonly auditAccountEmail: string;
  readonly controlTowerEnabled: string;
  /**
   * List of email addresses to be notified when pipeline is waiting for manual approval stage.
   * If pipeline do not have approval stage enabled, this value will have no impact.
   */
  readonly approvalStageNotifyEmailList?: string;
  readonly partition: string;
}

/**
 * AWS Accelerator Pipeline Class, which creates the pipeline for AWS Landing zone
 */
export class AcceleratorPipeline extends Construct {
  private readonly pipelineRole: iam.Role;
  private readonly toolkitProject: codebuild.PipelineProject;
  private readonly buildOutput: codepipeline.Artifact;
  private readonly acceleratorRepoArtifact: codepipeline.Artifact;
  private readonly configRepoArtifact: codepipeline.Artifact;

  private readonly pipeline: codepipeline.Pipeline;
  private readonly props: AcceleratorPipelineProps;
  private readonly installerKey: cdk.aws_kms.Key;

  constructor(scope: Construct, id: string, props: AcceleratorPipelineProps) {
    super(scope, id);

    this.props = props;

    //
    // Fields can be changed based on qualifier property
    let acceleratorKeyArnSsmParameterName = '/accelerator/installer/kms/key-arn';
    let secureBucketName = `aws-accelerator-pipeline-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`;
    let serverAccessLogsBucketName = '/accelerator/installer-access-logs-bucket-name';
    let configRepositoryName = 'aws-accelerator-config';
    let pipelineName = 'AWSAccelerator-Pipeline';
    let buildProjectName = 'AWSAccelerator-BuildProject';
    let toolkitProjectName = 'AWSAccelerator-ToolkitProject';

    //
    // Change the fields when qualifier is present
    if (this.props.qualifier) {
      acceleratorKeyArnSsmParameterName = `/accelerator/${this.props.qualifier}/installer/kms/key-arn`;
      secureBucketName = `${this.props.qualifier}-pipeline-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`;
      serverAccessLogsBucketName = `/accelerator/${this.props.qualifier}/installer-access-logs-bucket-name`;
      configRepositoryName = `${this.props.qualifier}-config`;
      pipelineName = `${this.props.qualifier}-pipeline`;
      buildProjectName = `${this.props.qualifier}-build-project`;
      toolkitProjectName = `${this.props.qualifier}-toolkit-project`;
    }

    let pipelineAccountEnvVariables: { [p: string]: codebuild.BuildEnvironmentVariable } | undefined;

    if (this.props.managementAccountId && this.props.managementAccountRoleName) {
      pipelineAccountEnvVariables = {
        MANAGEMENT_ACCOUNT_ID: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: this.props.managementAccountId,
        },
        MANAGEMENT_ACCOUNT_ROLE_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: this.props.managementAccountRoleName,
        },
      };
    }

    // Get installer key
    this.installerKey = cdk.aws_kms.Key.fromKeyArn(
      this,
      'AcceleratorKey',
      cdk.aws_ssm.StringParameter.valueForStringParameter(this, acceleratorKeyArnSsmParameterName),
    ) as cdk.aws_kms.Key;

    const bucket = new Bucket(this, 'SecureBucket', {
      encryptionType: BucketEncryptionType.SSE_KMS,
      s3BucketName: secureBucketName,
      kmsKey: this.installerKey,
      serverAccessLogsBucketName: cdk.aws_ssm.StringParameter.valueForStringParameter(this, serverAccessLogsBucketName),
    });

    const configRepository = new config_repository.ConfigRepository(this, 'ConfigRepository', {
      repositoryName: configRepositoryName,
      repositoryBranchName: 'main',
      description:
        'AWS Accelerator configuration repository, created and initialized with default config file by pipeline',
      managementAccountEmail: this.props.managementAccountEmail,
      logArchiveAccountEmail: this.props.logArchiveAccountEmail,
      auditAccountEmail: this.props.auditAccountEmail,
      controlTowerEnabled: this.props.controlTowerEnabled,
    });

    /**
     * Pipeline
     */
    this.pipelineRole = new iam.Role(this, 'PipelineRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });

    this.pipeline = new codepipeline.Pipeline(this, 'Resource', {
      pipelineName: pipelineName,
      artifactBucket: bucket.getS3Bucket(),
      role: this.pipelineRole,
    });

    this.acceleratorRepoArtifact = new codepipeline.Artifact('Source');
    this.configRepoArtifact = new codepipeline.Artifact('Config');

    let sourceAction:
      | cdk.aws_codepipeline_actions.CodeCommitSourceAction
      | cdk.aws_codepipeline_actions.GitHubSourceAction;

    if (this.props.sourceRepository === 'codecommit') {
      sourceAction = new codepipeline_actions.CodeCommitSourceAction({
        actionName: 'Source',
        repository: codecommit.Repository.fromRepositoryName(this, 'SourceRepo', this.props.sourceRepositoryName),
        branch: this.props.sourceBranchName,
        output: this.acceleratorRepoArtifact,
        trigger: codepipeline_actions.CodeCommitTrigger.NONE,
      });
    } else {
      sourceAction = new cdk.aws_codepipeline_actions.GitHubSourceAction({
        actionName: 'Source',
        owner: this.props.sourceRepositoryOwner,
        repo: this.props.sourceRepositoryName,
        branch: this.props.sourceBranchName,
        oauthToken: cdk.SecretValue.secretsManager('accelerator/github-token'),
        output: this.acceleratorRepoArtifact,
        trigger: cdk.aws_codepipeline_actions.GitHubTrigger.NONE,
      });
    }

    this.pipeline.addStage({
      stageName: 'Source',
      actions: [
        sourceAction,
        new codepipeline_actions.CodeCommitSourceAction({
          actionName: 'Configuration',
          repository: configRepository.getRepository(),
          branch: 'main',
          output: this.configRepoArtifact,
          trigger: codepipeline_actions.CodeCommitTrigger.NONE,
          variablesNamespace: 'Config-Vars',
        }),
      ],
    });

    /**
     * Build Stage
     */
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: buildProjectName,
      encryptionKey: this.installerKey,
      role: buildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 14,
            },
          },
          build: {
            commands: [
              'env',
              'cd source',
              `if [ "${cdk.Stack.of(this).partition}" = "aws-cn" ]; then
                  sed -i "s#registry.yarnpkg.com#registry.npmmirror.com#g" yarn.lock;
                  yarn config set registry https://registry.npmmirror.com
               fi`,
              'yarn install',
              'yarn lerna link',
              'yarn build',
              'yarn validate-config $CODEBUILD_SRC_DIR_Config',
            ],
          },
        },
        artifacts: {
          files: ['**/*'],
          'enable-symlinks': 'yes',
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        privileged: true, // Allow access to the Docker daemon
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          NODE_OPTIONS: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: '--max_old_space_size=8192',
          },
        },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.SOURCE),
    });

    this.buildOutput = new codepipeline.Artifact('Build');

    this.pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Build',
          project: buildProject,
          input: this.acceleratorRepoArtifact,
          extraInputs: [this.configRepoArtifact],
          outputs: [this.buildOutput],
          role: this.pipelineRole,
        }),
      ],
    });

    /**
     * Deploy Stage
     */

    this.toolkitProject = new codebuild.PipelineProject(this, 'ToolkitProject', {
      projectName: toolkitProjectName,
      encryptionKey: this.installerKey,
      role: this.props.toolkitRole,
      timeout: cdk.Duration.hours(5),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 14,
            },
          },
          build: {
            commands: [
              'env',
              'cd source',
              'cd packages/@aws-accelerator/accelerator',
              `if [ -z "\${ACCELERATOR_STAGE}" ]; then yarn run ts-node --transpile-only cdk.ts synth --require-approval never --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION}; fi`,
              `if [ ! -z "\${ACCELERATOR_STAGE}" ]; then yarn run ts-node --transpile-only cdk.ts synth --stage $ACCELERATOR_STAGE --require-approval never --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION}; fi`,
              `yarn run ts-node --transpile-only cdk.ts --require-approval never $CDK_OPTIONS --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION} --app cdk.out`,
            ],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
        privileged: true, // Allow access to the Docker daemon
        computeType: codebuild.ComputeType.LARGE,
        environmentVariables: {
          NODE_OPTIONS: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: '--max_old_space_size=8192',
          },
          CDK_METHOD: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: 'direct',
          },
          CDK_NEW_BOOTSTRAP: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: '1',
          },
          ACCELERATOR_QUALIFIER: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: this.props.qualifier ? this.props.qualifier : 'aws-accelerator',
          },
          ...pipelineAccountEnvVariables,
        },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.SOURCE),
    });

    // /**
    //  * The Prepare stage is used to verify that all prerequisites have been made and that the
    //  * Accelerator can be deployed into the environment
    //  * Creates the accounts
    //  * Creates the ou's if control tower is not enabled
    //  */
    this.pipeline.addStage({
      stageName: 'Prepare',
      actions: [this.createToolkitStage({ actionName: 'Prepare', command: 'deploy', stage: AcceleratorStage.PREPARE })],
    });

    this.pipeline.addStage({
      stageName: 'Accounts',
      actions: [
        this.createToolkitStage({ actionName: 'Accounts', command: 'deploy', stage: AcceleratorStage.ACCOUNTS }),
      ],
    });

    this.pipeline.addStage({
      stageName: 'Bootstrap',
      actions: [this.createToolkitStage({ actionName: 'Bootstrap', command: `bootstrap` })],
    });

    //
    // Add review stage based on parameter
    this.addReviewStage();

    /**
     * The Logging stack establishes all the logging assets that are needed in
     * all the accounts and will configure:
     *
     * - An S3 Access Logs bucket for every region in every account
     * - The Central Logs bucket in the log-archive account
     *
     */
    this.pipeline.addStage({
      stageName: 'Logging',
      actions: [
        this.createToolkitStage({ actionName: 'Key', command: 'deploy', stage: AcceleratorStage.KEY, runOrder: 1 }),
        this.createToolkitStage({
          actionName: 'Logging',
          command: 'deploy',
          stage: AcceleratorStage.LOGGING,
          runOrder: 2,
        }),
      ],
    });

    this.pipeline.addStage({
      stageName: 'Organization',
      actions: [
        this.createToolkitStage({
          actionName: 'Organizations',
          command: 'deploy',
          stage: AcceleratorStage.ORGANIZATIONS,
        }),
      ],
    });

    this.pipeline.addStage({
      stageName: 'SecurityAudit',
      actions: [
        this.createToolkitStage({
          actionName: 'SecurityAudit',
          command: 'deploy',
          stage: AcceleratorStage.SECURITY_AUDIT,
        }),
      ],
    });

    this.pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        this.createToolkitStage({
          actionName: 'Network_Prepare',
          command: 'deploy',
          stage: AcceleratorStage.NETWORK_PREP,
          runOrder: 1,
        }),
        this.createToolkitStage({
          actionName: 'Security',
          command: 'deploy',
          stage: AcceleratorStage.SECURITY,
          runOrder: 1,
        }),
        this.createToolkitStage({
          actionName: 'Operations',
          command: 'deploy',
          stage: AcceleratorStage.OPERATIONS,
          runOrder: 1,
        }),
        this.createToolkitStage({
          actionName: 'Network_VPCs',
          command: 'deploy',
          stage: AcceleratorStage.NETWORK_VPC,
          runOrder: 2,
        }),
        this.createToolkitStage({
          actionName: 'Security_Resources',
          command: 'deploy',
          stage: AcceleratorStage.SECURITY_RESOURCES,
          runOrder: 2,
        }),
        this.createToolkitStage({
          actionName: 'Network_Associations',
          command: 'deploy',
          stage: AcceleratorStage.NETWORK_ASSOCIATIONS,
          runOrder: 3,
        }),
        this.createToolkitStage({
          actionName: 'Customizations',
          command: 'deploy',
          stage: AcceleratorStage.CUSTOMIZATIONS,
          runOrder: 4,
        }),
        this.createToolkitStage({
          actionName: 'Finalize',
          command: 'deploy',
          stage: AcceleratorStage.FINALIZE,
          runOrder: 5,
        }),
      ],
    });

    // Enable pipeline notification for commercial partition
    this.enablePipelineNotification();
  }

  /**
   * Add review stage based on parameter
   */
  private addReviewStage() {
    if (this.props.enableApprovalStage) {
      const notificationTopic = new cdk.aws_sns.Topic(this, 'ManualApprovalActionTopic', {
        topicName: (this.props.qualifier ? this.props.qualifier : 'aws-accelerator') + '-pipeline-review-topic',
        displayName: (this.props.qualifier ? this.props.qualifier : 'aws-accelerator') + '-pipeline-review-topic',
        masterKey: this.installerKey,
      });

      let notifyEmails: string[] | undefined = undefined;

      if (notificationTopic) {
        if (this.props.approvalStageNotifyEmailList) {
          notifyEmails = this.props.approvalStageNotifyEmailList.split(',');
        }
      }

      this.pipeline.addStage({
        stageName: 'Review',
        actions: [
          this.createToolkitStage({ actionName: 'Diff', command: 'diff', runOrder: 1 }),
          new codepipeline_actions.ManualApprovalAction({
            actionName: 'Approve',
            runOrder: 2,
            additionalInformation: 'See previous stage (Diff) for changes.',
            notificationTopic,
            notifyEmails,
          }),
        ],
      });
    }
  }

  private createToolkitStage(stageProps: {
    actionName: string;
    command: string;
    stage?: string;
    runOrder?: number;
  }): codepipeline_actions.CodeBuildAction {
    let cdkOptions;
    if (
      stageProps.command === AcceleratorToolkitCommand.BOOTSTRAP.toString() ||
      stageProps.command === AcceleratorToolkitCommand.DIFF.toString()
    ) {
      cdkOptions = stageProps.command;
    } else {
      cdkOptions = `${stageProps.command} --stage ${stageProps.stage}`;
    }

    const environmentVariables: {
      [name: string]: cdk.aws_codebuild.BuildEnvironmentVariable;
    } = {
      CDK_OPTIONS: {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: cdkOptions,
      },
      CONFIG_COMMIT_ID: {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: '#{Config-Vars.CommitId}',
      },
    };

    if (stageProps.stage) {
      environmentVariables['ACCELERATOR_STAGE'] = {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: stageProps.stage ?? '',
      };
    }

    return new codepipeline_actions.CodeBuildAction({
      actionName: stageProps.actionName,
      runOrder: stageProps.runOrder,
      project: this.toolkitProject,
      input: this.buildOutput,
      extraInputs: [this.configRepoArtifact],
      role: this.pipelineRole,
      environmentVariables,
    });
  }

  /**
   * Enable pipeline notification for commercial partition and supported regions
   */
  private enablePipelineNotification() {
    // List of regions with AWS CodeStar being supported. For details, see documentation:
    // https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/
    const awsCodeStarSupportedRegions = [
      'us-east-1',
      'us-east-2',
      'us-west-1',
      'us-west-2',
      'ap-northeast-2',
      'ap-southeast-1',
      'ap-southeast-2',
      'ap-northeast-1',
      'ca-central-1',
      'eu-central-1',
      'eu-west-1',
      'eu-west-2',
      'eu-north-1',
    ];

    // We can Enable pipeline notification only for regions with AWS CodeStar being available
    if (awsCodeStarSupportedRegions.includes(cdk.Stack.of(this).region)) {
      const codeStarNotificationsRole = new cdk.aws_iam.CfnServiceLinkedRole(
        this,
        'AWSServiceRoleForCodeStarNotifications',
        {
          awsServiceName: 'codestar-notifications.amazonaws.com',
          description: 'Allows AWS CodeStar Notifications to access Amazon CloudWatch Events on your behalf',
        },
      );
      this.pipeline.node.addDependency(codeStarNotificationsRole);

      const acceleratorStatusTopic = new cdk.aws_sns.Topic(this, 'AcceleratorStatusTopic', {
        topicName: (this.props.qualifier ? this.props.qualifier : 'aws-accelerator') + '-pipeline-status-topic',
        displayName: (this.props.qualifier ? this.props.qualifier : 'aws-accelerator') + '-pipeline-status-topic',
        masterKey: this.installerKey,
      });

      acceleratorStatusTopic.grantPublish(this.pipeline.role);

      this.pipeline.notifyOn('AcceleratorPipelineStatusNotification', acceleratorStatusTopic, {
        events: [
          cdk.aws_codepipeline.PipelineNotificationEvents.MANUAL_APPROVAL_FAILED,
          cdk.aws_codepipeline.PipelineNotificationEvents.MANUAL_APPROVAL_NEEDED,
          cdk.aws_codepipeline.PipelineNotificationEvents.MANUAL_APPROVAL_SUCCEEDED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_CANCELED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_RESUMED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_STARTED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_SUCCEEDED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_SUPERSEDED,
        ],
      });

      // Pipeline failure status topic and alarm
      const acceleratorFailedStatusTopic = new cdk.aws_sns.Topic(this, 'AcceleratorFailedStatusTopic', {
        topicName: (this.props.qualifier ? this.props.qualifier : 'aws-accelerator') + '-pipeline-failed-status-topic',
        displayName:
          (this.props.qualifier ? this.props.qualifier : 'aws-accelerator') + '-pipeline-failed-status-topic',
        masterKey: this.installerKey,
      });

      acceleratorFailedStatusTopic.grantPublish(this.pipeline.role);

      this.pipeline.notifyOn('AcceleratorPipelineFailureNotification', acceleratorFailedStatusTopic, {
        events: [cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED],
      });

      acceleratorFailedStatusTopic
        .metricNumberOfMessagesPublished()
        .createAlarm(this, 'AcceleratorPipelineFailureAlarm', {
          threshold: 1,
          evaluationPeriods: 1,
          datapointsToAlarm: 1,
          treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmName: this.props.qualifier
            ? this.props.qualifier + '-pipeline-failed-alarm'
            : 'AwsAcceleratorFailedAlarm',
          alarmDescription: 'AWS Accelerator pipeline failure alarm, created by accelerator',
        });
    }
  }
}
