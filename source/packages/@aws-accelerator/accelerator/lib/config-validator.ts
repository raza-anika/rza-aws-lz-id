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
import {
  AccountsConfig,
  GlobalConfig,
  OrganizationConfig,
  SecurityConfig,
  CustomizationsConfigValidator,
  NetworkConfigValidator,
  IamConfigValidator,
} from '@aws-accelerator/config';
import { Logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

const configDirPath = process.argv[2];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const errors: { file: string; message: any }[] = [];

if (configDirPath) {
  Logger.info(`[config-validator] Config source directory -  ${configDirPath}`);

  try {
    AccountsConfig.load(configDirPath, true);
  } catch (e) {
    errors.push({ file: 'accounts-config.yaml', message: e });
  }

  try {
    GlobalConfig.load(configDirPath, true);
  } catch (e) {
    errors.push({ file: 'global-config.yaml', message: e });
  }

  try {
    new IamConfigValidator(configDirPath);
  } catch (e) {
    errors.push({ file: 'iam-config.yaml', message: e });
  }

  try {
    new NetworkConfigValidator(configDirPath);
  } catch (e) {
    errors.push({ file: 'network-config.yaml', message: e });
  }

  try {
    OrganizationConfig.load(configDirPath, true);
  } catch (e) {
    errors.push({ file: 'organization-config.yaml', message: e });
  }

  try {
    SecurityConfig.load(configDirPath, true);
  } catch (e) {
    errors.push({ file: 'security-config.yaml', message: e });
  }

  // Validate optional configuration files if they exist
  if (fs.existsSync(path.join(configDirPath, 'customizations-config.yaml'))) {
    try {
      new CustomizationsConfigValidator(configDirPath);
    } catch (e) {
      errors.push({ file: 'customizations-config.yaml', message: e });
    }
  }

  if (errors.length > 0) {
    Logger.warn(`[config-validator] Config file validation failed !!!`);
    errors.forEach(item => {
      Logger.warn(`[config-validator] ${item.message} in ${item.file} config file`);
    });
    process.exit(1);
  } else {
    Logger.info(`[config-validator] Config file validation successful.`);
  }
} else {
  Logger.info('[config-validator] Config source directory undefined !!!');
}
