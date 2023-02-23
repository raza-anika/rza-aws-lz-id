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
import { NagSuppressions } from 'cdk-nag';
import { pascalCase } from 'change-case';
import { Construct } from 'constructs';
import * as path from 'path';

import { IdentityCenterAssignmentConfig, IdentityCenterPermissionSetConfig, RoleConfig } from '@aws-accelerator/config';
import {
  BudgetDefinition,
  IdentityCenterGetInstanceId,
  Inventory,
  KeyLookup,
  LimitsDefinition,
} from '@aws-accelerator/constructs';

import { Logger } from '../logger';
import { AcceleratorStack, AcceleratorStackProps } from './accelerator-stack';

export interface OperationsStackProps extends AcceleratorStackProps {
  configDirPath: string;
}

interface PermissionSetMapping {
  name: string;
  arn: string;
}

export class OperationsStack extends AcceleratorStack {
  /**
   * List of all the defined SAML Providers
   */
  private providers: { [name: string]: cdk.aws_iam.SamlProvider } = {};

  /**
   * List of all the defined IAM Policies
   */
  private policies: { [name: string]: cdk.aws_iam.ManagedPolicy } = {};

  /**
   * List of all the defined IAM Roles
   */
  private roles: { [name: string]: cdk.aws_iam.Role } = {};

  /**
   * List of all the defined IAM Groups
   */
  private groups: { [name: string]: cdk.aws_iam.Group } = {};
  readonly cloudwatchKey!: cdk.aws_kms.Key;

  /**
   * Constructor for OperationsStack
   *
   * @param scope
   * @param id
   * @param props
   */
  constructor(scope: Construct, id: string, props: OperationsStackProps) {
    super(scope, id, props);

    // Security Services delegated admin account configuration
    // Global decoration for security services
    const securityAdminAccount = props.securityConfig.centralSecurityServices.delegatedAdminAccount;
    const securityAdminAccountId = props.accountsConfig.getAccountId(securityAdminAccount);

    //
    // Only deploy IAM and CUR resources into the home region
    //
    if (props.globalConfig.homeRegion === cdk.Stack.of(this).region) {
      this.addProviders();
      this.addManagedPolicies();
      this.addRoles();
      this.addGroups();
      this.addUsers();
      this.createStackSetRoles();
      // Identity Center
      //
      this.addIdentityCenterResources(securityAdminAccountId);
      //
      //
      // Budgets
      //
      this.enableBudgetReports();
      //
      // Service Quota Limits
      //
      this.increaseLimits();

      // Create Accelerator Access Role in every region
      this.createAssetAccessRole();
    }

    //
    // Backup Vaults
    //
    this.addBackupVaults();

    if (
      this.props.globalConfig.ssmInventory?.enable &&
      this.isIncluded(this.props.globalConfig.ssmInventory.deploymentTargets)
    ) {
      this.enableInventory();
    }

    Logger.info('[operations-stack] Completed stack synthesis');
  }

  /* Enable AWS Service Quota Limits
   *
   */
  private increaseLimits() {
    for (const limit of this.props.globalConfig.limits ?? []) {
      if (this.isIncluded(limit.deploymentTargets ?? [])) {
        Logger.info(`[operations-stack] Updating limits for provided services.`);
        new LimitsDefinition(this, `ServiceQuotaUpdates${limit.quotaCode}` + `${limit.desiredValue}`, {
          serviceCode: limit.serviceCode,
          quotaCode: limit.quotaCode,
          desiredValue: limit.desiredValue,
          kmsKey: this.cloudwatchKey,
          logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
        });
      }
    }
  }

  /**
   * Adds SAML Providers
   */
  private addProviders() {
    for (const providerItem of this.props.iamConfig.providers ?? []) {
      Logger.info(`[operations-stack] Add Provider ${providerItem.name}`);
      this.providers[providerItem.name] = new cdk.aws_iam.SamlProvider(
        this,
        `${pascalCase(providerItem.name)}SamlProvider`,
        {
          name: providerItem.name,
          metadataDocument: cdk.aws_iam.SamlMetadataDocument.fromFile(
            path.join(this.props.configDirPath, providerItem.metadataDocument),
          ),
        },
      );
    }
  }

  /**
   * Adds IAM Managed Policies
   */
  private addManagedPolicies() {
    for (const policySetItem of this.props.iamConfig.policySets ?? []) {
      if (!this.isIncluded(policySetItem.deploymentTargets)) {
        Logger.info(`[operations-stack] Item excluded`);
        continue;
      }

      for (const policyItem of policySetItem.policies) {
        Logger.info(`[operations-stack] Add customer managed policy ${policyItem.name}`);

        // Read in the policy document which should be properly formatted json
        const policyDocument = JSON.parse(
          this.generatePolicyReplacements(path.join(this.props.configDirPath, policyItem.policy), false),
        );

        // Create a statements list using the PolicyStatement factory
        const statements: cdk.aws_iam.PolicyStatement[] = [];
        for (const statement of policyDocument.Statement) {
          statements.push(cdk.aws_iam.PolicyStatement.fromJson(statement));
        }

        // Construct the ManagedPolicy
        this.policies[policyItem.name] = new cdk.aws_iam.ManagedPolicy(this, pascalCase(policyItem.name), {
          managedPolicyName: policyItem.name,
          statements,
        });

        // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission
        // rule suppression with evidence for this permission.
        NagSuppressions.addResourceSuppressionsByPath(
          this,
          `${this.stackName}/${pascalCase(policyItem.name)}/Resource`,
          [
            {
              id: 'AwsSolutions-IAM5',
              reason: 'Policies definition are derived from accelerator iam-config boundary-policy file',
            },
          ],
        );
      }
    }
  }

  /**
   * Generates the list of role principals for the provided roleItem
   *
   * @param roleItem
   * @returns List of cdk.aws_iam.PrincipalBase
   */
  private getRolePrincipals(roleItem: RoleConfig): cdk.aws_iam.PrincipalBase[] {
    const principals: cdk.aws_iam.PrincipalBase[] = [];

    for (const assumedByItem of roleItem.assumedBy ?? []) {
      Logger.info(
        `[operations-stack] Role - assumed by type(${assumedByItem.type}) principal(${assumedByItem.principal})`,
      );

      if (assumedByItem.type === 'service') {
        principals.push(new cdk.aws_iam.ServicePrincipal(assumedByItem.principal));
      }

      if (assumedByItem.type === 'account') {
        principals.push(new cdk.aws_iam.AccountPrincipal(assumedByItem.principal));
      }

      if (assumedByItem.type === 'provider') {
        // workaround due to https://github.com/aws/aws-cdk/issues/22091
        if (this.props.partition === 'aws-cn') {
          principals.push(
            new cdk.aws_iam.FederatedPrincipal(
              this.providers[assumedByItem.principal].samlProviderArn,
              {
                StringEquals: {
                  'SAML:aud': 'https://signin.amazonaws.cn/saml',
                },
              },
              'sts:AssumeRoleWithSAML',
            ),
          );
        } else {
          principals.push(new cdk.aws_iam.SamlConsolePrincipal(this.providers[assumedByItem.principal]));
        }
      }
    }

    return principals;
  }

  /**
   * Generates the list of managed policies for the provided roleItem
   *
   * @param roleItem
   * @returns List of cdk.aws_iam.IManagedPolicy
   */
  private getManagedPolicies(roleItem: RoleConfig): cdk.aws_iam.IManagedPolicy[] {
    const managedPolicies: cdk.aws_iam.IManagedPolicy[] = [];

    for (const policyItem of roleItem.policies?.awsManaged ?? []) {
      Logger.info(`[operations-stack] Role - aws managed policy ${policyItem}`);
      managedPolicies.push(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(policyItem));
    }
    for (const policyItem of roleItem.policies?.customerManaged ?? []) {
      Logger.info(`[operations-stack] Role - customer managed policy ${policyItem}`);
      managedPolicies.push(this.policies[policyItem]);
    }

    return managedPolicies;
  }

  /**
   * Adds IAM Roles
   */
  private addRoles() {
    for (const roleSetItem of this.props.iamConfig.roleSets ?? []) {
      if (!this.isIncluded(roleSetItem.deploymentTargets)) {
        Logger.info(`[operations-stack] Item excluded`);
        continue;
      }

      for (const roleItem of roleSetItem.roles) {
        Logger.info(`[operations-stack] Add role ${roleItem.name}`);

        const principals = this.getRolePrincipals(roleItem);
        const managedPolicies = this.getManagedPolicies(roleItem);

        let assumedBy: cdk.aws_iam.IPrincipal;
        if (roleItem.assumedBy.find(item => item.type === 'provider')) {
          // Since a SamlConsolePrincipal creates conditions, we can not
          // use the CompositePrincipal. Verify that it is alone
          if (principals.length > 1) {
            throw new Error('More than one principal found when adding provider');
          }
          assumedBy = principals[0];
        } else {
          assumedBy = new cdk.aws_iam.CompositePrincipal(...principals);
        }

        const role = new cdk.aws_iam.Role(this, pascalCase(roleItem.name), {
          roleName: roleItem.name,
          assumedBy,
          managedPolicies,
          path: roleSetItem.path,
          permissionsBoundary: this.policies[roleItem.boundaryPolicy],
        });

        // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
        // rule suppression with evidence for this permission.
        NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/${pascalCase(roleItem.name)}/Resource`, [
          {
            id: 'AwsSolutions-IAM4',
            reason: 'IAM Role created as per accelerator iam-config needs AWS managed policy',
          },
        ]);

        // Create instance profile
        if (roleItem.instanceProfile) {
          Logger.info(`[operations-stack] Role - creating instance profile for ${roleItem.name}`);
          new cdk.aws_iam.CfnInstanceProfile(this, `${pascalCase(roleItem.name)}InstanceProfile`, {
            // Use role object to force use of Ref
            instanceProfileName: role.roleName,
            roles: [role.roleName],
          });
        }

        this.grantManagedActiveDirectorySecretAccess(roleItem.name, role);

        // Add to roles list
        this.roles[roleItem.name] = role;
      }
    }
  }

  /**
   * Function to grant managed active directory secret access to instance role if the role is used in managed ad instance
   * @param role
   */
  private grantManagedActiveDirectorySecretAccess(roleName: string, role: cdk.aws_iam.Role) {
    for (const managedActiveDirectory of this.props.iamConfig.managedActiveDirectories ?? []) {
      const madAccountId = this.props.accountsConfig.getAccountId(managedActiveDirectory.account);
      if (managedActiveDirectory.activeDirectoryConfigurationInstance) {
        if (
          managedActiveDirectory.activeDirectoryConfigurationInstance.instanceRole === roleName &&
          madAccountId === cdk.Stack.of(this).account &&
          managedActiveDirectory.region === cdk.Stack.of(this).region
        ) {
          const madAdminSecretAccountId = this.props.accountsConfig.getAccountId(
            this.props.iamConfig.getManageActiveDirectorySecretAccountName(managedActiveDirectory.name),
          );
          const madAdminSecretRegion = this.props.iamConfig.getManageActiveDirectorySecretRegion(
            managedActiveDirectory.name,
          );

          const secretArn = `arn:aws:secretsmanager:${madAdminSecretRegion}:${madAdminSecretAccountId}:secret:/accelerator/ad-user/${managedActiveDirectory.name}/*`;
          // Attach MAD instance role access to MAD secrets
          Logger.info(`[operations-stack] Granting mad secret access to ${roleName}`);
          role.attachInlinePolicy(
            new cdk.aws_iam.Policy(
              this,
              `${pascalCase(managedActiveDirectory.name)}${pascalCase(roleName)}SecretsAccess`,
              {
                statements: [
                  new cdk.aws_iam.PolicyStatement({
                    effect: cdk.aws_iam.Effect.ALLOW,
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [secretArn],
                  }),
                ],
              },
            ),
          );

          // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
          NagSuppressions.addResourceSuppressionsByPath(
            this,
            `${this.stackName}/${pascalCase(managedActiveDirectory.name)}${pascalCase(roleName)}SecretsAccess/Resource`,
            [
              {
                id: 'AwsSolutions-IAM5',
                reason: 'MAD instance role need access to more than one mad user secrets',
              },
            ],
          );
        }
      }
    }
  }

  /**
   *  Adds IAM Groups
   */
  private addGroups() {
    for (const groupSetItem of this.props.iamConfig.groupSets ?? []) {
      if (!this.isIncluded(groupSetItem.deploymentTargets)) {
        Logger.info(`[operations-stack] Item excluded`);
        continue;
      }

      for (const groupItem of groupSetItem.groups) {
        Logger.info(`[operations-stack] Add group ${groupItem.name}`);

        const managedPolicies: cdk.aws_iam.IManagedPolicy[] = [];
        for (const policyItem of groupItem.policies?.awsManaged ?? []) {
          Logger.info(`[operations-stack] Group - aws managed policy ${policyItem}`);
          managedPolicies.push(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(policyItem));
        }
        for (const policyItem of groupItem.policies?.customerManaged ?? []) {
          Logger.info(`[operations-stack] Group - customer managed policy ${policyItem}`);
          managedPolicies.push(this.policies[policyItem]);
        }

        this.groups[groupItem.name] = new cdk.aws_iam.Group(this, pascalCase(groupItem.name), {
          groupName: groupItem.name,
          managedPolicies,
        });

        // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
        // rule suppression with evidence for this permission.
        NagSuppressions.addResourceSuppressionsByPath(
          this,
          `${this.stackName}/${pascalCase(groupItem.name)}/Resource`,
          [
            {
              id: 'AwsSolutions-IAM4',
              reason: 'Groups created as per accelerator iam-config needs AWS managed policy',
            },
          ],
        );
      }
    }
  }

  /**
   * Adds IAM Users
   */
  private addUsers() {
    for (const userSet of this.props.iamConfig.userSets ?? []) {
      if (!this.isIncluded(userSet.deploymentTargets)) {
        Logger.info(`[operations-stack] Item excluded`);
        continue;
      }

      for (const user of userSet.users ?? []) {
        Logger.info(`[operations-stack] Add user ${user.username}`);

        const secret = new cdk.aws_secretsmanager.Secret(this, pascalCase(`${user.username}Secret`), {
          generateSecretString: {
            secretStringTemplate: JSON.stringify({ username: user.username }),
            generateStringKey: 'password',
          },
          secretName: `/accelerator/${user.username}`,
        });

        // AwsSolutions-SMG4: The secret does not have automatic rotation scheduled.
        // rule suppression with evidence for this permission.
        NagSuppressions.addResourceSuppressionsByPath(
          this,
          `${this.stackName}/${pascalCase(user.username)}Secret/Resource`,
          [
            {
              id: 'AwsSolutions-SMG4',
              reason: 'Accelerator users created as per iam-config file, MFA usage is enforced with boundary policy',
            },
          ],
        );

        Logger.info(`[operations-stack] User - password stored to /accelerator/${user.username}`);

        new cdk.aws_iam.User(this, pascalCase(user.username), {
          userName: user.username,
          password: secret.secretValueFromJson('password'),
          groups: [this.groups[user.group]],
          permissionsBoundary: this.policies[user.boundaryPolicy],
          passwordResetRequired: true,
        });
      }
    }
  }

  /**
   * Enables budget reports
   */
  private enableBudgetReports() {
    if (this.props.globalConfig.reports?.budgets) {
      for (const budget of this.props.globalConfig.reports.budgets ?? []) {
        if (this.isIncluded(budget.deploymentTargets ?? [])) {
          Logger.info(`[operations-stack] Add budget ${budget.name}`);
          new BudgetDefinition(this, `${budget.name}BudgetDefinition`, {
            amount: budget.amount,
            includeCredit: budget.includeCredit,
            includeDiscount: budget.includeDiscount,
            includeOtherSubscription: budget.includeOtherSubscription,
            includeRecurring: budget.includeRecurring,
            includeRefund: budget.includeRefund,
            includeSubscription: budget.includeSubscription,
            includeSupport: budget.includeSupport,
            includeTax: budget.includeTax,
            includeUpfront: budget.includeUpfront,
            name: budget.name,
            notifications: budget.notifications,
            timeUnit: budget.timeUnit,
            type: budget.type,
            useAmortized: budget.useAmortized,
            useBlended: budget.useBlended,
            unit: budget.unit,
          });
        }
      }
    }
  }

  /**
   * Adds Backup Vaults as defined in the global-config.yaml. These Vaults can
   * be referenced in AWS Organizations Backup Policies
   */
  private addBackupVaults() {
    let backupKey: cdk.aws_kms.Key | undefined = undefined;
    for (const vault of this.props.globalConfig.backup?.vaults ?? []) {
      if (this.isIncluded(vault.deploymentTargets)) {
        // Only create the key if a vault is defined for this account
        if (backupKey === undefined) {
          backupKey = new cdk.aws_kms.Key(this, 'BackupKey', {
            alias: AcceleratorStack.ACCELERATOR_AWS_BACKUP_KEY_ALIAS,
            description: AcceleratorStack.ACCELERATOR_AWS_BACKUP_KEY_DESCRIPTION,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
          });
        }

        new cdk.aws_backup.BackupVault(this, `BackupVault_${vault.name}`, {
          backupVaultName: vault.name,
          encryptionKey: backupKey,
        });
      }
    }
  }

  private enableInventory() {
    Logger.info('[operations-stack] Enabling SSM Inventory');

    new Inventory(this, 'AcceleratorSsmInventory', {
      bucketName: `${
        AcceleratorStack.ACCELERATOR_CENTRAL_LOGS_BUCKET_NAME_PREFIX
      }-${this.props.accountsConfig.getLogArchiveAccountId()}-${this.props.centralizedLoggingRegion}`,
      bucketRegion: this.props.centralizedLoggingRegion,
      accountId: cdk.Stack.of(this).account,
      prefix: 'aws-accelerator',
    });
  }

  /**
   * Creates CloudFormation roles required for StackSets if stacksets are defined in customizations-config.yaml
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-prereqs-self-managed.html#prereqs-self-managed-permissions
   */
  private createStackSetRoles() {
    if (this.props.customizationsConfig?.customizations?.cloudFormationStackSets) {
      const managementAccountId = this.props.accountsConfig.getManagementAccountId();
      if (cdk.Stack.of(this).account == managementAccountId) {
        this.createStackSetAdminRole();
      }
      this.createStackSetExecutionRole(managementAccountId);
    }
  }

  private createStackSetAdminRole() {
    Logger.info(`[operations-stack] Creating StackSet Administrator Role`);
    new cdk.aws_iam.Role(this, 'StackSetAdminRole', {
      roleName: 'AWSCloudFormationStackSetAdministrationRole',
      assumedBy: new cdk.aws_iam.ServicePrincipal('cloudformation.amazonaws.com'),
      description: 'Assumes AWSCloudFormationStackSetExecutionRole in workload accounts to deploy StackSets',
      inlinePolicies: {
        AssumeRole: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ['sts:AssumeRole'],
              resources: ['arn:*:iam::*:role/AWSCloudFormationStackSetExecutionRole'],
            }),
          ],
        }),
      },
    });
  }

  /**
   * Custom resource to check if Identity Center Delegated Administrator
   * needs to be updated.
   */
  private addIdentityCenterPermissionSets(securityAdminAccountId: string, identityCenterInstanceId: string) {
    const permissionSetMap: PermissionSetMapping[] = [];
    if (cdk.Stack.of(this).account == securityAdminAccountId) {
      const identityCenter = this.props.iamConfig.identityCenter;
      if (identityCenter?.identityCenterPermissionSets) {
        for (const identityCenterPermissionSet of identityCenter.identityCenterPermissionSets) {
          const permissionSet = this.createPermissionsSet(identityCenterPermissionSet, identityCenterInstanceId);
          permissionSetMap.push(permissionSet);
        }
      }
    }
    return permissionSetMap;
  }

  private createPermissionsSet(
    identityCenterPermissionSet: IdentityCenterPermissionSetConfig,
    identityCenterInstanceId: string,
  ): PermissionSetMapping {
    let customerManagedPolicyReferencesList: cdk.aws_sso.CfnPermissionSet.CustomerManagedPolicyReferenceProperty[] = [];
    const permissionSetPair: PermissionSetMapping = {
      name: '',
      arn: '',
    };
    Logger.info(`[operations-stack] Adding Identity Center Permission Set ${identityCenterPermissionSet.name}`);
    if (identityCenterPermissionSet.policies?.customerManaged) {
      customerManagedPolicyReferencesList = this.generateManagedPolicyReferences(
        identityCenterPermissionSet.policies?.customerManaged,
      );
    }

    const convertedSessionDuration = this.convertMinutesToIso8601(identityCenterPermissionSet.sessionDuration);

    try {
      //if check for managedpolicy or customer managed
      const permissionSet = new cdk.aws_sso.CfnPermissionSet(
        this,
        `${pascalCase(identityCenterPermissionSet.name)}IdentityCenterPermissionSet`,
        {
          name: identityCenterPermissionSet.name,
          instanceArn: identityCenterInstanceId,
          managedPolicies: identityCenterPermissionSet?.policies?.awsManaged,
          customerManagedPolicyReferences: customerManagedPolicyReferencesList,
          sessionDuration: convertedSessionDuration ?? undefined,
        },
      );

      permissionSetPair.name = permissionSet.name;
      permissionSetPair.arn = permissionSet.attrPermissionSetArn;
    } catch (e) {
      Logger.error(e);
      throw e;
    }

    return permissionSetPair;
  }

  private addIdentityCenterAssignments(
    securityAdminAccountId: string,
    permissionSetMap: PermissionSetMapping[],
    identityCenterInstanceId: string,
  ) {
    if (cdk.Stack.of(this).account == securityAdminAccountId) {
      const identityCenter = this.props.iamConfig.identityCenter;
      if (identityCenter?.identityCenterAssignments) {
        for (const assignment of identityCenter.identityCenterAssignments) {
          this.createAssignment(assignment, permissionSetMap, identityCenterInstanceId);
        }
      }
    }
  }

  /**
   * Retrieve Identity Center Instance Id
   */
  private getIdentityCenterInstanceId(securityAdminAccountId: string) {
    Logger.info(`[operations-stack] Retrieving Identity Center Instance Id`);
    let identityCenterInstanceResponse;
    let identityCenterInstanceId;
    if (!securityAdminAccountId) {
      securityAdminAccountId = this.props.accountsConfig.getManagementAccountId();
    }
    if (cdk.Stack.of(this).account == securityAdminAccountId) {
      try {
        identityCenterInstanceResponse = new IdentityCenterGetInstanceId(this, `IdentityCenterGetInstanceId`);
        identityCenterInstanceId = identityCenterInstanceResponse.instanceId;
      } catch (e) {
        Logger.error(e);
        throw e;
      }
    }
    return identityCenterInstanceId;
  }

  private createAssignment(
    assignment: IdentityCenterAssignmentConfig,
    permissionSetMap: PermissionSetMapping[],
    identityCenterInstanceId: string,
  ) {
    let listOfTargets = [];
    listOfTargets = this.getAccountIdsFromDeploymentTarget(assignment.deploymentTargets);
    const permissionSetArnValue = this.getPermissionSetArn(permissionSetMap, assignment.permissionSetName);
    for (const target of listOfTargets) {
      Logger.info(`[operations-stack] Creating Identity Center Assignment ${assignment.name}-${target}`);
      try {
        new cdk.aws_sso.CfnAssignment(this, `${pascalCase(assignment.name)}-${target}`, {
          instanceArn: identityCenterInstanceId,
          permissionSetArn: permissionSetArnValue,
          principalId: assignment.principalId,
          principalType: assignment.principalType,
          targetId: target,
          targetType: 'AWS_ACCOUNT',
        });
      } catch (e) {
        Logger.error(e);
        throw e;
      }
    }
  }

  private getPermissionSetArn(permissionSetMap: PermissionSetMapping[], name: string) {
    let permissionSetArn = '';
    for (const permissionSet of permissionSetMap) {
      if (permissionSet.name == name && permissionSet.arn) {
        permissionSetArn = permissionSet.arn;
      }
    }
    return permissionSetArn;
  }

  private addIdentityCenterResources(securityAdminAccountId: string) {
    if (this.props.iamConfig.identityCenter) {
      if (cdk.Stack.of(this).account == securityAdminAccountId) {
        const identityCenterInstanceId = this.getIdentityCenterInstanceId(securityAdminAccountId);
        if (!identityCenterInstanceId) {
          throw new Error(
            `[operations-stack] No Identity Center instance found. Please ensure that the Identity Service is enabled, and rerun the Code Pipeline`,
          );
        }
        const permissionSetList = this.addIdentityCenterPermissionSets(
          securityAdminAccountId,
          identityCenterInstanceId,
        );
        this.addIdentityCenterAssignments(securityAdminAccountId, permissionSetList, identityCenterInstanceId);
      }
    }
  }

  private createStackSetExecutionRole(managementAccountId: string) {
    Logger.info(`[operations-stack] Creating StackSet Execution Role`);
    new cdk.aws_iam.Role(this, 'StackSetExecutionRole', {
      roleName: 'AWSCloudFormationStackSetExecutionRole',
      assumedBy: new cdk.aws_iam.AccountPrincipal(managementAccountId),
      description: 'Used to deploy StackSets',
      managedPolicies: [cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
    });

    // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
    // rule suppression with evidence for this permission.
    NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/StackSetExecutionRole/Resource`, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'IAM Role created as per accelerator iam-config needs AWS managed policy',
      },
    ]);

    // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission
    // rule suppression with evidence for this permission.
    NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/StackSetAdminRole/Resource`, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Policies definition are derived from accelerator iam-config boundary-policy file',
      },
    ]);
  }

  private createAssetAccessRole() {
    const accessBucketArn = `arn:${
      this.props.partition
    }:s3:::aws-accelerator-assets-${this.props.accountsConfig.getManagementAccountId()}-${
      this.props.globalConfig.homeRegion
    }`;

    const accountId = cdk.Stack.of(this).account;

    const accessRoleResourceName = `AssetAccessRole${accountId}`;
    const assetsAccessRole = new cdk.aws_iam.Role(this, accessRoleResourceName, {
      roleName: `AWSAccelerator-AssetsAccessRole`,
      assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'AWS Accelerator assets access role in workload accounts deploy ACM imported certificates.',
    });
    assetsAccessRole.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: [`${accessBucketArn}`, `${accessBucketArn}/*`],
        actions: ['s3:GetObject*', 's3:ListBucket'],
      }),
    );
    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: [`arn:${this.props.partition}:acm:*:${accountId}:certificate/*`],
        actions: ['acm:ImportCertificate'],
      }),
    );
    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: ['*'],
        actions: ['acm:RequestCertificate', 'acm:DeleteCertificate'],
      }),
    );
    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: [`arn:${this.props.partition}:ssm:*:${accountId}:parameter/*`],
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParameter'],
      }),
    );

    const assetsBucketKmsKey = new KeyLookup(this, 'AssetsBucketKms', {
      accountId: this.props.accountsConfig.getManagementAccountId(),
      keyRegion: this.props.globalConfig.homeRegion,
      roleName: AcceleratorStack.ACCELERATOR_ASSETS_CROSS_ACCOUNT_SSM_PARAMETER_ACCESS_ROLE_NAME,
      keyArnParameterName: AcceleratorStack.ACCELERATOR_ASSETS_KEY_ARN_PARAMETER_NAME,
      kmsKey: this.cloudwatchKey,
      logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
    }).getKey();

    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: [assetsBucketKmsKey.keyArn],
        actions: ['kms:Decrypt'],
      }),
    );

    // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission
    // rule suppression with evidence for this permission.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/${accessRoleResourceName}/DefaultPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Policy permissions are part of managed role and rest is to get access from s3 bucket',
        },
      ],
    );

    // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
    // rule suppression with evidence for this permission.
    NagSuppressions.addResourceSuppressionsByPath(this, `${this.stackName}/${accessRoleResourceName}/Resource`, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'IAM Role for lambda needs AWS managed policy',
      },
    ]);
  }
}
